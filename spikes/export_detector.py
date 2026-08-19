# Exports the VideoSeal detector to ONNX for the in-browser (WASM) verifier.
#
# Graph: image (1,3,H,W) float 0-1, dynamic H/W -> bilinear resize 256x256
# (plain, NOT antialiased: aten::_upsample_bilinear2d_aa is not exportable;
# the same swap was validated end-to-end for the embedder graphs) -> detector
# -> (1,257) logits: [0]=detection mask bit, [1:]=256 message bits.
#
# Also emits an fp16 copy (~2x smaller, fits GitHub's 100MB limit) — that is
# what the site ships. int8 dynamic quantization was shipped first and RETIRED:
# on real WhatsApp video it doubled the raw bit errors (74/256 vs 29/256 fp16)
# and broke mark recovery; fp16 tracks fp32 within a few bits everywhere.
# Parity is asserted against the torch reference on realistic degraded inputs.
#
# Run from the videoseal clone root:
#   python ../export_detector.py
import io
import os
import sys

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from PIL import Image

import videoseal

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
sys.path.insert(0, HERE)
import codec  # noqa: E402

PAYLOAD = (5 << 14) | 123

model = videoseal.load('videoseal')
model.eval()


class DetectorGraph(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.detector = m.detector
        self.size = m.img_size

    def forward(self, img):
        x = F.interpolate(img, size=(self.size, self.size), mode='bilinear', align_corners=False)
        return self.detector(x)  # (1, 257)


def export():
    g = DetectorGraph(model)
    dst = os.path.join(RESULTS, 'detector.onnx')
    torch.onnx.export(
        g, (torch.rand(1, 3, 480, 640),), dst,
        input_names=['image'], output_names=['preds'],
        dynamic_axes={'image': {2: 'h', 3: 'w'}},
        opset_version=17, dynamo=False)
    print(f'exported {dst} ({os.path.getsize(dst) / 1e6:.1f} MB)')

    import onnx
    from onnxconverter_common import float16
    dst16 = os.path.join(RESULTS, 'detector_fp16.onnx')
    m16 = float16.convert_float_to_float16(onnx.load(dst), keep_io_types=True)
    onnx.save(m16, dst16)
    print(f'fp16 {dst16} ({os.path.getsize(dst16) / 1e6:.1f} MB)')
    return dst, dst16


def embed(img):
    """Watermark like the app (photo path, strength 1.5)."""
    prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
    key = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
    apply_g = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))
    msg = codec.encode(PAYLOAD).numpy()
    rgb = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
    y_res = prep.run(None, {'y': y})[0]
    delta = key.run(None, {'y_res': y_res, 'message': msg})[0] * 1.5
    y_w = apply_g.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
    out = np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q)
    buf.seek(0)
    return Image.open(buf).convert('RGB')


def to_tensor(img):
    return np.asarray(img.convert('RGB')).astype(np.float32).transpose(2, 0, 1)[None] / 255.0


def decode_torch(img):
    t = torch.from_numpy(to_tensor(img))
    with torch.no_grad():
        preds = model.detect(t, is_video=False)['preds']
    return codec.decode(preds[0, 1:])


def decode_onnx(sess, img):
    preds = sess.run(None, {'image': to_tensor(img)})[0]
    return codec.decode(torch.from_numpy(preds[0, 1:]))


def main():
    fp32, fp16 = export()
    s32 = ort.InferenceSession(fp32)
    s8 = ort.InferenceSession(fp16)

    src = Image.open('assets/imgs/1.jpg').convert('RGB')
    wm = jpeg(embed(src), 95)
    ig = jpeg(wm.resize((1080, int(wm.height * 1080 / wm.width)), Image.LANCZOS), 60)
    crop = jpeg(ig.crop((int(ig.width * .03), int(ig.height * .04),
                         int(ig.width * .97), int(ig.height * .96))), 90)

    ok = True
    for name, img in [('clean wm', wm), ('IG re-encode', ig), ('screenshot crop', crop)]:
        pt, ct = decode_torch(img)
        p32, c32 = decode_onnx(s32, img)
        p8, c8 = decode_onnx(s8, img)
        line = f'{name:16s} torch={pt}/{ct:.3f}  fp32={p32}/{c32:.3f}  fp16={p8}/{c8:.3f}'
        print(line)
        ok &= (pt == p32 == p8 == PAYLOAD)
    assert ok, 'payload parity failed'
    print('PARITY OK: torch(antialias) == onnx fp32 == onnx fp16')


if __name__ == '__main__':
    main()
