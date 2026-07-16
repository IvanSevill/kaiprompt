package com.kaiprompt.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.ServerSocket
import java.net.Socket

/**
 * The phone's half of the notification story.
 *
 * The PC knocks: when a launch finishes it POSTs here, and the notification appears at once.
 * No Firebase, no Google, nothing in the cloud. Android 15 has no honest foreground-service
 * type for an indefinite local callback socket, so this fast path is active only while the app
 * is foregrounded. CatchUpWorker is the durable background path.
 *
 * A knock that never lands (phone off, no signal, service killed) is covered by CatchUpWorker.
 * The webhook is the fast path, not the only one.
 */
class ListenerService : Service() {

    companion object {
        const val PORT = 8899
        fun start(context: Context) {
            context.startService(Intent(context, ListenerService::class.java))
        }

        fun stop(context: Context) = context.stopService(Intent(context, ListenerService::class.java))

        /** Where the PC should knock. */
        fun callbackUrl(host: String) = "http://$host:$PORT/job-done"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: ServerSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        listen()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onDestroy() {
        scope.cancel()
        runCatching { socket?.close() }
        super.onDestroy()
    }

    private fun listen() = scope.launch {
        val server = runCatching { ServerSocket(PORT) }.getOrNull() ?: return@launch
        socket = server
        while (!server.isClosed) {
            val client = runCatching { server.accept() }.getOrNull() ?: continue
            launch { handle(client) }
        }
    }

    /**
     * Read one small POST by hand. Pulling in a web server to parse a handful of headers and
     * a line of JSON would be more code than the thing it replaced.
     */
    private fun handle(client: Socket) = client.use { c ->
        c.soTimeout = 5_000
        val pairing = Store(this).pairing ?: return@use respond(c, 401)
        if (!NotificationRequest.sourceAllowed(c.inetAddress, pairing)) return@use respond(c, 403)
        val request = try {
            NotificationRequest.parse(c.getInputStream(), pairing.token)
        } catch (error: NotificationRequestError) {
            return@use respond(c, error.status)
        } catch (_: Exception) {
            return@use respond(c, 400)
        }
        val event = try {
            JSONObject(Crypto.open(request.sealedBody, pairing.key))
        } catch (_: Exception) {
            return@use respond(c, 400)
        }
        respond(c, 204)
        announce(event)
    }

    private fun respond(client: Socket, status: Int) {
        val reason = when (status) {
            204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"
            403 -> "Forbidden"; 404 -> "Not Found"; 411 -> "Length Required"
            413 -> "Payload Too Large"; 415 -> "Unsupported Media Type"; 431 -> "Request Header Fields Too Large"
            else -> "Bad Request"
        }
        runCatching { client.getOutputStream().write("HTTP/1.1 $status $reason\r\nConnection: close\r\n\r\n".toByteArray()) }
    }

    private fun announce(event: JSONObject) {
        val store = Store(this)
        val id = event.optString("id")
        if (id.isBlank() || id in store.announced) return   // never say the same thing twice

        val delivered = Notifier(this).jobFinished(
            id = id,
            ok = event.optString("status") == "done",
            what = event.optString("preview").ifBlank {
                Store(this).language.localizedContext(this).getString(R.string.notification_default_job)
            },
            detail = event.optStringOrNull("error"),
        )
        if (delivered) store.announced = newestNotificationIds(store.announced, listOf(id))
    }
}
