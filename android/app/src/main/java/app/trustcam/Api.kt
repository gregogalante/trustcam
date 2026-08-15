package app.trustcam

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Thin client for the TrustCam registry API. All calls are blocking — use off the main thread. */
class Api(context: Context) {
    private val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val json = "application/json".toMediaType()

    // Fixed production endpoint; prefs override is a hidden dev escape hatch
    var baseUrl: String
        get() = prefs.getString("baseUrl", null)?.takeIf { it.isNotEmpty() } ?: BuildConfig.BASE_URL
        set(v) { prefs.edit().putString("baseUrl", v.trimEnd('/')).apply() }

    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v).apply() }

    var deviceId: Long
        get() = prefs.getLong("deviceId", -1)
        set(v) { prefs.edit().putLong("deviceId", v).apply() }

    val loggedIn get() = !token.isNullOrEmpty() && deviceId > 0

    private fun post(path: String, body: JSONObject, auth: Boolean = false): JSONObject {
        val req = Request.Builder()
            .url(baseUrl + path)
            .post(body.toString().toRequestBody(json))
            .apply { if (auth) header("Authorization", "Bearer $token") }
            .build()
        http.newCall(req).execute().use { res ->
            val parsed = JSONObject(res.body!!.string())
            if (!res.isSuccessful) {
                throw ApiException(parsed.optString("error", "HTTP ${res.code}"))
            }
            return parsed
        }
    }

    fun login(email: String, password: String) {
        token = post("/api/auth/login", JSONObject()
            .put("email", email).put("password", password)
        ).getString("token")
    }

    fun enrollDevice(model: String, key: DeviceKey.Info) {
        deviceId = post("/api/devices", JSONObject()
            .put("model", model)
            .put("publicKeyPem", key.publicKeyPem)
            .put("attestationChain", JSONArray(key.attestationChainB64))
            .put("securityLevel", key.securityLevel), auth = true
        ).getLong("id")
    }

    /**
     * Batch-syncs offline proofs. Returns the payloads the server acknowledged
     * (newly synced or already known). Throws on network failure — caller retries later.
     */
    /** One-time download of the embedder graph after sign-in (~90MB). */
    fun downloadModel(dest: java.io.File, onProgress: (Int) -> Unit) {
        val req = Request.Builder().url("$baseUrl/models/embedder_key.onnx").build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException("model download failed: HTTP ${res.code}")
            val total = res.body!!.contentLength()
            val tmp = java.io.File(dest.parentFile, dest.name + ".part")
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
            if (!tmp.renameTo(dest)) throw ApiException("model save failed")
        }
    }

    fun syncProofs(pending: JSONArray): Set<Int> {
        if (pending.length() == 0) return emptySet()
        val res = post("/api/proofs/sync", JSONObject()
            .put("deviceId", deviceId)
            .put("proofs", pending), auth = true)
        val acked = mutableSetOf<Int>()
        val results = res.getJSONArray("results")
        for (i in 0 until results.length()) {
            val r = results.getJSONObject(i)
            if (r.getString("status") in setOf("synced", "already-synced")) {
                acked.add(r.getInt("payload"))
            }
        }
        return acked
    }
}

class ApiException(message: String) : Exception(message)
