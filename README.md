# TrustCam (working name)

MVP for verifiable capture: an Android app that signs photos/videos at capture with a key in the phone's secure hardware, a registry API, and a public web verifier.

Feasibility research and phase-0 experiment reports live in [docs/](docs/); spike scripts in [spikes/](spikes/); the on-device test harness in [seitest/](seitest/).

## Components

```
server/    Fastify + SQLite: auth, device enrollment (Key Attestation), proofs, /api/verify
web/       Static site served by the server: landing, verify UI, paper pages
android/   Kotlin app: signup/login, CameraX photo+video, StrongBox/TEE ECDSA P-256 signing
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

SQLite data persists in the `trustcam-data` volume. The server refuses to boot in production without `JWT_SECRET`.

## Android app

- Release APK is served by the site at `/trustcam.apk` (file: `web/trustcam.apk`) — the site's download CTA points there.
- App is sign-in only; account registration happens on the website. Server URL is fixed to `https://trustcam.gregoriogalante.com` (long-press the logo on the sign-in screen for a dev override; cleartext HTTP works only in debug builds).
- Rebuild: `cd android && gradle assembleRelease` — signing uses `android/keystore.properties` + `android/release.keystore` (local only, gitignored; regenerate with `keytool` if lost, but reinstalling over an old version then requires uninstall). Copy the APK to `web/trustcam.apk`.

## How verification works (MVP)

- Device enrolls an ECDSA P-256 public key generated in StrongBox (TEE fallback) with its Android Key Attestation chain.
- At capture the app computes the file's SHA-256 and signs the 32 hash bytes in hardware (`SHA256withECDSA`); the proof (hash+signature+timestamps, ~200 bytes — never the media) is registered.
- `/api/verify` recomputes the hash from an uploaded file, finds the proof, re-verifies the signature against the enrolled key.

Known MVP limits (by design, see roadmap): whole-file signature (per-GOP SEI pipeline is the validated next step), attestation chain checked for key match but not yet validated to the Google root, capture time is device-claimed, exact-file match only (watermark recovery is phase 2).
