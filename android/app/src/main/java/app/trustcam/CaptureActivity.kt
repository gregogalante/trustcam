package app.trustcam

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
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
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = Api(this)
        b = ActivityCaptureBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.photoBtn.setOnClickListener { takePhoto() }
        b.videoBtn.setOnClickListener { toggleRecording() }

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
        val file = File(getExternalFilesDir(null), "IMG_${System.currentTimeMillis()}.jpg")
        val opts = ImageCapture.OutputFileOptions.Builder(file).build()
        imageCapture?.takePicture(opts, ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(res: ImageCapture.OutputFileResults) =
                    signAndRegister(file, "photo")
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
        val file = File(getExternalFilesDir(null), "VID_${System.currentTimeMillis()}.mp4")
        b.videoBtn.setImageResource(R.drawable.ic_stop)
        recording = vc.output
            .prepareRecording(this, FileOutputOptions.Builder(file).build())
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
                    else signAndRegister(file, "video")
                }
            }
    }

    /**
     * MVP integrity layer: whole-file hash signed in secure hardware.
     * The per-GOP SEI pipeline (validated in the spikes) replaces this recorder later.
     */
    private fun signAndRegister(file: File, mediaType: String) {
        val capturedAt = Instant.now().toString()
        b.status.visibility = android.view.View.VISIBLE
        b.status.text = getString(R.string.registering)
        thread {
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                file.inputStream().use { ins ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                    }
                }
                val hash = digest.digest()
                val signature = DeviceKey.signHash(hash)
                val hex = hash.joinToString("") { "%02x".format(it) }
                val id = api.registerProof(hex, signature, mediaType, file.length(), capturedAt)
                runOnUiThread {
                    b.status.text = getString(R.string.registered, id, file.name)
                }
            } catch (e: Exception) {
                runOnUiThread { b.status.text = "Proof failed: ${e.message}" }
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
