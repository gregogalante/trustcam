// Node test for web/js/codec_v3.js against results/v3_vectors.json.
// Run from spikes/: node test_v3_js.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// the browser file attaches to window/globalThis — eval it into this context
globalThis.window = globalThis
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(join(here, '../web/js/codec_v3.js'), 'utf8'))
const { TrustCamCodecV3 } = globalThis

const vectors = JSON.parse(readFileSync(join(here, 'results/v3_vectors.json'), 'utf8'))

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
  const out = TrustCamCodecV3.decode(toSoftBits(c.bits))
  const ok = out !== null && out.captureIdHex === c.captureId && out.corrected === 0
  check(`codec id=${c.captureId}`, ok, JSON.stringify(out))
}

// --- errorCases: exact recovery for flips <= 18, null beyond ---
for (const c of vectors.errorCases) {
  const out = TrustCamCodecV3.decode(toSoftBits(c.bits))
  if (c.flips <= 18) {
    const ok = out !== null && out.captureIdHex === c.captureId && out.corrected === c.flips
    check(`error flips=${c.flips}`, ok, JSON.stringify(out))
  } else {
    check(`error flips=${c.flips} -> null`, out === null, JSON.stringify(out))
  }
}

// --- all-zero id must be rejected even when the codeword is clean ---
check('zero id -> null', TrustCamCodecV3.decode(new Float32Array(256).fill(-1)) === null)

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
