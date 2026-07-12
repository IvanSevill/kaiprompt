package com.kaiprompt.app

import org.json.JSONObject
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The other half of lib/crypto.mjs on the PC.
 *
 * Everything the server sends over the Cloudflare tunnel arrives sealed, because Cloudflare
 * terminates the TLS and could otherwise read the lot: prompts, code, and everything Claude
 * said back. The key that opens it never went through the tunnel — it came off the PC's own
 * screen, in the pairing QR. That is the whole reason the tunnel is acceptable.
 *
 * AES-256-GCM: decryption fails outright on a wrong key or a tampered payload, rather than
 * quietly handing back garbage. If Cloudflare changed a byte, we find out.
 */
object Crypto {

    private const val ALGO = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128

    // java.util.Base64, not android.util.Base64: it exists from API 26 (our minSdk) AND on
    // a plain JVM, which is what lets every one of these tests run without an emulator. The
    // Android one would have made this class untestable on the machine that builds it.
    private val url64: Base64.Decoder = Base64.getUrlDecoder()
    private val std64: Base64.Decoder = Base64.getDecoder()

    /** The pairing QR carries the key base64url-encoded, exactly as Node minted it. */
    fun keyBytes(key: String): ByteArray = url64.decode(key)

    /**
     * A sealed envelope → the JSON inside.
     * Throws if the key is wrong or the payload was touched — never returns something we
     * cannot vouch for.
     */
    fun open(envelope: String, key: String): String {
        val json = JSONObject(envelope)
        require(json.optInt("v") == 1) { "not a sealed payload" }

        val iv = std64.decode(json.getString("iv"))
        val ct = std64.decode(json.getString("ct"))
        val tag = std64.decode(json.getString("tag"))

        // Java's GCM expects the tag appended to the ciphertext; Node keeps it separate.
        // Joining them here is what makes the two sides speak the same language.
        val cipher = Cipher.getInstance(ALGO)
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(keyBytes(key), "AES"),
            GCMParameterSpec(TAG_BITS, iv),
        )
        return String(cipher.doFinal(ct + tag), Charsets.UTF_8)
    }

    /** Is this a sealed envelope, or plain JSON? The server answers plainly to anyone who did not ask. */
    fun isSealed(body: String): Boolean = try {
        val j = JSONObject(body)
        j.optInt("v") == 1 && j.has("iv") && j.has("ct") && j.has("tag")
    } catch (_: Exception) {
        false
    }
}
