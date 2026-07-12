package com.kaiprompt.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * El descifrado tiene que hablar EXACTAMENTE el mismo idioma que lib/crypto.mjs del PC.
 *
 * Aquí se sella igual que lo hace Node (mismo formato de sobre, misma separación de la
 * etiqueta) y se comprueba que el móvil lo abre. Si las dos mitades se separan, el móvil
 * deja de entender a su PC y no hay forma de darse cuenta hasta tenerlo en la mano.
 *
 * Corre en la JVM, sin emulador: es lo que permite verificar la app en la misma máquina
 * que la compila.
 */
class CryptoTest {

    /** Sella como lo hace Node: AES-256-GCM, iv/ct/tag separados y en base64. */
    private fun sealLikeNode(plain: String, key: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(Base64.getUrlDecoder().decode(key), "AES"),
            GCMParameterSpec(128, iv),
        )
        val out = cipher.doFinal(plain.toByteArray())

        // Java pega la etiqueta al final del ciphertext; Node la guarda aparte. El sobre
        // usa el formato de Node, así que hay que separarla — y esa costura es justo lo
        // que este test existe para vigilar.
        val ct = out.copyOfRange(0, out.size - 16)
        val tag = out.copyOfRange(out.size - 16, out.size)

        return JSONObject()
            .put("v", 1)
            .put("iv", Base64.getEncoder().encodeToString(iv))
            .put("ct", Base64.getEncoder().encodeToString(ct))
            .put("tag", Base64.getEncoder().encodeToString(tag))
            .toString()
    }

    private fun newKey(): String =
        Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })

    @Test
    fun `abre un sobre sellado igual que lo sella el PC`() {
        val key = newKey()
        val original = """{"jobs":[{"id":"j1","prompt":"no es asunto de Cloudflare"}]}"""
        assertEquals(original, Crypto.open(sealLikeNode(original, key), key))
    }

    @Test
    fun `el sobre no lleva el contenido en claro`() {
        val key = newKey()
        val sobre = sealLikeNode("""{"secreto":"hunter2"}""", key)
        assertFalse(sobre.contains("hunter2"))
        assertFalse(sobre.contains("secreto"))
    }

    @Test(expected = Exception::class)
    fun `con la clave equivocada NO descifra`() {
        Crypto.open(sealLikeNode("""{"a":1}""", newKey()), newKey())
    }

    @Test(expected = Exception::class)
    fun `un sobre manipulado se rechaza en vez de descifrarse a otra cosa`() {
        val key = newKey()
        val sobre = JSONObject(sealLikeNode("""{"a":1}""", key))

        val ct = Base64.getDecoder().decode(sobre.getString("ct"))
        ct[0] = (ct[0].toInt() xor 0xff).toByte()          // un bit distinto
        sobre.put("ct", Base64.getEncoder().encodeToString(ct))

        Crypto.open(sobre.toString(), key)
    }

    @Test
    fun `isSealed distingue un sobre de JSON plano`() {
        assertTrue(Crypto.isSealed(sealLikeNode("""{"a":1}""", newKey())))
        assertFalse(Crypto.isSealed("""{"jobs":[]}"""))
        assertFalse(Crypto.isSealed("no soy json"))
    }

    @Test
    fun `la clave del QR se decodifica a 32 bytes (AES-256)`() {
        assertEquals(32, Crypto.keyBytes(newKey()).size)
    }
}
