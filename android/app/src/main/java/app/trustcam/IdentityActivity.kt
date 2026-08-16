package app.trustcam

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import app.trustcam.databinding.ActivityIdentityBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlin.concurrent.thread

/**
 * Device identity screen: always-available access to the registry entry
 * (share/copy it into the public registry.json) and a device-id regeneration
 * escape hatch for the rare case the random 10-bit id is already taken.
 */
class IdentityActivity : AppCompatActivity() {
    private lateinit var b: ActivityIdentityBinding
    private lateinit var device: Device

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        device = Device(this)
        b = ActivityIdentityBinding.inflate(layoutInflater)
        setContentView(b.root)

        refresh()
        b.shareBtn.setOnClickListener { share() }
        b.regenBtn.setOnClickListener { confirmRegenerate() }
        b.closeBtn.setOnClickListener { finish() }
    }

    private fun refresh() {
        b.summary.text = getString(R.string.identity_summary, device.name, device.deviceId)
        thread {
            val key = DeviceKey.ensure()
            val entry = device.enrollmentJson("${Build.MANUFACTURER} ${Build.MODEL}", key)
            runOnUiThread { b.enrollJson.text = "\"${device.deviceId}\": ${entry.toString(2)}" }
        }
    }

    private fun share() {
        thread {
            val key = DeviceKey.ensure()
            val entry = device.enrollmentJson("${Build.MANUFACTURER} ${Build.MODEL}", key)
            runOnUiThread {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, "\"${device.deviceId}\": $entry")
                }, getString(R.string.share_enrollment)))
            }
        }
    }

    private fun confirmRegenerate() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.regen_title)
            .setMessage(R.string.regen_warning)
            .setPositiveButton(R.string.regen_confirm) { _, _ ->
                device.regenerateDeviceId()
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }
}
