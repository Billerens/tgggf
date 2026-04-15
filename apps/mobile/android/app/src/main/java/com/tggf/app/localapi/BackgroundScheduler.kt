package com.tggf.app.localapi

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object BackgroundScheduler {
    private const val UNIQUE_PERIODIC_WORK = "tg_gf_scheduler_periodic"
    private const val UNIQUE_RECOVERY_WORK = "tg_gf_scheduler_recovery"
    private const val PERIODIC_INTERVAL_MINUTES = 15L
    private const val RECOVERY_DELAY_SECONDS = 8L

    @JvmStatic
    fun ensureScheduled(context: Context, reason: String) {
        val appContext = context.applicationContext
        val workManager = WorkManager.getInstance(appContext)

        val periodic =
            PeriodicWorkRequestBuilder<SchedulerWorker>(
                PERIODIC_INTERVAL_MINUTES,
                TimeUnit.MINUTES,
            ).build()
        workManager.enqueueUniquePeriodicWork(
            UNIQUE_PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            periodic,
        )

        val recovery =
            OneTimeWorkRequestBuilder<SchedulerWorker>()
                .setInitialDelay(RECOVERY_DELAY_SECONDS, TimeUnit.SECONDS)
                .build()
        workManager.enqueueUniqueWork(
            UNIQUE_RECOVERY_WORK,
            ExistingWorkPolicy.REPLACE,
            recovery,
        )

        val runtime = BackgroundRuntimeRepository(appContext)
        try {
            runtime.appendEvent(
                taskType = "scheduler",
                scopeId = "global",
                jobId = null,
                stage = "work_enqueued",
                level = "info",
                message = "Background scheduler work enqueued",
                detailsJson =
                    org.json.JSONObject().apply {
                        put("reason", reason.ifBlank { "unknown" })
                        put("periodicMinutes", PERIODIC_INTERVAL_MINUTES)
                        put("recoveryDelaySeconds", RECOVERY_DELAY_SECONDS)
                    }.toString(),
            )
        } finally {
            runtime.closeQuietly()
        }
    }
}

