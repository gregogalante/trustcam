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

  function findSubarray (hay, needle) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) { // eslint-disable-line no-labels
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer // eslint-disable-line no-labels
      }
      return i
    }
    return -1
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

  // ECDSA signatures from Android are DER; WebCrypto wants raw r||s (P1363)
  function derSigToP1363 (der) {
    let i = 2 // SEQUENCE header (assume short-form length; P-256 sigs are < 128 bytes)
    function readInt () {
      if (der[i++] !== 0x02) throw new Error('bad DER signature')
      let len = der[i++]
      let start = i
      i += len
      while (len > 32) { start++; len-- } // strip leading zero padding
      const out = new Uint8Array(32)
      out.set(der.subarray(start, start + len), 32 - len)
      return out
    }
    const r = readInt()
    const s = readInt()
    const sig = new Uint8Array(64)
    sig.set(r, 0)
    sig.set(s, 32)
    return sig
  }

  // Verifies the trailer seal against the canonical bytes (file minus trailer).
  async function verifySeal (bytes, proof, canonicalEnd) {
    const canonical = bytes.subarray(0, canonicalEnd)
    const hash = await crypto.subtle.digest('SHA-256', canonical)
    let sigValid = false
    let attested = false
    try {
      const spki = b64ToBytes(proof.pubkey)
      const key = await crypto.subtle.importKey('spki', spki,
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      sigValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        derSigToP1363(b64ToBytes(proof.sig)), hash)
      // the attestation leaf must certify the very key that signed
      if (Array.isArray(proof.attestation) && proof.attestation.length > 0) {
        attested = findSubarray(b64ToBytes(proof.attestation[0]), spki) >= 0
      }
    } catch {}
    return { sigValid, attested, fingerprint: toHex(hash) }
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
    VIDEO_SCAN_FRAMES,
    b64ToBytes,
    toHex,
    parseTrailer,
    derSigToP1363,
    verifySeal,
    toDetectorInput,
    decodePayload,
    idKey,
    idPretty,
    deviceIdOf,
    captureOf,
    markIdHex,
    sampleByMarkId
  }
})()
