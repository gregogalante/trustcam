import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import db from './db.js'
import { verifyFileSignature, attestationLeafMatchesKey } from './crypto.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const app = Fastify({ logger: true })

// Refuse to boot in production with the development secret
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production')
  process.exit(1)
}
app.register(fastifyJwt, { secret: process.env.JWT_SECRET || 'dev-secret-change-me' })
app.register(fastifyMultipart, { limits: { fileSize: 500 * 1024 * 1024 } })
app.register(fastifyStatic, { root: path.join(dir, '..', '..', 'web') })

const auth = async (req, reply) => {
  try { await req.jwtVerify() } catch { reply.code(401).send({ error: 'unauthorized' }) }
}

// --- auth ---

app.post('/api/auth/signup', async (req, reply) => {
  const { email, password, name } = req.body || {}
  if (!email || !password || !name) return reply.code(400).send({ error: 'email, password, name required' })
  if (password.length < 8) return reply.code(400).send({ error: 'password too short (min 8)' })
  try {
    const info = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10), name)
    return { token: app.jwt.sign({ uid: info.lastInsertRowid }) }
  } catch {
    return reply.code(409).send({ error: 'email already registered' })
  }
})

app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = req.body || {}
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase())
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return reply.code(401).send({ error: 'invalid credentials' })
  }
  return { token: app.jwt.sign({ uid: user.id }) }
})

// --- devices ---

app.post('/api/devices', { preHandler: auth }, async (req, reply) => {
  const { model, publicKeyPem, attestationChain, securityLevel } = req.body || {}
  if (!model || !publicKeyPem) return reply.code(400).send({ error: 'model, publicKeyPem required' })

  let attested = false
  if (Array.isArray(attestationChain) && attestationChain.length > 0) {
    attested = attestationLeafMatchesKey(attestationChain, publicKeyPem)
    if (!attested) return reply.code(400).send({ error: 'attestation leaf key mismatch' })
  }

  const info = db.prepare(
    'INSERT INTO devices (user_id, model, public_key_pem, attestation_chain, security_level) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.uid, model, publicKeyPem,
    attested ? JSON.stringify(attestationChain) : null,
    securityLevel || 'software')
  return { id: info.lastInsertRowid, attested }
})

// --- proofs ---

app.post('/api/proofs', { preHandler: auth }, async (req, reply) => {
  const { deviceId, sha256, signature, mediaType, sizeBytes, capturedAt } = req.body || {}
  if (!deviceId || !sha256 || !signature || !mediaType || !sizeBytes || !capturedAt) {
    return reply.code(400).send({ error: 'deviceId, sha256, signature, mediaType, sizeBytes, capturedAt required' })
  }
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, req.user.uid)
  if (!device) return reply.code(404).send({ error: 'device not found' })

  if (!verifyFileSignature(sha256.toLowerCase(), signature, device.public_key_pem)) {
    return reply.code(400).send({ error: 'signature verification failed' })
  }

  const info = db.prepare(
    'INSERT INTO proofs (user_id, device_id, sha256, signature, media_type, size_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.uid, deviceId, sha256.toLowerCase(), signature, mediaType, sizeBytes, capturedAt)
  return { id: info.lastInsertRowid, status: 'verified' }
})

app.get('/api/proofs', { preHandler: auth }, async (req) => {
  return db.prepare(`
    SELECT p.id, p.sha256, p.media_type, p.size_bytes, p.captured_at, p.created_at, d.model
    FROM proofs p JOIN devices d ON d.id = p.device_id
    WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 100
  `).all(req.user.uid)
})

// --- capture with watermarking (phase 2) ---

const WATERMARK_URL = process.env.WATERMARK_URL || 'http://localhost:8000'

