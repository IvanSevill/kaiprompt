package com.kaiprompt.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetAddress

class NotificationRequestTest {
    private val token = "pairing-token"

    private fun request(body: String, extraHeaders: String = ""): ByteArray {
        val bytes = body.toByteArray(Charsets.UTF_8)
        return ("POST /job-done HTTP/1.1\r\n" +
            "Authorization: Bearer $token\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "X-Kaip-Enc: 1\r\n" + extraHeaders +
            "Content-Length: ${bytes.size}\r\n\r\n").toByteArray(Charsets.ISO_8859_1) + bytes
    }

    @Test
    fun `reads the declared UTF-8 bytes across partial reads`() {
        val body = """{"v":1,"ct":"teléfono"}"""
        val source = request(body)
        val partial = object : InputStream() {
            var offset = 0
            override fun read(): Int = if (offset < source.size) source[offset++].toInt() and 0xff else -1
            override fun read(buffer: ByteArray, off: Int, len: Int): Int {
                if (offset >= source.size) return -1
                val count = minOf(2, len, source.size - offset)
                source.copyInto(buffer, off, offset, offset + count)
                offset += count
                return count
            }
        }
        assertEquals(body, NotificationRequest.parse(partial, token).sealedBody)
    }

    @Test
    fun `rejects wrong method path auth plaintext and oversized body`() {
        val valid = request("{}")
        val cases = listOf(
            valid.toString(Charsets.ISO_8859_1).replaceFirst("POST", "GET").toByteArray(Charsets.ISO_8859_1),
            valid.toString(Charsets.ISO_8859_1).replaceFirst("/job-done", "/other").toByteArray(Charsets.ISO_8859_1),
            valid.toString(Charsets.ISO_8859_1).replaceFirst("Bearer $token", "Bearer forged").toByteArray(Charsets.ISO_8859_1),
            valid.toString(Charsets.ISO_8859_1).replace("X-Kaip-Enc: 1\r\n", "").toByteArray(Charsets.ISO_8859_1),
            request("{}").toString(Charsets.ISO_8859_1)
                .replace("Content-Length: 2", "Content-Length: ${NotificationRequest.MAX_BODY_BYTES + 1}")
                .toByteArray(Charsets.ISO_8859_1),
        )
        cases.forEach { bytes ->
            assertTrue(runCatching { NotificationRequest.parse(ByteArrayInputStream(bytes), token) }.isFailure)
        }
    }

    @Test
    fun `source must match a literal paired PC address`() {
        val pairing = Pairing("https://tunnel.example", "http://192.168.1.8:7777", token, "key", true)
        assertTrue(NotificationRequest.sourceAllowed(InetAddress.getByName("192.168.1.8"), pairing))
        assertTrue(!NotificationRequest.sourceAllowed(InetAddress.getByName("8.8.8.8"), pairing))
    }
}
