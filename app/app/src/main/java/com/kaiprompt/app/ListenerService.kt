package com.kaiprompt.app

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
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
 * No Firebase, no Google, nothing in the cloud. It works because a *foreground* service is
 * exempt from Doze's network restrictions — an ordinary background service would be
 * suspended at 3am, which is exactly when the interesting launches finish.
 *
 * The permanent notification in the shade is what Android charges for that, and there is no
 * way around it. Pretending otherwise would just mean the notifications quietly stop working
 * after a week, which is worse.
 *
 * A knock that never lands (phone off, no signal, service killed) is covered by CatchUpWorker.
 * The webhook is the fast path, not the only one.
 */
class ListenerService : Service() {

    companion object {
        const val PORT = 8899
        private const val ONGOING_ID = 1

        fun start(context: Context) {
            val i = Intent(context, ListenerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
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
        Notifier.ensureChannels(this)
        startForeground(ONGOING_ID, ongoing())
        listen()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

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
        val reader = c.getInputStream().bufferedReader()

        var length = 0
        var line = reader.readLine()
        while (!line.isNullOrBlank()) {
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                length = line.substringAfter(':').trim().toIntOrNull() ?: 0
            }
            line = reader.readLine()
        }

        val body = if (length > 0) {
            CharArray(length).let { buf -> reader.read(buf, 0, length); String(buf) }
        } else ""

        c.getOutputStream().write("HTTP/1.1 204 No Content\r\n\r\n".toByteArray())
        runCatching { announce(JSONObject(body)) }
    }

    private fun announce(event: JSONObject) {
        val store = Store(this)
        val id = event.optString("id")
        if (id.isBlank() || id in store.announced) return   // never say the same thing twice
        store.announced = store.announced + id

        Notifier(this).jobFinished(
            id = id,
            ok = event.optString("status") == "done",
            what = event.optString("preview").ifBlank { "un lanzamiento" },
            detail = event.optStringOrNull("error"),
        )
    }

    private fun ongoing(): Notification =
        NotificationCompat.Builder(this, Notifier.CHANNEL_LIVE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Kaiprompt")
            .setContentText("esperando avisos del PC")
            .setPriority(NotificationCompat.PRIORITY_MIN)     // as quiet as Android allows
            .setOngoing(true)
            .build()
}
