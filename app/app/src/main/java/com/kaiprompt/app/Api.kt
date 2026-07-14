package com.kaiprompt.app

import android.content.Context
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Talking to your PC.
 *
 * Plain HttpURLConnection — no OkHttp. The API is six endpoints and one event stream; a
 * networking library would be more code than the thing it wraps.
 *
 * Every call asks for a sealed answer (`x-kaip-enc: 1`), so what crosses Cloudflare is an
 * envelope they have no key to. The unsealing happens here, at the edge of the app.
 */
class Api(private val pairing: Pairing, private val context: Context) {

    class Down(message: String, val statusCode: Int? = null) : Exception(message)
    class Unauthorized(context: Context) : Exception(context.getString(R.string.api_unauthorized))

    /**
     * The tunnel first, the home address as a fallback.
     *
     * Both are tried because they fail in opposite situations: the tunnel is down when the
     * PC just restarted `kaip serve` (a quick tunnel gets a new URL every time), and the LAN
     * address is unreachable the moment you leave the house. Trying both means the app keeps
     * working in the case the other one would have broken.
     */
    private val bases: List<String> = listOfNotNull(pairing.url, pairing.lan).distinct()

    fun state(): State = State.parse(get("/api/state"))

    /** Optional historical telemetry. Older PCs do not have this endpoint yet. */
    fun usage(): Usage = Usage.parse(get("/api/usage"))

    fun job(id: String): String = get("/api/job/$id")

    fun chat(ref: String): Chat = Chat.parse(get("/api/job/$ref/chat"))

    /**
     * Introduce this phone to the PC: its NAME, and — if we have one — where to knock.
     *
     * The name is the point, and it can only come from here. The PC has no way to know what
     * your handset is called, which is why it used to render a `?` wherever a device name
     * belonged.
     *
     * The url is nullable on purpose. It is built from this phone's own LAN address, and on
     * mobile data with no wifi there simply is not one. The PC used to reject a registration
     * with no url (400), so on 4G the phone paired, worked fine, and stayed anonymous — and
     * the PC never even registered that it existed. Now the name goes up regardless; a phone
     * with no callback still gets its news from the 15-minute catch-up poll.
     */
    fun registerDevice(url: String?, name: String, id: String) {
        val u = if (url == null) "null" else quote(url)
        post("/api/device", """{"url":$u,"name":${quote(name)},"id":${quote(id)}}""")
    }

    /** Best-effort farewell used only by the explicit Unpair action. */
    fun deleteDevice(id: String): PairingState = PairingState.parse(delete("/api/device/${URLEncoder.encode(id, "UTF-8")}"))

    fun pairingState(id: String): PairingState = PairingState.parse(get("/api/pairing/${URLEncoder.encode(id, "UTF-8")}"))

    /** Wipe everything that has already run. The one destructive thing the phone can do. */
    fun clearFinished() {
        attempt { base ->
            val c = open("$base/api/finished")
            c.requestMethod = "DELETE"
            readBody(c)
        }
    }

    /** Is the PC even on? The only call that needs no token. */
    fun ping(): Boolean = try {
        bases.any { base ->
            open("$base/api/ping", auth = false).let { c ->
                val ok = c.responseCode == 200
                c.disconnect()
                ok
            }
        }
    } catch (_: Exception) {
        false
    }

    // --- the wire ---------------------------------------------------------------
    private fun get(path: String): String = attempt { base ->
        val c = open("$base$path")
        readBody(c)
    }

    private fun post(path: String, body: String): String = attempt { base ->
        val c = open("$base$path")
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toByteArray()) }
        readBody(c)
    }

    private fun delete(path: String): String = attempt { base ->
        val c = open("$base$path")
        c.requestMethod = "DELETE"
        readBody(c)
    }

    /** Try each address in turn; only give up when they have all failed. */
    private fun <T> attempt(block: (String) -> T): T {
        var last: Exception? = null
        for (base in bases) {
            try {
                return block(base)
            } catch (e: Unauthorized) {
                throw e                       // a bad token will be bad on every address
            } catch (e: Exception) {
                last = e
            }
        }

        // Name the ADDRESS, not the hostname. `host` is decoration and is not even in the
        // compact QR any more, so this message used to read "no llego a ?." — which tells
        // you nothing, and tells you it twice. The address is the thing you can act on: it
        // says whether the app was reaching for the tunnel or for the PC on your wifi.
        val tried = bases.joinToString("\n") { "  · $it" }
        val why = last?.message.orEmpty()

        // A quick tunnel gets a NEW address every time `kaip serve` restarts, so the most
        // likely reason a working app suddenly stops working is simply that: it is knocking
        // on a door that no longer exists.
        val hint = if (pairing.tunnel) {
            context.getString(R.string.api_tunnel_hint)
        } else {
            context.getString(R.string.api_wifi_hint)
        }

        throw Down(context.getString(R.string.api_unreachable, tried, hint, why).trim())
    }

    private fun open(url: String, auth: Boolean = true): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 15000
            if (auth) {
                setRequestProperty("authorization", "Bearer ${pairing.token}")
                setRequestProperty("x-kaip-enc", "1")     // seal it: Cloudflare is listening
            }
        }

    private fun readBody(c: HttpURLConnection): String {
        val code = c.responseCode
        if (code == 401) throw Unauthorized(context)

        val stream = if (code in 200..299) c.inputStream else c.errorStream
        val body = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        c.disconnect()

        if (code !in 200..299) {
            throw Down(context.getString(R.string.api_response_error, code, body.take(200)), code)
        }

        // The 401 above is deliberately NOT sealed by the server, so the reason is readable.
        // Everything else is, and this is where it stops being Cloudflare's business.
        return if (Crypto.isSealed(body)) Crypto.open(body, pairing.key) else body
    }

    /**
     * The live feed. One line at a time, blocking — the caller runs it off the main thread
     * and closes it by cancelling the coroutine.
     */
    fun events(jobId: String, since: String?, onEvent: (LiveEvent) -> Unit) {
        attempt { base ->
            val query = buildString {
                append("?job=").append(URLEncoder.encode(jobId, "UTF-8"))
                if (since != null) append("&since=").append(URLEncoder.encode(since, "UTF-8"))
            }
            val c = open("$base/api/events$query")
            c.readTimeout = 0
            try {
                var eventId: String? = null
                c.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.startsWith("id:")) eventId = line.removePrefix("id:").trim()
                        if (!line.startsWith("data:")) continue
                        val payload = line.removePrefix("data:").trim()
                        if (payload.isEmpty()) continue
                        val opened = if (Crypto.isSealed(payload)) Crypto.open(payload, pairing.key) else payload
                        val parsed = LiveEvent.parse(opened)
                        onEvent(if (parsed.id == null && eventId != null) parsed.copy(id = eventId) else parsed)
                    }
                }
            } finally {
                c.disconnect()
            }
        }
    }

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
