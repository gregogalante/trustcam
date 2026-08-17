package app.trustcam

/**
 * Watermark payload codec v2 — MUST mirror spikes/codec_v2.py bit-for-bit:
 * 256-float message = 128 data bits (proofId 24 | pHash 104, MSB-first)
 * + 124 BCH(255,131,t=18) parity bits + 4 zero pad.
 * BCH parity is linear over GF(2), so encoding needs no BCH math on device:
 * parity = XOR of the precomputed generator rows of every set data bit.
 */
object PayloadCodecV2 {
    const val BITS = 256
    const val PHASH_BYTES = 13
    private const val DATA_BITS = 128
    private const val PROOF_ID_BITS = 24
    private const val MAX_ID = 1 shl PROOF_ID_BITS

    /**
     * Generator rows from spikes/results/checksum_vectors.json (bchMatrix):
     * row b = ecc of the message with only data bit b (MSB-first) set.
     * 31 hex chars = 124 parity bits per row.
     */
    private val MATRIX = arrayOf(
        "9c5900abd213239dfaa8633b92d7b2f", "c3c93632dd8adb0badeba0854bec80b", "ec012d7e5a462740864a415a2771199", "fbe520d819a05965139ab1b5913fd50",
        "7df2906c0cd02cb289cd58dac89fea8", "3ef948360668165944e6ac6d644ff54", "1f7ca41b03340b2ca2735636b227faa", "0fbe520d819a05965139ab1b5913fd5",
        "8a3a9f61f44e480e782344952e0ea76", "451d4fb0fa2724073c11a24a970753b", "af6b11bf4990d8c6ceb7403dc904f01", "da503eb8904b26a637e43106660521c",
        "6d281f5c482593531bf21883330290e", "36940fae2412c9a98df90c419981487", "96afb1b0268a2e11964317384e47fdf", "c6b26ebf27c65dcd9b9e1a84a5a4a73",
        "eebc8138a76064239d709c5ad0550a5", "fabbf6fb673378d49e07df35eaaddce", "7d5dfb7db399bc6a4f03ef9af556ee7", "b34b4bd9ed4f94f0773e66d5f82c2ef",
        "d440138bc22480bd6b20a2727e914eb", "e7c5bfa2d5910a9be52fc021bdcffe9", "fe0769b65e4bcf88a22871085c60a68", "7f03b4db2f25e7c4511438842e30534",
        "3f81da6d9792f3e2288a1c42171829a", "1fc0ed36cbc979f114450e210b8c14d", "8205c0fc5167f63dda9d1608074153a", "4102e07e28b3fb1eed4e8b0403a0a9d",
        "ad64c65820dab74a2618d49a83570d2", "56b2632c106d5ba5130c6a4d41ab869", "a6bc87f13cb5e717d939a43e22529a8", "535e43f89e5af38bec9cd21f11294d4",
        "29af21fc4f2d79c5f64e690f8894a6a", "14d790fe2796bce2fb273487c44a535", "878e7e18274814b42d2c0b5b60a2706", "43c73f0c13a40a5a169605adb051383",
        "ac0629e13d514fe85bf493ce5aafc5d", "dbe6a297aa2bed317d45d8ffafd0bb2", "6df3514bd515f698bea2ec7fd7e85d9", "bb1c1ec2de09b1890feee7276973770",
        "5d8e0f616f04d8c487f77393b4b9bb8", "2ec707b0b7826c6243fbb9c9da5cddc", "176383d85bc1363121fddce4ed2e6ee", "0bb1c1ec2de09b1890feee727697377",
        "883d56912273074918c0e621b9ccc27", "c9fb1d2fa5bac961dcdfe2085e6138f", "e91838f0e65e2e75bed0601cadb7c5b", "f969aa1f47ac5dff8fd7a116d45cbb1",
        "f15163689755643a97544193e8a9044", "78a8b1b44baab21d4baa20c9f454822", "3c5458da25d5590ea5d51064fa2a411", "93cf9a0a2669e6420255192aff92794",
        "49e7cd051334f321012a8c957fc93ca", "24f3e682899a79908095464abfe49e5", "9f9c4526704e760d10f5323ddd7516e", "4fce229338273b06887a991eeeba8b7",
        "aa02a72ea890d7461482dd97f5da1c7", "d8e4e5f060cb21665afeffd3786a57f", "e197c49f04e6da767dc0eef13eb2723", "fd2e5428b6f027fe6e5fe6601dde60d",
        "f3729c736ffb593a679062288c6869a", "79b94e39b7fdac9d33c83114463434d", "b139117bef7d9c8bc95b8992a19d43a", "589c88bdf7bece45e4adc4c950cea1d",
        "a1abf239cf5c2de7a2e9737c2ae0092", "50d5f91ce7ae16f3d174b9be1570049", "a58f4ae9475441bcb805cdc7883f5b8", "52c7a574a3aa20de5c02e6e3c41fadc",
        "2963d2ba51d5106f2e017371e20fd6e", "14b1e95d28ea88379700b9b8f107eb7", "87bd42c9a0f60ede9b3fcdc4fa04ac7", "ce3b1703e4f84daa1d2077faff850ff",
        "eaf83de6c6ff6c105e2faae5fd45de3", "f899a89457fcfccd7fa8446a7c25b6d", "f1a9622d1f7d34a3ef6bb32dbc9582a", "78d4b1168fbe9a51f7b5d996de4ac15",
        "b18feeec735c07edab657dd3eda2396", "58c7f77639ae03f6d5b2bee9f6d11cb", "a1864ddc28544b3e3a66ce6c79efd79", "dd26908920a96f5a4d8cf62ebe70b20",
        "6e9348449054b7ad26c67b175f38590", "3749a422482a5bd693633d8baf9c2c8", "1ba4d21124152deb49b19ec5d7ce164", "0dd26908920a96f5a4d8cf62ebe70b2",
        "06e9348449054b7ad26c67b175f3859", "8e912c251001ef783989a2c0387e9b0", "474896128800f7bc1cc4d1601c3f4d8", "23a44b0944007bde0e6268b00e1fa6c",
        "11d22584a2003def07313458070fd36", "08e912c251001ef783989a2c0387e9b", "89913f061c0345be9173dc0e8344ad1", "c92d29e43a82e81a18067f1fc3250f4",
        "649694f21d41740d0c033f8fe19287a", "324b4a790ea0ba0686019fc7f0c943d", "94c0135bb3d317c613bf5efb7ae3f82", "4a6009add9e98be309dfaf7dbd71fc1",
        "a8d5b2b1d8778f34d45046a65c3fa7c", "546ad958ec3bc79a6a2823532e1fd3e", "2a356cac761de3cd351411a9970fe9f", "98ff00310f8dbb23ca3599cc4900ad3",
        "c19a367fb3459754b5a55dfea6070f5", "ed28ad58ed21816f0a6d3fe7d184de6", "769456ac7690c0b785369ff3e8c26f3", "b6af9d310fcb2a9e9224dee176e66e5",
        "d6b278ffb366df8a19adfe6839f46ee", "6b593c7fd9b36fc50cd6ff341cfa377", "b8492858d85afd27d6d4ee828cfa427", "d1c1224b58ae3456bbd5e659c4fa78f",
        "e505274298d450ee0d55623460fa65b", "ff6725c678e962b256152002b2fa6b1", "f256248408f7fb9c7bb50119dbfa6c4", "792b1242047bfdce3dda808cedfd362",
        "3c958921023dfee71eed404676fe9b1", "93af72f7b59db5b6dfc9313bb9f8144", "49d7b97bdacedadb6fe4989ddcfc0a2", "24ebdcbded676d6db7f24c4eee7e051",
        "9f905839c230fc738b46b73ff5b85b4", "4fc82c1ce1187e39c5a35b9ffadc2da", "27e4160e708c3f1ce2d1adcffd6e16d", "9e17bd600cc5554b21d747ff7c3052a",
        "4f0bdeb00662aaa590eba3ffbe18295", "aa60593f37b21f9798ca40e75d8b4d6", "55302c9f9bd90fcbcc652073aec5a6b", "a77da028f96fcd20b68d012155e58a9",
        "de5b66734834ac550bf9118828759c8", "6f2db339a41a562a85fc88c4143ace4", "3796d99cd20d2b1542fe44620a1d672", "1bcb6cce6906958aa17f2231050eb39",
    )

