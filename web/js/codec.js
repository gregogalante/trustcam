// Payload codec for the 256-bit VideoSeal message — JS port of watermark/codec.py
// (bit-identical: 24-bit payload + CRC-8 poly 0x07 = 32-bit block, 8 repetitions,
// copies of each bit sit 32 positions apart).
window.TrustCamCodec = (() => {
  const BLOCK = 32
  const REPS = 8

  function crc8 (data) {
    let crc = 0
    for (const shift of [16, 8, 0]) {
      crc ^= (data >> shift) & 0xFF
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1)
        crc &= 0xFF
      }
    }
    return crc
  }

  // softBits: Float32Array(256) of logits. Returns { payload, confidence }
  // with payload = null when the CRC does not validate.
  function decode (softBits) {
    const combined = new Float32Array(BLOCK)
    for (let i = 0; i < BLOCK; i++) {
      for (let r = 0; r < REPS; r++) combined[i] += softBits[r * BLOCK + i]
    }
    let block = 0
    for (let i = 0; i < BLOCK; i++) block = (block * 2) + (combined[i] > 0 ? 1 : 0)
    const payload = Math.floor(block / 256)
    const crc = block % 256
    let agree = 0
    for (let i = 0; i < BLOCK; i++) {
      for (let r = 0; r < REPS; r++) {
        agree += ((softBits[r * BLOCK + i] > 0) === (combined[i] > 0)) ? 1 : 0
      }
    }
    const confidence = agree / (BLOCK * REPS)
    if (crc8(payload) !== crc || payload === 0) return { payload: null, confidence }
    return { payload, confidence }
  }

  return { decode }
})()
