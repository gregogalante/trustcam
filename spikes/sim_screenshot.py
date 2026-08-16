# Reproduces the "Instagram screenshot" failure chain on a photo watermarked
# exactly like PhotoWatermarker.kt (BT.601 luma -> ONNX graphs -> delta on RGB,
# JPEG q95), then measures extraction confidence after each cumulative stage:
# IG re-encode, screen render, screenshot, manual crop variants.
#
# Run from the videoseal clone root:
#   python ../sim_screenshot.py [image]
import io
import os
import sys

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

import videoseal

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
sys.path.insert(0, os.path.join(HERE, '..', 'watermark'))
import codec  # noqa: E402

PAYLOAD = (5 << 14) | 123

_model = videoseal.load('videoseal')
_model.eval()


def embed_like_app(img: Image.Image) -> Image.Image:
    """Bit-faithful PhotoWatermarker: Y-only pipeline, delta added to R,G,B."""
    prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
    key = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
    apply_g = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))
    msg = codec.encode(PAYLOAD).numpy()

    rgb = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
    y_res = prep.run(None, {'y': y})[0]
    delta = key.run(None, {'y_res': y_res, 'message': msg})[0]
    y_w = apply_g.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
    out = np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q)
    buf.seek(0)
    return Image.open(buf).convert('RGB')


def extract(img: Image.Image):
    t = torch.from_numpy(np.asarray(img.convert('RGB'))).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        preds = _model.detect(t, is_video=False)['preds']
    return codec.decode(preds[0, 1:])


def report(name, img):
    pid, conf = extract(img)
    ok = 'HIT ' if pid == PAYLOAD else ('MISS' if pid is None else 'WRONG')
    print(f'{ok} conf={conf:.3f} payload={pid}  {name}  ({img.width}x{img.height})')
    return pid == PAYLOAD, conf


def crop_frac(img, top, bottom, left, right):
    w, h = img.size
    return img.crop((int(w * left), int(h * top), int(w * (1 - right)), int(h * (1 - bottom))))


def tta_extract(img):
    """Extraction-side rescue: try a small grid of border crops, keep best CRC-valid."""
    best = (None, 0.0, 'none')
    for f in (0.0, 0.02, 0.05, 0.08, 0.12):
        for mode in ('sym',):
            cand = crop_frac(img, f, f, f, f) if f else img
            pid, conf = extract(cand)
            if pid == PAYLOAD and conf > best[1]:
                best = (pid, conf, f'crop{f}')
    return best


def main(path):
    src = Image.open(path).convert('RGB')
    print(f'source: {path} {src.size}')

    wm = jpeg(embed_like_app(src), 95)  # what lands in the gallery
    report('A. gallery original (wm, jpeg95)', wm)

    # B. Instagram: fit to 1080 wide, hard re-encode
    w0 = 1080 if wm.width >= 1080 else wm.width
    ig = jpeg(wm.resize((w0, int(wm.height * w0 / wm.width)), Image.LANCZOS), 65)
    report('B. + IG re-encode (1080w, q65)', ig)

    # C. screen render + screenshot: slight resample (display fit), PNG-like lossless
    scr = ig.resize((int(ig.width * 0.96), int(ig.height * 0.96)), Image.BILINEAR)
    report('C. + screen render 0.96x (screenshot)', scr)

    # D. manual crop, slightly inside the photo (cuts 3-4% of content)
    d = crop_frac(scr, 0.04, 0.03, 0.03, 0.04)
    okD, _ = report('D. + manual crop (3-4% content lost)', d)

    # D2. crop then saved as jpeg by the gallery editor
    d2 = jpeg(d, 90)
    report('D2. + gallery editor jpeg90', d2)

    # E. sloppy crop: UI bars left in (5% white top/bottom)
    w, h = scr.size
    canvas = Image.new('RGB', (w, int(h * 1.10)), (250, 250, 250))
    canvas.paste(scr, (0, int(h * 0.05)))
    report('E. crop with UI bars left in (5% top+bottom)', jpeg(canvas, 90))

    # F. IG 4:5 aspect center-crop applied at upload, then C+D
    if ig.height / ig.width > 1.25:
        f_img = crop_frac(ig, (1 - 1.25 * ig.width / ig.height) / 2,
                          (1 - 1.25 * ig.width / ig.height) / 2, 0, 0)
        f_img = crop_frac(f_img.resize((int(f_img.width * 0.96), int(f_img.height * 0.96)),
                                       Image.BILINEAR), 0.04, 0.03, 0.03, 0.04)
        report('F. IG 4:5 crop + screenshot + manual crop', jpeg(f_img, 90))

    # rescue attempt on the worst realistic case
    pid, conf, how = tta_extract(d2)
    print(f'TTA rescue on D2: payload={pid} conf={conf:.3f} via {how}')


def main2(path):
    """Realistic G75 scenario: 4080px source, sweep display sizes + compression."""
    src = Image.open(path).convert('RGB')
    big = src.resize((4080, int(src.height * 4080 / src.width)), Image.LANCZOS)
    wm = jpeg(embed_like_app(big), 95)
    report('G. gallery original 4080px', wm)
    ig = jpeg(wm.resize((1080, int(wm.height * 1080 / wm.width)), Image.LANCZOS), 60)
    report('H. + IG 1080w q60 (3.8x downscale)', ig)
    for disp_w in (1080, 860, 720, 540):
        scr = ig.resize((disp_w, int(ig.height * disp_w / ig.width)), Image.BILINEAR)
        cropped = jpeg(crop_frac(scr, 0.04, 0.03, 0.03, 0.04), 90)
        ok, _ = report(f'I. + displayed at {disp_w}px, crop, jpeg90', cropped)
        if not ok:
            pid, conf, how = tta_extract(cropped)
            print(f'   TTA rescue: payload={pid} conf={conf:.3f} via {how}')


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'assets/imgs/1.jpg'
    (main2 if 'big' in sys.argv[2:] else main)(path)
