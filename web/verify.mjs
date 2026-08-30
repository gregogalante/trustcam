#!/usr/bin/env node
// TrustCam command-line verifier — fully local, nothing is uploaded.
//
//     node verify.mjs photo.jpg            # proof-trailer check
//     node verify.mjs --scan file.jpg|mp4  # + invisible-mark scan when no trailer
//                                          #   (downloads the site's own scanner once;
//                                          #    needs ffmpeg/ffprobe for pixel decode)
//
// ONE verification source: this CLI runs the exact same files the browser
// verifier runs — js/codec.js, js/codec_v3.js, js/verifycore.js and the
// vendored onnxruntime wasm + detector.onnx — fetched from the site (or
// used straight from the repo when run next to web/). Only pixel decoding
// differs: the browser uses canvas, this CLI uses ffmpeg rawvideo RGBA.
//
// Exit codes: 0 verified (exact file, or mark resolved to a verified
// original on file) · 1 invalid/no proof · 2 origin traced only.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.TRUSTCAM_URL || 'https://trustcam.gregoriogalante.com'
// Shared verifier files, pinned by SHA-256: this CLI executes what it
// downloads, so every file must hash-match the site version this copy of
// verify.mjs was published with. Regenerate after any change:
//   node verify.mjs --hashes   (from a repo checkout, next to web/)
const SHARED = {
  'js/codec.js': 'c38ef43250b509d7d3d757074099418eaf049c1b669650bd47beffad6e9ce5e2',
  'js/codec_v3.js': 'cce9236875d72a64c49c832e6ec1ff0e125d02916016d10085bf3e3e268f6989',
  'js/verifycore.js': 'e956536928377aac3fd67d121823817eb305c17f545cc53ba44099675edaf8df',
  'ort/ort.min.js': 'be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8',
  'ort/ort-wasm-simd-threaded.mjs': '745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8',
  'ort/ort-wasm-simd-threaded.wasm': '207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea',
  'models/detector.onnx': '4b09c87d43314303b7854bbe615a4c97f4531bd239c0a7383319bde6717ce781'
}

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------- shared-source resolution: repo checkout, else site + cache ----------
function repoDir () {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.existsSync(path.join(here, 'js', 'verifycore.js')) ? here : null
}

async function sourceDir () {
  const here = repoDir()
  if (here) return here // developer checkout: run what is on disk, no pinning
  const cache = path.join(os.homedir(), '.cache', 'trustcam')
  for (const [rel, hash] of Object.entries(SHARED)) {
    const dst = path.join(cache, rel)
    // cached copies are re-verified every run; stale/tampered ones re-fetch
    if (fs.existsSync(dst) && sha256(fs.readFileSync(dst)) === hash) continue
    console.error(`downloading ${rel} from ${BASE} …`)
    const res = await fetch(`${BASE}/${rel}`)
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (sha256(buf) !== hash) {
      throw new Error(`${rel}: integrity check failed — the site has been updated ` +
        'since this copy of verify.mjs was published. Re-download it:\n' +
        `  curl -sO ${BASE}/verify.mjs`)
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, buf)
  }
  return cache
}

function loadShared (dir) {
  globalThis.window = globalThis // the browser modules attach to window
  for (const rel of Object.keys(SHARED)) {
    if (!rel.endsWith('.js') || rel.startsWith('ort/')) continue
    ;(0, eval)(fs.readFileSync(path.join(dir, rel), 'utf8')) // eslint-disable-line no-eval
  }
  return globalThis.TrustCamVerifyCore
}

let sessionPromise = null
function detector (dir) {
  if (!sessionPromise) {
    globalThis.self = globalThis
    const ort = createRequire(import.meta.url)(path.join(dir, 'ort', 'ort.min.js'))
    ort.env.wasm.wasmPaths = 'file://' + path.join(dir, 'ort') + path.sep
    ort.env.wasm.numThreads = 1
    globalThis.ort = ort
    sessionPromise = ort.InferenceSession.create(
      new Uint8Array(fs.readFileSync(path.join(dir, 'models', 'detector.onnx'))),
      { executionProviders: ['wasm'] })
  }
  return sessionPromise
}

async function runDetector (core, dir, rgba, w, h) {
  const session = await detector(dir)
  const out = await session.run({
    image: new globalThis.ort.Tensor('float32', core.toDetectorInput(rgba, w, h), [1, 3, h, w])
  })
  return out.preds.data.subarray(1)
}

// ---------- pixel decode via ffmpeg (the only non-shared piece) ----------
function ffprobe (file, entries) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' })
  return JSON.parse(out)
}

// same downscale rule as the browser canvas path
function scanDims (w, h, core) {
  const scale = Math.min(1, core.SCAN_MAX_DIM / Math.max(w, h))
  return { w: Math.round(w * scale), h: Math.round(h * scale) }
}

