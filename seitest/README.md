# seitest — on-device test harness

Instrumented tests measuring, on a real Android device:

1. **SeiMuxTest** — custom SEI NAL survival through MediaCodec HW encoder + MediaMuxer (per-GOP signature transport validation).
2. **OrtBenchTest** — VideoSeal embedder (ONNX, fp32) latency on CPU / XNNPACK / NNAPI.

**Full run instructions for a new device: [../docs/06-device-test-runbook.md](../docs/06-device-test-runbook.md).** Results go in the table there + `../spikes/results/device_tests.jsonl`.

No app UI — everything runs via `am instrument`, results in logcat (tag `SPIKE`).

**Before building**: the model asset `app/src/androidTest/assets/embedder.onnx` (90MB) is not in git. Regenerate it with [../spikes/spike_export.py](../spikes/spike_export.py) (writes `spikes/results/embedder.onnx`, setup in [../spikes/README.md](../spikes/README.md)) and copy it there. `SeiMuxTest` builds and runs without it; only `OrtBenchTest` needs it.
