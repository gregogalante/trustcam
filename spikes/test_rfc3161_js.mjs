// RFC 3161 verifier test against a REAL Sectigo token captured in
// results/rfc3161_vector.json (regen: see docs in AGENTS.md — request a fresh
// token for any hash with `openssl ts -query` + curl to the TSA).
// Run from spikes/: node test_rfc3161_js.mjs
import fs from 'fs'

globalThis.TrustCamCodecV3 = {}
globalThis.TrustCamCodec = {}
// eslint-disable-next-line no-eval
eval(fs.readFileSync(new URL('../web/js/verifycore.js', import.meta.url), 'utf8'))
const core = globalThis.TrustCamVerifyCore
const v = JSON.parse(fs.readFileSync(new URL('results/rfc3161_vector.json', import.meta.url), 'utf8'))

let passed = 0
let failed = 0
function check (name, cond) {
  if (cond) passed++
  else { failed++; console.error(`FAIL ${name}`) }
}

const good = await core.verifyTimestamp(v.tsr, v.sha256)
check('real token verifies', good.status === 'verified')
check('genTime matches', good.genTime === v.genTime)

check('wrong hash rejected', (await core.verifyTimestamp(v.tsr, 'ab'.repeat(32))).status === 'invalid')

const tampered = core.b64ToBytes(v.tsr)
tampered[tampered.length - 10] ^= 1
const tamperedB64 = Buffer.from(tampered).toString('base64')
check('tampered token rejected', (await core.verifyTimestamp(tamperedB64, v.sha256)).status === 'invalid')

check('absent token -> null', await core.verifyTimestamp(undefined, v.sha256) === null)
check('garbage token rejected', (await core.verifyTimestamp('aGVsbG8=', v.sha256)).status === 'invalid')

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
