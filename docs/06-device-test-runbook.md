# Device Test Runbook

Self-contained instructions to run the phase-0 on-device tests on a **new Android device** and report results. Written so an AI agent (or human) can execute it without any other context from this project.

## What these tests measure

1. **SEI passthrough** (`SeiMuxTest`): whether this device's MediaCodec hardware H.264 encoder + MediaMuxer preserve custom SEI NAL units (type 6, payload type 5 user-data-unregistered) prepended to each encoded access unit. This validates the per-GOP signature transport (ONVIF Media Signing style) on the device's OEM stack.
2. **Embedder latency** (`OrtBenchTest`): VideoSeal watermark embedder (28.3 GFLOPs fp32, ONNX) inference time via ONNX Runtime on CPU / XNNPACK / NNAPI.

## Prerequisites

- macOS/Linux host with `adb` and `ffmpeg` on PATH, plus `python3`.
- Java 17 and Android SDK (for building; skip if prebuilt APKs are available in `seitest/app/build/outputs/apk/`).
- Android device, API 28+, USB debugging enabled and authorized (`adb devices` shows `device`, not `unauthorized`).
- This repo checked out; all paths below relative to the repo root (`trustcam/`); the harness is in `seitest/`.
- For the benchmark test only: regenerate `seitest/app/src/androidTest/assets/embedder.onnx` (not in git) — see `seitest/README.md`.

## Step 1 — Record device identity

```bash
adb shell getprop ro.product.manufacturer ro.product.model ro.soc.model ro.build.version.release
```

## Step 2 — Build (skip if APKs already present)

```bash
export ANDROID_HOME=~/Library/Android/sdk   # adjust to host
cd seitest
gradle assembleDebug assembleDebugAndroidTest   # any gradle >= 8.9; wrapper dist 8.14.3 known-good
```

Outputs: `app/build/outputs/apk/debug/app-debug.apk` and `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` (~165MB, contains the ONNX model).

## Step 3 — Install and run

```bash
adb install -r seitest/app/build/outputs/apk/debug/app-debug.apk
adb install -r seitest/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb logcat -c

# Test 1: SEI passthrough (~10s)
adb shell am instrument -w -e class dev.spike.seitest.SeiMuxTest dev.spike.seitest.test/androidx.test.runner.AndroidJUnitRunner

# Test 2: latency benchmark (~3 min; device should be idle, screen on, not thermally throttled)
adb shell am instrument -w -e class dev.spike.seitest.OrtBenchTest dev.spike.seitest.test/androidx.test.runner.AndroidJUnitRunner

adb logcat -d -s SPIKE
```

Expected logcat lines: `encoder: <name>`, `SEI_MUX_RESULT ... seiWritten=60 ...`, three `ORT_BENCH <backend> avg_ms=...` (a backend may log `FAILED: <reason>` — that is a valid result, record it).

## Step 4 — Verify SEI actually survived (host side)

The in-device assertion only checks the muxer accepted the samples. The real check is scanning the produced MP4:

```bash
adb pull /storage/emulated/0/Android/data/dev.spike.seitest/files/sei_test.mp4 .
ffmpeg -y -v error -i sei_test.mp4 -c:v copy -bsf:v h264_mp4toannexb -f h264 sei_test.h264
python3 -c "
data = open('sei_test.h264','rb').read()
print('SEI found:', data.count(b'SPIKESEIUUID0001'), '/ 60 expected')"
```

**PASS** = 60/60. Partial counts or 0 = the OEM stack strips/rewrites SEI → record as FAIL with the count.

## Step 5 — Clean up and report

```bash
adb uninstall dev.spike.seitest.test
adb uninstall dev.spike.seitest
```

Append one row to the results table in [04-phase0-spikes.md](04-phase0-spikes.md) (section "On-device tests") and one JSON block to `spikes/results/device_tests.jsonl`:

```json
{"date": "YYYY-MM-DD", "manufacturer": "", "model": "", "soc": "", "android": "",
 "encoder": "", "sei_pass": true, "sei_count": 60,
 "ort_cpu4_ms": 0, "ort_xnnpack_ms": 0, "ort_nnapi_ms": 0, "notes": ""}
```

## Known issues / troubleshooting

- `libonnxruntime4j_jni.so not found` → onnxruntime dependency must be `implementation` (app APK), not `androidTestImplementation`; instrumented tests run in the app process.
- `INSTALL_FAILED_INSUFFICIENT_STORAGE` → the test APK is ~165MB; free space first.
- NNAPI slower than CPU is a common valid result (deprecated API, falls back to CPU with overhead). Record it, don't retry.
- Benchmark variance: if the device is hot, numbers inflate; rerun after cool-down and keep the better run.
- MediaMuxer rejecting the first sample (`writeSampleData` throws) would indicate this OEM needs the fallback fMP4 muxer — record as FAIL with the exception message.

## Baseline results

| Date | Device | SoC | Encoder | SEI | cpu4 ms | xnnpack ms | nnapi ms |
|---|---|---|---|---|---|---|---|
| 2026-08-12 | Motorola Moto G75 5G | SM6475 | c2.qti.avc.encoder | 60/60 PASS | 1044.6 | 1042.2 | 2843.9 |
