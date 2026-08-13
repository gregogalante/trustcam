# Phase 0 Spikes — Results

Date: 2026-08-12. Environment: macOS (Apple Silicon), conda env `videoseal`, torch 2.13 (MPS), ffmpeg 8.1.2. Model: VideoSeal v1.0 `y_256b_img` (256-bit payload, Y-channel).

Phase 0 goal: kill the project cheaply if either assumption fails. Neither did.

## Spike 2 — Watermark robustness vs social transcodes: PASS

**Question**: does a 256-bit watermark embedded at capture survive the re-encoding social platforms apply on upload? (If not, the recovery service — the core product — is impossible and the project changes shape.)

**Method** ([spike_robustness.py](../spikes/spike_robustness.py)): embed a random 256-bit message into the VideoSeal test video (1904×1080, 24fps, 256 frames) at CRF 18 (capture-like quality), then re-encode the watermarked file with ffmpeg ladders approximating platform pipelines, then extract and measure bit accuracy (predictions averaged across all frames).

**Results** ([results/robustness.json](../spikes/results/robustness.json)):

| Condition | Bit accuracy | Wrong bits /256 |
|---|---|---|
| Baseline (no transcode) | 100% | 0 |
| YouTube-like 1080p 8Mbps H.264 | 100% | 0 |
| TikTok-like 1080p 3Mbps H.264 | 100% | 0 |
| X-like 720p 2Mbps H.264 | 100% | 0 |
| WhatsApp-like 480p 1Mbps H.264 | 98.05% | 5 |
| H.265 CRF 28 | 99.22% | 2 |
| Crop 10% + rescale | 100% | 0 |
| Stress: 360p 500kbps | 94.92% | 13 |

- Imperceptibility: **PSNR 46.8 dB** watermarked vs source (>40 dB ≈ invisible).
- Worst case (13/256 wrong bits) is trivially correctable with BCH — e.g. BCH(255,131) corrects 18. Net: **full payload recovery in every tested condition**.
- Embedding throughput: 9.7 fps on Mac **CPU** including ffmpeg decode/encode I/O.

**Caveats**: ffmpeg ladders approximate but don't replicate platform pipelines (proprietary preprocessing, two-pass, per-title encoding). Single test clip, animation-style content. Real upload/download test is the next step.

## Spike 1 — Embedder exportability + latency: PASS

**Question**: can the watermark embedder run in real time on a phone at capture?

**Method** ([spike_export.py](../spikes/spike_export.py)): load the embedder, count params, benchmark at 256×256 (its native processing size) on CPU and MPS, export to ONNX as a proxy for TFLite/CoreML/ExecuTorch viability.

**Results** ([results/export.json](../spikes/results/export.json)):

| Metric | Value |
|---|---|
| Embedder params | 23.7M |
| Input | **Y channel only** (1×256×256) + 256-bit message |
| PyTorch CPU | 133.7 ms/frame |
| PyTorch MPS (Mac GPU) | **23.6 ms/frame** (≈42 fps) |
| ONNX export | **Clean, no op blockers** — 94.7MB fp32 (≈24MB after int8 quantization) |
| onnxruntime CPU | 59.9 ms/frame |

Why this is enough for 1080p30:
- Y-channel input fits camera YUV pipelines directly (no RGB conversion).
- VideoSeal embeds on a subset of frames and propagates the residual temporally → effective per-video-frame cost is a fraction of the per-inference cost.
- Phone NPUs (int8) are in the same class as Mac GPU fp32 for conv workloads.

**Caveats**: Mac numbers are a proxy — the on-phone benchmark (TFLite/ExecuTorch, real NPU delegate) is still open. Extractor (24M params) is server-side only, no mobile constraint.

## Real platform round-trip (in progress)

Actual upload → platform re-encode → download → extract ([extract_check.py](../spikes/extract_check.py)):

| Platform | Result | Notes |
|---|---|---|
| YouTube (unlisted, 1080p H.264) | **99.61%** — 1/256 wrong bits | 9.2MB → 4.7MB re-encode; DASH mp4 needs lossless remux before extraction (no `nb_frames`) |
| TikTok | pending | |
| WhatsApp (Desktop/HD path) | **100%** — 0/256 wrong bits | Light re-encode: kept 1904×1080 @ 7.2Mbps. Phone-to-phone "standard quality" (~480p) is harsher — covered by the simulated 480p/1M test (98%) |

The simulated-ladder numbers held up against a real platform pipeline.

## On-device tests (Moto G75 5G — Snapdragon 6 Gen 3/SM6475, Android 16)

Test harness: [seitest/](../seitest) — instrumented tests, results via logcat (tag SPIKE).

### SEI passthrough (point 3): PASS

`SeiMuxTest`: MediaCodec H.264 hardware encoder (`c2.qti.avc.encoder`), custom SEI NAL (type 6, payload type 5 user-data-unregistered) prepended to each of 60 access units, muxed with MediaMuxer. Pulled MP4 → `h264_mp4toannexb` → **60/60 SEI markers present, payload byte-identical**. The Axis/ONVIF-style per-GOP signature transport works on this OEM without a custom muxer. (Sample size: 1 OEM — repeat on Samsung/Xiaomi when available.)

### Embedder latency (point 2): NEEDS WORK — quantization/NPU required for mid-range

`OrtBenchTest`, ONNX Runtime 1.20, embedder fp32 (28.3 GFLOPs @ 256×256, measured by onnxsim):

| Backend | ms/inference |
|---|---|
| CPU 4 threads | 1044.6 |
| XNNPACK | 1042.2 |
| NNAPI | 2843.9 (falls back to CPU with overhead — no HTP mapping) |

Analysis: ~1s/inference fp32 on a mid-range CPU. With temporal propagation (1 inference per 16-frame chunk) 30fps needs ~1.9 inf/s → **~2× short on this phone at fp32**. Paths to close the gap, in order of expected payoff:
1. **int8/fp16 quantization + Qualcomm QNN EP (Hexagon NPU)** — typical 4–8× on this SoC class; the real fix.
2. TFLite GPU delegate (Adreno) — requires solving the Tile conversion blocker (msg-processor broadcast outside the graph; see convert_tflite notes).
3. Cheaper knobs: longer propagation window (chunk 32 → ~0.9 inf/s needed, borderline OK even fp32; robustness impact to test), async embedding with bounded lag, embed at 128×128 (4× cheaper; robustness impact to test).

Flagship SoCs (Snapdragon 8-class NPU) are expected to be comfortably real-time int8; mid-range needs the quantization work. This is an engineering gap, not a feasibility wall.

Conversion notes: direct litert-torch (torch.export) and onnx2tf both choke on the msg-processor Tile/broadcast (results/convert_tflite.log); ONNX Runtime Android sidesteps conversion entirely and runs the desktop-validated .onnx as-is.

## Reproduction

Scripts live in [spikes/](../spikes/) — setup (VideoSeal clone, conda env, checkpoints) and run commands are in [spikes/README.md](../spikes/README.md).
