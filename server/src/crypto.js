import crypto from 'crypto'

// Signature convention (shared with the Android app):
// sig = ECDSA-P256(SHA256(H)) where H = the 32 raw bytes of the file's SHA-256.
// The app signs H with Android's SHA256withECDSA; verifying re-hashes H.
export function verifyFileSignature (sha256Hex, signatureB64, publicKeyPem) {
  try {
    const hashBytes = Buffer.from(sha256Hex, 'hex')
    if (hashBytes.length !== 32) return false
    return crypto.verify(
      'sha256', hashBytes,
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64')
    )
  } catch {
    return false
  }
}

// MVP attestation check: the enrolled public key must match the attestation
// leaf certificate's key. Full chain validation against the Google hardware
// attestation roots (incl. RKP root, mandatory since 2026-04) is a phase-1 TODO.
export function attestationLeafMatchesKey (chainB64, publicKeyPem) {
  try {
    const leaf = new crypto.X509Certificate(Buffer.from(chainB64[0], 'base64'))
    const enrolled = crypto.createPublicKey(publicKeyPem)
    return leaf.publicKey.equals(enrolled)
  } catch {
    return false
  }
}

export function sha256Stream (stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let size = 0
    stream.on('data', chunk => { hash.update(chunk); size += chunk.length })
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }))
    stream.on('error', reject)
  })
}
