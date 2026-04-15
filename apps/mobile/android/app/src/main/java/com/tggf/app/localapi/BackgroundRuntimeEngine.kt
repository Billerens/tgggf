package com.tggf.app.localapi

import android.content.Context
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

object BackgroundRuntimeEngine {
    private const val TASK_TOPIC_GENERATION = "topic_generation"
    private const val TASK_GROUP_ITERATION = "group_iteration"
    private const val DEFAULT_TOPIC_DELAY_MS = 2_000L
    private const val DEFAULT_GROUP_INTERVAL_MS = 4_200L
    private const val EVENT_PRUNE_TICK_INTERVAL = 30L
    private const val EVENT_PRUNE_MAX_ROWS = 1_000

    private val inFlight = AtomicBoolean(false)
    private val tickCounter = AtomicLong(0L)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-runtime-engine").apply {
            isDaemon = true
        }
    }

    @JvmStatic
    fun requestTick(context: Context) {
        if (!inFlight.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        executor.execute {
            try {
                processTick(appContext)
            } catch (_: Exception) {
                // Best-effort background runtime loop.
            } finally {
                inFlight.set(false)
            }
        }
    }

    private fun processTick(context: Context) {
        val runtimeRepository = BackgroundRuntimeRepository(context)
        val jobs = BackgroundJobRepository(context)
        try {
            val desiredStates = runtimeRepository.listDesiredStates()
            val knownJobsById =
                jobs.listJobs(status = null, limit = 400).associateBy { job -> job.id }
            val enabledKeys = mutableSetOf<String>()

            for (state in desiredStates) {
                if (!isManagedTaskType(state.taskType)) continue
                val key = buildStateKey(state.taskType, state.scopeId)
                if (state.enabled) {
                    enabledKeys.add(key)
                    val jobId = buildManagedJobId(state.taskType, state.scopeId)
                    ensureManagedJob(
                        runtimeRepository = runtimeRepository,
                        jobs = jobs,
                        state = state,
                        existingJob = knownJobsById[jobId],
                    )
                } else {
                    cancelManagedJob(runtimeRepository, jobs, state.taskType, state.scopeId)
                }
            }

            // Prevent stale orphan jobs from running when desired-state was switched off.
            val existingJobs = jobs.listJobs(status = null, limit = 200)
            for (job in existingJobs) {
                if (!isManagedTaskType(job.type)) continue
                val scopeId = parseScopeId(job.id, job.type)
                if (scopeId.isBlank()) continue
                val key = buildStateKey(job.type, scopeId)
                if (enabledKeys.contains(key)) continue
                if (job.status == BackgroundJobRepository.STATUS_PENDING || job.status == BackgroundJobRepository.STATUS_LEASED) {
                    jobs.cancelJob(job.id)
                    runtimeRepository.appendEvent(
                        taskType = job.type,
                        scopeId = scopeId,
                        jobId = job.id,
                        stage = "orphan_cancelled",
                        level = "warn",
                        message = "Cancelled orphan managed job because desired-state is disabled",
                        detailsJson = null,
                    )
                }
            }

            val nextTick = tickCounter.incrementAndGet()
            if (nextTick % EVENT_PRUNE_TICK_INTERVAL == 0L) {
                runtimeRepository.trimEvents(EVENT_PRUNE_MAX_ROWS)
            }
        } finally {
            jobs.closeQuietly()
            runtimeRepository.closeQuietly()
        }
    }

    private fun ensureManagedJob(
        runtimeRepository: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        state: BackgroundDesiredStateRecord,
        existingJob: BackgroundJobRecord?,
    ) {
        val jobId = buildManagedJobId(state.taskType, state.scopeId)
        val payloadJson = buildManagedPayloadJson(state)
        val runAtMs =
            when (existingJob?.status) {
                BackgroundJobRepository.STATUS_PENDING,
                BackgroundJobRepository.STATUS_LEASED,
                -> existingJob.runAtMs
                else -> System.currentTimeMillis()
            }
        try {
            jobs.ensureRecurringJob(
                id = jobId,
                type = state.taskType,
                payloadJson = payloadJson,
                runAtMs = runAtMs,
                maxAttempts = 0,
            )
        } catch (error: Exception) {
            runtimeRepository.appendEvent(
                taskType = state.taskType,
                scopeId = state.scopeId,
                jobId = jobId,
                stage = "ensure_failed",
                level = "error",
                message = "Failed to ensure managed background job",
                detailsJson = JSONObject().apply {
                    put("error", error.message ?: "unknown_error")
                }.toString(),
            )
        }
    }

    private fun cancelManagedJob(
        runtimeRepository: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        taskType: String,
        scopeId: String,
    ) {
        val jobId = buildManagedJobId(taskType, scopeId)
        try {
            jobs.cancelJob(jobId)
        } catch (error: Exception) {
            runtimeRepository.appendEvent(
                taskType = taskType,
                scopeId = scopeId,
                jobId = jobId,
                stage = "cancel_failed",
                level = "error",
                message = "Failed to cancel managed background job",
                detailsJson = JSONObject().apply {
                    put("error", error.message ?: "unknown_error")
                }.toString(),
            )
        }
    }

    private fun buildManagedPayloadJson(state: BackgroundDesiredStateRecord): String {
        val payload = parsePayloadObject(state.payloadJson)
        return when (state.taskType) {
            TASK_TOPIC_GENERATION -> {
                val delayMs = max(0L, payload.optLong("delayMs", DEFAULT_TOPIC_DELAY_MS))
                JSONObject().apply {
                    put("sessionId", state.scopeId)
                    put("delayMs", delayMs)
                }.toString()
            }
            TASK_GROUP_ITERATION -> {
                val intervalMs = max(1_000L, payload.optLong("intervalMs", DEFAULT_GROUP_INTERVAL_MS))
                JSONObject().apply {
                    put("roomId", state.scopeId)
                    put("intervalMs", intervalMs)
                }.toString()
            }
            else -> payload.toString()
        }
    }

    private fun parsePayloadObject(payloadJson: String): JSONObject {
        if (payloadJson.isBlank()) return JSONObject()
        return try {
            JSONObject(payloadJson)
        } catch (_: JSONException) {
            JSONObject()
        }
    }

    private fun buildManagedJobId(taskType: String, scopeId: String): String {
        val normalizedScope = scopeId.trim()
        return "$taskType:$normalizedScope"
    }

    private fun parseScopeId(jobId: String, taskType: String): String {
        val prefix = "$taskType:"
        if (!jobId.startsWith(prefix)) return ""
        return jobId.removePrefix(prefix).trim()
    }

    private fun isManagedTaskType(taskType: String): Boolean {
        return taskType == TASK_TOPIC_GENERATION || taskType == TASK_GROUP_ITERATION
    }

    private fun buildStateKey(taskType: String, scopeId: String): String {
        return "$taskType:${scopeId.trim()}"
    }
}
