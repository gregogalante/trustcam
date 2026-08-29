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
      // strip leading zero padding; O(1) and bounds-checked so garbage DER
      // (e.g. an RSA signature fed to the EC path) throws instead of spinning
      const skip = Math.max(0, node.len - size)
      const start = node.content + skip
      const len = node.len - skip
      if (!(len >= 0) || start + len > der.length) throw new Error('bad DER signature')
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
    let head = 1
    let tagNum = tag & 0x1f
    if (tagNum === 0x1f) { // high-tag-number form (attestation authorization tags >= 31)
      tagNum = 0
      while (b[pos + head] & 0x80) { tagNum = tagNum * 128 + (b[pos + head] & 0x7f); head++ }
      tagNum = tagNum * 128 + b[pos + head]
      head++
    }
    let len = b[pos + head]
    head++
    if (len & 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + b[pos + head + i]
      head += n
    }
    return { tag, tagNum, start: pos, content: pos + head, len, end: pos + head + len }
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

  // ---------- Android Key Attestation extension (leaf certificate) ----------
  // The extension is authenticated by the chain itself: its values are only
  // meaningful when verifyAttestation returned 'google-root'.
  const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17'
  const SECURITY_LEVELS = ['software', 'tee', 'strongbox']
  const BOOT_STATES = ['verified', 'self-signed', 'unverified', 'failed']
  // identity of the official capture app, pinned like the Google roots above:
  // package name + SHA-256 of the APK signing certificate (apksigner --print-certs)
  const APP_PACKAGE = 'app.trustcam'
  const APP_CERT_SHA256 = '9a5519ad61bdc5caaa8be4af2e2efc6417ac4a40ecc35c9957a752699938648b'

  function derInt (b, node) {
    let v = 0
    for (let i = node.content; i < node.end; i++) v = v * 256 + b[i]
    return v
  }

  /**
   * Parses the Android Key Attestation extension of the leaf certificate:
   * hardware-asserted security level, verified-boot state / bootloader lock
   * (rootOfTrust, teeEnforced) and the identity of the app that created the
   * key (attestationApplicationId, asserted by the platform). Returns null
   * when the extension is missing or unreadable.
   */
  function parseKeyDescription (leafDer) {
    try {
      const tbs = derChildren(leafDer, derParse(leafDer, 0))[0]
      const extBlock = derChildren(leafDer, tbs).find(n => n.tag === 0xa3) // extensions [3]
      if (!extBlock) return null
      let desc = null
      for (const ext of derChildren(leafDer, derChildren(leafDer, extBlock)[0])) {
        const kids = derChildren(leafDer, ext) // extnID, [critical,] extnValue
        if (derOid(leafDer, kids[0]) !== KEY_DESCRIPTION_OID) continue
        desc = derParse(leafDer, kids[kids.length - 1].content) // KeyDescription inside the OCTET STRING
        break
      }
      if (!desc) return null
      // KeyDescription: version, securityLevel, keymintVersion, keymintSecurityLevel,
      // challenge, uniqueId, softwareEnforced [6], teeEnforced [7]
      const kd = derChildren(leafDer, desc)
      const out = {
        securityLevel: SECURITY_LEVELS[derInt(leafDer, kd[1])] || 'unknown',
        bootState: null,
        deviceLocked: null,
        appPackages: null,
        appDigests: null
      }
      for (const list of [kd[6], kd[7]]) {
        for (const entry of derChildren(leafDer, list)) {
          if (entry.tagNum === 704) { // rootOfTrust [704]
            const rot = derChildren(leafDer, derChildren(leafDer, entry)[0])
            out.deviceLocked = leafDer[rot[1].content] !== 0
            out.bootState = BOOT_STATES[derInt(leafDer, rot[2])] || 'unknown'
          } else if (entry.tagNum === 709) { // attestationApplicationId [709]
            const inner = derParse(leafDer, derChildren(leafDer, entry)[0].content)
            const [pkgs, digests] = derChildren(leafDer, inner)
            out.appPackages = derChildren(leafDer, pkgs).map(p => {
              const name = derChildren(leafDer, p)[0]
              return new TextDecoder().decode(leafDer.subarray(name.content, name.end))
            })
            out.appDigests = derChildren(leafDer, digests).map(d =>
              toHex(leafDer.subarray(d.content, d.end)))
          }
        }
      }
      return out
    } catch { return null }
  }

  // ---------- RFC 3161 timestamp token ----------
  // The app fetches a token for the canonical SHA-256 at capture time (when
  // online) and stores it in the proof as `tsr` (base64 DER TimeStampToken).
  // A verified token proves the file existed NO LATER than genTime — the
  // only third-party fact in an otherwise device-claimed proof.
  const TSTINFO_OID = '1.2.840.113549.1.9.16.1.4'
  const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4'
  const HASH_OIDS = {
    '2.16.840.1.101.3.4.2.1': 'SHA-256',
    '2.16.840.1.101.3.4.2.2': 'SHA-384',
    '2.16.840.1.101.3.4.2.3': 'SHA-512'
  }
  // trusted TSA certificates, sha256 of the DER — Sectigo public time stamping
  // CA R41 + Root R46 (the signer leaf rotates; either ancestor pins the chain)
  const TSA_ROOTS = [
    '38b52fe70bdde4ecf34d77498d7cbfe48efd83294dca04de01868f7735d2db79',
    'b53ac15cc1afb6e2ac06828f555bb3bf5bad8b2bac1733ce4cb7aafe729356de'
  ]

  // "20260829061311Z" (optional fraction) -> "2026-08-29T06:13:11Z"
  function genTimeToIso (s) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s)
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null
  }

  // verify an RSA/ECDSA signature over `data` with a parsed certificate
  async function verifySigWithCert (cert, hashName, sig, data) {
    if (cert.keyKind === 'EC') {
      if (!cert.curve) return false
      const key = await crypto.subtle.importKey('spki', cert.spki,
        { name: 'ECDSA', namedCurve: cert.curve.name }, false, ['verify'])
      return crypto.subtle.verify({ name: 'ECDSA', hash: hashName }, key,
        derSigToP1363(sig, cert.curve.size), data)
    }
    const key = await crypto.subtle.importKey('spki', cert.spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: hashName }, false, ['verify'])
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)
  }

  /**
   * Verifies an RFC 3161 TimeStampToken (CMS SignedData over TSTInfo) against
   * the canonical hash: messageImprint match, messageDigest attribute over the
   * TSTInfo bytes, signer signature over the signed attributes, and the signer
   * chained to a pinned TSA certificate. Returns:
   *   { status: 'verified'|'untrusted-tsa'|'invalid', genTime, tsa? }
   * or null when tsrB64 is absent.
   */
  async function verifyTimestamp (tsrB64, hashHex) {
    if (!tsrB64) return null
    try {
      const b = b64ToBytes(tsrB64)
      // ContentInfo { signedData OID, [0] SignedData }
      const content = derChildren(b, derParse(b, 0))
      const sd = derChildren(b, derParse(b, content[1].content))
      // SignedData: version, digestAlgorithms, encapContentInfo, [0] certs, [1] crls?, signerInfos
      const encap = derChildren(b, sd[2])
      if (derOid(b, encap[0]) !== TSTINFO_OID) return { status: 'invalid', genTime: null }
      const eContent = derParse(b, derChildren(b, encap[1])[0].content) // OCTET STRING wrapping TSTInfo
      const tstBytes = b.subarray(eContent.start, eContent.end)
      // TSTInfo: version, policy, messageImprint { algId, hashedMessage }, serial, genTime
      const tst = derChildren(b, eContent)
      const imprint = derChildren(b, tst[2])
      const genTime = genTimeToIso(new TextDecoder().decode(
        b.subarray(tst[4].content, tst[4].end)))
      if (toHex(b.subarray(imprint[1].content, imprint[1].end)) !== hashHex || !genTime) {
        return { status: 'invalid', genTime: null }
      }
      // certificates [0] IMPLICIT and signerInfos (last child)
      const certsNode = sd.find(n => n.tag === 0xa0)
      const certs = certsNode
        ? derChildren(b, certsNode).map(n => {
            const der = b.subarray(n.start, n.end)
            return { der, parsed: parseCert(der) }
          })
        : []
      // SignerInfo: version, sid, digestAlgorithm, [0] signedAttrs, sigAlg, signature
      const si = derChildren(b, derChildren(b, sd[sd.length - 1])[0])
      const hashName = HASH_OIDS[derOid(b, derChildren(b, si[2])[0])]
      const attrsNode = si.find(n => n.tag === 0xa0)
      const sigNode = si[si.length - 1]
      if (!hashName || !attrsNode) return { status: 'invalid', genTime }
      // messageDigest attribute must hash the TSTInfo bytes
      let mdOk = false
      const tstDigest = toHex(await crypto.subtle.digest(hashName, tstBytes))
      for (const attr of derChildren(b, attrsNode)) {
        const kids = derChildren(b, attr)
        if (derOid(b, kids[0]) !== MESSAGE_DIGEST_OID) continue
        const val = derChildren(b, kids[1])[0]
        mdOk = toHex(b.subarray(val.content, val.end)) === tstDigest
      }
      if (!mdOk) return { status: 'invalid', genTime }
      // signature is over the signed attributes re-tagged as SET OF (0x31)
      const attrsDer = b.slice(attrsNode.start, attrsNode.end)
      attrsDer[0] = 0x31
      const sig = b.subarray(sigNode.content, sigNode.end)
      let signer = null
      for (const c of certs) {
        // a candidate that throws (unparseable key/signature) is just not the signer
        try {
          if (await verifySigWithCert(c.parsed, hashName, sig, attrsDer)) { signer = c; break }
        } catch {}
      }
      if (!signer) return { status: 'invalid', genTime }
      // walk the chain inside the token; trusted if any link is pinned
      const chainHashes = []
      let cur = signer
      for (let depth = 0; cur && depth < 6; depth++) {
        chainHashes.push(toHex(await crypto.subtle.digest('SHA-256', cur.der)))
        let next = null
        for (const c of certs) {
          try {
            if (c !== cur && await verifyCertSig(cur.parsed, c.parsed)) { next = c; break }
          } catch {}
        }
        cur = next
      }
      return {
        status: chainHashes.some(h => TSA_ROOTS.includes(h)) ? 'verified' : 'untrusted-tsa',
        genTime
      }
    } catch {
      return { status: 'invalid', genTime: null }
    }
  }

  // matches the attested app identity against the pinned official app
  function appIdentity (key) {
    if (!key || !key.appPackages) return 'unrecorded'
    return key.appPackages.includes(APP_PACKAGE) && (key.appDigests || []).includes(APP_CERT_SHA256)
      ? 'official' : 'mismatch'
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
    // hardware-asserted facts from the leaf's attestation extension
    const key = Array.isArray(proof.attestation) && proof.attestation.length
      ? parseKeyDescription(b64ToBytes(proof.attestation[0])) : null
    // RFC 3161 token over the same canonical hash (null on pre-tsr proofs)
    const timestamp = await verifyTimestamp(proof.tsr, toHex(hash))
    return {
      sigValid,
      attestation,
      attested: attestation === 'google-root',
      key,
      timestamp,
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

  // Retry plans when the direct downscaled scan fails: first the SAME frame at
  // native resolution — tall 9:16 captures come out of the 1536 scan at only
  // ~864px wide, which alone can cost the BCH margin (measured: a clean 9:16
  // original decoded with 5 errors at native res and 21 at 1536) — then the
  // aspect-restore pads for cropped copies.
  function scanPlans (w, h) {
    return [{ w, h, dx: 0, dy: 0 }, ...padPlans(w, h)]
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
    parseKeyDescription,
    appIdentity,
    APP_PACKAGE,
    verifyTimestamp,
    verifySeal,
    toDetectorInput,
    decodePayload,
    idKey,
    idPretty,
    deviceIdOf,
    captureOf,
    markIdHex,
    sampleByMarkId,
    padPlans,
    scanPlans
  }
})()
