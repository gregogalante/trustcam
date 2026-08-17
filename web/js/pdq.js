// PDQ perceptual hash — JS port of spikes/pdq_ref.py (itself a line-by-line
// port of the official ThreatExchange pdq/cpp). Math.fround after every
// arithmetic step mirrors the reference's float32 pipeline, so bits match
// the Python vectors within 0-1 flips near the median.
;(typeof window !== 'undefined' ? window : globalThis).TrustCamPdq = (() => {
  const REC601 = [0.299, 0.587, 0.114]
  const f32 = Math.fround

  // one pass of the Jarosz box filter along a vector (four phases: ramp-up,
  // initial full windows, steady state, ramp-down)
  function box1d (invec, inOff, inStride, outvec, outOff, outStride, n, fullWindow) {
    const half = Math.floor((fullWindow + 2) / 2)
    const p1 = half - 1
    const p2 = fullWindow - half + 1
    const p3 = n - fullWindow
    const p4 = half - 1
    let li = 0
    let ri = 0
    let oi = 0
    let s = 0
    let win = 0
    for (let k = 0; k < p1; k++) {
      s = f32(s + invec[inOff + ri * inStride])
      win++
      ri++
    }
    for (let k = 0; k < p2; k++) {
      s = f32(s + invec[inOff + ri * inStride])
      win++
      outvec[outOff + oi * outStride] = f32(s / win)
      ri++
      oi++
    }
    for (let k = 0; k < p3; k++) {
      s = f32(s + invec[inOff + ri * inStride])
      s = f32(s - invec[inOff + li * inStride])
      outvec[outOff + oi * outStride] = f32(s / win)
      li++
      ri++
      oi++
    }
    for (let k = 0; k < p4; k++) {
      s = f32(s - invec[inOff + li * inStride])
      win--
      outvec[outOff + oi * outStride] = f32(s / win)
      li++
      oi++
    }
  }

  // two reps of row-then-column box filtering, in place on buf (rows*cols)
  function jarosz (buf, rows, cols, wrow, wcol) {
    const tmp = new Float32Array(rows * cols)
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < rows; i++) {
        box1d(buf, i * cols, 1, tmp, i * cols, 1, cols, wrow)
      }
      for (let j = 0; j < cols; j++) {
        box1d(tmp, j, cols, buf, j, cols, rows, wcol)
      }
    }
  }

  // center-sample decimation to 64x64
  function decimate (buf, rows, cols) {
    const out = new Float32Array(64 * 64)
    for (let oi = 0; oi < 64; oi++) {
      const ii = Math.floor(((oi + 0.5) * rows) / 64)
      for (let oj = 0; oj < 64; oj++) {
        const jj = Math.floor(((oj + 0.5) * cols) / 64)
        out[oi * 64 + oj] = buf[ii * cols + jj]
      }
    }
    return out
  }

  // 16x64 DCT-II matrix with the PDQ (i+1) row offset, float32 entries
  const DCT = (() => {
    const scale = f32(Math.sqrt(2.0 / 64.0))
    const d = new Float32Array(16 * 64)
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 64; j++) {
        d[i * 64 + j] = f32(scale * f32(Math.cos((Math.PI / 2.0 / 64.0) * (i + 1) * (2 * j + 1))))
      }
    }
    return d
  })()

  // Torben median (no sort, matches the C++ reference exactly)
  function torben (m) {
    const n = m.length
    let lo = m[0]
    let hi = m[0]
    for (let i = 1; i < n; i++) {
      if (m[i] < lo) lo = m[i]
      if (m[i] > hi) hi = m[i]
    }
    const halfN = Math.floor((n + 1) / 2)
    let less = 0
    let greater = 0
    let guess = 0
    let maxlt = 0
    let mingt = 0
    for (;;) {
      guess = f32(f32(lo + hi) / 2)
      less = 0
      greater = 0
      maxlt = lo
      mingt = hi
      for (let i = 0; i < n; i++) {
        if (m[i] < guess) {
          less++
          if (m[i] > maxlt) maxlt = m[i]
        } else if (m[i] > guess) {
          greater++
          if (m[i] < mingt) mingt = m[i]
        }
      }
      if (less <= halfN && greater <= halfN) break
      if (less > greater) hi = maxlt
      else lo = mingt
    }
    const equal = n - less - greater
    if (less >= halfN) return maxlt
    if (less + equal >= halfN) return guess
    return mingt
  }

  // luma: rows*cols values 0..255 (plain Array or typed array, row-major).
  // Returns Uint8Array(32) — bit k (MSB byte 0) = DCT coeff (k/16, k%16) > median.
  function fromLuma (luma, width, height) {
    const rows = height
    const cols = width
    let b64
    if (rows === 64 && cols === 64) {
      b64 = Float32Array.from(luma)
    } else {
      const buf = Float32Array.from(luma)
      const wrow = Math.floor((cols + 127) / 128)
      const wcol = Math.floor((rows + 127) / 128)
      jarosz(buf, rows, cols, wrow, wcol)
      b64 = decimate(buf, rows, cols)
    }

    // 16x64 * 64x64 * 64x16 DCT. Sequential accumulation with the product
    // kept in double and one rounding per step (FMA semantics) reproduces
    // numpy's float32 sgemm bit-exactly on the reference vectors.
    const tmp = new Float32Array(16 * 64) // DCT @ b64
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 64; j++) {
        let s = 0
        for (let k = 0; k < 64; k++) s = f32(s + DCT[i * 64 + k] * b64[k * 64 + j])
        tmp[i * 64 + j] = s
      }
    }
    const B = new Float32Array(16 * 16) // tmp @ DCT^T
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        let s = 0
        for (let k = 0; k < 64; k++) s = f32(s + tmp[i * 64 + k] * DCT[j * 64 + k])
        B[i * 16 + j] = s
      }
    }

    const median = torben(B)
    const hash = new Uint8Array(32)
    for (let k = 0; k < 256; k++) {
      if (B[k] > median) hash[k >> 3] |= 1 << (7 - (k & 7))
    }
    return hash
  }

  // data: RGBA Uint8ClampedArray (canvas ImageData.data), REC601 luma
  function fromImageData (data, width, height) {
    const luma = new Float32Array(width * height)
    for (let p = 0; p < luma.length; p++) {
      const o = p * 4
      luma[p] = f32(f32(REC601[0] * data[o]) + f32(REC601[1] * data[o + 1]) + f32(REC601[2] * data[o + 2]))
    }
    return fromLuma(luma, width, height)
  }

  // Hamming distance over the first 104 bits (13 bytes) — the pHash slice
  function hamming104 (hashBytes, otherBytes) {
    let d = 0
    for (let i = 0; i < 13; i++) {
      let x = hashBytes[i] ^ otherBytes[i]
      while (x) {
        d += x & 1
        x >>= 1
      }
    }
    return d
  }

  return { fromLuma, fromImageData, hamming104 }
})()
