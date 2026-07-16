package com.kaiprompt.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * The safety net under the webhook.
 *
 * The PC knocking on the phone is the fast path, and it is the one that works. But a knock
 * lands nowhere if the phone was off, out of signal, or Android had killed the listener —
 * and a webhook does not retry itself. Without this, "it finished at 3am and I never heard"
 * would be a real, silent failure mode, which for a tool whose entire purpose is telling you
 * that would be an embarrassment.
 *
 * So every 15 minutes (Android's floor) we ask the PC directly and announce anything that
 * finished while nobody was listening. `announced` in Store is what keeps a job from being
 * announced twice — a notification you have already read reappearing is how people turn
 * notifications off.
 */
class CatchUpWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private const val NAME = "kaip-catchup"

        fun schedule(context: Context) {
            val work = PeriodicWorkRequestBuilder<CatchUpWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, work)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }

    override suspend fun doWork(): Result {
        val store = Store(applicationContext)
        val pairing = store.pairing ?: return Result.success()

        val state = try {
            Api(pairing, store.language.localizedContext(applicationContext)).state()
        } catch (_: Exception) {
            return Result.retry()               // the PC is off, or we are; try again later
        }

        val finished = state.jobs.filter { it.finishedAt != null }
        if (!store.notificationBaselineReady) {
            // Installing or updating the app must not replay the whole queue as alerts.
            store.announced = newestNotificationIds(
                store.announced,
                finished.sortedByDescending { it.finishedAt }.map { it.id },
            )
            store.notificationBaselineReady = true
            return Result.success()
        }

        val unseen = finished.filter { it.id !in store.announced }.sortedByDescending { it.finishedAt }
        if (unseen.isEmpty()) return Result.success()

        // Only suppress an alert after Android accepted it. A denied permission or disabled
        // channel must remain recoverable on the next wake-up rather than losing the event.
        val delivered = Notifier(applicationContext).jobsFinished(unseen)
        store.announced = newestNotificationIds(store.announced, delivered)
        return Result.success()
    }
}