// Multipart: file + fields (deviceId, sha256, signature, mediaType, capturedAt).
// Verifies the device signature over the ORIGINAL bytes, registers the proof,
// gets a watermarked copy from the watermark service (payload = proof id),
// stores its hash and streams it back to the app.
app.post('/api/capture', { preHandler: auth }, async (req, reply) => {
  let fileBuf = null
  let filename = 'capture.bin'
  const fields = {}
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      filename = part.filename || filename
      fileBuf = await part.toBuffer()
    } else {
      fields[part.fieldname] = part.value
    }
  }
  const { deviceId, sha256, signature, mediaType, capturedAt } = fields
  if (!fileBuf || !deviceId || !sha256 || !signature || !mediaType || !capturedAt) {
    return reply.code(400).send({ error: 'file, deviceId, sha256, signature, mediaType, capturedAt required' })
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, req.user.uid)
  if (!device) return reply.code(404).send({ error: 'device not found' })

  // The claimed hash must match the uploaded bytes AND the device signature
  const actual = crypto.createHash('sha256').update(fileBuf).digest('hex')
  if (actual !== sha256.toLowerCase()) return reply.code(400).send({ error: 'sha256 does not match file' })
  if (!verifyFileSignature(actual, signature, device.public_key_pem)) {
    return reply.code(400).send({ error: 'signature verification failed' })
  }

  const info = db.prepare(
    'INSERT INTO proofs (user_id, device_id, sha256, signature, media_type, size_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.uid, deviceId, actual, signature, mediaType, fileBuf.length, capturedAt)
  const proofId = info.lastInsertRowid

  const form = new FormData()
  form.append('file', new Blob([fileBuf]), filename)
  form.append('proof_id', String(proofId))
  const wmRes = await fetch(`${WATERMARK_URL}/embed`, { method: 'POST', body: form })
  if (!wmRes.ok) {
    req.log.error(`watermark embed failed: ${wmRes.status}`)
    // Proof of the original still stands; the app keeps the unwatermarked file
    return reply.code(502).send({ error: 'watermarking failed', proofId })
  }
  const wmBuf = Buffer.from(await wmRes.arrayBuffer())
  const wmSha = crypto.createHash('sha256').update(wmBuf).digest('hex')
  db.prepare('UPDATE proofs SET wm_sha256 = ? WHERE id = ?').run(wmSha, proofId)

  return reply
    .header('content-type', wmRes.headers.get('content-type') || 'application/octet-stream')
    .header('x-proof-id', String(proofId))
    .send(wmBuf)
})

// --- public verification ---

const PROOF_LOOKUP = `
  SELECT p.*, d.model, d.security_level, d.public_key_pem, d.attestation_chain, u.name AS owner_name
  FROM proofs p JOIN devices d ON d.id = p.device_id JOIN users u ON u.id = p.user_id
`

function proofResponse (proof, extra) {
  return {
    found: true,
    mediaType: proof.media_type,
    owner: proof.owner_name,
    device: { model: proof.model, securityLevel: proof.security_level, attested: !!proof.attestation_chain },
    capturedAt: proof.captured_at,
    registeredAt: proof.created_at,
    ...extra
  }
}

app.post('/api/verify', async (req, reply) => {
  const file = await req.file()
  if (!file) return reply.code(400).send({ error: 'file required' })
  const fileBuf = await file.toBuffer()
  const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex')
  const size = fileBuf.length

  // 1. Exact match: original bytes (hardware-signed) or watermarked copy
  let proof = db.prepare(`${PROOF_LOOKUP} WHERE p.sha256 = ? ORDER BY p.id LIMIT 1`).get(sha256)
  if (proof) {
    const signatureValid = verifyFileSignature(sha256, proof.signature, proof.public_key_pem)
    return proofResponse(proof, {
      verified: signatureValid, match: 'original', sha256, sizeBytes: size
    })
  }
  proof = db.prepare(`${PROOF_LOOKUP} WHERE p.wm_sha256 = ? ORDER BY p.id LIMIT 1`).get(sha256)
  if (proof) {
    // Byte-exact watermarked copy: derived server-side from a hardware-signed
    // original, so integrity holds even though the device signed the original
    return proofResponse(proof, {
      verified: true, match: 'watermarked', sha256, sizeBytes: size
    })
  }

  // 2. No exact match: try to recover the proof id from the invisible watermark
  try {
    const form = new FormData()
    form.append('file', new Blob([fileBuf]), file.filename || 'upload.bin')
    const res = await fetch(`${WATERMARK_URL}/extract`, { method: 'POST', body: form })
    if (res.ok) {
      const { proofId, confidence } = await res.json()
      if (proofId != null && confidence >= 0.7) {
        proof = db.prepare(`${PROOF_LOOKUP} WHERE p.id = ? LIMIT 1`).get(proofId)
        if (proof) {
          return proofResponse(proof, {
            verified: false, match: 'watermark-recovered', confidence, sha256, sizeBytes: size,
            message: 'This file has been re-encoded (its bytes differ from the registered capture), but the invisible watermark identifies the original proof. Byte-level integrity cannot be verified.'
          })
        }
      }
    }
  } catch (e) {
    req.log.warn(`watermark extract unavailable: ${e.message}`)
  }

  return {
    found: false, sha256, sizeBytes: size,
    message: 'No proof found: no exact match and no recoverable watermark. The file was not captured with a registered device, or was modified beyond watermark survival.'
  }
})

app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT) || 3000
app.listen({ port, host: '0.0.0.0' })
