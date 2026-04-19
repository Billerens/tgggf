package com.tggf.app.localapi

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject

class SchedulerWorker(
    appContext: Context,
    params: WorkerParameters
) : Worker(appContext, params) {
    override fun doWork(): Result {
        val runtime = BackgroundRuntimeRepository(applicationContext)
        val jobs = BackgroundJobRepository(applicationContext)
        try {
            return try {
                BackgroundRuntimeEngine.requestTick(applicationContext)
                TopicGenerationNativeExecutor.requestTick(applicationContext)
                GroupIterationNativeExecutor.requestTick(applicationContext)
                OneToOneChatNativeExecutor.requestTick(applicationContext)

                val enabledCount =
                    runtime.countDesiredStates(taskType = null, enabledOnly = true)
                val pendingCount =
                    jobs.countJobs(status = BackgroundJobRepository.STATUS_PENDING)
                val leasedCount =
                    jobs.countJobs(status = BackgroundJobRepository.STATUS_LEASED)
                val shouldKeepAlive = enabledCount > 0 || pendingCount > 0 || leasedCount > 0
                if (shouldKeepAlive) {
                    ForegroundSyncService.ensureStartedIfEnabled(applicationContext)
                }

                runtime.appendEvent(
                    taskType = "scheduler",
                    scopeId = "global",
                    jobId = null,
                    stage = "worker_tick",
                    level = "info",
                    message = "Scheduler worker processed background tick",
                    detailsJson =
                        JSONObject().apply {
                            put("enabledCount", enabledCount)
                            put("pendingCount", pendingCount)
                            put("leasedCount", leasedCount)
                            put("keepAliveStarted", shouldKeepAlive)
                        }.toString(),
                )
                Result.success()
            } catch (error: Exception) {
                runtime.appendEvent(
                    taskType = "scheduler",
                    scopeId = "global",
                    jobId = null,
                    stage = "worker_failed",
                    level = "error",
                    message = "Scheduler worker failed",
                    detailsJson =
                        JSONObject().apply {
                            put("error", error.message ?: "unknown_error")
                        }.toString(),
                )
                Result.retry()
            }
        } finally {
            jobs.closeQuietly()
            runtime.closeQuietly()
        }
    }
}
