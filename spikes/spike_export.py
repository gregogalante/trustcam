# Spike 1: exportability + latency of the VideoSeal embedder for mobile.
# 1. Counts params, benchmarks embedder at 256x256 on CPU and MPS.
# 2. Tries torch.onnx export (proxy for TFLite/ExecuTorch viability).
# Numbers on Mac are a proxy; phone NPU verdict needs a device test later.
import json
import os
import sys
import time

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))
import videoseal  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'results')


def bench(fn, warmup=3, iters=20):
    for _ in range(warmup):
        fn()
    t0 = time.time()
    for _ in range(iters):
        fn()
    return (time.time() - t0) / iters * 1000  # ms


def main():
    os.makedirs(OUT, exist_ok=True)
    model = videoseal.load('videoseal')
    model.eval()

    embedder = model.embedder
    n_params = sum(p.numel() for p in embedder.parameters())
    proc_size = model.img_size if hasattr(model, 'img_size') else 256
    print(f'embedder: {type(embedder).__name__}, {n_params / 1e6:.1f}M params, '
          f'processing size {proc_size}')

    # Embedder input: image (or Y channel) at 256x256 + 256-bit message
    chans = 1 if getattr(embedder, 'yuv', False) else 3
    img = torch.rand(1, chans, 256, 256)
    msg = torch.randint(0, 2, (1, 256)).float()

    results = {'embedder_params_M': round(n_params / 1e6, 1), 'yuv': chans == 1}

    with torch.no_grad():
        results['cpu_ms_per_frame'] = round(
            bench(lambda: embedder(img, msg)), 1)
    print(f"cpu: {results['cpu_ms_per_frame']} ms/frame")

    if torch.backends.mps.is_available():
        emb_mps = videoseal.load('videoseal').embedder.eval().to('mps')
        img_m, msg_m = img.to('mps'), msg.to('mps')

        def run_mps():
            with torch.no_grad():
                emb_mps(img_m, msg_m)
            torch.mps.synchronize()
        results['mps_ms_per_frame'] = round(bench(run_mps), 1)
        print(f"mps: {results['mps_ms_per_frame']} ms/frame")

    # ONNX export attempt (embedder only — extractor stays server-side)
    onnx_path = os.path.join(OUT, 'embedder.onnx')
    try:
        torch.onnx.export(
            embedder, (img, msg), onnx_path,
            input_names=['frame', 'message'], output_names=['residual'],
            opset_version=17, dynamo=False)
        size_mb = os.path.getsize(onnx_path) / 1e6
        results['onnx_export'] = {'ok': True, 'size_mb': round(size_mb, 1)}
        print(f'onnx export ok: {size_mb:.1f}MB')
        # Sanity: run through onnxruntime if available
        try:
            import onnxruntime as ort
            sess = ort.InferenceSession(onnx_path)
            t = bench(lambda: sess.run(None, {
                'frame': img.numpy(), 'message': msg.numpy()}))
            results['onnxruntime_cpu_ms'] = round(t, 1)
            print(f'onnxruntime cpu: {t:.1f} ms/frame')
        except ImportError:
            results['onnxruntime_cpu_ms'] = None
    except Exception as e:  # noqa: BLE001 — report any export blocker
        results['onnx_export'] = {'ok': False, 'error': str(e)[:500]}
        print(f'onnx export FAILED: {e}')

    with open(os.path.join(OUT, 'export.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print('saved results/export.json')


if __name__ == '__main__':
    main()
