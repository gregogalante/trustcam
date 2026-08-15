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
    private lateinit var api: Api
    private lateinit var queue: ProofQueue
    private var engine: WatermarkEngine? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = Api(this)
        queue = ProofQueue(this)
        b = ActivityCaptureBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.photoBtn.setOnClickListener { takePhoto() }
        b.videoBtn.setOnClickListener { toggleRecording() }

        // Warm up the 90MB embedder in the background; sync any queued proofs
        thread {
            engine = WatermarkEngine(this)
            trySync()
        }

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
            val provider = future.get()
            val preview = Preview.Builder().build()
                .also { it.surfaceProvider = b.preview.surfaceProvider }
            imageCapture = ImageCapture.Builder().build()
            val recorder = Recorder.Builder()
                .setQualitySelector(QualitySelector.from(Quality.FHD))
                .build()
            videoCapture = VideoCapture.withOutput(recorder)

            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA,
                preview, imageCapture, videoCapture)
        }, ContextCompat.getMainExecutor(this))
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
                if (event is VideoRecordEvent.Finalize) {
                    b.videoBtn.setImageResource(R.drawable.ic_record)
                    if (event.hasError()) toast("Recording failed: ${event.error}")
                    else sealCapture(event.outputResults.outputUri, "video")
                }
            }
    }

    /**
     * Fully offline sealing: embed the invisible watermark (payload =
     * deviceId + local counter), hash + hardware-sign the watermarked file,
     * queue the proof. Sync happens whenever connectivity allows.
     */
    private fun sealCapture(uri: Uri, mediaType: String) {
        val capturedAt = Instant.now().toString()
        b.status.visibility = View.VISIBLE
        b.status.text = getString(R.string.watermarking)
        showProgress(indeterminate = true)
        thread {
            try {
                // wait for the engine warm-up if needed
                while (engine == null) Thread.sleep(100)
                val eng = engine!!
                val payload = PayloadCodec.payloadOf(api.deviceId, queue.nextCounter())
                val msg = PayloadCodec.encode(payload)

                if (mediaType == "photo") {
                    PhotoWatermarker.watermarkInPlace(contentResolver, uri, eng, msg)
                } else {
                    val tmp = File(cacheDir, "wm_$payload.mp4")
                    VideoWatermarker.process(this, uri, tmp, eng, msg) { pct ->
                        runOnUiThread {
                            showProgress(indeterminate = false, percent = pct)
                            b.status.text = getString(R.string.watermarking_pct, pct)
                        }
                    }
                    contentResolver.openOutputStream(uri, "wt")!!.use { out ->
                        tmp.inputStream().use { it.copyTo(out, 1 shl 16) }
                    }
                    tmp.delete()
                }

                runOnUiThread {
                    showProgress(indeterminate = true)
                    b.status.text = getString(R.string.signing)
                }
                val digest = MessageDigest.getInstance("SHA-256")
                var size = 0L
                contentResolver.openInputStream(uri)!!.use { ins ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                        size += n
                    }
                }
                val hash = digest.digest()
                val signature = DeviceKey.signHash(hash)
                val hex = hash.joinToString("") { "%02x".format(it) }
                queue.enqueue(payload, hex, signature, mediaType, size, capturedAt)

                val synced = trySync()
                runOnUiThread {
                    b.progress.visibility = View.GONE
                    b.status.text = getString(
                        if (synced) R.string.sealed_synced else R.string.sealed_offline, payload)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    b.progress.visibility = View.GONE
                    b.status.text = "Sealing failed: ${e.message}"
                }
            }
        }
    }

    /** Best-effort sync of the offline queue; false when offline or on error. */
    private fun trySync(): Boolean {
        return try {
            val acked = api.syncProofs(queue.pending())
            if (acked.isNotEmpty()) queue.removeAcked(acked)
            queue.pending().length() == 0
        } catch (e: Exception) {
            false
        }
    }

    /** Material progress indicators only allow mode switches while hidden. */
    private fun showProgress(indeterminate: Boolean, percent: Int = 0) {
        if (b.progress.isIndeterminate != indeterminate) {
            b.progress.visibility = View.GONE
            b.progress.isIndeterminate = indeterminate
        }
        if (!indeterminate) b.progress.progress = percent
        b.progress.visibility = View.VISIBLE
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
