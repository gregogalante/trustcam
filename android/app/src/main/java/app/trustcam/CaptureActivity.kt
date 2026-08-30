package app.trustcam

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.MediaStoreOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.trustcam.databinding.ActivityCaptureBinding
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import kotlin.concurrent.thread

class CaptureActivity : AppCompatActivity() {
    private lateinit var b: ActivityCaptureBinding
    private lateinit var device: Device
    private var engine: WatermarkEngine? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        device = Device(this)
        b = ActivityCaptureBinding.inflate(layoutInflater)
        setContentView(b.root)

        // Edge-to-edge viewfinder: the preview runs under the system bars and
        // the floating controls shift by the bar insets instead
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(b.root) { _, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            b.controls.setPadding(0, b.controls.paddingTop, 0, 28.dp + bars.bottom)
            (b.identityBtn.layoutParams as android.view.ViewGroup.MarginLayoutParams)
                .topMargin = 16.dp + bars.top
            insets
        }

        b.photoBtn.setOnClickListener { takePhoto() }
        b.videoBtn.setOnClickListener { toggleRecording() }
        b.identityBtn.setOnClickListener {
            startActivity(android.content.Intent(this, IdentityActivity::class.java))
        }

        // Warm up the 90MB embedder in the background
        thread { engine = WatermarkEngine(this) }

        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(this, perms, 1)
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (results.all { it == PackageManager.PERMISSION_GRANTED }) startCamera()
        else { toast("Camera permission required"); finish() }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            cameraProvider = future.get()
            bindCamera()
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindCamera() {
        val provider = cameraProvider ?: return
        // Photos use the sensor's native 4:3: full resolution AND the margin the
        // watermark strength was calibrated on (16:9 crops 25% of the pixels and
        // measurably erodes the BCH decode margin). WYSIWYG holds: the preview
        // letterboxes the same 4:3 frame that gets sealed; while RECORDING, side
        // bands dim everything outside the video's 16:9 crop (see toggleRecording).
        val ratio4x3 = androidx.camera.core.resolutionselector.ResolutionSelector.Builder()
            .setAspectRatioStrategy(androidx.camera.core.resolutionselector
                .AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
            .build()
        b.preview.scaleType = androidx.camera.view.PreviewView.ScaleType.FIT_CENTER
        val preview = Preview.Builder()
            .setResolutionSelector(ratio4x3)
            .build()
            .also { it.surfaceProvider = b.preview.surfaceProvider }
        imageCapture = ImageCapture.Builder()
            .setResolutionSelector(ratio4x3)
            .build()
        val recorder = Recorder.Builder()
            .setQualitySelector(QualitySelector.from(Quality.FHD))
            .build()
        videoCapture = VideoCapture.withOutput(recorder)

        provider.unbindAll()
        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA,
            preview, imageCapture, videoCapture)
    }

