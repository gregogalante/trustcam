# Spike: PDQ Hamming separation, benign transcodes vs semantic edits,
# at full 256 bits and truncated to the 104 bits that fit codec_v2.
# Kill criterion: benign and edit distance distributions overlap at 104 bits.
import json
import os
import random
import subprocess

import cv2
import numpy as np
import pdqhash

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'videoseal', 'assets', 'videos', '1.mp4')
OUT = os.path.join(BASE, 'results')
FRAMES_DIR = os.path.join(OUT, 'pdq_frames')
N_FRAMES = 8
TRUNC = 104

random.seed(42)


def extract_frames():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    paths = []
    for i in range(N_FRAMES):
        idx = i * 32  # spread across the 256-frame clip
        path = os.path.join(FRAMES_DIR, f'f{idx:03d}.png')
        if not os.path.exists(path):
            subprocess.run(
                ['ffmpeg', '-y', '-i', SRC, '-vf', f'select=eq(n\\,{idx})',
                 '-vframes', '1', path], check=True, capture_output=True)
        paths.append(path)
    return paths


def phash(img_bgr):
    h, _ = pdqhash.compute(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    return h


def dist(a, b, bits):
    return int(np.count_nonzero(a[:bits] != b[:bits]))


def jpeg(img, q):
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, q])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def resize(img, scale=None, width=None):
    h, w = img.shape[:2]
    if width:
        scale = width / w
    return cv2.resize(img, (int(w * scale), int(h * scale)),
                      interpolation=cv2.INTER_AREA)


# --- benign: what sharing pipelines do -------------------------------------
BENIGN = {
    'jpeg_q85': lambda im, _: jpeg(im, 85),
    'jpeg_q70': lambda im, _: jpeg(im, 70),
    'jpeg_q50': lambda im, _: jpeg(im, 50),
    'resize075_q70': lambda im, _: jpeg(resize(im, scale=0.75), 70),
    'resize1280_q70': lambda im, _: jpeg(resize(im, width=1280), 70),
    'resize05_q50': lambda im, _: jpeg(resize(im, scale=0.5), 50),
}


# --- edits: what an attacker/AI editor does ---------------------------------
def patch_paste(img, donor, area_frac):
    # square patch from a different frame — stand-in for inpaint/replace
    out = img.copy()
    h, w = img.shape[:2]
    side = int((area_frac * h * w) ** 0.5)
    y = random.randrange(0, h - side)
    x = random.randrange(0, w - side)
    out[y:y + side, x:x + side] = donor[y:y + side, x:x + side]
    return out


def inpaint_region(img, area_frac):
    # object removal via cv2 inpaint over a random rectangle
    h, w = img.shape[:2]
    side = int((area_frac * h * w) ** 0.5)
    y = random.randrange(0, h - side)
    x = random.randrange(0, w - side)
    mask = np.zeros((h, w), np.uint8)
    mask[y:y + side, x:x + side] = 255
    return cv2.inpaint(img, mask, 5, cv2.INPAINT_TELEA)


def crop_rescale(img, frac):
    h, w = img.shape[:2]
    dy, dx = int(h * frac / 2), int(w * frac / 2)
    return cv2.resize(img[dy:h - dy, dx:w - dx], (w, h))


EDITS = {
    'patch10': lambda im, d: patch_paste(im, d, 0.10),
    'patch20': lambda im, d: patch_paste(im, d, 0.20),
    'patch30': lambda im, d: patch_paste(im, d, 0.30),
    'patch10_q70': lambda im, d: jpeg(patch_paste(im, d, 0.10), 70),
    'inpaint15': lambda im, d: inpaint_region(im, 0.15),
    'crop10': lambda im, d: crop_rescale(im, 0.10),
    'crop20': lambda im, d: crop_rescale(im, 0.20),
}


def main():
    paths = extract_frames()
    imgs = [cv2.imread(p) for p in paths]
    refs = [phash(im) for im in imgs]

    per_op = {}
    for group, ops in (('benign', BENIGN), ('edit', EDITS)):
        for name, op in ops.items():
            d256, d104 = [], []
            for i, im in enumerate(imgs):
                donor = imgs[(i + 4) % len(imgs)]
                h = phash(op(im, donor))
                d256.append(dist(refs[i], h, 256))
                d104.append(dist(refs[i], h, TRUNC))
            per_op[name] = {
                'group': group,
                'd256': d256, 'd104': d104,
                'mean256': round(float(np.mean(d256)), 1),
                'mean104': round(float(np.mean(d104)), 1),
            }
            print(f'{group:6s} {name:15s} 256: {min(d256):3d}-{max(d256):3d} '
                  f'(mean {np.mean(d256):5.1f})   104: {min(d104):3d}-{max(d104):3d} '
                  f'(mean {np.mean(d104):5.1f})')

    benign104 = [d for v in per_op.values() if v['group'] == 'benign' for d in v['d104']]
    edit104 = [d for v in per_op.values() if v['group'] == 'edit' for d in v['d104']]
    summary = {
        'benign_max_104': max(benign104),
        'edit_min_104': min(edit104),
        'separated_104': max(benign104) < min(edit104),
        'pdq_threshold_scaled_104': round(31 * TRUNC / 256, 1),
    }
    print(f"\nbenign max @104 = {summary['benign_max_104']}, "
          f"edit min @104 = {summary['edit_min_104']}, "
          f"separated = {summary['separated_104']}")

    with open(os.path.join(OUT, 'pdq_separation.json'), 'w') as f:
        json.dump({'per_op': per_op, 'summary': summary}, f, indent=2)
    print('saved results/pdq_separation.json')


if __name__ == '__main__':
    main()
