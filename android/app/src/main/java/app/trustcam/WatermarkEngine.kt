package app.trustcam

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.nio.FloatBuffer

/**
 * Runs the exported VideoSeal graphs on-device.
 * All inputs/outputs are full-range luma in [0,1], shape (1,1,H,W).
 *
 *   prep:  y (H,W)        -> y_res (256x256)      cheap, every key frame
 *   key:   y_res + msg    -> delta_raw (256x256)  heavy (24M params), key frames only
 *   apply: y + delta_raw  -> y_w (H,W)            cheap, every frame
 */
class WatermarkEngine(context: Context) {
    private val env = OrtEnvironment.getEnvironment()
    private val prep: OrtSession
    private val key: OrtSession
    private val apply: OrtSession

    init {
        val opts = OrtSession.SessionOptions()
        prep = env.createSession(loadAsset(context, "frame_prep.onnx"), opts)
        // The 90MB embedder is downloaded once at sign-in (keeps the APK small)
        key = createKeySession(context, modelFile(context).readBytes())
        apply = env.createSession(loadAsset(context, "frame_apply.onnx"), opts)
    }

    /**
     * Picks the faster execution provider for the heavy key graph. NNAPI with
     * fp16 relaxation wins on some SoCs but LOSES on others (partitioned
     * graphs pay per-call copy overhead), so the first launch of each app
     * version times one real inference on both and persists the winner —
     * measured, not assumed. fp16 embed quality: spikes/spike_fp16_embedder.py.
     */
    private fun createKeySession(context: Context, bytes: ByteArray): OrtSession {
        val prefs = context.getSharedPreferences("trustcam", Context.MODE_PRIVATE)
        val prefKey = "keyEp-${BuildConfig.VERSION_CODE}"
        fun cpu() = env.createSession(bytes, OrtSession.SessionOptions())
        fun nnapi(): OrtSession? = try {
            val o = OrtSession.SessionOptions()
            o.addNnapi(java.util.EnumSet.of(ai.onnxruntime.providers.NNAPIFlags.USE_FP16))
            env.createSession(bytes, o)
        } catch (e: Exception) {
            android.util.Log.w("TrustCam", "NNAPI unavailable", e)
            null
        }
        when (prefs.getString(prefKey, null)) {
            "cpu" -> return cpu()
            "nnapi" -> return nnapi() ?: cpu()
        }
        // benchmark: 2 runs each (the first NNAPI call pays graph compilation),
        // keep the best time per session
        fun bench(s: OrtSession): Long {
            val yRes = FloatArray(256 * 256)
            val msg = FloatArray(256)
            var best = Long.MAX_VALUE
            repeat(2) {
                val t0 = System.nanoTime()
                OnnxTensor.createTensor(env, FloatBuffer.wrap(yRes), longArrayOf(1, 1, 256, 256)).use { yT ->
                    OnnxTensor.createTensor(env, FloatBuffer.wrap(msg), longArrayOf(1, 256)).use { mT ->
                        s.run(mapOf("y_res" to yT, "message" to mT)).close()
                    }
                }
                best = minOf(best, (System.nanoTime() - t0) / 1_000_000)
            }
            return best
        }
        val cpuSession = cpu()
        val nnapiSession = nnapi() ?: run {
            prefs.edit().putString(prefKey, "cpu").apply()
            return cpuSession
        }
        val cpuMs = bench(cpuSession)
        val nnapiMs = bench(nnapiSession)
        val winner = if (nnapiMs < cpuMs) "nnapi" else "cpu"
        android.util.Log.i("TrustCam", "key EP benchmark: cpu=${cpuMs}ms nnapi=${nnapiMs}ms -> $winner")
        prefs.edit().putString(prefKey, winner).apply()
        return if (winner == "nnapi") {
            cpuSession.close(); nnapiSession
        } else {
            nnapiSession.close(); cpuSession
        }
    }

    private fun loadAsset(context: Context, name: String): ByteArray =
        context.assets.open(name).use { it.readBytes() }

    /** Heavy step: watermark signal for one key frame. */
    fun keyDelta(y: FloatArray, w: Int, h: Int, msg: FloatArray): FloatArray {
        OnnxTensor.createTensor(env, FloatBuffer.wrap(y), longArrayOf(1, 1, h.toLong(), w.toLong())).use { yT ->
            prep.run(mapOf("y" to yT)).use { prepOut ->
                val yRes = prepOut.get(0) as OnnxTensor
                OnnxTensor.createTensor(env, FloatBuffer.wrap(msg), longArrayOf(1, 256)).use { msgT ->
                    key.run(mapOf("y_res" to yRes, "message" to msgT)).use { keyOut ->
                        val d = (keyOut.get(0) as OnnxTensor).floatBuffer
                        return FloatArray(d.remaining()).also { d.get(it) }
                    }
                }
            }
        }
    }

    /** Cheap step: JND-attenuated blend of a (possibly propagated) delta. */
    fun applyDelta(y: FloatArray, w: Int, h: Int, deltaRaw: FloatArray): FloatArray {
        OnnxTensor.createTensor(env, FloatBuffer.wrap(y), longArrayOf(1, 1, h.toLong(), w.toLong())).use { yT ->
            OnnxTensor.createTensor(env, FloatBuffer.wrap(deltaRaw), longArrayOf(1, 1, 256, 256)).use { dT ->
                apply.run(mapOf("y" to yT, "delta_raw" to dT)).use { out ->
                    val r = (out.get(0) as OnnxTensor).floatBuffer
                    return FloatArray(r.remaining()).also { r.get(it) }
                }
            }
        }
    }

    fun close() {
        prep.close(); key.close(); apply.close()
    }

    companion object {
        const val STEP = 4  // frames between key frames (matches server video_mode)

        fun modelFile(context: Context) = java.io.File(context.filesDir, "embedder_key.onnx")
        fun isReady(context: Context) = modelFile(context).length() > 50_000_000
    }
}
