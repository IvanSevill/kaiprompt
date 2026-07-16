package com.kaiprompt.app

import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.security.MessageDigest

internal data class ParsedNotificationRequest(val sealedBody: String)

internal class NotificationRequestError(val status: Int) : Exception()

internal object NotificationRequest {
    const val MAX_BODY_BYTES = 32 * 1024
    private const val MAX_HEADER_BYTES = 16 * 1024

    fun parse(input: InputStream, authorizationToken: String): ParsedNotificationRequest {
        var headerBytes = 0
        fun line(): String {
            val bytes = ArrayList<Byte>()
            while (true) {
                val next = input.read()
                if (next < 0) throw NotificationRequestError(400)
                headerBytes++
                if (headerBytes > MAX_HEADER_BYTES) throw NotificationRequestError(431)
                if (next == '\n'.code) break
                if (next != '\r'.code) bytes += next.toByte()
            }
            return bytes.toByteArray().toString(Charsets.ISO_8859_1)
        }

        val request = line().split(' ')
        if (request.size != 3 || request[0] != "POST" || request[1] != "/job-done" || !request[2].startsWith("HTTP/1.")) {
            throw NotificationRequestError(404)
        }
        val headers = linkedMapOf<String, String>()
        while (true) {
            val value = line()
            if (value.isEmpty()) break
            val separator = value.indexOf(':')
            if (separator <= 0) throw NotificationRequestError(400)
            val name = value.substring(0, separator).trim().lowercase()
            if (name in headers) throw NotificationRequestError(400)
            headers[name] = value.substring(separator + 1).trim()
        }

        val expected = "Bearer $authorizationToken".toByteArray(Charsets.UTF_8)
        val supplied = headers["authorization"].orEmpty().toByteArray(Charsets.UTF_8)
        if (!MessageDigest.isEqual(expected, supplied)) throw NotificationRequestError(401)
        if (headers["content-type"]?.substringBefore(';')?.trim()?.lowercase() != "application/json" ||
            headers["x-kaip-enc"] != "1"
        ) throw NotificationRequestError(415)

        val length = headers["content-length"]?.toIntOrNull() ?: throw NotificationRequestError(411)
        if (length !in 1..MAX_BODY_BYTES) throw NotificationRequestError(413)
        val body = ByteArray(length)
        var offset = 0
        while (offset < body.size) {
            val count = input.read(body, offset, body.size - offset)
            if (count < 0) throw NotificationRequestError(400)
            offset += count
        }
        return ParsedNotificationRequest(body.toString(Charsets.UTF_8))
    }

    fun sourceAllowed(source: InetAddress, pairing: Pairing): Boolean {
        if (source.isLoopbackAddress || source.isSiteLocalAddress || source.isLinkLocalAddress) return true
        val expected = listOfNotNull(pairing.lan, pairing.url).mapNotNull { base ->
            val host = runCatching { URI(base).host }.getOrNull() ?: return@mapNotNull null
            val literal = host.contains(':') || host.matches(Regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}"))
            if (!literal) return@mapNotNull null
            runCatching { InetAddress.getByName(host).hostAddress }.getOrNull()
        }
        val actual = source.hostAddress?.removePrefix("::ffff:") ?: return false
        return expected.any { it.removePrefix("::ffff:") == actual }
    }
}
