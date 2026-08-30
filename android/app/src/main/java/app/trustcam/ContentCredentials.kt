package app.trustcam

import android.content.Context
import android.util.Log
import org.contentauth.c2pa.C2PA
import org.contentauth.c2pa.SignerInfo
import org.contentauth.c2pa.SigningAlgorithm
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * C2PA / Content Credentials manifest embedding (dual-emit: the manifest is a
 * standards-facing mirror of the proof; the trailer remains the cryptographic
 * binding TrustCam itself verifies).
 *
 * DEVELOPMENT CREDENTIALS: manifests are currently signed with the bundled
 * self-signed certificate (assets/c2pa_dev_cert.pem) — every external C2PA
 * validator will show the chain as untrusted until it is replaced by a
 * CA-issued credential. The embedding happens BEFORE hashing/sealing, so the
 * manifest is covered by the trailer signature.
 */
object ContentCredentials {
    private const val TAG = "ContentCredentials"
    private const val TSA_URL = "https://timestamp.sectigo.com"

    /**
     * Embeds a signed manifest into src, writing to dst. Best-effort: returns
     * false (and leaves dst untouched) on any failure — the capture is still
     * sealed by the trailer either way.
     */
    fun embed(context: Context, src: File, dst: File,
              captureId: String, deviceId: String): Boolean {
        return try {
            val cert = context.assets.open("c2pa_dev_cert.pem").readBytes().decodeToString()
            val key = context.assets.open("c2pa_dev_key.pem").readBytes().decodeToString()
            val manifest = JSONObject()
                .put("claim_generator_info", JSONArray().put(JSONObject()
                    .put("name", "TrustCam")
                    .put("version", BuildConfig.VERSION_NAME)))
                .put("title", "TC_${captureId.substring(0, 8)}")
                .put("assertions", JSONArray()
                    .put(JSONObject()
                        .put("label", "c2pa.actions")
                        .put("data", JSONObject().put("actions", JSONArray().put(JSONObject()
                            .put("action", "c2pa.created")
                            .put("digitalSourceType",
                                "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture")))))
                    .put(JSONObject()
                        .put("label", "app.trustcam.capture")
                        .put("data", JSONObject()
                            .put("captureId", captureId)
                            .put("deviceId", deviceId))))
                .toString()
            C2PA.sign(src, dst, manifest, SignerInfo(SigningAlgorithm.ES256, cert, key, TSA_URL))
            dst.exists() && dst.length() > 0
        } catch (e: Exception) {
            Log.w(TAG, "manifest embedding skipped: ${e.message}")
            false
        }
    }
}
