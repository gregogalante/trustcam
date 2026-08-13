import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcryptjs'
import path from 'path'
import { fileURLToPath } from 'url'
import db from './db.js'
import { verifyFileSignature, attestationLeafMatchesKey, sha256Stream } from './crypto.js'

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

// --- public verification ---

app.post('/api/verify', async (req, reply) => {
  const file = await req.file()
  if (!file) return reply.code(400).send({ error: 'file required' })
  const { sha256, size } = await sha256Stream(file.file)

  const proof = db.prepare(`
    SELECT p.*, d.model, d.security_level, d.public_key_pem, d.attestation_chain, u.name AS owner_name
    FROM proofs p JOIN devices d ON d.id = p.device_id JOIN users u ON u.id = p.user_id
    WHERE p.sha256 = ? ORDER BY p.id LIMIT 1
  `).get(sha256)

  if (!proof) {
    return {
      found: false, sha256, sizeBytes: size,
      message: 'No proof registered for this exact file. The file may have been re-encoded or modified after capture, or was not captured with a registered device.'
    }
  }

  // Re-verify the stored signature against the recomputed hash — the DB row
  // is a claim, the signature is the evidence.
  const signatureValid = verifyFileSignature(sha256, proof.signature, proof.public_key_pem)

  return {
    found: true,
    verified: signatureValid,
    sha256,
    sizeBytes: size,
    mediaType: proof.media_type,
    owner: proof.owner_name,
    device: { model: proof.model, securityLevel: proof.security_level, attested: !!proof.attestation_chain },
    capturedAt: proof.captured_at,
    registeredAt: proof.created_at
  }
})

app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT) || 3000
app.listen({ port, host: '0.0.0.0' })
