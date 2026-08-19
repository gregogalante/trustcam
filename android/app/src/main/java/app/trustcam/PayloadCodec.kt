package app.trustcam

/**
 * Repetition payload codec (the v1 wire format) — MUST mirror spikes/codec.py:
 * (24-bit mark id || CRC-8) = 32-bit block, repeated 8x; copy r of bit i at
 * position r*32+i, so burst errors hit at most one copy per bit.
 *
 * Used for VIDEO: the WhatsApp-class channel flips ~20-25% of the decoded
 * bits systematically, which no code carrying 128 bits in 256 can survive —
 * positional redundancy is what works (measured on real round-trips). The
 * mark id is random per capture; the proof (and the originals record) binds
 * it to the full capture UUID.
 */
object PayloadCodec {
    private const val BLOCK = 32
    private const val REPS = 8
    const val BITS = 256
    const val MAX_ID = 1 shl 24

    fun crc8(data: Int): Int {
        var crc = 0
        for (shift in intArrayOf(16, 8, 0)) {
            crc = crc xor ((data shr shift) and 0xFF)
            repeat(8) {
                crc = if (crc and 0x80 != 0) (crc shl 1) xor 0x07 else crc shl 1
                crc = crc and 0xFF
            }
        }
        return crc
    }

    /** 256-float message (0/1) for the embedder graph. */
    fun encode(markId: Int): FloatArray {
        require(markId in 1 until MAX_ID) { "markId out of range" }
        val block = (markId.toLong() shl 8) or crc8(markId).toLong()
        val msg = FloatArray(BITS)
        for (i in 0 until BLOCK) {
            val bit = ((block shr (BLOCK - 1 - i)) and 1L).toFloat()
            for (r in 0 until REPS) msg[r * BLOCK + i] = bit
        }
        return msg
    }
}
