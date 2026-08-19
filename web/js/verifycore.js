// Shared verification core — the ONE implementation used by both the browser
// verifier (verify.html) and the CLI (verify.mjs, node). Everything here must
// run in both environments: WebCrypto (crypto.subtle), TextDecoder and atob
// are available in browsers and node >= 18.
// Depends on codec.js and codec_v3.js being loaded first.
;(typeof window !== 'undefined' ? window : globalThis).TrustCamVerifyCore = (() => {
  const root = typeof window !== 'undefined' ? window : globalThis
  const MAGIC = 'TCPROOF1'

  const V1_MIN_CONFIDENCE = 0.7
  const SCAN_MAX_DIM = 1536 // longest image side fed to the detector
  // the aspect-restore rescue works on native pixels (the extra downscale
  // costs the few bits of margin a cropped copy has left)
  const RESCUE_MAX_DIM = 2560
  const VIDEO_SCAN_FRAMES = 24 // frames sampled evenly across the duration

  function b64ToBytes (b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function toHex (bytes) {
    return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // ---------- proof trailer ----------
  function parseTrailer (bytes) {
    const n = bytes.length
    if (n < 20) return null
    const magic = new TextDecoder().decode(bytes.subarray(n - 8))
    if (magic !== MAGIC) return null
    const dv = new DataView(bytes.buffer, bytes.byteOffset + n - 12, 4)
    const jsonLen = dv.getUint32(0)
    if (jsonLen <= 0 || jsonLen > n - 20) return null
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(n - 12 - jsonLen, n - 12)))
      return { proof: json, canonicalEnd: n - 20 - jsonLen }
    } catch { return null }
  }

  // ECDSA signatures from Android are DER; WebCrypto wants raw r||s (P1363).
  // size = bytes per integer (32 for P-256, 48 for P-384).
  function derSigToP1363 (der, size = 32) {
    const seq = derParse(der, 0)
    const [ri, si] = derChildren(der, seq)
    function pad (node) {
      let start = node.content
      let len = node.len
      while (len > size) { start++; len-- } // strip leading zero padding
      const out = new Uint8Array(size)
      out.set(der.subarray(start, start + len), size - len)
      return out
    }
    const sig = new Uint8Array(size * 2)
    sig.set(pad(ri), 0)
    sig.set(pad(si), size)
    return sig
  }

  // ---------- minimal DER / X.509 ----------
  function derParse (b, pos) {
    const tag = b[pos]
    let len = b[pos + 1]
    let head = 2
    if (len & 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + b[pos + 2 + i]
      head = 2 + n
    }
    return { tag, start: pos, content: pos + head, len, end: pos + head + len }
  }

  function derChildren (b, node) {
    const out = []
    let p = node.content
    while (p < node.end) {
      const c = derParse(b, p)
      out.push(c)
      p = c.end
    }
    return out
  }

  function derOid (b, node) {
    const v = b.subarray(node.content, node.end)
    const parts = [Math.floor(v[0] / 40), v[0] % 40]
    let acc = 0
    for (let i = 1; i < v.length; i++) {
      acc = acc * 128 + (v[i] & 0x7f)
      if (!(v[i] & 0x80)) { parts.push(acc); acc = 0 }
    }
    return parts.join('.')
  }

  const EC_CURVES = {
    '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
    '1.3.132.0.34': { name: 'P-384', size: 48 },
    '1.3.132.0.35': { name: 'P-521', size: 66 }
  }
  const SIG_ALGS = {
    '1.2.840.10045.4.3.2': { kind: 'EC', hash: 'SHA-256' },
    '1.2.840.10045.4.3.3': { kind: 'EC', hash: 'SHA-384' },
    '1.2.840.10045.4.3.4': { kind: 'EC', hash: 'SHA-512' },
    '1.2.840.113549.1.1.11': { kind: 'RSA', hash: 'SHA-256' },
    '1.2.840.113549.1.1.12': { kind: 'RSA', hash: 'SHA-384' },
    '1.2.840.113549.1.1.13': { kind: 'RSA', hash: 'SHA-512' }
  }

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  function parseCert (der) {
    const cert = derParse(der, 0)
    const [tbs, sigAlg, sigVal] = derChildren(der, cert)
    const alg = SIG_ALGS[derOid(der, derChildren(der, sigAlg)[0])]
    const tbsKids = derChildren(der, tbs)
    const shift = tbsKids[0].tag === 0xa0 ? 1 : 0 // optional version [0]
    const spkiNode = tbsKids[shift + 5]
    const spki = der.subarray(spkiNode.start, spkiNode.end)
    // curve of the SUBJECT key (used to verify the NEXT cert down the chain)
    const algSeq = derChildren(der, spkiNode)[0]
    const algKids = derChildren(der, algSeq)
    const keyOid = derOid(der, algKids[0])
    const curve = keyOid === '1.2.840.10045.2.1' && algKids[1]
      ? EC_CURVES[derOid(der, algKids[1])] : null
    return {
      tbs: der.subarray(tbs.start, tbs.end),
      alg,
      sig: der.subarray(sigVal.content + 1, sigVal.end), // BIT STRING, skip pad byte
      spki,
      keyKind: keyOid === '1.2.840.10045.2.1' ? 'EC' : 'RSA',
      curve
    }
  }

  // Google hardware attestation roots — SHA-256 of the DER certificates from
  // https://android.googleapis.com/attestation/root (RSA 2022 + ECDSA 2025)
  const GOOGLE_ROOTS = [
    'cedb1cb6dc896ae5b0da3e70e9b16255c55e8d77f5f4b9d206bb45525e79892e',
    '6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0'
  ]

  // verifies one cert's signature with the issuer's public key
  async function verifyCertSig (child, issuer) {
    if (!child.alg) return false
    if (issuer.keyKind === 'EC') {
      if (!issuer.curve) return false
      const key = await crypto.subtle.importKey('spki', issuer.spki,
        { name: 'ECDSA', namedCurve: issuer.curve.name }, false, ['verify'])
      return crypto.subtle.verify({ name: 'ECDSA', hash: child.alg.hash }, key,
        derSigToP1363(child.sig, issuer.curve.size), child.tbs)
    }
    const key = await crypto.subtle.importKey('spki', issuer.spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: child.alg.hash }, false, ['verify'])
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, child.sig, child.tbs)
  }

  /**
   * Validates an Android Key Attestation chain (leaf first, base64 DER):
   * the leaf must certify exactly the signing key, every certificate must be
   * signed by the next one, and the last must be a pinned Google hardware
   * attestation root. Returns:
   *   'google-root'     chain fully verified to a Google root
   *   'unverified-root' chain internally consistent, root not a known Google one
   *   'invalid'         broken signature / malformed / wrong leaf key
   *   'none'            no chain in the proof
   */
  async function verifyAttestation (chainB64, signerSpkiB64) {
    if (!Array.isArray(chainB64) || chainB64.length === 0) return 'none'
    try {
      const certs = chainB64.map(c => parseCert(b64ToBytes(c)))
      const signer = b64ToBytes(signerSpkiB64)
      if (toHex(certs[0].spki) !== toHex(signer)) return 'invalid'
      for (let i = 0; i < certs.length - 1; i++) {
        if (!await verifyCertSig(certs[i], certs[i + 1])) return 'invalid'
      }
      const root = certs[certs.length - 1]
      if (!await verifyCertSig(root, root)) return 'invalid' // self-signature
      const rootDer = b64ToBytes(chainB64[chainB64.length - 1])
      const rootHash = toHex(await crypto.subtle.digest('SHA-256', rootDer))
      return GOOGLE_ROOTS.includes(rootHash) ? 'google-root' : 'unverified-root'
    } catch {
      return 'invalid'
    }
  }

  // Verifies the trailer seal against the canonical bytes (file minus trailer).
  async function verifySeal (bytes, proof, canonicalEnd) {
    const canonical = bytes.subarray(0, canonicalEnd)
    const hash = await crypto.subtle.digest('SHA-256', canonical)
    let sigValid = false
    try {
      const spki = b64ToBytes(proof.pubkey)
      const key = await crypto.subtle.importKey('spki', spki,
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      sigValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        derSigToP1363(b64ToBytes(proof.sig)), hash)
    } catch {}
    // full chain validation: leaf key match, cert-by-cert signatures, pinned root
    const attestation = await verifyAttestation(proof.attestation, proof.pubkey)
    return {
      sigValid,
      attestation,
      attested: attestation === 'google-root',
      fingerprint: toHex(hash)
    }
  }

  // ---------- invisible-mark payload ----------
  // RGBA pixels -> CHW float tensor data for the detector graph
  function toDetectorInput (rgba, w, h) {
    const n = w * h
    const chw = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
      chw[i] = rgba[i * 4] / 255
      chw[n + i] = rgba[i * 4 + 1] / 255
      chw[2 * n + i] = rgba[i * 4 + 2] / 255
    }
    return chw
  }

  // preds: 256 soft bits (frame-averaged for video). v3 first: its BCH check
  // is ~2^-124 false-accept, so a v3 hit is authoritative; fall back to the
  // v1 repetition codec for pre-1.2 captures.
  function decodePayload (preds) {
    const v3 = root.TrustCamCodecV3.decode(preds)
    if (v3) return { v: 3, captureIdHex: v3.captureIdHex, corrected: v3.corrected }
    const { payload, confidence } = root.TrustCamCodec.decode(preds)
    if (payload != null && confidence >= V1_MIN_CONFIDENCE) {
      return { v: 1, proofId: payload, confidence }
    }
    return null
  }

  // ---------- aspect-restore rescue ----------
  // Platforms crop to their post formats (Instagram 1:1 / 4:5); the mark grid
  // is anchored to the FULL capture frame, so a cropped copy misaligns it.
  // Restoring the capture aspect by padding the short side re-aligns the grid
  // for the surviving content. App captures are 4:3 (legacy) or 16:9.
  const CAPTURE_RATIOS = [4 / 3, 16 / 9]

  // pad plans (centered, gray fill) that turn a cropped copy back into a
  // capture-shaped frame; only ratios wider than the input make sense
  function padPlans (w, h) {
    const short = Math.min(w, h)
    const long = Math.max(w, h)
    const plans = []
    for (const r of CAPTURE_RATIOS) {
      const targetLong = Math.round(short * r)
      if (targetLong <= long + 2) continue // input is not cropped tighter than this
      plans.push(h >= w
        ? { w, h: targetLong, dx: 0, dy: Math.round((targetLong - h) / 2) }
        : { w: targetLong, h, dx: Math.round((targetLong - w) / 2), dy: 0 })
    }
    return plans
  }

  // canonical UUID string -> 32-hex key used by samples.json
  function idKey (uuidOrHex) {
    return String(uuidOrHex || '').toLowerCase().replace(/-/g, '')
  }

  // pretty print a 32-hex capture id as a canonical UUID
  function idPretty (hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  function deviceIdOf (proofId) { return Math.floor(proofId / 16384) }
  function captureOf (proofId) { return proofId % 16384 }

  // 24-bit video mark id as 6 hex chars (the samples.json binding key)
  function markIdHex (id) { return id.toString(16).padStart(6, '0') }

  // find the sample entry bound to a 24-bit video mark id
  function sampleByMarkId (db, id) {
    const hex = markIdHex(id)
    for (const [key, entry] of Object.entries(db.samples || {})) {
      if (entry.markId === hex) return { key, entry }
    }
    return null
  }

  return {
    MAGIC,
    V1_MIN_CONFIDENCE,
    SCAN_MAX_DIM,
    RESCUE_MAX_DIM,
    VIDEO_SCAN_FRAMES,
    b64ToBytes,
    toHex,
    parseTrailer,
    derSigToP1363,
    verifyAttestation,
    verifySeal,
    toDetectorInput,
    decodePayload,
    idKey,
    idPretty,
    deviceIdOf,
    captureOf,
    markIdHex,
    sampleByMarkId,
    padPlans
  }
})()