function decodeFrames (file, w, h, filters) {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', `${filters}scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
  { maxBuffer: 1 << 30 })
  if (res.status !== 0) throw new Error('ffmpeg failed: ' + res.stderr)
  return res.stdout
}

// ---------- verdict printing ----------
function markId (core, proof) {
  return proof.captureId
    ? `capture ${proof.captureId}`
    : `device #${core.deviceIdOf(proof.payload || 0)} · capture #${core.captureOf(proof.payload || 0)}`
}

async function samplesDb () {
  try {
    return await (await fetch(`${BASE}/samples.json`)).json()
  } catch { return { samples: {} } }
}

// Mark-only outcome: resolve the capture id against the verified originals
// on file; a hit means a human can compare copy vs original.
function printSampleHit (core, key, entry) {
  console.log('ORIGIN TRACED — verified original ON FILE.')
  console.log(`  recorded by : ${entry.name} (${entry.model})`)
  console.log(`  captured at : ${entry.capturedAt} (device-claimed)`)
  console.log(`  capture id  : ${core.idPretty(key)}`)
  console.log(`  original    : ${BASE}${entry.original}`)
  console.log('  compare your copy against the original above — any depicted difference is an edit.')
  process.exit(0)
}

async function printMarkVerdict (core, decoded) {
  const db = await samplesDb()
  if (decoded.v === 3) {
    const entry = db.samples?.[decoded.captureIdHex]
    if (entry) printSampleHit(core, decoded.captureIdHex, entry)
    console.log('ORIGIN TRACED — content NOT verified.')
    console.log(`  capture id  : ${core.idPretty(decoded.captureIdHex)}`)
    console.log('  the mark identifies a TrustCam capture, but its verified original is not on file.')
    console.log('  the copy was modified since capture (re-encode or edit — indistinguishable).')
    process.exit(2)
  }
  // repetition-format mark: videos since 1.2.2 + pre-1.2 captures
  const hit = core.sampleByMarkId(db, decoded.proofId)
  if (hit) printSampleHit(core, hit.key, hit.entry)
  console.log('ORIGIN TRACED — content NOT verified.')
  console.log(`  mark id     : ${core.markIdHex(decoded.proofId)}`)
  console.log(`  mark signal : ${Math.round(decoded.confidence * 100)}% (decoding confidence, not authenticity)`)
  console.log('  the copy was modified since capture (re-encode or edit — indistinguishable).')
  process.exit(2)
}

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--hashes')) {
    // release helper: print the pinned-hash map from a repo checkout
    const here = repoDir()
    if (!here) {
      console.error('--hashes needs a repo checkout (run next to web/js/)')
      process.exit(1)
    }
    for (const rel of Object.keys(SHARED)) {
      console.log(`  '${rel}': '${sha256(fs.readFileSync(path.join(here, rel)))}',`)
    }
    process.exit(0)
  }
  const scan = args.includes('--scan')
  const files = args.filter(a => a !== '--scan')
  if (files.length !== 1 || !fs.existsSync(files[0])) {
    console.error('usage: node verify.mjs [--scan] <photo-or-video>')
    process.exit(1)
  }
  const file = files[0]
  const dir = await sourceDir()
  const core = loadShared(dir)
  const bytes = new Uint8Array(fs.readFileSync(file))

  // trailer first: intact files verify cryptographically, no scan needed
  const t = core.parseTrailer(bytes)
  if (t) {
    const p = t.proof
    const { sigValid, attestation, key, health, timestamp, fingerprint } = await core.verifySeal(bytes, p, t.canonicalEnd)
    const ATT = {
      'google-root': 'chain verified to Google hardware attestation root',
      'unverified-root': 'chain valid, root NOT a Google hardware root',
      invalid: 'chain INVALID — hardware claim unproven',
      none: 'not present'
    }
    // extension values are authenticated by the chain — flag them when it isn't
    const caveat = attestation === 'google-root' ? '' : ' (chain unverified)'
    const boot = key
      ? (key.bootState === 'verified' && key.deviceLocked
          ? 'verified, bootloader locked'
          : `${key.bootState || 'unknown'}${key.deviceLocked === false ? ', bootloader UNLOCKED' : ''} — compromised system can sign arbitrary images`) + caveat
      : 'attestation extension not present'
    const app = {
      official: `official (${core.APP_PACKAGE}, signing cert match)${caveat}`,
      mismatch: `MISMATCH (${((key && key.appPackages) || []).join(', ') || 'unknown'}) — not the official build${caveat}`,
      unrecorded: 'not recorded in the attestation'
    }[core.appIdentity(key)]
    console.log(sigValid
      ? 'VERIFIED — exact file, seal valid. Untouched since capture.'
      : 'INVALID — the file carries a proof but the seal does NOT check out. Untrusted.')
    console.log(`  recorded by : ${p.name}`)
    console.log(`  device      : ${p.model} (${p.securityLevel})`)
    console.log(`  attestation : ${ATT[attestation]}`)
    if (health) {
      const line = health.revoked.length
        ? 'REVOKED certificate in chain — hardware claim broken'
        : [health.validity === 'expired' ? 'cert window closed (short-lived by design — covers key creation)' : null,
            health.validity === 'not-yet-valid' ? 'cert window in the future — check the clock' : null,
            health.crl === 'unavailable' ? 'revocation list unreachable — not checked' : null]
            .filter(Boolean).join('; ') || 'clean — not revoked, cert windows valid'
      console.log(`  chain health: ${line}`)
    }
    console.log(`  boot        : ${boot}`)
    console.log(`  signing app : ${app}`)
    console.log(`  captured at : ${p.capturedAt} (device-claimed)`)
    if (timestamp) {
      const TS = {
        verified: `existed no later than ${timestamp.genTime} (RFC 3161, trusted TSA)`,
        'untrusted-tsa': `token reads ${timestamp.genTime} but the TSA is not trusted — treat as device-claimed`,
        invalid: 'token INVALID — treat the time as device-claimed'
      }
      console.log(`  timestamped : ${TS[timestamp.status]}`)
    }
    console.log(`  mark id     : ${markId(core, p)}`)
    console.log(`  fingerprint : ${fingerprint}`)
    process.exit(sigValid ? 0 : 1)
  }

  if (!scan) {
    console.log('NO PROOF TRAILER — if this copy was re-encoded by a platform,')
    console.log('re-run with --scan to look for the invisible mark in the pixels.')
    process.exit(1)
  }

  const isVideo = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']
    .includes(path.extname(file).toLowerCase())

  if (!isVideo) {
    const s = ffprobe(file, 'stream=width,height').streams[0]
    const { w, h } = scanDims(s.width, s.height, core)
    const rgba = new Uint8ClampedArray(decodeFrames(file, w, h, '').subarray(0, w * h * 4))
    let decoded = core.decodePayload(await runDetector(core, dir, rgba, w, h))
    // rescue passes at native resolution (the regular scan's downscale alone
    // can cost the BCH margin, especially on tall 9:16 frames): first the same
    // frame unpadded, then the aspect-restore pads for platform crops
    // (BCH-only — its false-accept rate makes multiple tries safe).
    if (!decoded) {
      const rs = Math.min(1, core.RESCUE_MAX_DIM / Math.max(s.width, s.height))
      const rw = Math.round(s.width * rs)
      const rh = Math.round(s.height * rs)
      const native = new Uint8ClampedArray(decodeFrames(file, rw, rh, '').subarray(0, rw * rh * 4))
      for (const plan of core.scanPlans(rw, rh)) {
        console.error(plan.dx || plan.dy
          ? 'mark not found as-is — retrying with the original framing restored …'
          : 'mark not found as-is — retrying at full resolution …')
        const padded = new Uint8ClampedArray(plan.w * plan.h * 4).fill(128)
        for (let y = 0; y < rh; y++) {
          padded.set(native.subarray(y * rw * 4, (y + 1) * rw * 4),
            ((y + plan.dy) * plan.w + plan.dx) * 4)
        }
        const d = core.decodePayload(await runDetector(core, dir, padded, plan.w, plan.h))
        if (d && d.v === 3) { decoded = d; break }
      }
    }
    if (!decoded) {
      console.log('NO PROOF — no invisible mark could be recovered.')
      process.exit(1)
    }
    await printMarkVerdict(core, decoded)
  }

  // video: sample frames evenly, average soft bits — same flow as the browser
  const info = ffprobe(file, 'stream=width,height:format=duration')
  const s = info.streams[0]
  const dur = parseFloat(info.format?.duration || '0') ||
    parseFloat(ffprobe(file, 'format=duration').format.duration)
  const { w, h } = scanDims(s.width, s.height, core)
  const n = core.VIDEO_SCAN_FRAMES
  const raw = decodeFrames(file, w, h, `fps=${Math.max(n / Math.max(dur, 0.1), 0.1)},`)
  const frameSize = w * h * 4
  const frames = Math.min(n, Math.floor(raw.length / frameSize))
  if (frames === 0) throw new Error('no frames decoded')
  const acc = new Float64Array(256)
  for (let f = 0; f < frames; f++) {
    const rgba = new Uint8ClampedArray(raw.subarray(f * frameSize, (f + 1) * frameSize))
    const preds = await runDetector(core, dir, rgba, w, h)
    for (let b = 0; b < 256; b++) acc[b] += preds[b]
  }
  const avg = new Float32Array(256)
  for (let b = 0; b < 256; b++) avg[b] = acc[b] / frames
  const decoded = core.decodePayload(avg)
  if (!decoded) {
    console.log('NO PROOF — no invisible mark could be recovered from the sampled frames.')
    process.exit(1)
  }
  await printMarkVerdict(core, decoded)
}

main().catch(e => { console.error(e.message); process.exit(1) })