    private fun takePhoto() {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "TC_${System.currentTimeMillis()}.jpg")
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/TrustCam")
        }
        val opts = ImageCapture.OutputFileOptions.Builder(
            contentResolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
        ).build()
        imageCapture?.takePicture(opts, ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(res: ImageCapture.OutputFileResults) {
                    res.savedUri?.let { sealCapture(it, "photo") }
                        ?: toast("Capture failed: no URI")
                }
                override fun onError(e: ImageCaptureException) = toast("Capture failed: ${e.message}")
            })
    }

    private fun toggleRecording() {
        val vc = videoCapture ?: return
        recording?.let {
            it.stop()
            recording = null
            return
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "TC_${System.currentTimeMillis()}.mp4")
            put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/TrustCam")
        }
        val opts = MediaStoreOutputOptions.Builder(
            contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        ).setContentValues(values).build()

        b.videoBtn.setImageResource(R.drawable.ic_stop)
        recording = vc.output
            .prepareRecording(this, opts)
            .apply {
                if (ContextCompat.checkSelfPermission(this@CaptureActivity,
                        Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    withAudioEnabled()
                }
            }
            .start(ContextCompat.getMainExecutor(this)) { event ->
                when (event) {
                    is VideoRecordEvent.Start -> {
                        b.status.visibility = View.VISIBLE
                        b.status.text = getString(R.string.rec_elapsed, 0L, 0L)
                        showVideoCropBands(true)
                    }
                    is VideoRecordEvent.Status -> {
                        val secs = event.recordingStats.recordedDurationNanos / 1_000_000_000L
                        b.status.text = getString(R.string.rec_elapsed, secs / 60, secs % 60)
                    }
                    is VideoRecordEvent.Finalize -> {
                        b.videoBtn.setImageResource(R.drawable.ic_record)
                        b.status.visibility = View.GONE
                        showVideoCropBands(false)
                        if (event.hasError()) toast("Recording failed: ${event.error}")
                        else sealCapture(event.outputResults.outputUri, "video")
                    }
                }
            }
    }

    /**
     * WYSIWYG for video: the preview shows the photo's full 4:3 frame; while
     * recording, dim the two strips the video's 16:9 crop excludes (an eighth
     * of the frame per side), so what stays bright is exactly what gets sealed.
     */
    private fun showVideoCropBands(show: Boolean) {
        if (!show) {
            b.recBandStart.visibility = View.GONE
            b.recBandEnd.visibility = View.GONE
            return
        }
        val vw = b.preview.width.toFloat()
        val vh = b.preview.height.toFloat()
        if (vw == 0f || vh == 0f) return
        val portrait = vh >= vw
        // FIT_CENTER rect of the 4:3 (3:4 in portrait) preview content
        val contentW = if (portrait) minOf(vw, vh * 3f / 4f) else minOf(vw, vh * 4f / 3f)
        val contentH = if (portrait) contentW * 4f / 3f else contentW * 3f / 4f
        val offX = (vw - contentW) / 2f
        val offY = (vh - contentH) / 2f
        fun place(v: View, x: Float, y: Float, w: Int, h: Int) {
            v.layoutParams = v.layoutParams.apply { width = w; height = h }
            v.x = x
            v.y = y
            v.visibility = View.VISIBLE
        }
        if (portrait) {
            val band = contentW / 8f
            place(b.recBandStart, offX, offY, band.toInt(), contentH.toInt())
            place(b.recBandEnd, offX + contentW - band, offY, band.toInt(), contentH.toInt())
        } else {
            val band = contentH / 8f
            place(b.recBandStart, offX, offY, contentW.toInt(), band.toInt())
            place(b.recBandEnd, offX, offY + contentH - band, contentW.toInt(), band.toInt())
        }
    }

    /**
     * Fully offline, fully self-contained sealing: embed the invisible
     * watermark (payload = random 128-bit capture id), hash the canonical
     * bytes, hardware-sign, then append the proof trailer to the file itself.
     * There is nothing to sync — the file carries its own proof; the capture
     * id is the pointer a verifier can use to look up the original.
     */
    private fun sealCapture(uri: Uri, mediaType: String) {
        val capturedAt = Instant.now().toString()
        // Hide camera + capture controls while sealing: free the camera (and its
        // CPU share) for the ONNX pipeline and block any new capture attempt
        cameraProvider?.unbindAll()
        b.controls.visibility = View.GONE
        b.status.visibility = View.GONE
        b.sealingOverlay.visibility = View.VISIBLE
        b.sealStatus.text = getString(R.string.watermarking)
        showProgress(indeterminate = true)
        thread {
            try {
                // wait for the engine warm-up if needed
                while (engine == null) Thread.sleep(100)
                val eng = engine!!
                val t0 = System.currentTimeMillis()

                // random capture id — photos embed all 128 bits (v3 payload);
                // the video channel can't carry them (WhatsApp-class transcodes
                // flip ~20-25% of decoded bits), so video embeds a random 24-bit
                // mark id in the proven repetition format and the proof binds it
                // to the capture id
                val captureId = java.util.UUID.randomUUID()
                var markId = 0
                var gopFinal: GopSigner.Final? = null
                if (mediaType == "photo") {
                    val idBytes = java.nio.ByteBuffer.allocate(16)
                        .putLong(captureId.mostSignificantBits)
                        .putLong(captureId.leastSignificantBits)
                        .array()
                    PhotoWatermarker.watermarkInPlace(contentResolver, uri, eng,
                        PayloadCodecV3.encode(idBytes))
                } else {
                    markId = java.security.SecureRandom().nextInt(PayloadCodec.MAX_ID - 1) + 1
                    val msg = PayloadCodec.encode(markId)
                    val tmp = File(cacheDir, "wm_$captureId.mp4")
                    // per-GOP rolling signatures ride inside the bitstream (SEI):
                    // a trimmed copy keeps its intact segments verifiable
                    val gop = GopSigner(android.util.Base64.decode(
                        DeviceKey.ensure().publicKeySpkiB64, android.util.Base64.DEFAULT))
                    gopFinal = VideoWatermarker.process(this, uri, tmp, eng, msg, gop) { pct ->
                        runOnUiThread {
                            showProgress(indeterminate = false, percent = pct)
                            b.sealStatus.text = getString(R.string.watermarking_pct, pct)
                        }
                    }
                    contentResolver.openOutputStream(uri, "wt")!!.use { out ->
                        tmp.inputStream().use { it.copyTo(out, 1 shl 16) }
                    }
                    tmp.delete()
                }

                runOnUiThread {
                    showProgress(indeterminate = true)
                    b.sealStatus.text = getString(R.string.signing)
                }
                // canonical hash = the file WITHOUT the proof trailer (not yet appended)
                val digest = MessageDigest.getInstance("SHA-256")
                contentResolver.openInputStream(uri)!!.use { ins ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                    }
                }
                val hash = digest.digest()
                val key = DeviceKey.ensure()
                // RFC 3161 token over the same hash the secure element signs —
                // best-effort: null when offline, the proof is valid without it
                val tsr = Rfc3161.token(hash)
                val proof = org.json.JSONObject()
                    .put("v", 2)
                    .put("captureId", captureId.toString())
                    .apply {
                        // videos: the in-pixel mark carries this 24-bit id, not
                        // the full capture id — record the binding in the proof
                        if (markId != 0) put("markId", "%06x".format(markId))
                    }
                    .put("deviceId", device.deviceId)
                    .put("name", device.name)
                    .put("model", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
                    .put("capturedAt", capturedAt)
                    .put("mediaType", mediaType)
                    .put("securityLevel", key.securityLevel)
                    .put("pubkey", key.publicKeySpkiB64)
                    .put("attestation", org.json.JSONArray(key.attestationChainB64))
                    .apply { if (tsr != null) put("tsr", tsr) }
                    .apply {
                        // the final GOP's bitstream signature has no next keyframe
                        // to ride in — it travels here instead
                        gopFinal?.let {
                            put("gopSig", org.json.JSONObject()
                                .put("i", it.i)
                                .put("sig", it.sigB64)
                                .put("spki", key.publicKeySpkiB64))
                        }
                    }
                    .put("sig", DeviceKey.signHash(hash))
                contentResolver.openOutputStream(uri, "wa")!!.use {
                    it.write(ProofTrailer.build(proof))
                }

                // sealing time in the completion message: lets field tests
                // compare accelerated vs CPU embedding without extra tooling
                val secs = (System.currentTimeMillis() - t0) / 1000.0
                runOnUiThread {
                    // surface the timestamp outcome: without it the only hint of an
                    // offline capture would be a missing row in the verifier later
                    finishSealing(getString(R.string.sealed,
                        captureId.toString().substring(0, 8), secs,
                        getString(if (tsr != null) R.string.ts_ok else R.string.ts_missing)))
                }
            } catch (e: Exception) {
                runOnUiThread { finishSealing("Sealing failed: ${e.message}") }
            }
        }
    }

    /** Restore the capture UI (camera preview + controls) and show the outcome. */
    private fun finishSealing(message: String) {
        b.sealingOverlay.visibility = View.GONE
        b.controls.visibility = View.VISIBLE
        b.status.visibility = View.VISIBLE
        b.status.text = message
        bindCamera()
    }

    /** Material progress indicators only allow mode switches while hidden. */
    private fun showProgress(indeterminate: Boolean, percent: Int = 0) {
        if (b.sealProgress.isIndeterminate != indeterminate) {
            b.sealProgress.visibility = View.GONE
            b.sealProgress.isIndeterminate = indeterminate
        }
        if (!indeterminate) b.sealProgress.progress = percent
        b.sealProgress.visibility = View.VISIBLE
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
}
