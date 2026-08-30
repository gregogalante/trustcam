package app.trustcam

import android.media.MediaCodec
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * Rolling per-GOP bitstream signatures (the app ⇄ verifier SEI contract —
 * canonical reference and test fixture: spikes/make_gopsig_fixture.mjs).
 *
 * Each GOP's VCL NAL units (types 1 and 5, raw bytes incl. emulation
 * prevention, no transport framing) are SHA-256'd and the 32-byte hash is
 * signed in the secure element exactly like the trailer seal. The signature
 * rides in a user_data_unregistered SEI prepended to the NEXT GOP's keyframe:
 *
 *   [16B "TrustCamGopSig01"][ver u8=1][gopIndex u32be]
 *   [spkiLen u16be][spki][sigLen u16be][DER sig]
 *
 * The final GOP has no next keyframe: its record goes into the proof trailer
 * (`gopSig`). A losslessly trimmed copy keeps interior GOPs verifiable even
 * with the trailer long gone.
 */
class GopSigner(private val spki: ByteArray) {
    class Final(val i: Int, val sigB64: String)

    private val uuid = "TrustCamGopSig01".toByteArray(Charsets.US_ASCII)
    private var digest = MessageDigest.getInstance("SHA-256")
    private var gopIndex = -1
    private var frames = 0

    /** Transforms one encoded access unit (Annex-B): may prepend a SEI. */
    fun onSample(sample: ByteArray, isKey: Boolean): ByteArray {
        var out = sample
        if (isKey) {
            if (gopIndex >= 0 && frames > 0) {
                // seal the finished GOP; its signature travels in this keyframe
                out = annexBSei(gopIndex, sign()) + sample
            }
            digest = MessageDigest.getInstance("SHA-256")
            gopIndex++
            frames = 0
        }
        if (gopIndex >= 0) {
            for (nal in splitAnnexB(sample)) {
                val type = nal.first.toInt() and 0x1f
                if (type == 1 || type == 5) digest.update(nal.second)
            }
            frames++
        }
        return out
    }

    /** Record for the last GOP — stored in the proof trailer, not in a SEI. */
    fun finish(): Final? {
        if (gopIndex < 0 || frames == 0) return null
        return Final(gopIndex, Base64.encodeToString(sign(), Base64.NO_WRAP))
    }

    private fun sign(): ByteArray {
        val hash = digest.digest()
        return Base64.decode(DeviceKey.signHash(hash), Base64.DEFAULT)
    }

    /** (first byte, full NAL bytes) for every NAL in an Annex-B access unit. */
    private fun splitAnnexB(buf: ByteArray): List<Pair<Byte, ByteArray>> {
        val nals = ArrayList<Pair<Byte, ByteArray>>()
        val starts = ArrayList<Int>()
        var i = 0
        while (i + 3 < buf.size) {
            if (buf[i].toInt() == 0 && buf[i + 1].toInt() == 0) {
                if (buf[i + 2].toInt() == 1) { starts.add(i + 3); i += 3; continue }
                if (buf[i + 2].toInt() == 0 && i + 4 <= buf.size && buf[i + 3].toInt() == 1) {
                    starts.add(i + 4); i += 4; continue
                }
            }
            i++
        }
        for ((k, s) in starts.withIndex()) {
            // the next start code (minus its 00-prefix run) bounds this NAL
            var e = if (k + 1 < starts.size) starts[k + 1] else buf.size
            if (k + 1 < starts.size) {
                e -= 3
                if (e > s && buf[e - 1].toInt() == 0) e-- // 4-byte start code
            }
            if (e > s) nals.add(Pair(buf[s], buf.copyOfRange(s, e)))
        }
        return nals
    }

    /** Builds the signature SEI as an Annex-B NAL (start code + escaped RBSP). */
    private fun annexBSei(index: Int, sig: ByteArray): ByteArray {
        val body = ByteArrayOutputStream()
        body.write(uuid)
        body.write(1) // version
        body.write(byteArrayOf((index ushr 24).toByte(), (index ushr 16).toByte(),
            (index ushr 8).toByte(), index.toByte()))
        body.write(byteArrayOf((spki.size ushr 8).toByte(), spki.size.toByte()))
        body.write(spki)
        body.write(byteArrayOf((sig.size ushr 8).toByte(), sig.size.toByte()))
        body.write(sig)
        val payload = body.toByteArray()

        val rbsp = ByteArrayOutputStream()
        rbsp.write(5) // payload_type: user_data_unregistered
        var n = payload.size
        while (n >= 255) { rbsp.write(255); n -= 255 }
        rbsp.write(n)
        rbsp.write(payload)
        rbsp.write(0x80) // rbsp trailing stop bit

        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0, 0, 0, 1, 6)) // start code + SEI NAL header
        // emulation prevention: 00 00 [00..03] -> 00 00 03 xx
        var zeros = 0
        for (b in rbsp.toByteArray()) {
            val v = b.toInt() and 0xff
            if (zeros >= 2 && v <= 3) { out.write(3); zeros = 0 }
            out.write(v)
            zeros = if (v == 0) zeros + 1 else 0
        }
        return out.toByteArray()
    }

    companion object {
        /** True when this access unit starts a new GOP. */
        fun isKeyFrame(info: MediaCodec.BufferInfo): Boolean =
            info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
    }
}
