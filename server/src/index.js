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

// Offline sync: the app embeds watermarks on-device (payload = deviceId<<14 | counter)
// and uploads the signed proofs in batch when it gets connectivity.
app.post('/api/proofs/sync', { preHandler: auth }, async (req, reply) => {
  const { deviceId, proofs } = req.body || {}
  if (!deviceId || !Array.isArray(proofs) || proofs.length === 0 || proofs.length > 500) {
    return reply.code(400).send({ error: 'deviceId and proofs[] (1-500) required' })
  }
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, req.user.uid)
  if (!device) return reply.code(404).send({ error: 'device not found' })

  const insert = db.prepare(
    'INSERT INTO proofs (user_id, device_id, sha256, signature, media_type, size_bytes, captured_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const results = proofs.map(p => {
    const { payload, sha256, signature, mediaType, sizeBytes, capturedAt } = p || {}
    if (!payload || !sha256 || !signature || !mediaType || !sizeBytes || !capturedAt) {
      return { payload, status: 'invalid' }
    }
    // Payload namespace is per-device: reject payloads outside this device's range
    if (Math.floor(payload / 16384) !== Number(deviceId)) {
      return { payload, status: 'payload-device-mismatch' }
    }
    if (!verifyFileSignature(sha256.toLowerCase(), signature, device.public_key_pem)) {
      return { payload, status: 'bad-signature' }
    }
    try {
      insert.run(req.user.uid, deviceId, sha256.toLowerCase(), signature,
        mediaType, sizeBytes, capturedAt, payload)
      return { payload, status: 'synced' }
    } catch {
      // unique payload violation -> already synced earlier (idempotent retry)
      return { payload, status: 'already-synced' }
    }
  })
  return { results }
})

// --- public verification ---

const WATERMARK_URL = process.env.WATERMARK_URL || 'http://localhost:8000'

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
        // on-device proofs match by payload; legacy server-embedded files
        // used the row id as payload
        proof = db.prepare(`${PROOF_LOOKUP} WHERE p.payload = ? LIMIT 1`).get(proofId) ||
          db.prepare(`${PROOF_LOOKUP} WHERE p.payload IS NULL AND p.id = ? LIMIT 1`).get(proofId)
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

app.get('/api/health', async () => ({ ok: true, version: '0.5.2' }))

const port = Number(process.env.PORT) || 3000
app.listen({ port, host: '0.0.0.0' })
