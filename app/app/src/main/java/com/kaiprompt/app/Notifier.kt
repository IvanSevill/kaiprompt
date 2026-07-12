package com.kaiprompt.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Saying "it finished".
 *
 * One place, used by both routes in: the webhook (instant, when the PC can reach the phone)
 * and the catch-up poll (later, when it could not). They must produce the same notification,
 * or the same job would look like two different events depending on how you found out.
 */
class Notifier(private val context: Context) {

    companion object {
        const val CHANNEL_LIVE = "kaip_live"
        const val CHANNEL_DONE = "kaip_done"

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(NotificationManager::class.java)

            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_LIVE, "Conexión", NotificationManager.IMPORTANCE_MIN).apply {
                    description =
                        "La notificación permanente que Android exige para poder avisarte con la app cerrada."
                }
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_DONE, "Lanzamientos", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Cuando un lanzamiento termina o falla."
                }
            )
        }
    }

    fun jobFinished(id: String, ok: Boolean, what: String, detail: String?) {
        val open = PendingIntent.getActivity(
            context,
            id.hashCode(),
            Intent(context, MainActivity::class.java).putExtra("job", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val body = listOfNotNull(what, detail).joinToString("\n\n")

        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(if (ok) "✓ terminado" else "✗ falló")
            .setContentText(what)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            // A failure is worth interrupting you for; a success can wait until you look.
            .setPriority(if (ok) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .build()

        runCatching { NotificationManagerCompat.from(context).notify(id.hashCode(), n) }
    }

    fun jobsFinished(jobs: List<Job>) {
        for (j in jobs) {
            jobFinished(
                id = j.id,
                ok = j.status == "done",
                what = j.preview.ifBlank { j.prompt?.lineSequence()?.firstOrNull() ?: j.id },
                detail = j.error,
            )
        }
    }
}
