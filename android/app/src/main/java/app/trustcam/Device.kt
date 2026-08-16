package app.trustcam

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Device identity, fully local: display name + random 10-bit device id chosen
 * at setup (collision odds are negligible at experiment scale), plus the
 * capture counter for the watermark payload. There is no account and no
 * registry API — enrollment means adding this device's JSON to the public
 * registry.json in the site repo.
 */
class Device(context: Context) {
    private val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    var name: String?
        get() = prefs.getString("deviceName", null)
        set(v) { prefs.edit().putString("deviceName", v).apply() }

    // key is NOT "deviceId": 0.5.x stored a Long there (server-assigned id) and
    // reusing it would ClassCastException on update installs
    val ready get() = !name.isNullOrEmpty() && prefs.getInt("localDeviceId", 0) > 0

    val deviceId: Int
        get() {
            var id = prefs.getInt("localDeviceId", 0)
            if (id == 0) {
                id = SecureRandom().nextInt(1023) + 1 // 1..1023 (10-bit, 0 reserved)
                prefs.edit().putInt("localDeviceId", id).apply()
            }
            return id
        }

    /** Picks a fresh random id — only for registry collisions. Files already
     *  sealed keep the old id in their watermark. */
    fun regenerateDeviceId() {
        prefs.edit()
            .putInt("localDeviceId", SecureRandom().nextInt(1023) + 1)
            .apply()
    }

    fun nextCounter(): Int {
        val n = prefs.getInt("captureCounter", 0)
        prefs.edit().putInt("captureCounter", n + 1).apply()
        return n
    }

    /** Entry to paste into the public registry.json (one-time, per device). */
    fun enrollmentJson(model: String, key: DeviceKey.Info): JSONObject = JSONObject()
        .put("name", name)
        .put("model", model)
        .put("securityLevel", key.securityLevel)
        .put("pubkey", key.publicKeySpkiB64)
        .put("attestation", JSONArray(key.attestationChainB64))
        .put("enrolledAt", Instant.now().toString())

    /** One-time download of the embedder graph from the static site (~90MB). */
    fun downloadModel(dest: File, onProgress: (Int) -> Unit) {
        val req = Request.Builder().url("${BuildConfig.BASE_URL}/models/embedder_key.onnx").build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw RuntimeException("model download failed: HTTP ${res.code}")
            val total = res.body!!.contentLength()
            val tmp = File(dest.parentFile, dest.name + ".part")
            res.body!!.byteStream().use { ins ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(1 shl 16)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct != last) { last = pct; onProgress(pct) }
                        }
                    }
                }
            }
            if (!tmp.renameTo(dest)) throw RuntimeException("model save failed")
        }
    }
}
