package app.trustcam

import android.content.Context
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer

/**
 * On-device video watermarking: decode -> embed on the Y plane -> re-encode,
 * audio copied through untouched.
 *
 * Codec buffers are in CODED orientation with limited-range luma; the graphs
 * expect DISPLAY orientation and full range (that is what the server-side
 * extractor sees after platforms bake rotation in). So per frame:
 * limited->full, rotate to display, embed, rotate back, full->limited.
 */
object VideoWatermarker {

    fun process(context: Context, srcUri: Uri, dst: File,
                engine: WatermarkEngine, msg: FloatArray,
                onProgress: (Int) -> Unit) {
        val extractor = MediaExtractor()
        extractor.setDataSource(context, srcUri, null)
        var videoTrack = -1
        var audioTrack = -1
        for (i in 0 until extractor.trackCount) {
            val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: ""
            if (mime.startsWith("video/") && videoTrack < 0) videoTrack = i
            if (mime.startsWith("audio/") && audioTrack < 0) audioTrack = i
        }
        require(videoTrack >= 0) { "no video track" }

        val inFormat = extractor.getTrackFormat(videoTrack)
        val mime = inFormat.getString(MediaFormat.KEY_MIME)!!
        val w = inFormat.getInteger(MediaFormat.KEY_WIDTH)
        val h = inFormat.getInteger(MediaFormat.KEY_HEIGHT)
        val rotation = if (inFormat.containsKey(MediaFormat.KEY_ROTATION))
            inFormat.getInteger(MediaFormat.KEY_ROTATION) else 0
        val fps = if (inFormat.containsKey(MediaFormat.KEY_FRAME_RATE))
            inFormat.getInteger(MediaFormat.KEY_FRAME_RATE) else 30
        val durationUs = if (inFormat.containsKey(MediaFormat.KEY_DURATION))
            inFormat.getLong(MediaFormat.KEY_DURATION) else 0L

        val decoder = MediaCodec.createDecoderByType(mime)
        decoder.configure(inFormat, null, null, 0)
        decoder.start()

        val outFormat = MediaFormat.createVideoFormat("video/avc", w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            val srcBitrate = if (inFormat.containsKey(MediaFormat.KEY_BIT_RATE))
                inFormat.getInteger(MediaFormat.KEY_BIT_RATE) else 0
            setInteger(MediaFormat.KEY_BIT_RATE, if (srcBitrate > 0) srcBitrate else w * h * 6)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val encoder = MediaCodec.createEncoderByType("video/avc")
        encoder.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoder.start()

        val muxer = MediaMuxer(dst.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        if (rotation != 0) muxer.setOrientationHint(rotation)
        var muxVideo = -1
        var muxAudio = -1
        var muxerStarted = false

        extractor.selectTrack(videoTrack)
        val info = MediaCodec.BufferInfo()
        var extractorDone = false
        var decoderDone = false
        var frameIdx = 0
        var delta: FloatArray? = null
        // display-orientation dimensions for the graphs
        val rotated = rotation % 180 != 0
        val dw = if (rotated) h else w
        val dh = if (rotated) w else h

        while (true) {
            // 1. feed extractor -> decoder
            if (!extractorDone) {
                val inIdx = decoder.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    val buf = decoder.getInputBuffer(inIdx)!!
                    val size = extractor.readSampleData(buf, 0)
                    if (size < 0) {
                        decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        extractorDone = true
                    } else {
                        decoder.queueInputBuffer(inIdx, 0, size, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }

            // 2. decoder output -> watermark -> encoder input
            if (!decoderDone) {
                val outIdx = decoder.dequeueOutputBuffer(info, 10_000)
                if (outIdx >= 0) {
                    val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    if (info.size > 0) {
                        val decImage = decoder.getOutputImage(outIdx)!!
                        // wait for an encoder input slot
                        var encIdx = -1
                        while (encIdx < 0) {
                            encIdx = encoder.dequeueInputBuffer(10_000)
                            if (encIdx < 0) drainEncoder(encoder, muxer, info2 = MediaCodec.BufferInfo(),
                                onFormat = { fmt ->
                                    muxVideo = muxer.addTrack(fmt)
                                    if (audioTrack >= 0 && muxAudio < 0) {
                                        muxAudio = muxer.addTrack(extractorFormat(context, srcUri, audioTrack))
                                    }
                                    muxer.start(); muxerStarted = true
                                },
                                write = { b, i -> if (muxerStarted) muxer.writeSampleData(muxVideo, b, i) })
                        }
                        val encImage = encoder.getInputImage(encIdx)!!

                        // --- Y plane: limited->full, rotate, embed, rotate back ---
                        var y = readYFull(decImage, w, h)
                        if (rotation != 0) y = rotate(y, w, h, rotation)
                        if (frameIdx % WatermarkEngine.STEP == 0) {
                            delta = engine.keyDelta(y, dw, dh, msg)
                        }
                        var yW = engine.applyDelta(y, dw, dh, delta!!)
                        if (rotation != 0) yW = rotate(yW, dw, dh, 360 - rotation)
                        writeYLimited(yW, encImage, w, h)
                        copyChroma(decImage, encImage)

                        decoder.releaseOutputBuffer(outIdx, false)
                        encoder.queueInputBuffer(encIdx, 0, w * h * 3 / 2, info.presentationTimeUs, 0)
                        frameIdx++
                        if (durationUs > 0) {
                            onProgress((info.presentationTimeUs * 100 / durationUs).toInt().coerceIn(0, 99))
                        }
                    } else {
                        decoder.releaseOutputBuffer(outIdx, false)
                    }
                    if (eos) {
                        decoderDone = true
                        val encIdx = waitInput(encoder)
                        encoder.queueInputBuffer(encIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    }
                }
            }

            // 3. drain encoder -> muxer
            val done = drainEncoder(encoder, muxer, MediaCodec.BufferInfo(),
                onFormat = { fmt ->
                    muxVideo = muxer.addTrack(fmt)
                    if (audioTrack >= 0 && muxAudio < 0) {
                        muxAudio = muxer.addTrack(extractorFormat(context, srcUri, audioTrack))
                    }
                    muxer.start(); muxerStarted = true
                },
                write = { b, i -> if (muxerStarted) muxer.writeSampleData(muxVideo, b, i) })
            if (done && decoderDone) break
        }

        decoder.stop(); decoder.release()
        encoder.stop(); encoder.release()

        // 4. audio passthrough
        if (audioTrack >= 0 && muxAudio >= 0) {
            val ax = MediaExtractor()
            ax.setDataSource(context, srcUri, null)
            ax.selectTrack(audioTrack)
            val buf = ByteBuffer.allocate(1 shl 20)
            val ai = MediaCodec.BufferInfo()
            while (true) {
                val size = ax.readSampleData(buf, 0)
                if (size < 0) break
                ai.set(0, size, ax.sampleTime,
                    if (ax.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                        MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(muxAudio, buf, ai)
                ax.advance()
            }
            ax.release()
        }
        extractor.release()
        if (muxerStarted) muxer.stop()
        muxer.release()
        onProgress(100)
    }

    /** Drains all currently available encoder output; true when EOS was seen. */
    private fun drainEncoder(encoder: MediaCodec, muxer: MediaMuxer, info2: MediaCodec.BufferInfo,
                             onFormat: (MediaFormat) -> Unit,
                             write: (ByteBuffer, MediaCodec.BufferInfo) -> Unit): Boolean {
        while (true) {
            val idx = encoder.dequeueOutputBuffer(info2, 0)
            when {
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> onFormat(encoder.outputFormat)
                idx >= 0 -> {
                    if (info2.size > 0 && info2.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        val buf = encoder.getOutputBuffer(idx)!!
                        write(buf, info2)
                    }
                    val eos = info2.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    encoder.releaseOutputBuffer(idx, false)
                    if (eos) return true
                }
                else -> return false
            }
        }
    }

    private fun waitInput(codec: MediaCodec): Int {
        while (true) {
            val idx = codec.dequeueInputBuffer(10_000)
            if (idx >= 0) return idx
        }
    }

    private fun extractorFormat(context: Context, uri: Uri, track: Int): MediaFormat {
        val ex = MediaExtractor()
        ex.setDataSource(context, uri, null)
        val f = ex.getTrackFormat(track)
        ex.release()
        return f
    }

    /** Decoder Y plane -> full-range floats in [0,1] (BT.601 limited source). */
    private fun readYFull(img: Image, w: Int, h: Int): FloatArray {
        val plane = img.planes[0]
        val buf = plane.buffer
        val stride = plane.rowStride
        val out = FloatArray(w * h)
        val row = ByteArray(w)
        for (r in 0 until h) {
            buf.position(r * stride)
            buf.get(row, 0, w)
            val base = r * w
            for (c in 0 until w) {
                val v = row[c].toInt() and 0xFF
                out[base + c] = ((v - 16f) / 219f).coerceIn(0f, 1f)
            }
        }
        return out
    }

    /** Full-range floats -> limited-range bytes into the encoder Y plane. */
    private fun writeYLimited(y: FloatArray, img: Image, w: Int, h: Int) {
        val plane = img.planes[0]
        val buf = plane.buffer
        val stride = plane.rowStride
        val row = ByteArray(w)
        for (r in 0 until h) {
            val base = r * w
            for (c in 0 until w) {
                row[c] = (y[base + c] * 219f + 16f).toInt().coerceIn(0, 255).toByte()
            }
            buf.position(r * stride)
            buf.put(row, 0, w)
        }
    }

    /** Copies U and V planes decoder -> encoder respecting strides. */
    private fun copyChroma(src: Image, dst: Image) {
        for (p in 1..2) {
            val s = src.planes[p]
            val d = dst.planes[p]
            val ch = src.height / 2
            val cw = src.width / 2
            for (r in 0 until ch) {
                for (c in 0 until cw) {
                    val sv = s.buffer.get(r * s.rowStride + c * s.pixelStride)
                    d.buffer.put(r * d.rowStride + c * d.pixelStride, sv)
                }
            }
        }
    }

    /** Rotates a (h x w) luma plane clockwise by 90/180/270 degrees. */
    private fun rotate(y: FloatArray, w: Int, h: Int, degrees: Int): FloatArray {
        return when (((degrees % 360) + 360) % 360) {
            90 -> FloatArray(w * h).also { out ->
                // out is (w rows x h cols): out[c][h-1-r] = in[r][c]
                for (r in 0 until h) for (c in 0 until w) out[c * h + (h - 1 - r)] = y[r * w + c]
            }
            180 -> FloatArray(w * h).also { out ->
                for (i in 0 until w * h) out[w * h - 1 - i] = y[i]
            }
            270 -> FloatArray(w * h).also { out ->
                for (r in 0 until h) for (c in 0 until w) out[(w - 1 - c) * h + r] = y[r * w + c]
            }
            else -> y
        }
    }
}
