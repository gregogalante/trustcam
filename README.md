# TrustCam (working name)

MVP for verifiable capture: an Android app that signs photos/videos at capture with a key in the phone's secure hardware, a registry API, and a public web verifier.

Feasibility research and phase-0 experiment reports live in [docs/](docs/); spike scripts in [spikes/](spikes/); the on-device test harness in [seitest/](seitest/).

## Components

```
server/    Fastify + SQLite: auth, device enrollment (Key Attestation), proofs, /api/verify
watermark/ Python service: VideoSeal watermark extraction for the public verifier
web/       Static site served by the server: landing, verify UI, paper pages
android/   Kotlin app: sign-in, CameraX photo+video, StrongBox/TEE ECDSA P-256 signing
docs/      Research findings, architecture, market analysis, phase-0 reports, device runbook
spikes/    Phase-0 experiment scripts (VideoSeal robustness, export, round-trip checks)
seitest/   Android instrumented tests: SEI passthrough + on-device embedder benchmark
```

## Run (development)

```bash
cd server && yarn install && yarn start   # http://localhost:3000
```

Web UI at `/`, verify at `/verify.html`, registration at `/register.html`, project paper at `/paper/`.

Test: `node server/test/e2e.js` (server must be running; use a throwaway `DB_PATH`).

## Deploy (trustcam.gregoriogalante.com)

### Railway (single service)

The root Dockerfile bundles the Node API and the Python watermark service in one
container (`start.sh` runs both; the watermark service is localhost-only).

1. New service from this repo — the root Dockerfile is picked up automatically. First build is heavy (~2GB: CPU torch + baked VideoSeal checkpoint).
2. Add a **Volume** with mount path `/data` (SQLite lives there; without it the DB resets on every deploy).
3. Set `JWT_SECRET` (e.g. `openssl rand -hex 32`); the server refuses to boot in production without it. Railway injects `PORT` and the server honors it.
4. Attach the custom domain `trustcam.gregoriogalante.com` in Settings → Networking (then add the CNAME Railway shows you at your DNS provider). TLS is automatic.
5. Give the service as much CPU as the plan allows: video watermark *extraction* on the verify page is CPU-bound. Tuning: `WM_THREADS` (torch threads for extraction — auto-detected from the cgroup quota).

`watermark/Dockerfile` still exists if you ever want to split the watermark service out (set `WATERMARK_URL` on the Node service accordingly).

### Generic VPS (docker compose)

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

The container listens on `127.0.0.1:3000`; point a TLS-terminating reverse proxy at it, e.g. Caddy:

```
trustcam.gregoriogalante.com {
    reverse_proxy localhost:3000
}
```

SQLite data persists in the `trustcam-data` volume.

## Android app

- Release APK is served by the site at `/trustcam.apk` (file: `web/trustcam.apk`) — the site's download CTA points there.
- App is sign-in only; account registration happens on the website. Server URL is fixed to `https://trustcam.gregoriogalante.com` (long-press the logo on the sign-in screen for a dev override; cleartext HTTP works only in debug builds).
- Rebuild: `cd android && gradle assembleRelease` — signing uses `android/keystore.properties` + `android/release.keystore` (local only, gitignored; regenerate with `keytool` if lost, but reinstalling over an old version then requires uninstall). Copy the APK to `web/trustcam.apk`.

## How verification works (MVP)

- Device enrolls an ECDSA P-256 public key generated in StrongBox (TEE fallback) with its Android Key Attestation chain.
- At capture the app computes the file's SHA-256 and signs the 32 hash bytes in hardware (`SHA256withECDSA`); the proof (hash+signature+timestamps, ~200 bytes — never the media) is registered.
- `/api/verify` recomputes the hash from an uploaded file, finds the proof, re-verifies the signature against the enrolled key.

## On-device watermarking (phase 3 — fully offline capture)

The app embeds the invisible watermark **on the phone** and works offline after the
first sign-in:

- **Graphs**: the VideoSeal pipeline is exported as three ONNX graphs
  (`spikes/export_frame_graphs.py`): `frame_prep` (resize) and `frame_apply`
  (JND attenuation + upscale + blend) ship in the APK; the 90MB `embedder_key`
  is served at `/models/embedder_key.onnx` (file: `web/models/`) and downloaded
  once at sign-in. Numerical parity vs the server pipeline is asserted at export.
- **Video**: MediaCodec decode → Y-plane-only embedding (limited↔full range, coded↔display
  rotation) → re-encode, audio passthrough. Key frame every 4 frames, delta propagated.
- **Payload namespace**: `deviceId (10 bit) << 14 | local counter (14 bit)` — assigned
  implicitly at enrollment, so the phone never needs the server again to capture.
  The Kotlin codec (`PayloadCodec.kt`) is bit-identical to `watermark/codec.py`
  (unit-tested against generated vectors).
- **Offline queue**: proofs (hash + hardware signature + payload, ~200B) queue in
  the app and batch-sync via `POST /api/proofs/sync` (idempotent) when online.
- `/api/verify` resolves: byte-exact match → watermark extraction → payload lookup
  (legacy server-embedded files resolve by proof id).

The server-side watermark service remains for **extraction only** (verify page).

Known limits (by design, see roadmap): whole-file signature (per-GOP SEI pipeline is
the validated next step), attestation checked for key match but not yet validated to
the Google root, capture time is device-claimed, video sealing takes ~1-2 min per
10s clip on mid-range phones at fp32 (int8/NPU is the tracked speed-up).
