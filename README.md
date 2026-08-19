# TrustCam

Verifiable capture with **zero infrastructure**: an Android camera app that seals
photos and videos at the moment of capture, and a fully static, client-side
verifier. There are no accounts and no servers — the proof travels inside the
file, and an invisible watermark in the pixels survives social-media re-encoding.

Feasibility research and experiment reports live in [docs/](docs/); spike scripts
in [spikes/](spikes/); the on-device test harness in [seitest/](seitest/).

## How it works

1. **Capture** (Android app): photo/video saved to the gallery. Every capture
   gets a random 128-bit capture id (UUID).
2. **Invisible mark**: the capture id is embedded into the pixels on the device
   (VideoSeal exported to ONNX) and survives platform re-encoding. Photos carry
   all 128 bits protected by BCH(255,131); video — a much noisier channel —
   carries a random 24-bit mark id in an 8× repetition format, bound to the
   capture id by the proof.
3. **Seal**: the file's SHA-256 is signed by an ECDSA P-256 key generated inside
   the phone's secure hardware (StrongBox/TEE, with Key Attestation), and the
   proof (capture id, device id, timestamps, public key, attestation chain,
   signature) is appended to the file as a trailer that is also a valid MP4
   `free` box.
4. **Verify** ([web/verify.html](web/verify.html), 100% client-side): trailer
   present → strip, hash, verify signature with WebCrypto and validate the
   attestation chain up to Google's pinned hardware roots → *Verified*. Trailer
   stripped by a platform → the watermark is extracted **in the browser**
   (fp16 ONNX detector, ~67MB, onnxruntime-web, cached after the first scan)
   and the recovered id looked up in [web/samples.json](web/samples.json) —
   the verified originals on file — for a side-by-side comparison with the
   original → *Origin traced*. Nothing is ever uploaded.

Live round-trips through WhatsApp, YouTube and Instagram — including the
honest failures — are on the [demos page](web/demos.html), copies downloadable.

## Components

```
web/       Static site (GitHub Pages): landing, client-side verifier, live
           demos, paper, verified originals (samples), ONNX models, APK
android/   Kotlin app: setup (no account), CameraX capture, on-device
           watermarking, hardware signing, proof trailer
docs/      Research findings, market analysis, experiment reports (dated
           research logs), device runbook
spikes/    Experiment scripts: robustness, ONNX exports, payload codecs
           (codec.py / codec_v3.py — canonical implementations)
seitest/   Android instrumented tests: SEI passthrough + embedder benchmark
examples/  Reference device record (the identity every proof carries)
```

## Site (GitHub Pages)

The site is fully static and deploys from `web/` via
[.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to
`main`. Custom domain: `trustcam.gregoriogalante.com` (CNAME in `web/`).

Local preview:

```bash
python3 -m http.server 8090 -d web
```

## Android app

- Release APK served by the site at `/trustcam.apk` (file: `web/trustcam.apk`).
- First launch: choose a display name — a hardware key is generated, the 90MB
  embedder model is downloaded once from the site, and the app shows the
  device record. From then on the app works fully offline.
- Rebuild: `cd android && gradle assembleRelease` — signing uses
  `android/keystore.properties` + `android/release.keystore` (local only,
  gitignored). Copy the APK to `web/trustcam.apk`.

## Proof trailer format

```
trailer   = [4B box size]["free"][proof JSON utf-8][4B json length]["TCPROOF1"]
canonical = file bytes without the trailer
H         = SHA-256(canonical)
sig       = ECDSA-P256(SHA-256(H))     // Android SHA256withECDSA over H
```

JPEG decoders ignore bytes after EOI; MP4 players ignore unknown `free` boxes.
Full details in the [architecture paper](web/paper/architecture.html).

## Known limits (by design — see the paper)

- Watermark recovery needs roughly half of the original image area to survive:
  Instagram's 1:1 crop of a portrait capture (25% lost) is beyond it, the
  standard 4:5 crop is not (the verifier restores the framing automatically).
- The browser scans photos and videos; the CLI ([web/verify.mjs](web/verify.mjs),
  served at `/verify.mjs`) runs the same site modules and wasm in node — one
  verification source, integrity-pinned, ffmpeg only for pixel decode.
- Capture time is device-claimed (RFC 3161 tokens are the tracked upgrade).
- Attestation certificate validity dates and the revocation list are not
  checked (offline verifier); the chain itself is fully validated.
- Video sealing runs at ~1s per key frame on mid-range phone CPUs (the app
  benchmarks NNAPI vs CPU per device and keeps the faster).
