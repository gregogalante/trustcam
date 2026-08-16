# spikes — phase 0 feasibility scripts

Experiment scripts behind the results in [docs/04-phase0-spikes.md](../docs/04-phase0-spikes.md). Reports and light artifacts (JSON results, logs, watermark payload) are versioned here; the heavy dependencies are not — restore them as follows before rerunning.

## One-time setup

```bash
# 1. VideoSeal clone (expected at spikes/videoseal)
git clone --depth 1 https://github.com/facebookresearch/videoseal.git videoseal

# 2. Conda env
conda create -n videoseal python=3.11 -y
conda activate videoseal
pip install torch torchvision torchaudio
pip install -r videoseal/requirements.txt
pip install -e videoseal --no-deps        # skips decord (no arm64 macOS wheel)
pip install requests onnx onnxruntime      # requests is an undeclared videoseal dep

# 3. Checkpoint auto-downloads (218MB) into ./ckpts on first videoseal.load()
```

`ffmpeg` must be on PATH.

## Scripts

All must run **from the videoseal clone root** (configs/checkpoints resolve relative to cwd):

```bash
cd videoseal
python ../spike_robustness.py                      # embed → simulated social transcodes → extract (~8 min)
python ../spike_export.py                          # latency bench + ONNX export (~3 min)
python ../export_frame_graphs.py                   # exports the 3 on-device embedder graphs + parity asserts
python ../export_detector.py                       # exports the browser detector (fp32 + int8) + parity asserts
python ../sim_device_pipeline.py <video>           # bit-faithful simulation of the Android video pipeline
python ../sim_screenshot.py [image]                # watermark survival across the social/screenshot chain
python ../extract_check.py <video> [...]           # verify a platform round-trip file against results/watermarked.txt
python ../convert_tflite.py                        # TFLite conversion attempt (known-blocked, kept as documentation)
```

`codec.py` in this folder is the **canonical** payload codec — `PayloadCodec.kt`
(app) and `web/js/codec.js` (browser) must stay bit-identical to it.

- `results/watermarked.txt` — the 256-bit payload embedded in `roundtrip/upload_me.mp4`; needed by `extract_check.py` for future platform round-trips (TikTok still pending).
- `roundtrip/upload_me.mp4` — watermarked reference video to upload to platforms.
- `results/device_tests.jsonl` — on-device results, one JSON per device (see [runbook](../docs/06-device-test-runbook.md)).

Conversion env (`aiedge` conda env with litert-torch/onnx2tf) is only needed to retry TFLite conversion — both tools currently fail on VideoSeal's msg-processor Tile op; ONNX Runtime is the working mobile path.
