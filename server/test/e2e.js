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

// --- phase 2: watermark flow (runs only if the watermark service is up) ---
const WM = process.env.WATERMARK_URL || 'http://localhost:8000'
const wmUp = await fetch(WM + '/health').then(r => r.ok).catch(() => false)
if (!wmUp) {
  console.log('watermark service not running — phase 2 tests skipped')
  process.exit(0)
}

const { execFileSync } = await import('child_process')
const fs = await import('fs')
const os = await import('os')
const path = await import('path')

const imgPath = process.env.TEST_IMAGE ||
  new URL('../../spikes/videoseal/assets/imgs/1.jpg', import.meta.url).pathname
const img = fs.readFileSync(imgPath)
const imgSha = crypto.createHash('sha256').update(img).digest()

// simulated capture upload
const capForm = new FormData()
capForm.append('file', new Blob([img]), 'capture.jpg')
capForm.append('deviceId', String(device.body.id))
capForm.append('sha256', imgSha.toString('hex'))
capForm.append('signature', crypto.sign('sha256', imgSha, privateKey).toString('base64'))
capForm.append('mediaType', 'photo')
capForm.append('capturedAt', new Date().toISOString())
const capRes = await fetch(BASE + '/api/capture', {
  method: 'POST', body: capForm, headers: { authorization: `Bearer ${token}` }
})
assert.equal(capRes.status, 200, 'capture failed: ' + await capRes.clone().text())
const proofId = capRes.headers.get('x-proof-id')
const wmFile = Buffer.from(await capRes.arrayBuffer())
assert.ok(wmFile.length > 1000)

// exact match on the watermarked copy
const vForm = new FormData()
vForm.append('file', new Blob([wmFile]), 'wm.jpg')
const v1 = await (await fetch(BASE + '/api/verify', { method: 'POST', body: vForm })).json()
assert.equal(v1.match, 'watermarked', JSON.stringify(v1))
assert.equal(v1.verified, true)

// social-style degradation: re-encode + downscale, then recover via watermark
const tmp = path.join(os.tmpdir(), 'tc-e2e')
fs.mkdirSync(tmp, { recursive: true })
const wmPath = path.join(tmp, 'wm.jpg')
const degPath = path.join(tmp, 'deg.jpg')
fs.writeFileSync(wmPath, wmFile)
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', wmPath, '-q:v', '7', '-vf', 'scale=iw*0.8:ih*0.8', degPath])
const deg = fs.readFileSync(degPath)
const v2Form = new FormData()
v2Form.append('file', new Blob([deg]), 'deg.jpg')
const v2 = await (await fetch(BASE + '/api/verify', { method: 'POST', body: v2Form })).json()
assert.equal(v2.match, 'watermark-recovered', JSON.stringify(v2))
assert.equal(v2.owner, 'Test User')
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`E2E phase 2 OK: capture #${proofId} watermarked, exact wm match, recovery after re-encode (conf ${v2.confidence})`)
