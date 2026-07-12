package com.kaiprompt.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.ServerSocket
import java.net.Socket

/**
 * The half of the notification story that lives on the phone.
 *
 * The PC knocks: when a launch finishes it POSTs to this phone, and a notification appears
 * at once — no Firebase, no Google, nothing in the cloud. That works because the phone is
 * reachable through the tunnel, and because a *foreground* service is exempt from Doze's
 * network restrictions. An ordinary background service would be suspended at 3am, which is
 * exactly when the interesting launches finish.
 *
 * The price Android charges for that is the permanent notification you see in the shade.
 * There is no way around it, and pretending otherwise would just mean the notifications
 * quietly stop working after a week.
 *
 * A knock that never arrives (phone off, no signal, app killed) is covered by the catch-up
 * poll in CatchUpWorker — the webhook is the fast path, not the only one.
 */
class ListenerService : Service() {

    companion object {
        const val PORT = 8899
        private const val CHANNEL_LIVE = "kaip_live"
        private const val CHANNEL_DONE = "kaip_done"
        private const val ONGOING_ID = 1

        fun start(context: Context) {
            val i = Intent(context, ListenerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ListenerService::class.java))
        }

        /** The address the PC should knock on. Filled in once we know our own IP. */
        fun callbackUrl(host: String) = "http://$host:$PORT/job-done"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: ServerSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(ONGOING_ID, ongoing())
        listen()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        runCatching { socket?.close() }
        super.onDestroy()
    }

    // --- the knock ------------------------------------------------------------
    private fun listen() = scope.launch {
        val server = runCatching { ServerSocket(PORT) }.getOrNull() ?: return@launch
        socket = server

        while (!server.isClosed) {
            val client = runCatching { server.accept() }.getOrNull() ?: continue
            launch { handle(client) }
        }
    }

    private fun handle(client: Socket) = client.use { c ->
        val reader = c.getInputStream().bufferedReader()

        // A hand-rolled HTTP read: the request is one POST with a small JSON body, and
        // pulling in a web server for that would be absurd.
        var length = 0
        var line = reader.readLine()
        while (!line.isNullOrBlank()) {
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                length = line.substringAfter(':').trim().toIntOrNull() ?: 0
            }
            line = reader.readLine()
        }

        val body = CharArray(length).let { buf ->
            if (length > 0) reader.read(buf, 0, length)
            String(buf)
        }

        c.getOutputStream().write("HTTP/1.1 204 No Content\r\n\r\n".toByteArray())
        runCatching { announce(JSONObject(body)) }
    }

    /** A launch finished. Say so, plainly: what it was, and whether it worked. */
    private fun announce(event: JSONObject) {
        val store = Store(this)
        val id = event.optString("id")
        if (id.isBlank() || id in store.announced) return
        store.announced = store.announced + id

        val ok = event.optString("status") == "done"
        val what = event.optString("preview").ifBlank { "un lanzamiento" }

        notify(
            id.hashCode(),
            title = if (ok) "✓ terminado" else "✗ falló",
            text = what,
            sub = event.optStringOrNull("error"),
            ok = ok,
        )
    }

    private fun notify(id: Int, title: String, text: String, sub: String?, ok: Boolean) {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(this, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOfNotNull(text, sub).joinToString("\n\n")))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(if (ok) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .build()

        runCatching { NotificationManagerCompat.from(this).notify(id, n) }
    }

    private fun ongoing(): Notification =
        NotificationCompat.Builder(this, CHANNEL_LIVE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Kaiprompt")
            .setContentText("esperando avisos del PC")
            .setPriority(NotificationCompat.PRIORITY_MIN)     // as quiet as Android allows
            .setOngoing(true)
            .build()

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)

        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_LIVE, "Conexión", NotificationManager.IMPORTANCE_MIN).apply {
                description = "La notificación permanente que Android exige para poder recibir avisos con la app cerrada."
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, "Lanzamientos", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Cuando un lanzamiento termina o falla."
            }
        )
    }
}
