package app.trustcam

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.trustcam.databinding.ActivitySetupBinding
import kotlin.concurrent.thread

/**
 * First-launch setup, no account: pick a display name, generate the hardware
 * key, download the watermark model, then show the registry entry to publish.
 */
class SetupActivity : AppCompatActivity() {
    private lateinit var b: ActivitySetupBinding
    private lateinit var device: Device

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        device = Device(this)
        if (device.ready && WatermarkEngine.isReady(this)) return goCapture()

        b = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.name.setText(device.name ?: "")
        b.startBtn.setOnClickListener { start() }
        b.continueBtn.setOnClickListener { goCapture() }
    }

    private fun start() {
        val name = b.name.text.toString().trim()
        if (name.isEmpty()) return toast(getString(R.string.fill_name))
        device.name = name
        b.startBtn.isEnabled = false
        b.progress.visibility = View.VISIBLE

        thread {
            try {
                val key = DeviceKey.ensure()
                if (!WatermarkEngine.isReady(this)) {
                    device.downloadModel(WatermarkEngine.modelFile(this)) { pct ->
                        runOnUiThread { b.startBtn.text = getString(R.string.downloading_model, pct) }
                    }
                }
                val entry = device.enrollmentJson("${Build.MANUFACTURER} ${Build.MODEL}", key)
                runOnUiThread {
                    b.progress.visibility = View.GONE
                    b.form.visibility = View.GONE
                    b.enrollCard.visibility = View.VISIBLE
                    b.enrollJson.text = "\"${device.deviceId}\": ${entry.toString(2)}"
                    b.shareBtn.setOnClickListener {
                        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, "\"${device.deviceId}\": $entry")
                        }, getString(R.string.share_enrollment)))
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    toast(e.message ?: getString(R.string.generic_error))
                    b.startBtn.isEnabled = true
                    b.startBtn.text = getString(R.string.setup_start)
                    b.progress.visibility = View.GONE
                }
            }
        }
    }

    private fun goCapture() {
        startActivity(Intent(this, CaptureActivity::class.java))
        finish()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
