# Agent Instructions

MVP monorepo. Overview and run commands in README.md. Research docs in `docs/`, spike scripts in `spikes/`.

## Environment

- Node via nvm (v24 works). Package manager: **yarn** (yarn.lock present in server/).
- Android: SDK at `~/Library/Android/sdk`, gradle from wrapper dist `~/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3/bin/gradle`, `export ANDROID_HOME` before building.
- JS code follows JavaScript Standard Style (no semicolons, single quotes, 2-space indent).

## Commands

```bash
cd server && yarn start                      # serve API + web on :3000
node server/test/e2e.js                      # API e2e (server running, throwaway DB_PATH)
cd android && gradle assembleDebug           # build APK
# watermark service (needs conda env `videoseal` + spikes/videoseal clone, see spikes/README.md):
cd spikes/videoseal && cp ../../watermark/{codec,media,app}.py . && uvicorn app:app --port 8000
```

The e2e includes the watermark flow (capture → embed → recovery after re-encode) and skips it automatically if the watermark service is down.

## Conventions / invariants

- **Signature convention** (server ⇄ app contract, do not change unilaterally):
  `sig = ECDSA-P256(SHA256(H))` where `H` = 32 raw bytes of the file's SHA-256.
  Server side: `crypto.verify('sha256', H, pubkey, sig)` in `server/src/crypto.js`.
  App side: `Signature("SHA256withECDSA").update(H)` in `android/.../DeviceKey.kt`.
- Proofs never contain media; `/api/verify` hashes uploads in-stream, never stores files.
- SQLite via better-sqlite3, schema auto-created in `server/src/db.js`. Local DB — safe to delete for a reset.
- Web pages are plain static HTML/CSS/JS in `web/`, served by @fastify/static. No framework, keep it that way for the MVP.
- Attestation: MVP checks leaf-cert key == enrolled key. Full chain validation to Google hardware attestation roots (incl. post-2026-04 RKP root) is a tracked TODO in `server/src/crypto.js`.
- Watermark payload codec lives in `watermark/codec.py` (24-bit proof id + CRC8, 8 reps, copies 32 apart). Changing it desyncs every already-embedded file — never change the layout without a versioning strategy.
- The watermark service is internal-only (Node reaches it via `WATERMARK_URL`); it must never be exposed publicly.
- When testing locally, the service runs from `spikes/videoseal/` because VideoSeal resolves configs/ckpts relative to cwd; the three .py files are copied there (copies are gitignored implicitly — canonical sources are in `watermark/`).

## Testing on devices

On-device test harness and multi-device runbook: `docs/06-device-test-runbook.md`.
