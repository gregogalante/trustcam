package app.trustcam

/**
 * Watermark payload codec — MUST mirror watermark/codec.py on the server:
 * (24-bit payload || CRC-8) = 32-bit block, repeated 8x; copy r of bit i at
 * position r*32+i, so burst errors hit at most one copy per bit.
 * Payload layout: deviceId (10 bit) << 14 | local counter (14 bit).
 */
object PayloadCodec {
    private const val BLOCK = 32
    private const val REPS = 8
    const val BITS = 256
    const val MAX_PAYLOAD = 1 shl 24

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
    fun encode(payload: Int): FloatArray {
        require(payload in 1 until MAX_PAYLOAD) { "payload out of range" }
        val block = (payload.toLong() shl 8) or crc8(payload).toLong()
        val msg = FloatArray(BITS)
        for (i in 0 until BLOCK) {
            val bit = ((block shr (BLOCK - 1 - i)) and 1L).toFloat()
            for (r in 0 until REPS) msg[r * BLOCK + i] = bit
        }
        return msg
    }

    fun payloadOf(deviceId: Long, counter: Int): Int {
        require(deviceId in 1..1023) { "deviceId does not fit the 10-bit payload prefix" }
        require(counter in 0 until (1 shl 14)) { "capture counter exhausted for this device" }
        return ((deviceId.toInt()) shl 14) or counter
    }
}
