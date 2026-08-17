package app.trustcam

import kotlin.math.cos
import kotlin.math.sqrt

/**
 * PDQ perceptual hash — line-by-line port of spikes/pdq_ref.py (itself a port
 * of the official ThreatExchange C++): two Jarosz box-filter passes, 64x64
 * center-sample decimation, 16x64 DCT with the (i+1) row offset, Torben
 * median, bit k = DCT coeff (k/16, k%16) > median. Float (32-bit) arithmetic
 * throughout to keep bit parity with the python reference; the quality metric
 * is intentionally omitted (unused on device).
 */
object Pdq {
    private const val OUT = 64 // downsample edge
    private const val DCT_N = 16 // kept DCT coefficients per axis

    /** First 104 bits of the 256-bit hash, packed MSB-first into 13 bytes. */
    fun hash104(luma: FloatArray, width: Int, height: Int): ByteArray {
        val bits = hash256(luma, width, height)
        val out = ByteArray(13)
        for (k in 0 until 104) {
            if (bits[k] == 1) {
                out[k ushr 3] = (out[k ushr 3].toInt() or (1 shl (7 - (k and 7)))).toByte()
            }
        }
        return out
    }

    /** Full 256-bit hash as 0/1 ints; luma is row-major, values 0..255. */
    internal fun hash256(luma: FloatArray, width: Int, height: Int): IntArray {
        require(luma.size == width * height) { "luma size does not match dimensions" }
        val b64 = if (width == OUT && height == OUT) {
            luma.copyOf()
        } else {
            val buf = luma.copyOf()
            // computeJaroszFilterWindowSize(dim, 64) = ceil(dim / 128)
            jarosz(buf, height, width, (width + 127) / 128, (height + 127) / 128)
            decimate(buf, height, width)
        }
        val dct = dct16(b64)
        val median = torben(dct)
        return IntArray(DCT_N * DCT_N) { if (dct[it] > median) 1 else 0 }
    }

    /**
     * Sliding unnormalized box filter — same four phases as the reference
     * (grow window, first full outputs, slide, shrink window).
     */
    private fun box1d(
        inv: FloatArray, inOff: Int, inStride: Int,
        out: FloatArray, outOff: Int, outStride: Int,
        n: Int, fullWindow: Int
    ) {
        val half = (fullWindow + 2) / 2
        var li = 0
        var ri = 0
        var oi = 0
        var s = 0f
        var win = 0
        repeat(half - 1) {
            s += inv[inOff + ri * inStride]
            win++
            ri++
        }
        repeat(fullWindow - half + 1) {
            s += inv[inOff + ri * inStride]
            win++
            out[outOff + oi * outStride] = s / win
            ri++
            oi++
        }
        repeat(n - fullWindow) {
            s += inv[inOff + ri * inStride]
            s -= inv[inOff + li * inStride]
            out[outOff + oi * outStride] = s / win
            li++
            ri++
            oi++
        }
        repeat(half - 1) {
            s -= inv[inOff + li * inStride]
            win--
            out[outOff + oi * outStride] = s / win
            li++
            oi++
        }
    }

    /** Two passes of row + column box filters (Jarosz approximation of Gaussian). */
    private fun jarosz(buf: FloatArray, rows: Int, cols: Int, wRow: Int, wCol: Int) {
        val tmp = FloatArray(buf.size)
        repeat(2) {
            for (i in 0 until rows) box1d(buf, i * cols, 1, tmp, i * cols, 1, cols, wRow)
            for (j in 0 until cols) box1d(tmp, j, cols, buf, j, cols, rows, wCol)
        }
    }

    /** Center sampling down to 64x64 — same index formula as the reference. */
    private fun decimate(buf: FloatArray, rows: Int, cols: Int): FloatArray {
        val out = FloatArray(OUT * OUT)
        for (oi in 0 until OUT) {
            val ii = ((oi + 0.5) * rows / OUT).toInt()
            for (oj in 0 until OUT) {
                val jj = ((oj + 0.5) * cols / OUT).toInt()
                out[oi * OUT + oj] = buf[ii * cols + jj]
            }
        }
        return out
    }

    // 16x64 DCT-II basis; PDQ keeps coefficients 1..16 hence the (i+1) factor.
    private val dctMat: FloatArray by lazy {
        val scale = sqrt(2.0 / OUT).toFloat()
        FloatArray(DCT_N * OUT).also { m ->
            for (i in 0 until DCT_N) {
                for (j in 0 until OUT) {
                    m[i * OUT + j] = scale *
                        cos(Math.PI / 2.0 / OUT * (i + 1) * (2 * j + 1)).toFloat()
                }
            }
        }
    }

    /**
     * fma(a, b, s) in float32, emulated via double (exact: a*b fits a double).
     * The reference BLAS accumulates dot products with sequential fused
     * multiply-adds; plain float32 multiply-then-add flips near-median bits
     * on smooth images, so we must round the same way.
     */
    private fun fma(a: Float, b: Float, s: Float): Float =
        (a.toDouble() * b.toDouble() + s.toDouble()).toFloat()

    /** B = D x b64 x D^T (16x16), float32 with fused accumulation. */
    private fun dct16(b64: FloatArray): FloatArray {
        val d = dctMat
        val t = FloatArray(DCT_N * OUT)
        for (i in 0 until DCT_N) {
            for (j in 0 until OUT) {
                var s = 0f
                for (k in 0 until OUT) s = fma(d[i * OUT + k], b64[k * OUT + j], s)
                t[i * OUT + j] = s
            }
        }
        val out = FloatArray(DCT_N * DCT_N)
        for (i in 0 until DCT_N) {
            for (j in 0 until DCT_N) {
                var s = 0f
                for (k in 0 until OUT) s = fma(t[i * OUT + k], d[j * OUT + k], s)
                out[i * DCT_N + j] = s
            }
        }
        return out
    }

    /** Torben median — no reordering, exact same guess/bound updates as the C++. */
    private fun torben(m: FloatArray): Float {
        val n = m.size
        val halfN = (n + 1) / 2
        var lo = m[0]
        var hi = m[0]
        for (v in m) {
            if (v < lo) lo = v
            if (v > hi) hi = v
        }
        while (true) {
            val guess = (lo + hi) / 2
            var less = 0
            var greater = 0
            var maxlt = lo
            var mingt = hi
            for (v in m) {
                if (v < guess) {
                    less++
                    if (v > maxlt) maxlt = v
                } else if (v > guess) {
                    greater++
                    if (v < mingt) mingt = v
                }
            }
            if (less <= halfN && greater <= halfN) {
                val equal = n - less - greater
                return when {
                    less >= halfN -> maxlt
                    less + equal >= halfN -> guess
                    else -> mingt
                }
            }
            if (less > greater) hi = maxlt else lo = mingt
        }
    }
}
