#!/usr/bin/env node
// TrustCam command-line verifier — fully local, nothing is uploaded.
//
//     node verify.mjs photo.jpg            # proof-trailer check
//     node verify.mjs --scan file.jpg|mp4  # + invisible-mark scan when no trailer
//                                          #   (downloads the site's own scanner once;
//                                          #    needs ffmpeg/ffprobe for pixel decode)
//
// ONE verification source: this CLI runs the exact same files the browser
// verifier runs — js/codec.js, js/codec_v2.js, js/pdq.js, js/verifycore.js and
// the vendored onnxruntime wasm + detector.onnx — fetched from the site (or
// used straight from the repo when run next to web/). Only pixel decoding
// differs: the browser uses canvas, this CLI uses ffmpeg rawvideo RGBA.
//
// Exit codes: 0 verified/intact · 1 invalid/no proof · 2 origin traced or
// inconclusive · 3 content modified.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.TRUSTCAM_URL || 'https://trustcam.gregoriogalante.com'
const SHARED = [
  'js/codec.js', 'js/codec_v2.js', 'js/pdq.js', 'js/verifycore.js',
  'ort/ort.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm',
  'models/detector.onnx'
]

// ---------- shared-source resolution: repo checkout, else site + cache ----------
async function sourceDir () {
  const here = path.dirname(fileURLToPath(import.meta.url))
  if (fs.existsSync(path.join(here, 'js', 'verifycore.js'))) return here
  const cache = path.join(os.homedir(), '.cache', 'trustcam')
  for (const rel of SHARED) {
    const dst = path.join(cache, rel)
    if (fs.existsSync(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    console.error(`downloading ${rel} from ${BASE} …`)
    const res = await fetch(`${BASE}/${rel}`)
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`)
    fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()))
  }
  return cache
}

function loadShared (dir) {
  globalThis.window = globalThis // the browser modules attach to window
  for (const rel of SHARED) {
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
function markId (core, proofId) {
  return `device #${core.deviceIdOf(proofId)} · capture #${core.captureOf(proofId)}`
}

async function registryName (core, proofId) {
  try {
    const reg = await (await fetch(`${BASE}/registry.json`)).json()
    return reg.devices?.[String(core.deviceIdOf(proofId))] || null
  } catch { return null }
}

async function printOriginTraced (core, decoded) {
  const entry = await registryName(core, decoded.proofId)
  const who = entry ? entry.name : `device #${core.deviceIdOf(decoded.proofId)} (not in the public registry)`
  console.log('ORIGIN TRACED — content NOT verified.')
  console.log(`  this copy derives from a TrustCam capture by: ${who}`)
  console.log(`  mark id     : ${markId(core, decoded.proofId)}`)
  if (decoded.v === 1) {
    console.log(`  mark signal : ${Math.round(decoded.confidence * 100)}% (decoding confidence, not authenticity)`)
  }
  console.log('  the copy was modified since capture (re-encode or edit — indistinguishable).')
  process.exit(2)
}

async function main () {
  const args = process.argv.slice(2)
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
    const { sigValid, attested, fingerprint } = await core.verifySeal(bytes, p, t.canonicalEnd)
    console.log(sigValid
      ? 'VERIFIED — exact file, seal valid. Untouched since capture.'
      : 'INVALID — the file carries a proof but the seal does NOT check out. Untrusted.')
    console.log(`  recorded by : ${p.name}`)
    console.log(`  device      : ${p.model} (${p.securityLevel}${attested ? ', hardware-attested key' : ''})`)
    console.log(`  captured at : ${p.capturedAt} (device-claimed)`)
    console.log(`  mark id     : ${markId(core, p.payload || 0)}`)
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
    const decoded = core.decodePayload(await runDetector(core, dir, rgba, w, h))
    if (!decoded) {
      console.log('NO PROOF — no invisible mark could be recovered.')
      process.exit(1)
    }
    if (decoded.v === 2) {
      // content check: sealed checksum vs these pixels (same tiers as the site)
      const dist = core.contentDistance(rgba, w, h, decoded.phashHex)
      const verdict = core.contentVerdict(dist)
      const entry = await registryName(core, decoded.proofId)
      const who = entry ? entry.name : `device #${core.deviceIdOf(decoded.proofId)} (not in the public registry)`
      if (verdict === 'intact') {
        console.log('ORIGIN TRACED — content INTACT (recompressed copy, nothing depicted has changed).')
      } else if (verdict === 'inconclusive') {
        console.log('ORIGIN TRACED — content check INCONCLUSIVE (gray zone between compression and a small edit).')
      } else {
        console.log('ORIGIN TRACED — content MODIFIED after capture (edit, splice or crop).')
      }
      console.log(`  recorded by      : ${who}`)
      console.log(`  mark id          : ${markId(core, decoded.proofId)}`)
      console.log(`  content distance : ${dist} (0 = identical, ≤${core.PDQ_MATCH} = intact, >${core.PDQ_INCONCLUSIVE} = modified)`)
      process.exit(verdict === 'intact' ? 0 : verdict === 'inconclusive' ? 2 : 3)
    }
    await printOriginTraced(core, decoded)
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
  await printOriginTraced(core, decoded)
}

main().catch(e => { console.error(e.message); process.exit(1) })