    // Rows split as (hi 60 bits, lo 64 bits) for cheap XOR accumulation.
    private val rowHi = LongArray(DATA_BITS)
    private val rowLo = LongArray(DATA_BITS)

    init {
        for (b in 0 until DATA_BITS) {
            rowHi[b] = MATRIX[b].substring(0, 15).toLong(16)
            rowLo[b] = MATRIX[b].substring(15).toULong(16).toLong()
        }
    }

    /** 256-float message (0/1) for the embedder graph; phash is 13 bytes (104 bits). */
    fun encode(proofId: Int, phash: ByteArray): FloatArray {
        require(proofId in 1 until MAX_ID) { "proofId out of range" }
        require(phash.size == PHASH_BYTES) { "phash must be $PHASH_BYTES bytes" }
        val msg = FloatArray(BITS)
        var hi = 0L
        var lo = 0L
        for (i in 0 until DATA_BITS) {
            // data bits MSB-first: 24-bit proofId then 104-bit phash
            val bit = if (i < PROOF_ID_BITS) {
                (proofId shr (PROOF_ID_BITS - 1 - i)) and 1
            } else {
                val p = i - PROOF_ID_BITS
                (phash[p ushr 3].toInt() shr (7 - (p and 7))) and 1
            }
            if (bit == 1) {
                msg[i] = 1f
                hi = hi xor rowHi[i]
                lo = lo xor rowLo[i]
            }
        }
        // parity bits 128..251 (last 4 message bits stay zero pad)
        for (j in 0 until 60) msg[DATA_BITS + j] = ((hi shr (59 - j)) and 1L).toFloat()
        for (j in 0 until 64) msg[DATA_BITS + 60 + j] = ((lo ushr (63 - j)) and 1L).toFloat()
        return msg
    }

    /** proofId layout unchanged from v1: deviceId(10) << 14 | counter(14). */
    fun payloadOf(deviceId: Long, counter: Int): Int = PayloadCodec.payloadOf(deviceId, counter)
}
