# Validates that an fp16 embedder (what NNAPI's fp16 relaxation computes)
# produces marks as recoverable as the fp32 one. Embeds the same payload with
# both, then decodes with the shipped fp16 detector across photo channels and
# a WhatsApp-class video transcode. Also reports the delta between the two
# watermarked outputs (visibility proxy).
#   cd spikes/videoseal && python ../spike_fp16_embedder.py [video]
import io
import os
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, os.getcwd())

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
sys.path.insert(0, HERE)
import codec  # noqa: E402
import codec_v3  # noqa: E402

# fp16 copy of the key graph (io kept fp32, like NNAPI relaxation)
FP16 = os.path.join(RESULTS, 'embedder_key_fp16.onnx')
if not os.path.exists(FP16):
    m16 = float16.convert_float_to_float16(
        onnx.load(os.path.join(RESULTS, 'embedder_key.onnx')), keep_io_types=True)
    # the converter leaves the msg_processor Cast at to=FLOAT while its
    # consumers become fp16 — flip it (boundary I/O casts keep to=FLOAT)
    from onnx import TensorProto
    for node in m16.graph.node:
        if node.op_type == 'Cast' and 'msg_processor' in node.name:
            for a in node.attribute:
                if a.name == 'to' and a.i == TensorProto.FLOAT:
                    a.i = TensorProto.FLOAT16
    onnx.save(m16, FP16)

_prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
_key32 = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
_key16 = ort.InferenceSession(FP16)
_apply = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))
_det = ort.InferenceSession('/Users/galante/trustcam/web/models/detector.onnx')

CAPTURE = uuid.uuid4()
MSG_PHOTO = codec_v3.encode(CAPTURE.bytes).numpy()
MARK_ID = 0x2636A4
MSG_VIDEO = codec.encode(MARK_ID).numpy()


def embed(rgb, key, msg, strength):
    y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
    y_res = _prep.run(None, {'y': y})[0]
    delta = key.run(None, {'y_res': y_res, 'message': msg})[0] * strength
    y_w = _apply.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
    return np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)


def detect(rgb):
    import torch
    t = rgb.transpose(2, 0, 1)[None].astype(np.float32)
    preds = _det.run(None, {'image': t})[0][0, 1:]
    return torch.from_numpy(preds)


def jpeg(rgb, q):
    img = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q)
    buf.seek(0)
    return np.asarray(Image.open(buf).convert('RGB')).astype(np.float32) / 255


def resize_max(rgb, max_dim):
    img = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8))
    s = max_dim / max(img.size)
    if s < 1:
        img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    return np.asarray(img).astype(np.float32) / 255


def photo_report(name, key):
    src = np.asarray(Image.open('assets/imgs/1.jpg').convert('RGB')).astype(np.float32) / 255
    wm = embed(src, key, MSG_PHOTO, 1.2)
    exp = (codec_v3.encode(CAPTURE.bytes)[0, :codec_v3.CODED_BITS] > 0.5).long()
    for ch, img in [('jpeg95', jpeg(wm, 95)),
                    ('whatsapp', jpeg(resize_max(jpeg(wm, 95), 1600), 75))]:
        sb = detect(img)
        errors = int(((sb[:codec_v3.CODED_BITS] > 0).long() != exp).sum())
        cid, _ = codec_v3.decode(sb)
        ok = cid == CAPTURE.bytes
        print(f'photo {name} {ch:9s}: errors {errors:3d}/252 decode={"OK" if ok else "FAIL"}')
    return wm


def video_report(name, key, path, n=48):
    # consecutive frames, STEP=4 propagation, WhatsApp-class transcode
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=width,height:stream_side_data=rotation',
                            '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    vals = [v for v in probe.replace('\n', ',').split(',') if v.strip('-').lstrip('-').isdigit()]
    w, h = int(vals[0]), int(vals[1])
    if len(vals) > 2 and int(vals[2]) % 180 != 0:
        w, h = h, w
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-frames:v', str(n),
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                         capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8)
    frames = frames[:len(frames) // (w * h * 3) * w * h * 3].reshape(-1, h, w, 3).astype(np.float32) / 255
    out = np.empty_like(frames)
    delta = None
    y_last = None
    for i, rgb in enumerate(frames):
        y = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])[None, None]
        if i % 4 == 0:
            y_res = _prep.run(None, {'y': y})[0]
            delta = key.run(None, {'y_res': y_res, 'message': MSG_VIDEO})[0]
        y_w = _apply.run(None, {'y': y, 'delta_raw': delta})[0][0, 0]
        out[i] = np.clip(rgb + (y_w - y[0, 0])[..., None], 0.0, 1.0)
        y_last = y
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'in.mp4')
        dst = os.path.join(td, 'wa.mp4')
        enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                                '-s', f'{w}x{h}', '-r', '30', '-i', 'pipe:0',
                                '-c:v', 'libx264', '-b:v', '14M', '-pix_fmt', 'yuv420p', src],
                               stdin=subprocess.PIPE)
        enc.stdin.write((out * 255 + 0.5).astype(np.uint8).tobytes())
        enc.stdin.close()
        enc.wait()
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', 'scale=478:850',
                        '-c:v', 'libx264', '-b:v', '1700k', '-pix_fmt', 'yuv420p', dst], check=True)
        raw2 = subprocess.run(['ffmpeg', '-v', 'error', '-i', dst, '-f', 'rawvideo',
                               '-pix_fmt', 'rgb24', 'pipe:1'], capture_output=True).stdout
    m = len(raw2) // (478 * 850 * 3)
    wa = np.frombuffer(raw2, np.uint8)[:m * 478 * 850 * 3].reshape(m, 850, 478, 3).astype(np.float32) / 255
    import torch
    acc = torch.zeros(256)
    idx = [int((i + 0.5) * m / 24) for i in range(24)]
    for i in idx:
        acc += detect(wa[i])
    avg = acc / len(idx)
    exp = (codec.encode(MARK_ID)[0] > 0.5).long()
    errors = int(((avg > 0).long() != exp).sum())
    pid, conf = codec.decode(avg)
    print(f'video {name}: whatsapp errors {errors:3d}/256 decode={"OK" if pid == MARK_ID else "FAIL"} conf={conf:.3f}')


def main():
    wm32 = photo_report('fp32', _key32)
    wm16 = photo_report('fp16', _key16)
    d = np.abs(wm32 - wm16) * 255
    print(f'photo fp32-vs-fp16 output delta: max {d.max():.2f}/255, mean {d.mean():.4f}')
    video = sys.argv[1] if len(sys.argv) > 1 else '/Users/galante/trustcam/web/samples/tc_f0dba886.mp4'
    video_report('fp32', _key32, video)
    video_report('fp16', _key16, video)


if __name__ == '__main__':
    main()
