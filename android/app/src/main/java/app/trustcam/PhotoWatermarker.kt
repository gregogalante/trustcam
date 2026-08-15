package app.trustcam

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri

/**
 * Photo watermarking: luma delta computed by the graphs, added equally to
 * R,G,B (mathematically a pure Y shift — same convention as the server).
 */
object PhotoWatermarker {

    fun watermarkInPlace(resolver: ContentResolver, uri: Uri,
                         engine: WatermarkEngine, msg: FloatArray) {
        val src = resolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) }
        val w = src.width
        val h = src.height
        val pixels = IntArray(w * h)
        src.getPixels(pixels, 0, w, 0, 0, w, h)

        // full-range luma, BT.601 weights (same as the model's RGB2YUV)
        val y = FloatArray(w * h)
        for (i in pixels.indices) {
            val p = pixels[i]
            val r = (p shr 16) and 0xFF
            val g = (p shr 8) and 0xFF
            val b = p and 0xFF
            y[i] = (0.299f * r + 0.587f * g + 0.114f * b) / 255f
        }

        val delta = engine.keyDelta(y, w, h, msg)
        val yW = engine.applyDelta(y, w, h, delta)

        for (i in pixels.indices) {
            val d = ((yW[i] - y[i]) * 255f)
            val p = pixels[i]
            val r = (((p shr 16) and 0xFF) + d).toInt().coerceIn(0, 255)
            val g = (((p shr 8) and 0xFF) + d).toInt().coerceIn(0, 255)
            val b = ((p and 0xFF) + d).toInt().coerceIn(0, 255)
            pixels[i] = (p.toLong() and 0xFF000000L).toInt() or (r shl 16) or (g shl 8) or b
        }

        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(pixels, 0, w, 0, 0, w, h)
        resolver.openOutputStream(uri, "wt")!!.use {
            out.compress(Bitmap.CompressFormat.JPEG, 95, it)
        }
        src.recycle()
        out.recycle()
    }
}
