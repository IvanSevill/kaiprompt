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
            Api(pairing).state()
        } catch (_: Exception) {
            return Result.retry()               // the PC is off, or we are; try again later
        }

        val finished = state.jobs.filter { it.finishedAt != null && it.id !in store.announced }
        if (finished.isEmpty()) return Result.success()

        // Mark them all first. If the notification itself fails we would rather lose one
        // than announce the same job on every wake-up from now until the end of time.
        store.announced = store.announced + finished.map { it.id }

        Notifier(applicationContext).jobsFinished(finished)
        return Result.success()
    }
}
