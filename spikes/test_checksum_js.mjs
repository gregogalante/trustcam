// Node test for web/js/codec_v2.js + web/js/pdq.js against
// results/checksum_vectors.json. Run from spikes/: node test_checksum_js.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// the browser files attach to window/globalThis — eval them into this context
globalThis.window = globalThis
for (const f of ['../web/js/codec_v2.js', '../web/js/pdq.js']) {
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(join(here, f), 'utf8'))
}
const { TrustCamCodecV2, TrustCamPdq } = globalThis

const vectors = JSON.parse(readFileSync(join(here, 'results/checksum_vectors.json'), 'utf8'))

let pass = 0
let fail = 0
function check (name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name} ${detail}`)
  }
}

function toSoftBits (bitString) {
  return Float32Array.from(bitString, ch => (ch === '1' ? 1 : -1))
}

// --- codecCases: clean encodes must decode exactly ---
for (const c of vectors.codecCases) {
  const out = TrustCamCodecV2.decode(toSoftBits(c.bits))
  const ok = out !== null && out.proofId === c.proofId &&
    out.phashHex === c.phash && out.corrected === 0
  check(`codec proofId=${c.proofId}`, ok, JSON.stringify(out))
}

// --- errorCases: exact recovery for flips <= 18, null beyond ---
for (const c of vectors.errorCases) {
  const out = TrustCamCodecV2.decode(toSoftBits(c.bits))
  if (c.flips <= 18) {
    const ok = out !== null && out.proofId === c.proofId &&
      out.phashHex === c.phash && out.corrected === c.flips
    check(`error flips=${c.flips} proofId=${c.proofId}`, ok, JSON.stringify(out))
  } else {
    check(`error flips=${c.flips} -> null`, out === null, JSON.stringify(out))
  }
}

// --- pdqCases: formula luma images, Hamming <= 2 vs reference ---
const images = {
  mix640x480: { w: 640, h: 480, f: (x, y) => (x * 7 + y * 13 + (x * y) % 31) % 256 },
  grad512x512: {
    w: 512,
    h: 512,
    f: (x, y) => Math.floor((Math.floor(x * 255 / 511) + Math.floor(y * 255 / 511)) / 2)
  },
  blocks300x200: {
    w: 300,
    h: 200,
    f: (x, y) => ((Math.floor(x / 25) + Math.floor(y / 25)) % 2) * 200 + (x + y) % 55
  }
}

function hamming256 (hash, bitString) {
  let d = 0
  for (let k = 0; k < 256; k++) {
    const bit = (hash[k >> 3] >> (7 - (k & 7))) & 1
    if (bit !== (bitString[k] === '1' ? 1 : 0)) d++
  }
  return d
}

for (const c of vectors.pdqCases) {
  const img = images[c.image]
  const luma = new Float64Array(img.w * img.h)
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) luma[y * img.w + x] = img.f(x, y)
  }
  const hash = TrustCamPdq.fromLuma(luma, img.w, img.h)
  const d = hamming256(hash, c.bits)
  check(`pdq ${c.image}`, d <= 2, `hamming=${d}`)
}

// hamming104 sanity: distance confined to the first 13 bytes
{
  const a = new Uint8Array(32)
  const b = new Uint8Array(32)
  b[0] = 0x80 // bit 0
  b[12] = 0x01 // bit 103
  b[13] = 0xff // bits 104+ must not count
  check('hamming104', TrustCamPdq.hamming104(a, b) === 2,
    `got ${TrustCamPdq.hamming104(a, b)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
