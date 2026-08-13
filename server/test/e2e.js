// End-to-end API test with a simulated device (P-256 key in software).
// Run: node test/e2e.js (expects server on :3000 with a throwaway DB)
import crypto from 'crypto'
import assert from 'assert'

const BASE = process.env.BASE || 'http://localhost:3000'

async function api (path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers
    }
  })
  return { status: res.status, body: await res.json() }
}

// signup
const email = `test-${Date.now()}@example.com`
const signup = await api('/api/auth/signup', {
  method: 'POST', body: JSON.stringify({ email, password: 'password123', name: 'Test User' })
})
assert.equal(signup.status, 200, JSON.stringify(signup.body))
const token = signup.body.token

// enroll simulated device (software key, no attestation chain)
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const device = await api('/api/devices', {
  method: 'POST',
  body: JSON.stringify({
    model: 'Simulated Device',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    securityLevel: 'software'
  })
}, token)
assert.equal(device.status, 200, JSON.stringify(device.body))

// fake media file + proof
const media = crypto.randomBytes(1024 * 1024)
const sha256 = crypto.createHash('sha256').update(media).digest()
const signature = crypto.sign('sha256', sha256, privateKey).toString('base64')

const proof = await api('/api/proofs', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: device.body.id,
    sha256: sha256.toString('hex'),
    signature,
    mediaType: 'video',
    sizeBytes: media.length,
    capturedAt: new Date().toISOString()
  })
}, token)
assert.equal(proof.status, 200, JSON.stringify(proof.body))
assert.equal(proof.body.status, 'verified')

// tampered signature must be rejected
const bad = await api('/api/proofs', {
  method: 'POST',
  body: JSON.stringify({
    deviceId: device.body.id,
    sha256: crypto.createHash('sha256').update('other').digest('hex'),
    signature,
    mediaType: 'video',
    sizeBytes: 1,
    capturedAt: new Date().toISOString()
  })
}, token)
assert.equal(bad.status, 400, 'tampered proof must be rejected')

// public verify: matching file
const form = new FormData()
form.append('file', new Blob([media]), 'clip.mp4')
const verify = await api('/api/verify', { method: 'POST', body: form })
assert.equal(verify.status, 200)
assert.equal(verify.body.found, true)
assert.equal(verify.body.verified, true)
assert.equal(verify.body.owner, 'Test User')

// public verify: modified file (1 byte flipped)
media[0] ^= 0xff
const form2 = new FormData()
form2.append('file', new Blob([media]), 'clip.mp4')
const verify2 = await api('/api/verify', { method: 'POST', body: form2 })
assert.equal(verify2.body.found, false, 'modified file must not match')

console.log('E2E OK: signup, enroll, proof, tamper-reject, verify-hit, verify-miss')
