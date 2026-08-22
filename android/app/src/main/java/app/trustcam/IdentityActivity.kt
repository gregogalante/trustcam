package app.trustcam

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.trustcam.databinding.ActivityIdentityBinding
import app.trustcam.databinding.DialogRegenerateBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlin.concurrent.thread

/**
 * Device identity screen: share the device record, regenerate the identity
 * (a fresh device id always comes with a fresh nickname — the pair is what
 * the verifier shows, so they change together), and a short project blurb
 * linking to the site.
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
        b.websiteBtn.setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.BASE_URL)))
        }
        b.closeBtn.setOnClickListener { finish() }
    }

    private fun refresh() {
        // app version on the identity screen: lets testers confirm which build
        // captured a file when debugging recognition in the field
        val version = packageManager.getPackageInfo(packageName, 0).versionName
        b.summary.text = getString(R.string.identity_summary, device.name, device.deviceId, version)
    }

    private fun share() {
        thread {
            val key = DeviceKey.ensure()
            val entry = device.enrollmentJson("${Build.MANUFACTURER} ${Build.MODEL}", key)
            val intent = device.shareRecordIntent(this, entry)
            runOnUiThread {
                startActivity(Intent.createChooser(intent, getString(R.string.share_enrollment)))
            }
        }
    }

    /** New id + new nickname together: the dialog won't confirm without a name. */
    private fun confirmRegenerate() {
        val d = DialogRegenerateBinding.inflate(layoutInflater)
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.regen_title)
            .setMessage(R.string.regen_warning)
            .setView(d.root)
            .setPositiveButton(R.string.regen_confirm) { _, _ ->
                device.name = d.name.text.toString().trim()
                device.regenerateDeviceId()
                refresh()
                toast(getString(R.string.regen_done))
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
        val confirm = dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE)
        confirm.isEnabled = false
        d.name.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) {
                confirm.isEnabled = !s.isNullOrBlank()
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, n: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, before: Int, n: Int) {}
        })
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
