package app.trustcam

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** Thin client for the TrustCam registry API. All calls are blocking — use off the main thread. */
class Api(context: Context) {
    private val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // Server-side video watermarking takes minutes for long clips
        .writeTimeout(15, TimeUnit.MINUTES)
        .readTimeout(15, TimeUnit.MINUTES)
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

    fun registerProof(sha256Hex: String, signatureB64: String, mediaType: String,
                      sizeBytes: Long, capturedAtIso: String): Long {
        return post("/api/proofs", JSONObject()
            .put("deviceId", deviceId)
            .put("sha256", sha256Hex)
            .put("signature", signatureB64)
            .put("mediaType", mediaType)
            .put("sizeBytes", sizeBytes)
            .put("capturedAt", capturedAtIso), auth = true
        ).getLong("id")
    }

    /**
     * Uploads the signed capture; the server registers the proof, embeds the
     * invisible watermark and returns the watermarked file. On success the
     * callback receives the watermarked stream to persist; on watermark-service
     * failure the proof still exists and `watermarked` is false.
     */
    data class CaptureResult(val proofId: Long, val watermarked: Boolean)

    fun capture(resolver: ContentResolver, uri: Uri, filename: String,
                sha256Hex: String, signatureB64: String, mediaType: String,
                capturedAtIso: String, writeWatermarked: (InputStream) -> Unit): CaptureResult {
        val fileBody = object : RequestBody() {
            override fun contentType() =
                (if (mediaType == "video") "video/mp4" else "image/jpeg").toMediaType()
            override fun writeTo(sink: BufferedSink) {
                resolver.openInputStream(uri)!!.use { ins ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        sink.write(buf, 0, n)
                    }
                }
            }
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, fileBody)
            .addFormDataPart("deviceId", deviceId.toString())
            .addFormDataPart("sha256", sha256Hex)
            .addFormDataPart("signature", signatureB64)
            .addFormDataPart("mediaType", mediaType)
            .addFormDataPart("capturedAt", capturedAtIso)
            .build()
        val req = Request.Builder()
            .url("$baseUrl/api/capture")
            .post(body)
            .header("Authorization", "Bearer $token")
            .build()
        http.newCall(req).execute().use { res ->
            if (res.code == 502) {
                // Watermarking failed but the proof of the original is registered
                val parsed = JSONObject(res.body!!.string())
                return CaptureResult(parsed.optLong("proofId", -1), watermarked = false)
            }
            if (!res.isSuccessful) {
                throw ApiException(JSONObject(res.body!!.string()).optString("error", "HTTP ${res.code}"))
            }
            val proofId = res.header("x-proof-id")?.toLong() ?: -1
            res.body!!.byteStream().use(writeWatermarked)
            return CaptureResult(proofId, watermarked = true)
        }
    }
}

class ApiException(message: String) : Exception(message)
