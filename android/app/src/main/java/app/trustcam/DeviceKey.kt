package app.trustcam

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.Signature

/**
 * Device signing key: ECDSA P-256 generated inside StrongBox when available,
 * TEE otherwise. The private key never leaves secure hardware; we sign the
 * 32 raw bytes of a file's SHA-256 (server re-verifies with the same convention).
 */
object DeviceKey {
    private const val ALIAS = "trustcam_device_key"

    data class Info(
        val publicKeySpkiB64: String,
        val attestationChainB64: List<String>,
        val securityLevel: String
    )

    fun ensure(): Info {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(ALIAS)) generate()
        return info()
    }

    private fun generate() {
        val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }

        fun spec(strongBox: Boolean): KeyGenParameterSpec {
            val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge)
            if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
            return b.build()
        }

        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            kpg.initialize(spec(strongBox = true))
            kpg.generateKeyPair()
            level = "strongbox"
        } catch (e: Exception) {
            // Mid-range devices often lack StrongBox — TEE is the documented fallback
            kpg.initialize(spec(strongBox = false))
            kpg.generateKeyPair()
            level = "tee"
        }
    }

    // Security level is only knowable at generation time without extra parsing;
    // persisted lazily via the keystore presence + this marker.
    private var level: String = "unknown"

    private fun info(): Info {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val chain = ks.getCertificateChain(ALIAS) ?: emptyArray()
        val pub = ks.getCertificate(ALIAS).publicKey
        return Info(
            // raw SPKI DER, base64: what WebCrypto importKey('spki') expects
            publicKeySpkiB64 = Base64.encodeToString(pub.encoded, Base64.NO_WRAP),
            attestationChainB64 = chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) },
            securityLevel = if (level != "unknown") level else "tee"
        )
    }

    /** Sign the 32 raw bytes of a SHA-256 hash. Returns base64 DER signature. */
    fun signHash(hash: ByteArray): String {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = ks.getKey(ALIAS, null) as java.security.PrivateKey
        val sig = Signature.getInstance("SHA256withECDSA").apply {
            initSign(key)
            update(hash)
        }
        return Base64.encodeToString(sig.sign(), Base64.NO_WRAP)
    }
}
