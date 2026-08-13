# Round-trip check: extract the watermark from a platform re-encoded copy
# and compare against the original embedded message.
# Usage (from videoseal/ repo root): python ../extract_check.py <video> [<video>...]
import os
import subprocess
import sys
import tempfile

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))

import videoseal  # noqa: E402
from inference_streaming import detect_video  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
MSG_FILE = os.path.join(BASE, 'results', 'watermarked.txt')


def main(paths):
    with open(MSG_FILE) as f:
        msg = torch.tensor([int(c) for c in f.read().strip()], dtype=torch.float32)

    model = videoseal.load('videoseal')
    model.eval()

    for path in paths:
        # DASH/fragmented MP4s (e.g. from YouTube) lack nb_frames; a lossless
        # remux restores it without touching pixels.
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
            remuxed = tmp.name
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', path,
                        '-c', 'copy', '-an', remuxed], check=True)
        soft = detect_video(model, remuxed, chunk_size=16)
        os.unlink(remuxed)
        bits = (soft > 0).float().cpu()
        acc = (bits == msg).float().mean().item() * 100
        wrong = int((bits != msg).sum().item())
        size_mb = os.path.getsize(path) / 1e6
        print(f'{os.path.basename(path)}: {acc:.2f}% bit accuracy, '
              f'{wrong}/256 wrong bits, {size_mb:.1f}MB')


if __name__ == '__main__':
    main(sys.argv[1:])
