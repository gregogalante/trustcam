package app.trustcam

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.trustcam.databinding.ActivityIdentityBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlin.concurrent.thread

/**
 * Device identity screen: edit the display name, always-available access to
 * the registry entry (share/copy into the public registry.json), and a
 * device-id regeneration escape hatch for registry collisions.
 */
class IdentityActivity : AppCompatActivity() {
    private lateinit var b: ActivityIdentityBinding
    private lateinit var device: Device

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        device = Device(this)
        b = ActivityIdentityBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.name.setText(device.name ?: "")
        refresh()
        b.saveNameBtn.setOnClickListener { if (saveName()) refresh() }
        b.shareBtn.setOnClickListener { saveName(); share() }
        b.regenBtn.setOnClickListener { confirmRegenerate() }
        b.closeBtn.setOnClickListener { finish() }
    }

    /** Persists the edited name; false when the field is empty. */
    private fun saveName(): Boolean {
        val name = b.name.text.toString().trim()
        if (name.isEmpty()) {
            toast(getString(R.string.fill_name))
            return false
        }
        if (name != device.name) {
            device.name = name
            toast(getString(R.string.name_saved))
        }
        return true
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
                saveName() // a new identity can carry a new nickname too
                device.regenerateDeviceId()
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
