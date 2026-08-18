# Agent Instructions

Zero-infrastructure monorepo: static site (GitHub Pages) + Android app. The proof
travels inside the captured file; verification is fully client-side. Overview and
run commands in README.md. Research docs in `docs/`, spike scripts in `spikes/`.

## Environment

- Android: SDK at `~/Library/Android/sdk`, gradle from wrapper dist
  `~/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3/bin/gradle`,
  `export ANDROID_HOME JAVA_HOME` ("/Applications/Android Studio.app/Contents/jbr/Contents/Home") before building.
- Python spikes: conda env `videoseal`, run from `spikes/videoseal/` clone root
  (VideoSeal resolves configs/ckpts relative to cwd). See `spikes/README.md`.
- JS code follows JavaScript Standard Style (no semicolons, single quotes, 2-space indent).

## Commands

```bash
python3 -m http.server 8090 -d web           # serve the static site locally
cd android && gradle assembleRelease        # build APK (signing: android/keystore.properties, local only)
cd spikes/videoseal && python ../export_detector.py   # re-export detector + parity
```

## Conventions / invariants

- **Proof trailer** (app ⇄ verifier contract, do not change unilaterally):
  `[4B box size]["free"][proof JSON][4B json length]["TCPROOF1"]` appended to the
  file; canonical bytes = file minus trailer; `sig = ECDSA-P256(SHA256(H))` where
  `H` = 32 raw bytes of the canonical SHA-256. App side:
  `Signature("SHA256withECDSA").update(H)` in `android/.../DeviceKey.kt` +
  `ProofTrailer.kt`. Verifier side: WebCrypto in `web/verify.html`
  (DER→P1363 signature conversion required).
- **Watermark payload codec** exists in THREE implementations that must stay
  bit-identical: `spikes/codec.py` (canonical), `android/.../PayloadCodec.kt`
  (unit-tested against python vectors), `web/js/codec.js`. 24-bit payload
  (`deviceId<<14 | counter`) + CRC8, 8 reps, copies 32 apart. Changing the layout
  desyncs every already-embedded file — never change it without versioning.
- **Payload v2 (photos since 1.1.0)**: proofId 24 | PDQ pHash 104 | BCH(255,131)
  parity 124 | pad 4. Canonical `spikes/codec_v2.py` + `spikes/pdq_ref.py`;
  ports `android/.../PayloadCodecV2.kt` + `Pdq.kt` (encode) and
  `web/js/codec_v2.js` + `web/js/pdq.js` (decode), parity-tested against
  `spikes/results/checksum_vectors.json` (regen: `spikes/export_checksum_vectors.py`).
  Verifier tries v2 (BCH) first, falls back to v1 (CRC8). Video still embeds v1.
  Same versioning rule: never change layouts, add a v3.
- Device ids are random 10-bit values chosen at app setup; `web/registry.json`
  maps them to names/keys (enrollment = pull request). Exact-file verification
  does not need the registry.
- On-device graphs are exported by `spikes/export_frame_graphs.py`
  (parity-asserted); tiny ones live in `android/app/src/main/assets/`, the 90MB
  embedder in `web/models/` (downloaded by the app at setup). The browser
  detector (`web/models/detector.onnx`, int8) is exported by
  `spikes/export_detector.py`. `spikes/sim_device_pipeline.py` and
  `spikes/sim_screenshot.py` simulate the exact Android pipelines.
- Photo embed strength is ×1.5 (`PhotoWatermarker.STRENGTH`) — measured PSNR
  43.7dB, survives ~40% content loss. Video stays ×1.0.
- Web pages are plain static HTML/CSS/JS in `web/`. No framework, no backend —
  keep it that way. onnxruntime-web is vendored in `web/ort/`.
- **Single verification source**: all verdict logic lives in
  `web/js/verifycore.js` (+ codec/pdq js), used by BOTH `web/verify.html` and
  the node CLI `web/verify.mjs` (which downloads the site's own modules + wasm
  and uses ffmpeg only to decode pixels). Never fork verification logic into a
  second implementation.
- Attestation: the verifier checks the leaf cert certifies the signing key.
  Full chain validation to Google hardware attestation roots is a tracked TODO.

## Testing on devices

On-device test harness and multi-device runbook: `docs/06-device-test-runbook.md`.
