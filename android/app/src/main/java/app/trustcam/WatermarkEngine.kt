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
        key = env.createSession(modelFile(context).readBytes(), opts)
        apply = env.createSession(loadAsset(context, "frame_apply.onnx"), opts)
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
