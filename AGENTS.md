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
- **Watermark payload v3 (PHOTOS since 1.2.0)**: captureId 128 (random UUID) |
  BCH(255,131) parity 124 | pad 4. Canonical `spikes/codec_v3.py`;
  ports `android/.../PayloadCodecV3.kt` (encode, matrix XOR) and
  `web/js/codec_v3.js` (decode), parity-tested against
  `spikes/results/v3_vectors.json` (regen: `spikes/export_v3_vectors.py`;
  JS test: `spikes/test_v3_js.mjs`).
- **VIDEO embeds the repetition format** (`spikes/codec.py` /
  `PayloadCodec.kt` / `web/js/codec.js`: 24-bit id + CRC8, 8 reps) with a
  RANDOM markId since 1.2.2 — real WhatsApp video flips ~20-25% of decoded
  bits systematically, beyond any 128-bit-in-256 code (theoretical ceiling
  ~48 bits); positional redundancy is what survives. The proof's `markId`
  (6-hex) binds the mark to the captureId; samples entries carry the same
  field. The verifier tries v3 (BCH) first, then the repetition format.
  Changing a layout desyncs every already-embedded file — never change one,
  add a version.
- Proof JSON v2 (app ≥ 1.2.0) carries `captureId` + `deviceId` (both UUIDs;
  videos add `markId`); v1 proofs carried a numeric `payload`. The verifier
  supports both.
- `web/samples.json` maps capture ids (32-hex, no dashes) to verified originals
  under `web/samples/` — the static stand-in for the future cloud registry.
  Exact-file verification does not need it.
- On-device graphs are exported by `spikes/export_frame_graphs.py`
  (parity-asserted); tiny ones live in `android/app/src/main/assets/`, the 90MB
  embedder in `web/models/` (downloaded by the app at setup). The browser
  detector (`web/models/detector.onnx`, int8) is exported by
  `spikes/export_detector.py`. `spikes/sim_screenshot.py` simulates the exact
  Android photo pipeline.
- Photo embed strength is ×1.2 (`PhotoWatermarker.STRENGTH`) — lowest strength
  that BCH-decodes across every simulated channel incl. the flat-sky
  screenshot+crop worst case (PSNR ≈45dB; sweep in
  `spikes/spike_strength_sweep.py`). Video stays ×1.0.
- The embedder key session runs on NNAPI with fp16 relaxation when the SoC
  supports it (CPU fallback logged as "NNAPI unavailable"); fp16 embed
  quality validated in `spikes/spike_fp16_embedder.py`.
- Web pages are plain static HTML/CSS/JS in `web/`. No framework, no backend —
  keep it that way. onnxruntime-web is vendored in `web/ort/`.
- **One design system**: `web/style.css` (single stylesheet, every page).
  Tokens on `:root` (dark) + a `prefers-color-scheme: light` override — never
  hardcode a color in a page. Monospace (`--mono`) marks machine-emitted text
  (labels, ids, numbers, badges), sans is for prose. Diagrams are HTML, never
  fixed-viewBox SVG: flow charts use `.flow` / `.fnode` / `.farrow` (`.branch`
  + `.lanes` for the two-route one), bit layouts use `.bits` / `.bitbar` with
  proportional `flex` values — all of them turn into vertical stacks under
  720px, so nothing scrolls sideways on a phone. Prose-only pages use
  `<main class="doc">`; the nav link of the current page carries
  `aria-current="page"`.
- **Single verification source**: all verdict logic lives in
  `web/js/verifycore.js` (+ codec js), used by BOTH `web/verify.html` and
  the node CLI `web/verify.mjs` (which downloads the site's own modules + wasm
  and uses ffmpeg only to decode pixels). Never fork verification logic into a
  second implementation.
- **CLI integrity pinning**: `verify.mjs` embeds SHA-256 hashes of every
  shared file it downloads. After ANY change to `web/js/*`, `web/ort/*` or
  `web/models/detector.onnx`, regenerate with `node web/verify.mjs --hashes`
  and update the SHARED map, or the published CLI fails closed.
- The browser caches the detector via the Cache API under the name
  `trustcam-model-v1` (in `web/verify.html`) — bump the name whenever
  `web/models/detector.onnx` changes or visitors keep the old model.
- **Aspect-restore rescue** (photos): when the direct scan fails, browser and
  CLI retry with the capture aspect restored by centered gray padding
  (`core.padPlans`, native-res pixels — the regular scan's downscale costs
  the remaining margin; BCH hits only). Measured: Instagram 4:5 crop of a
  3:4 capture (6% lost) decodes (corr 12-13/18); Instagram 1:1 (25% lost)
  is BEYOND the payload's limit (~22 coded errors vs t=18) — a real
  documented boundary, not a bug.
- Attestation: the verifier validates the FULL chain (leaf key match,
  cert-by-cert signatures incl. root self-signature, root pinned against
  Google's published attestation roots — `GOOGLE_ROOTS` sha256 list in
  verifycore.js, source https://android.googleapis.com/attestation/root).
  Certificate validity dates and the revocation list are NOT checked (offline
  verifier) — tracked as future work.
- Attestation extension: `parseKeyDescription` in verifycore.js reads the leaf's
  Android Key Attestation extension (verified-boot state, bootloader lock,
  attestationApplicationId) and `appIdentity` matches it against the pinned
  official app: `APP_PACKAGE` + `APP_CERT_SHA256` (SHA-256 of the APK signing
  cert, `apksigner verify --print-certs web/trustcam.apk`). A NEW release
  keystore means a new digest — update the pin or every new capture reports
  "mismatch". Extension values are authenticated by the chain: UIs flag them
  when the chain didn't verify to a Google root.

## Testing on devices

On-device test harness and multi-device runbook: `docs/06-device-test-runbook.md`.
