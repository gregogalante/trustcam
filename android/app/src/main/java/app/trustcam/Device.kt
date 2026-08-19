package app.trustcam

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Device identity, fully local: display name + random device UUID generated
 * at setup. There is no account (yet) — the UUID is the key the future cloud
 * registration will use; today it only travels inside each file's proof.
 */
class Device(context: Context) {
    private val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    var name: String?
        get() = prefs.getString("deviceName", null)
        set(v) { prefs.edit().putString("deviceName", v).apply() }

    val ready get() = !name.isNullOrEmpty()

    val deviceId: String
        get() {
            var id = prefs.getString("deviceUuid", null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString("deviceUuid", id).apply()
            }
            return id
        }

    /** Picks a fresh random id. Files already sealed keep the old id in their proof. */
    fun regenerateDeviceId() {
        prefs.edit().putString("deviceUuid", UUID.randomUUID().toString()).apply()
    }

    /** Self-contained device record (what a future cloud registration would store). */
    fun enrollmentJson(model: String, key: DeviceKey.Info): JSONObject = JSONObject()
        .put("deviceId", deviceId)
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
