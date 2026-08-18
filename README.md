# TrustCam

Verifiable capture with **zero infrastructure**: an Android camera app that seals
photos and videos at the moment of capture, and a fully static, client-side
verifier. There are no accounts and no servers — the proof travels inside the
file, and an invisible watermark in the pixels survives social-media re-encoding.

Feasibility research and experiment reports live in [docs/](docs/); spike scripts
in [spikes/](spikes/); the on-device test harness in [seitest/](seitest/).

## How it works

1. **Capture** (Android app): photo/video saved to the gallery.
2. **Invisible mark**: a 24-bit payload (device id + capture counter, CRC-8, ×8
   redundancy) is embedded into the pixels on the device (VideoSeal exported to
   ONNX). Survives platform re-encoding.
3. **Seal**: the file's SHA-256 is signed by an ECDSA P-256 key generated inside
   the phone's secure hardware (StrongBox/TEE, with Key Attestation), and the
   proof (payload, timestamps, public key, attestation chain, signature) is
   appended to the file as a trailer that is also a valid MP4 `free` box.
4. **Verify** ([web/verify.html](web/verify.html), 100% client-side): trailer
   present → strip, hash, verify signature with WebCrypto → *Verified*. Trailer
   stripped by a platform → the watermark is extracted **in the browser**
   (int8 ONNX detector, ~34MB, onnxruntime-web) and the device resolved via the
   public [registry.json](web/registry.json) → *Origin traced* (origin only,
   never integrity). Nothing is ever uploaded.

Devices enroll by adding the JSON shown at app setup to `web/registry.json`
(pull request). The registry only names devices for social copies — exact files
verify without it.

## Components

```
web/       Static site (GitHub Pages): landing, client-side verifier, paper,
           device registry, ONNX models, APK
android/   Kotlin app: setup (no account), CameraX capture, on-device
           watermarking, hardware signing, proof trailer
docs/      Research findings, market analysis, phase reports, device runbook
spikes/    Experiment scripts: robustness, ONNX exports, pipeline simulations,
           payload codec (codec.py — canonical implementation)
seitest/   Android instrumented tests: SEI passthrough + embedder benchmark
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
  registry entry to publish. From then on the app works fully offline.
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

- Watermark recovery needs roughly half of the original image area to survive.
- The browser scans photos and videos; the CLI ([web/verify.mjs](web/verify.mjs),
  served at `/verify.mjs`) runs the same site modules and wasm in node — one
  verification source, ffmpeg only for pixel decode.
- Capture time is device-claimed (RFC 3161 tokens are the tracked upgrade).
- Attestation chain is checked leaf-against-key; validation up to Google's root
  is on the roadmap.
- Video sealing takes ~1–2 min per 10s clip on mid-range phones at fp32
  (int8/NPU is the tracked speed-up).
