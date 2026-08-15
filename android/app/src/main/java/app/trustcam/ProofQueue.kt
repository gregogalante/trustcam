package app.trustcam

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Offline proof queue: captures are watermarked and signed fully on-device;
 * entries wait here until connectivity allows a batch sync.
 */
class ProofQueue(context: Context) {
    private val file = File(context.filesDir, "proof_queue.json")
    private val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)

    /** Next value of the local capture counter (14-bit payload suffix). */
    fun nextCounter(): Int {
        val n = prefs.getInt("captureCounter", 0)
        prefs.edit().putInt("captureCounter", n + 1).apply()
        return n
    }

    @Synchronized
    fun enqueue(payload: Int, sha256: String, signature: String,
                mediaType: String, sizeBytes: Long, capturedAt: String) {
        val all = readAll()
        all.put(JSONObject()
            .put("payload", payload)
            .put("sha256", sha256)
            .put("signature", signature)
            .put("mediaType", mediaType)
            .put("sizeBytes", sizeBytes)
            .put("capturedAt", capturedAt))
        file.writeText(all.toString())
    }

    @Synchronized
    fun pending(): JSONArray = readAll()

    /** Removes entries the server acknowledged (synced or duplicate). */
    @Synchronized
    fun removeAcked(ackedPayloads: Set<Int>) {
        val all = readAll()
        val rest = JSONArray()
        for (i in 0 until all.length()) {
            val e = all.getJSONObject(i)
            if (e.getInt("payload") !in ackedPayloads) rest.put(e)
        }
        file.writeText(rest.toString())
    }

    private fun readAll(): JSONArray =
        if (file.exists()) JSONArray(file.readText()) else JSONArray()
}
