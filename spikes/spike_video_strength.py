# Video embed sweep on a REAL capture: strength x delta-refresh (STEP) through
# a WhatsApp-class transcode (478x850 @ ~1.7Mbps), measuring repetition-format
# recovery exactly like the verifier (24 sampled frames, soft-average).
# Mirrors VideoWatermarker.kt: delta from a key frame reused for STEP frames.
#   cd spikes/videoseal && python ../spike_video_strength.py <video> [frames]
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.getcwd())

import numpy as np
import onnxruntime as ort
import torch

import videoseal

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
sys.path.insert(0, HERE)
import codec  # noqa: E402

MARK_ID = 0x2636A4
N_FRAMES = int(sys.argv[2]) if len(sys.argv) > 2 else 96
SCAN_FRAMES = 24

_model = videoseal.load('videoseal')
_model.eval()
_prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
_key = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
_apply = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))
_msg = codec.encode(MARK_ID).numpy()
_exp = (codec.encode(MARK_ID)[0] > 0.5).long()


def read_frames(path, n):
    """First n frames, display orientation (ffmpeg autorotates), RGB float 0..1."""
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height:stream_side_data=rotation',
                            '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    vals = [v for v in probe.replace('\n', ',').split(',') if v.strip('-').isdigit()]
    w, h = int(vals[0]), int(vals[1])
    rot = int(vals[2]) if len(vals) > 2 else 0
    if rot % 180 != 0:
        w, h = h, w
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-frames:v', str(n),
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                         capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8)
    frames = frames[:len(frames) // (w * h * 3) * w * h * 3]
    return frames.reshape(-1, h, w, 3).astype(np.float32) / 255.0


def embed_video(frames, strength, step):
    """Y-delta embed with key-frame propagation, like VideoWatermarker."""
    out = np.empty_like(frames)
    delta = None
    for i, rgb in enumerate(frames):
        y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
        if i % step == 0:
            y_res = _prep.run(None, {'y': y})[0]
            delta = _key.run(None, {'y_res': y_res, 'message': _msg})[0] * strength
        y_w = _apply.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
        out[i] = np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)
    return out


def transcode(frames, w_out, h_out, bitrate):
    h, w = frames.shape[1:3]
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'in.mp4')
        dst = os.path.join(td, 'out.mp4')
        enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo',
                                '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', '30', '-i', 'pipe:0',
                                '-c:v', 'libx264', '-b:v', '14M', '-pix_fmt', 'yuv420p', src],
                               stdin=subprocess.PIPE)
        enc.stdin.write((frames * 255 + 0.5).astype(np.uint8).tobytes())
        enc.stdin.close()
        enc.wait()
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src,
                        '-vf', f'scale={w_out}:{h_out}', '-c:v', 'libx264',
                        '-b:v', bitrate, '-pix_fmt', 'yuv420p', dst], check=True)
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', dst, '-f', 'rawvideo',
                              '-pix_fmt', 'rgb24', 'pipe:1'], capture_output=True).stdout
    n = len(raw) // (w_out * h_out * 3)
    return np.frombuffer(raw, np.uint8)[:n * w_out * h_out * 3] \
        .reshape(n, h_out, w_out, 3).astype(np.float32) / 255.0


def scan(frames):
    """Verifier flow: SCAN_FRAMES sampled evenly, soft bits averaged."""
    idx = [int((i + 0.5) * len(frames) / SCAN_FRAMES) for i in range(SCAN_FRAMES)]
    acc = torch.zeros(256)
    for i in idx:
        t = torch.from_numpy(frames[i]).permute(2, 0, 1).unsqueeze(0)
        with torch.no_grad():
            acc += _model.detect(t, is_video=False)['preds'][0, 1:]
    avg = acc / len(idx)
    errors = int(((avg > 0).long() != _exp).sum())
    pid, conf = codec.decode(avg)
    return errors, pid == MARK_ID, conf


def main(path):
    frames = read_frames(path, N_FRAMES)
    print(f'{len(frames)} frames {frames.shape[2]}x{frames.shape[1]} from {path}')
    for strength, step in [(1.0, 4), (1.0, 1), (1.5, 4), (2.0, 4), (1.5, 1)]:
        wm = embed_video(frames, strength, step)
        wa = transcode(wm, 478, 850, '1700k')
        errors, ok, conf = scan(wa)
        print(f'strength={strength} step={step}: whatsapp raw errors {errors}/256, '
              f'decode={"OK" if ok else "FAIL"} conf={conf:.3f}')


if __name__ == '__main__':
    main(sys.argv[1])
