package app.trustcam

import android.util.Base64
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * RFC 3161 trusted timestamp for the canonical hash: proves the sealed file
 * existed no later than the TSA's clock says — the only third-party fact in
 * an otherwise device-claimed proof. Best-effort: offline or TSA down means
 * no token, and the proof stays valid without it (the verifier then shows
 * the capture time as device-claimed, exactly as before).
 */
object Rfc3161 {
    private const val TAG = "Rfc3161"

    // free public TSA, reachable over https (the verifier pins its cert chain)
    private const val TSA_URL = "https://timestamp.sectigo.com"

    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    // Fixed TimeStampReq template for a SHA-256 imprint, no nonce, certReq=TRUE:
    //   SEQUENCE { version 1, messageImprint { sha256, OCTET(32) }, certReq TRUE }
    // (replay of an old token is pointless — the hash is fresh per capture)
    private val REQ_PREFIX = byteArrayOf(
        0x30, 0x39, 0x02, 0x01, 0x01, 0x30, 0x31, 0x30, 0x0d, 0x06, 0x09,
        0x60, 0x86.toByte(), 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
        0x05, 0x00, 0x04, 0x20
    )
    private val REQ_SUFFIX = byteArrayOf(0x01, 0x01, 0xff.toByte())

    /**
     * Requests a timestamp token for a 32-byte SHA-256 hash. Returns the
     * TimeStampToken DER as base64 (the proof's `tsr` field), or null on any
     * failure — never throws, never blocks longer than the http timeouts.
     */
    fun token(hash: ByteArray): String? {
        require(hash.size == 32)
        return try {
            val req = Request.Builder()
                .url(TSA_URL)
                .post((REQ_PREFIX + hash + REQ_SUFFIX)
                    .toRequestBody("application/timestamp-query".toMediaType()))
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                extractToken(resp.body!!.bytes())
            }
        } catch (e: Exception) {
            Log.w(TAG, "timestamp skipped: ${e.message}")
            null
        }
    }

    /**
     * TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPT }.
     * Accepts granted(0) / grantedWithMods(1) and returns the raw token bytes.
     */
    private fun extractToken(resp: ByteArray): String? {
        var pos = header(resp, 0).first                    // enter TimeStampResp
        val (statusContent, statusEnd) = header(resp, pos) // PKIStatusInfo
        val (intContent, _) = header(resp, statusContent)  // status INTEGER
        if (resp[intContent].toInt() !in 0..1) return null
        val (_, tokenEnd) = header(resp, statusEnd)        // token = next element
        return Base64.encodeToString(resp.copyOfRange(statusEnd, tokenEnd), Base64.NO_WRAP)
    }

    /** Minimal DER header parse: returns (content start, node end). */
    private fun header(b: ByteArray, pos: Int): Pair<Int, Int> {
        var head = 2
        var len = b[pos + 1].toInt() and 0xff
        if (len and 0x80 != 0) {
            val n = len and 0x7f
            len = 0
            for (i in 0 until n) len = len * 256 + (b[pos + 2 + i].toInt() and 0xff)
            head = 2 + n
        }
        return Pair(pos + head, pos + head + len)
    }
}
