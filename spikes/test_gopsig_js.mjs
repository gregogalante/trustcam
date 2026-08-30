// Per-GOP bitstream signature verification against the generated fixture
// (make_gopsig_fixture.mjs). Run from spikes/: node test_gopsig_js.mjs
import fs from 'fs'
import { execFileSync } from 'child_process'

globalThis.TrustCamCodecV3 = {}
globalThis.TrustCamCodec = {}
// eslint-disable-next-line no-eval
eval(fs.readFileSync(new URL('../web/js/verifycore.js', import.meta.url), 'utf8'))
const core = globalThis.TrustCamVerifyCore
const meta = JSON.parse(fs.readFileSync(new URL('results/gopsig_meta.json', import.meta.url), 'utf8'))
const fixture = new Uint8Array(fs.readFileSync(new URL('results/gopsig_fixture.mp4', import.meta.url)))

let passed = 0
let failed = 0
function check (name, cond) {
  if (cond) passed++
  else { failed++; console.error(`FAIL ${name}`) }
}

// full file + proof-side record for the final GOP: everything verifies
const full = await core.verifyBitstream(fixture, meta.lastGop)
check('all GOPs verified', full && full.verified === meta.gopCount && full.total === meta.gopCount)
check('single signing key', full && full.keyB64 === meta.spki)

// without the proof record the last GOP has no signature to check
const noProof = await core.verifyBitstream(fixture, null)
check('last GOP unsigned without proof', noProof.verified === meta.gopCount - 1 &&
  noProof.signed === meta.gopCount - 1)

// tamper one byte inside the 3rd GOP's video data: exactly that GOP fails
const vt = core.mp4VideoSamples(fixture)
const g3start = vt.samples.filter(s => s.sync)[2]
const tampered = fixture.slice()
tampered[g3start.off + vt.nalLen + 30] ^= 1
const t = await core.verifyBitstream(tampered, meta.lastGop)
check('tampered GOP fails', t.verified === meta.gopCount - 1)
check('other GOPs still verify', t.gops.filter(g => g.ok).length === meta.gopCount - 1)

// lossless trim (ffmpeg -c copy): interior GOPs keep verifying, trailer gone
execFileSync('ffmpeg', ['-v', 'error', '-ss', '2', '-i', 'results/gopsig_fixture.mp4',
  '-t', '4', '-c', 'copy', '-y', 'results/gopsig_trimmed.mp4'])
const trimmed = new Uint8Array(fs.readFileSync(new URL('results/gopsig_trimmed.mp4', import.meta.url)))
const tr = await core.verifyBitstream(trimmed, null)
check('trimmed copy has verified GOPs', tr !== null && tr.verified >= 1)
console.log(`  (trim kept ${tr ? tr.total : 0} GOPs, ${tr ? tr.verified : 0} verified)`)

// a plain unsigned mp4 yields null (no records)
let orig = new Uint8Array(fs.readFileSync(new URL('../web/samples/tc_f0dba886.mp4', import.meta.url)))
const plain = await core.verifyBitstream(orig, null)
check('unsigned video -> null', plain === null)

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
