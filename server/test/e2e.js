// End-to-end API test with a simulated device (P-256 key in software).
// Covers the offline-first flow: enroll -> on-device proof -> batch sync -> verify.
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

function syncBody (deviceId, entries) {
  return JSON.stringify({ deviceId, proofs: entries })
}

function proofEntry (payload, media, privateKey) {
  const sha = crypto.createHash('sha256').update(media).digest()
  return {
    payload,
    sha256: sha.toString('hex'),
    signature: crypto.sign('sha256', sha, privateKey).toString('base64'),
    mediaType: 'video',
    sizeBytes: media.length,
    capturedAt: new Date().toISOString()
  }
}

// signup + enroll
const email = `test-${Date.now()}@example.com`
const signup = await api('/api/auth/signup', {
  method: 'POST', body: JSON.stringify({ email, password: 'password123', name: 'Test User' })
})
assert.equal(signup.status, 200, JSON.stringify(signup.body))
const token = signup.body.token

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
const deviceId = device.body.id

// on-device capture, synced later
const media = crypto.randomBytes(1024 * 1024)
const payload = (deviceId << 14) | 1
const sync = await api('/api/proofs/sync', {
  method: 'POST', body: syncBody(deviceId, [proofEntry(payload, media, privateKey)])
}, token)
assert.equal(sync.status, 200, JSON.stringify(sync.body))
assert.equal(sync.body.results[0].status, 'synced')

// idempotent retry
const retry = await api('/api/proofs/sync', {
  method: 'POST', body: syncBody(deviceId, [proofEntry(payload, media, privateKey)])
}, token)
assert.equal(retry.body.results[0].status, 'already-synced')

// forged signature rejected
const forged = proofEntry((deviceId << 14) | 2, media, privateKey)
forged.sha256 = crypto.createHash('sha256').update('other').digest('hex')
const bad = await api('/api/proofs/sync', {
  method: 'POST', body: syncBody(deviceId, [forged])
}, token)
assert.equal(bad.body.results[0].status, 'bad-signature')

// payload outside the device namespace rejected
const alien = await api('/api/proofs/sync', {
  method: 'POST', body: syncBody(deviceId, [proofEntry(((deviceId + 1) << 14) | 1, media, privateKey)])
}, token)
assert.equal(alien.body.results[0].status, 'payload-device-mismatch')

// client-side verify: fingerprint lookup without uploading the file
const sha = crypto.createHash('sha256').update(media).digest('hex')
const byHash = await api(`/api/verify/hash/${sha}`)
assert.equal(byHash.body.found, true)
assert.equal(byHash.body.verified, true, JSON.stringify(byHash.body))
const byHashMiss = await api(`/api/verify/hash/${'0'.repeat(64)}`)
assert.equal(byHashMiss.body.found, false)

// public verify: exact match of the synced capture
const form = new FormData()
form.append('file', new Blob([media]), 'clip.mp4')
const hit = await (await fetch(BASE + '/api/verify', { method: 'POST', body: form })).json()
assert.equal(hit.found, true)
assert.equal(hit.verified, true, JSON.stringify(hit))
assert.equal(hit.owner, 'Test User')

// public verify: modified file must not match byte-exactly
media[0] ^= 0xff
const form2 = new FormData()
form2.append('file', new Blob([media]), 'clip.mp4')
const miss = await (await fetch(BASE + '/api/verify', { method: 'POST', body: form2 })).json()
assert.equal(miss.found, false, 'modified file must not match')

console.log('E2E OK: signup, enroll, sync, idempotent retry, forged-signature reject, namespace reject, hash-lookup hit/miss, verify hit/miss')
console.log('(watermark extraction path is validated by spikes/sim_device_pipeline.py against the service)')