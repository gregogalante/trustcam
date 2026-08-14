# TrustCam (working name)

MVP for verifiable capture: an Android app that signs photos/videos at capture with a key in the phone's secure hardware, a registry API, and a public web verifier.

Feasibility research and phase-0 experiment reports live in [docs/](docs/); spike scripts in [spikes/](spikes/); the on-device test harness in [seitest/](seitest/).

## Components

```
server/    Fastify + SQLite: auth, device enrollment (Key Attestation), proofs, /api/verify
watermark/ Python service: VideoSeal invisible watermark embed/extract (payload = proof id)
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
5. Give the service as much CPU as the plan allows: video watermarking is CPU-bound (~3× clip duration per request on a fast CPU). Tuning env vars: `WM_THREADS` (torch threads — set it to the service's actual vCPU count; auto-detected from the cgroup quota by default) and `WM_STEP_SIZE` (frames between watermarked key frames, default 4 — raising it trades a little robustness for a little speed).

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

## Watermark layer (phase 2)

At capture the app uploads the hardware-signed original; the server registers the proof, has the watermark service embed the **proof id as an invisible VideoSeal watermark** (256-bit message: 24-bit id + CRC8, 8× repetition-coded), and returns the watermarked copy, which replaces the gallery file. `/api/verify` then resolves, in order: byte-exact original → byte-exact watermarked copy → **watermark extraction on re-encoded copies** (survives social-media transcodes; measured 100% recovery after YouTube/WhatsApp round-trips and 720p/2Mbps re-encodes).

Trade-offs: media transits the server for embedding (it is not stored — only hashes are); watermarked verification of re-encoded copies proves provenance, not byte integrity; proof ids are capped at 16.7M by the 24-bit payload.

Known MVP limits (by design, see roadmap): whole-file signature (per-GOP SEI pipeline is the validated next step), attestation chain checked for key match but not yet validated to the Google root, capture time is device-claimed, on-device embedding deferred until int8+QNN work lands.
