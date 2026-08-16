package app.trustcam

import org.json.JSONObject
import java.nio.ByteBuffer

/**
 * Self-contained proof, appended to the sealed file ("proof-in-file"):
 *
 *   [4B box size][4B type "free"][proof JSON utf-8][4B json length][8B magic "TCPROOF1"]
 *
 * The whole trailer is a valid MP4 `free` box, so video players ignore it;
 * JPEG decoders ignore anything after EOI. The signature covers the canonical
 * bytes = the file WITHOUT this trailer, so verification is:
 * read last 12 bytes -> magic + length -> strip -> hash -> verify.
 */
object ProofTrailer {
    const val MAGIC = "TCPROOF1"

    fun build(proof: JSONObject): ByteArray {
        val json = proof.toString().toByteArray(Charsets.UTF_8)
        val total = 8 + json.size + 4 + 8
        return ByteBuffer.allocate(total).apply {
            putInt(total)                                  // box size
            put("free".toByteArray(Charsets.US_ASCII))     // box type
            put(json)
            putInt(json.size)
            put(MAGIC.toByteArray(Charsets.US_ASCII))
        }.array()
    }
}
