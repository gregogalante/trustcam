# spikes — feasibility and validation scripts

Experiment scripts behind the results in [docs/](../docs/) and the paper's
research page. Reports and light artifacts (JSON results) are versioned here;
the heavy dependencies are not — restore them as follows before rerunning.

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
pip install requests onnx onnxruntime onnxconverter-common bchlib
```

`ffmpeg` must be on PATH.

## Scripts

All must run **from the videoseal clone root** (configs/checkpoints resolve relative to cwd):

```bash
cd videoseal
python ../spike_robustness.py                # embed → simulated social transcodes → extract
python ../spike_export.py                    # latency bench + ONNX export
python ../export_frame_graphs.py             # exports the 3 on-device embedder graphs + parity asserts
python ../export_detector.py                 # exports the browser detector (fp32 + fp16) + parity asserts
python ../sim_screenshot.py [image]          # watermark survival across the social/screenshot chain
python ../spike_strength_sweep.py            # photo embed strength: visibility vs recovery
python ../spike_video_strength.py <video>    # video embed strength x delta-refresh through WhatsApp-sim
python ../spike_fp16_embedder.py             # fp16 embedder quality vs fp32 (NNAPI relaxation proxy)
python ../export_v3_vectors.py               # parity vectors for the v3 payload codec (run from spikes/)
node   ../test_v3_js.mjs                     # web/js/codec_v3.js against the vectors (run from spikes/)
python ../convert_tflite.py                  # TFLite conversion attempt (known-blocked, kept as documentation)
```

Canonical payload codecs live in this folder — the ports must stay
bit-identical to them:

- `codec.py` (repetition format: video, and legacy captures) ↔
  `PayloadCodec.kt` (app), `web/js/codec.js` (browser)
- `codec_v3.py` (128-bit capture id + BCH: photos) ↔
  `PayloadCodecV3.kt` (app), `web/js/codec_v3.js` (browser),
  pinned by `results/v3_vectors.json`

`codec_v2.py`, `pdq_ref.py` and the `spike_pdq_*`/`spike_bch_*`/
`spike_video_segments.py` scripts are the research record behind the explored
(not shipped) content-checksum design — see
[docs/07](../docs/07-watermark-content-checksum.md).

- `results/device_tests.jsonl` — on-device results, one JSON per device (see [runbook](../docs/06-device-test-runbook.md)).
