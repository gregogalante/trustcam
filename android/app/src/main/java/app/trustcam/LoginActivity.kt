package app.trustcam

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.trustcam.databinding.ActivityLoginBinding
import kotlin.concurrent.thread

class LoginActivity : AppCompatActivity() {
    private lateinit var b: ActivityLoginBinding
    private lateinit var api: Api

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = Api(this)
        if (api.loggedIn) return goCapture()

        b = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.loginBtn.setOnClickListener { submit() }
        b.registerLink.setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${api.baseUrl}/register.html")))
        }
        // Hidden dev escape hatch: long-press the logo to override the server URL
        b.title.setOnLongClickListener {
            b.serverUrlLayout.visibility = View.VISIBLE
            b.serverUrl.setText(api.baseUrl)
            true
        }
    }

    private fun submit() {
        val email = b.email.text.toString().trim()
        val password = b.password.text.toString()
        if (email.isEmpty() || password.isEmpty()) return toast(getString(R.string.fill_credentials))

        if (b.serverUrlLayout.visibility == View.VISIBLE) {
            api.baseUrl = b.serverUrl.text.toString().trim()
        }

        b.loginBtn.isEnabled = false
        b.progress.visibility = View.VISIBLE

        thread {
            try {
                api.login(email, password)
                // Enrollment is per-install: reuse the hardware key, register once
                if (api.deviceId <= 0) {
                    val key = DeviceKey.ensure()
                    api.enrollDevice("${Build.MANUFACTURER} ${Build.MODEL}", key)
                }
                runOnUiThread { goCapture() }
            } catch (e: Exception) {
                runOnUiThread {
                    toast(e.message ?: getString(R.string.generic_error))
                    b.loginBtn.isEnabled = true
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
