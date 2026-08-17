# Spike 3 + sweep: per-segment payloads in video — does the in-band pHash story
# extend to video, and what segment length should the payload contract use?
# Each segment of `seg` frames carries its own codec_v2 payload. Measured per
# segment length (16/32/48 frames):
#   1. control: whole-video averaging over mixed messages must fail (clean).
#   2. known boundaries: per-segment decode after transcode.
#   3. blind sliding window: recovery with no boundary info (trimmed-clip case).
import json
import os
import random
import subprocess
import sys

import ffmpeg
import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))

import videoseal  # noqa: E402
from inference_streaming import embed_video_clip, detect_video_clip  # noqa: E402

import codec_v2  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'videoseal', 'assets', 'videos', '1.mp4')
OUT = os.path.join(BASE, 'results')
WM = os.path.join(OUT, 'watermarked_seg.mp4')

SEG_SWEEP = (16, 32, 48)
DETECT_BATCH = 16
PROOF_ID = (0x2A5 << 14) | 1234
TRIM_START, TRIM_LEN = 70, 120  # deliberately misaligned cut (70 % 16 = 6)


def video_geometry(path):
    info = next(s for s in ffmpeg.probe(path)['streams']
                if s['codec_type'] == 'video')
    return int(info['width']), int(info['height']), int(info['nb_frames'])


def embed_segments(model, msgs, seg):
    w, h, _ = video_geometry(SRC)
    read = (ffmpeg.input(SRC)
            .output('pipe:', format='rawvideo', pix_fmt='rgb24')
            .run_async(pipe_stdout=True, pipe_stderr=False))
    write = (ffmpeg.input('pipe:', format='rawvideo', pix_fmt='rgb24',
                          s=f'{w}x{h}', r=24)
             .output(WM, vcodec='libx264', pix_fmt='yuv420p', crf=18, r=24)
             .overwrite_output()
             .run_async(pipe_stdin=True, pipe_stderr=False))
    frame_size = w * h * 3
    i = 0
    while True:
        data = read.stdout.read(frame_size * seg)
        if not data:
            break
        n = len(data) // frame_size
        chunk = np.frombuffer(data, np.uint8).reshape([n, h, w, 3])
        write.stdin.write(embed_video_clip(model, chunk, msgs[i]).tobytes())
        i += 1
    read.stdout.close()
    write.stdin.close()
    read.wait()
    write.wait()


def detect_frames(model, path):
    """Per-frame soft bits, (nframes, 256) — no averaging."""
    w, h, _ = video_geometry(path)
    read = (ffmpeg.input(path)
            .output('pipe:', format='rawvideo', pix_fmt='rgb24')
            .run_async(pipe_stdout=True, pipe_stderr=False))
    frame_size = w * h * 3
    preds = []
    while True:
        data = read.stdout.read(frame_size * DETECT_BATCH)
        if not data:
            break
        n = len(data) // frame_size
        chunk = np.frombuffer(data, np.uint8).reshape([n, h, w, 3])
        preds.append(detect_video_clip(model, chunk))
    read.stdout.close()
    read.wait()
    soft = torch.cat(preds, dim=0)
    # decode thresholds at 0 — recenter if the extractor emits [0,1] scores
    if soft.min() >= 0:
        soft = soft - 0.5
    return soft


def decode_window(soft):
    return codec_v2.decode(soft.mean(dim=0))


def analyze(soft, expected, aligned, seg):
    """expected: per-segment payload ints; aligned: frame offset of this clip
    inside the original video."""
    out = {}
    # 1. whole-video average (mixed messages)
    got_id, _, _ = decode_window(soft)
    out['whole_avg_decodes'] = got_id is not None

    # 2. known boundaries (only meaningful when aligned % seg == 0)
    hits = 0
    nwin = soft.shape[0] // seg
    for i in range(nwin):
        got_id, got_hash, _ = decode_window(soft[i * seg:(i + 1) * seg])
        want = expected[(aligned + i * seg) // seg]
        hits += int(got_id == PROOF_ID and got_hash == want)
    out['known_bounds'] = f'{hits}/{nwin}'

    # 3. blind sliding window, stride 1: no boundary info (trimmed-clip case)
    found, wrong = set(), 0
    for start in range(0, soft.shape[0] - seg + 1):
        got_id, got_hash, _ = decode_window(soft[start:start + seg])
        if got_id is None:
            continue
        if got_id == PROOF_ID and got_hash in expected:
            found.add(expected.index(got_hash))
        else:
            wrong += 1
    # denominator: original segments fully contained in this clip
    full = [s for s in range(len(expected))
            if s * seg >= aligned and (s + 1) * seg <= aligned + soft.shape[0]]
    out['blind_segments_found'] = f'{len(found)}/{len(full)}'
    out['blind_wrong_payloads'] = wrong
    return out


def run(model, seg):
    random.seed(7)
    _, _, nframes = video_geometry(SRC)
    nseg = (nframes + seg - 1) // seg
    hashes = [random.getrandbits(codec_v2.PHASH_BITS) for _ in range(nseg)]
    msgs = [codec_v2.encode(PROOF_ID, ph) for ph in hashes]

    embed_segments(model, msgs, seg)
    results = {'segments': nseg}

    results['baseline'] = analyze(detect_frames(model, WM), hashes, 0, seg)
    print(f'seg{seg} baseline:', results['baseline'])

    wa = os.path.join(OUT, 'seg_whatsapp.mp4')
    subprocess.run(['ffmpeg', '-y', '-i', WM, '-vf', 'scale=-2:480',
                    '-c:v', 'libx264', '-b:v', '1M', '-an', wa],
                   check=True, capture_output=True)
    results['whatsapp_480p_1M'] = analyze(detect_frames(model, wa), hashes, 0, seg)
    print(f'seg{seg} whatsapp:', results['whatsapp_480p_1M'])
    os.remove(wa)

    tr = os.path.join(OUT, 'seg_trim.mp4')
    subprocess.run(['ffmpeg', '-y', '-i', WM, '-vf',
                    f'select=between(n\\,{TRIM_START}\\,{TRIM_START + TRIM_LEN - 1}),setpts=N/FRAME_RATE/TB',
                    '-c:v', 'libx264', '-crf', '23', '-an', tr],
                   check=True, capture_output=True)
    results['trim_misaligned'] = analyze(detect_frames(model, tr), hashes,
                                         TRIM_START, seg)
    print(f'seg{seg} trim:', results['trim_misaligned'])
    os.remove(tr)
    return results


def main():
    os.makedirs(OUT, exist_ok=True)
    model = videoseal.load('videoseal')
    model.eval()
    results = {f'seg{seg}': run(model, seg) for seg in SEG_SWEEP}
    with open(os.path.join(OUT, 'video_segments.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print('saved results/video_segments.json')


if __name__ == '__main__':
    main()
