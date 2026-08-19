// Payload codec v3 for the 256-bit VideoSeal message — JS port of the decoder
// half of spikes/codec_v3.py (bit-identical wire format).
// Layout: 128 data bits (captureId, MSB-first) + 124 BCH parity + 4 zero pad.
// Code: BCH(255,131,t=18) over GF(2^8), primitive poly 0x11d (Linux-kernel
// bch, as produced by python bchlib), shortened to 252 coded bits — the 3
// missing leading data bits are implicit zeros.
// Bit mapping: wire bit i (0..251) is the coefficient of x^(251-i) in the
// codeword polynomial, so an error at exponent e sits at wire index 251-e.
;(typeof window !== 'undefined' ? window : globalThis).TrustCamCodecV3 = (() => {
  const T = 18 // correctable errors
  const N_SYND = 2 * T // 36 syndromes S_1..S_36
  const DATA_BITS = 128
  const CODED_BITS = 252 // 128 data + 124 parity
  const PRIM_POLY = 0x11d

  // GF(2^8) exp/log tables, exp doubled to skip mod in products
  const GF_EXP = new Uint8Array(512)
  const GF_LOG = new Int16Array(256)
  {
    let x = 1
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x
      GF_LOG[x] = i
      x <<= 1
      if (x & 0x100) x ^= PRIM_POLY
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
  }

  function gfMul (a, b) {
    if (a === 0 || b === 0) return 0
    return GF_EXP[GF_LOG[a] + GF_LOG[b]]
  }

  // S_j = R(alpha^j) over the received hard bits; even syndromes derived by
  // squaring (binary BCH: S_2j = S_j^2)
  function syndromes (hard) {
    const S = new Uint8Array(N_SYND + 1) // 1-based
    for (let j = 1; j <= N_SYND; j += 2) {
      let s = 0
      for (let i = 0; i < CODED_BITS; i++) {
        if (hard[i]) s ^= GF_EXP[(j * (251 - i)) % 255]
      }
      S[j] = s
    }
    for (let j = 2; j <= N_SYND; j += 2) {
      const h = S[j >> 1]
      S[j] = h === 0 ? 0 : GF_EXP[(2 * GF_LOG[h]) % 255]
    }
    return S
  }

  // Berlekamp-Massey: error locator polynomial Lambda from the syndromes.
  // Returns coefficient array [1, l1, l2, ...] or null when degree > t.
  function berlekampMassey (S) {
    let lambda = [1]
    let b = [1]
    let L = 0
    let m = 1
    let bScale = 1
    for (let n = 1; n <= N_SYND; n++) {
      // discrepancy d = S_n + sum lambda_i * S_(n-i)
      let d = S[n]
      for (let i = 1; i <= L; i++) {
        if (lambda[i] && S[n - i]) d ^= gfMul(lambda[i], S[n - i])
      }
      if (d === 0) {
        m++
        continue
      }
      const coeff = GF_EXP[(GF_LOG[d] - GF_LOG[bScale] + 255) % 255]
      const next = lambda.slice()
      for (let i = 0; i < b.length; i++) {
        if (b[i]) next[i + m] = (next[i + m] || 0) ^ gfMul(coeff, b[i])
      }
      if (2 * L <= n - 1) {
        b = lambda
        bScale = d
        L = n - L
        m = 1
      } else {
        m++
      }
      lambda = next
    }
    while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop()
    if (lambda.length - 1 > T || L !== lambda.length - 1) return null
    return lambda
  }

  // Chien search: roots Lambda(alpha^-e) = 0 give error exponents e; wire
  // index is 251-e. Returns indices or null when the root count does not
  // match the locator degree (uncorrectable) or a root falls in the 3
  // implicit leading zero bits of the shortened code.
  function chien (lambda) {
    const deg = lambda.length - 1
    const positions = []
    for (let e = 0; e < 255; e++) {
      let v = 0
      for (let i = 0; i <= deg; i++) {
        if (lambda[i]) v ^= GF_EXP[(GF_LOG[lambda[i]] + i * (255 - e)) % 255]
      }
      if (v === 0) {
        if (e > 251) return null // outside the shortened codeword
        positions.push(251 - e)
        if (positions.length === deg) break
      }
    }
    if (positions.length !== deg) return null
    return positions
  }

  // softBits: 256 logits (Float32Array or plain array), threshold > 0.
  // Returns { captureIdHex, corrected } or null when uncorrectable (or the
  // corrected captureId is all-zero — reserved/invalid).
  function decode (softBits) {
    const hard = new Uint8Array(CODED_BITS)
    for (let i = 0; i < CODED_BITS; i++) hard[i] = softBits[i] > 0 ? 1 : 0

    const S = syndromes(hard)
    let corrected = 0
    if (S.some(s => s !== 0)) {
      const lambda = berlekampMassey(S)
      if (!lambda) return null
      const positions = chien(lambda)
      if (!positions) return null
      for (const p of positions) hard[p] ^= 1
      // reject miscorrections that slipped through: residual syndromes
      if (syndromes(hard).some(s => s !== 0)) return null
      corrected = positions.length
    }

    let captureIdHex = ''
    let nonZero = false
    for (let i = 0; i < DATA_BITS; i += 4) {
      const nib = (hard[i] << 3) | (hard[i + 1] << 2) | (hard[i + 2] << 1) | hard[i + 3]
      if (nib) nonZero = true
      captureIdHex += nib.toString(16)
    }
    if (!nonZero) return null
    return { captureIdHex, corrected }
  }

  return { decode }
})()
