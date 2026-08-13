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
}

class ApiException(message: String) : Exception(message)
