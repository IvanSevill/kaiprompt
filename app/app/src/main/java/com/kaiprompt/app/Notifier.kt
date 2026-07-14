package com.kaiprompt.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

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
            val strings = Store(context).language.localizedContext(context)

            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_LIVE, strings.getString(R.string.notification_channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
                    description = strings.getString(R.string.notification_channel_connection_description)
                }
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_DONE, strings.getString(R.string.notification_channel_jobs), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = strings.getString(R.string.notification_channel_jobs_description)
                }
            )
        }

        fun canNotify(context: Context): Boolean {
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
            val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL_DONE)
            return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
        }
    }

    fun jobFinished(id: String, ok: Boolean, what: String, detail: String?): Boolean {
        if (!canNotify(context)) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        val strings = Store(context).language.localizedContext(context)
        val open = PendingIntent.getActivity(
            context,
            id.hashCode(),
            Intent(context, MainActivity::class.java).putExtra("job", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val body = listOfNotNull(what, detail).joinToString("\n\n")

        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(strings.getString(if (ok) R.string.notification_done else R.string.notification_failed))
            .setContentText(what)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            // A failure is worth interrupting you for; a success can wait until you look.
            .setPriority(if (ok) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .build()

        return runCatching {
            NotificationManagerCompat.from(context).notify(id.hashCode(), n)
            true
        }.getOrDefault(false)
    }

    fun jobsFinished(jobs: List<Job>): Set<String> = jobs.mapNotNullTo(mutableSetOf()) { j ->
        if (jobFinished(
                id = j.id,
                ok = j.status == "done",
                what = j.preview.ifBlank { j.prompt?.lineSequence()?.firstOrNull() ?: j.id },
                detail = j.error,
            )) j.id else null
    }
}
