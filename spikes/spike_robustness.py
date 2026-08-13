# Spike 2: VideoSeal robustness vs simulated social-media transcodes.
# Embeds a 256-bit message, re-encodes with ladders mimicking real platforms,
# then measures bit accuracy of extraction per condition.
import json
import os
import subprocess
import sys
import time

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))

import videoseal  # noqa: E402
from inference_streaming import embed_video, detect_video  # noqa: E402
from videoseal.evals.metrics import bit_accuracy  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'videoseal', 'assets', 'videos', '1.mp4')
OUT = os.path.join(BASE, 'results')
WM = os.path.join(OUT, 'watermarked.mp4')

# Encoding ladders approximating what platforms do to uploads.
# (codec, args) — all re-encode from the watermarked file.
CONDITIONS = {
    'youtube_1080p_8M': ['-c:v', 'libx264', '-b:v', '8M', '-preset', 'medium'],
    'tiktok_1080p_3M': ['-c:v', 'libx264', '-b:v', '3M', '-preset', 'medium'],
    'twitter_720p_2M': ['-vf', 'scale=-2:720', '-c:v', 'libx264', '-b:v', '2M'],
    'whatsapp_480p_1M': ['-vf', 'scale=-2:480', '-c:v', 'libx264', '-b:v', '1M'],
    'h265_crf28': ['-c:v', 'libx265', '-crf', '28'],
    'crop10_rescale': ['-vf', 'crop=iw*0.9:ih*0.9,scale=1904:1080', '-c:v', 'libx264', '-crf', '23'],
    'stress_360p_500k': ['-vf', 'scale=-2:360', '-c:v', 'libx264', '-b:v', '500k'],
}


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def psnr(ref, dist):
    # ffmpeg PSNR between two videos, returns average luma PSNR
    r = subprocess.run(
        ['ffmpeg', '-i', dist, '-i', ref, '-lavfi',
         '[0:v][1:v]psnr', '-f', 'null', '-'],
        capture_output=True, text=True)
    for line in r.stderr.splitlines():
        if 'average:' in line:
            return float(line.split('average:')[1].split()[0])
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    model = videoseal.load('videoseal')
    model.eval()

    # Embed once at capture-like quality (CRF 18)
    t0 = time.time()
    msgs = embed_video(model, SRC, WM, chunk_size=16, crf=18)
    embed_s = time.time() - t0
    nframes = 256
    print(f'embed: {embed_s:.1f}s for {nframes} frames '
          f'({nframes / embed_s:.2f} fps incl. ffmpeg I/O)')

    results = {
        'embed_seconds': round(embed_s, 1),
        'embed_fps': round(nframes / embed_s, 2),
        'psnr_watermarked_vs_source': psnr(SRC, WM),
        'conditions': {},
    }

    # Baseline: extract from the watermarked file itself
    soft = detect_video(model, WM, chunk_size=16)
    acc = bit_accuracy(soft, msgs).item() * 100
    results['conditions']['baseline_no_transcode'] = {'bit_acc': round(acc, 2)}
    print(f'baseline: {acc:.2f}%')

    for name, args in CONDITIONS.items():
        dst = os.path.join(OUT, f'{name}.mp4')
        run(['ffmpeg', '-y', '-i', WM] + args + ['-an', dst])
        soft = detect_video(model, dst, chunk_size=16)
        acc = bit_accuracy(soft, msgs).item() * 100
        wrong = int(round((100 - acc) / 100 * 256))
        size_mb = os.path.getsize(dst) / 1e6
        results['conditions'][name] = {
            'bit_acc': round(acc, 2), 'wrong_bits_of_256': wrong,
            'size_mb': round(size_mb, 1),
        }
        print(f'{name}: {acc:.2f}% ({wrong} wrong bits, {size_mb:.1f}MB)')

    with open(os.path.join(OUT, 'robustness.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print('saved results/robustness.json')


if __name__ == '__main__':
    main()
