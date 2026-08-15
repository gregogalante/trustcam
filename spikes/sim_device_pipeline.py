# Simulates the Android on-device watermarking pipeline bit-for-bit:
# yuv420p frames (limited range, like MediaCodec), Y-plane-only processing
# through the three exported ONNX graphs, temporal propagation every 4 frames,
# re-encode, then payload extraction through the server-side service.
#
# Run from the videoseal clone root (service must be up on :8000):
#   python ../sim_device_pipeline.py <input.mp4>
import json
import os
import subprocess
import sys

import numpy as np
import onnxruntime as ort

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')

STEP = 4
PAYLOAD = (5 << 14) | 123  # device 5, counter 123


def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height,avg_frame_rate:stream_side_data=rotation',
         '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    w, h = int(s['width']), int(s['height'])
    rot = 0
    for sd in s.get('side_data_list', []):
        rot = int(sd.get('rotation', rot))
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, den = s['avg_frame_rate'].split('/')
    return w, h, float(num) / float(den)


def main(src, dst):
    # message from the payload codec (canonical source: watermark/codec.py)
    sys.path.insert(0, os.path.join(os.path.dirname(RESULTS), '..', 'watermark'))
    import codec
    msg = codec.encode(PAYLOAD).numpy()

    prep = ort.InferenceSession(os.path.join(RESULTS, 'frame_prep.onnx'))
    key = ort.InferenceSession(os.path.join(RESULTS, 'embedder_key.onnx'))
    apply_g = ort.InferenceSession(os.path.join(RESULTS, 'frame_apply.onnx'))

    w, h, fps = probe(src)
    ysz, csz = w * h, (w // 2) * (h // 2)
    fsz = ysz + 2 * csz

    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:'],
        stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y',
         '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:',
         '-i', src, '-map', '0:v', '-map', '1:a?', '-c:a', 'copy',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', dst],
        stdin=subprocess.PIPE)

    delta = None
    n = 0
    while True:
        raw = dec.stdout.read(fsz)
        if len(raw) < fsz:
            break
        buf = np.frombuffer(raw, np.uint8)
        y = buf[:ysz].reshape(h, w).astype(np.float32) / 255.0
        # limited (16-235) -> full range, exactly as the app will do
        y_full = np.clip((y * 255.0 - 16.0) / 219.0, 0.0, 1.0)[None, None]

        if n % STEP == 0:
            y_res = prep.run(None, {'y': y_full})[0]
            delta = key.run(None, {'y_res': y_res, 'message': msg})[0]
        y_w = apply_g.run(None, {'y': y_full, 'delta_raw': delta})[0][0, 0]

        # full -> limited, back into the untouched UV planes
        y_out = np.clip(y_w * 219.0 + 16.0, 0.0, 255.0).astype(np.uint8)
        enc.stdin.write(y_out.tobytes())
        enc.stdin.write(buf[ysz:].tobytes())
        n += 1

    dec.stdout.close()
    enc.stdin.close()
    dec.wait()
    assert enc.wait() == 0, 'encode failed'
    print(f'{n} frames watermarked -> {dst}')


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'assets/videos/1.mp4'
    main(src, '/tmp/sim_device_wm.mp4')
    print(f'expected payload: {PAYLOAD}')
