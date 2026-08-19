# Photo embed STRENGTH sweep: visibility (PSNR + max local delta) vs
# robustness (coded-bit errors + BCH v3 decode) across realistic channels.
# Goal: pick the lowest strength that still decodes everywhere the current
# 1.5x does. Embed pipeline is bit-faithful to PhotoWatermarker.kt (Y-only
# delta scaled by STRENGTH before the JND apply graph).
#
# Run from the videoseal clone root:
#   python ../spike_strength_sweep.py
import io
import json
import os
import sys
import uuid

# script lives in spikes/ which shadows the videoseal package with the clone
# dir — make the clone root (cwd) win the import
sys.path.insert(0, os.getcwd())

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

import videoseal

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
sys.path.insert(0, HERE)
import codec_v3  # noqa: E402

STRENGTHS = [1.0, 1.1, 1.2, 1.3, 1.5]
CAPTURE_ID = uuid.uuid4().bytes

_model = videoseal.load('videoseal')
_model.eval()

_prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
_key = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
_apply = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))
_msg = codec_v3.encode(CAPTURE_ID).numpy()
_coded = (codec_v3.encode(CAPTURE_ID)[0, :codec_v3.CODED_BITS] > 0.5).long()


def embed(img: Image.Image, strength: float) -> Image.Image:
    rgb = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
    y_res = _prep.run(None, {'y': y})[0]
    delta = _key.run(None, {'y_res': y_res, 'message': _msg})[0] * strength
    y_w = _apply.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
    out = np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q)
    buf.seek(0)
    return Image.open(buf).convert('RGB')


def resize_max(img, max_dim, resample=Image.LANCZOS):
    scale = max_dim / max(img.size)
    if scale >= 1:
        return img
    return img.resize((round(img.width * scale), round(img.height * scale)), resample)


def crop_frac(img, top, bottom, left, right):
    w, h = img.size
    return img.crop((int(w * left), int(h * top), int(w * (1 - right)), int(h * (1 - bottom))))


def soft_bits(img):
    t = torch.from_numpy(np.asarray(img.convert('RGB'))).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        preds = _model.detect(t, is_video=False)['preds']
    return preds[0, 1:]


def check(img):
    sb = soft_bits(img)
    errors = int(((sb[:codec_v3.CODED_BITS] > 0).long() != _coded).sum())
    cid, nflips = codec_v3.decode(sb)
    return errors, cid == CAPTURE_ID


def psnr(a: Image.Image, b: Image.Image):
    x = np.asarray(a).astype(np.float64)
    y = np.asarray(b).astype(np.float64)
    mse = ((x - y) ** 2).mean()
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)


# channels: name -> transform(gallery jpeg95 image)
def ch_whatsapp(img):
    return jpeg(resize_max(img, 1600), 75)


def ch_whatsapp2(img):
    return jpeg(resize_max(ch_whatsapp(img), 1600), 75)


def ch_instagram(img):
    w = min(1080, img.width)
    return jpeg(img.resize((w, round(img.height * w / img.width)), Image.LANCZOS), 65)


def ch_screenshot_crop(img):
    ig = ch_instagram(img)
    scr = ig.resize((int(ig.width * 0.96), int(ig.height * 0.96)), Image.BILINEAR)
    return jpeg(crop_frac(scr, 0.04, 0.03, 0.03, 0.04), 90)


CHANNELS = {
    'gallery_q95': lambda img: img,
    'whatsapp': ch_whatsapp,
    'whatsapp_x2': ch_whatsapp2,
    'instagram': ch_instagram,
    'screenshot_crop': ch_screenshot_crop,
}


def test_images():
    imgs = {'photo': Image.open('assets/imgs/1.jpg').convert('RGB')}
    # phone-resolution variant: the G75 saves ~4080px wide
    imgs['photo_4080'] = imgs['photo'].resize(
        (4080, round(imgs['photo'].height * 4080 / imgs['photo'].width)), Image.LANCZOS)
    # flat sky gradient: worst case for low-frequency watermark visibility
    h, w = 1536, 2048
    yy = np.linspace(0, 1, h)[:, None]
    sky = np.zeros((h, w, 3), np.float32)
    sky[..., 0] = 120 + 60 * yy
    sky[..., 1] = 170 + 40 * yy
    sky[..., 2] = 235 - 15 * yy
    rng = np.random.default_rng(7)
    sky += rng.normal(0, 1.2, sky.shape)  # sensor-noise floor, avoids banding
    imgs['flat_sky'] = Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8))
    return imgs


def main():
    out = {'captureId': CAPTURE_ID.hex(), 'strengths': {}}
    imgs = test_images()
    for s in STRENGTHS:
        row = {}
        print(f'--- strength {s} ---')
        for name, src in imgs.items():
            wm = jpeg(embed(src, s), 95)
            p = psnr(src, wm)
            # max local luma shift: what the eye actually notices in flat areas
            dmax = float(np.abs(np.asarray(wm).astype(np.int16)
                                - np.asarray(jpeg(src, 95)).astype(np.int16)).max())
            row[name] = {'psnr': round(p, 2), 'maxDelta': dmax, 'channels': {}}
            for ch, fn in CHANNELS.items():
                errors, ok = check(fn(wm))
                row[name]['channels'][ch] = {'codedErrors': errors, 'decoded': ok}
                print(f'{name:12s} {ch:16s} err={errors:3d} decode={"OK" if ok else "FAIL"}'
                      f'  psnr={p:.1f} maxD={dmax:.0f}')
        out['strengths'][str(s)] = row
    with open(os.path.join(RESULTS, 'strength_sweep.json'), 'w') as f:
        json.dump(out, f, indent=1)
    print('saved results/strength_sweep.json')


if __name__ == '__main__':
    main()
