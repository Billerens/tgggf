package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

object GroupIterationNativeExecutor {
    private const val GROUP_ITERATION_JOB_TYPE = "group_iteration"
    private const val GROUP_ITERATION_JOB_PREFIX = "group_iteration:"
    private const val GROUP_ITERATION_LEASE_MS = 120_000L
    private const val GROUP_ITERATION_DEFAULT_INTERVAL_MS = 4_200L
    private const val GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS = 30_000L
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L

    private val inFlight = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-group-native").apply {
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
                // Best-effort native dispatcher.
            } finally {
                inFlight.set(false)
            }
        }
    }

    private fun processTick(context: Context) {
        val jobs = BackgroundJobRepository(context)
        val runtime = BackgroundRuntimeRepository(context)
        val repository = LocalRepository(context)
        val claimed = jobs.claimDueJobs(
            limit = 1,
            leaseMs = GROUP_ITERATION_LEASE_MS,
            type = GROUP_ITERATION_JOB_TYPE,
        )

        if (claimed.isEmpty()) {
            emitAwaitingState(
                context = context,
                runtime = runtime,
                jobs = jobs,
                repository = repository,
            )
            return
        }

        for (job in claimed) {
            processClaimedJob(
                context = context,
                jobs = jobs,
                runtime = runtime,
                repository = repository,
                job = job,
            )
        }
    }

    private fun emitAwaitingState(
        context: Context,
        runtime: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        repository: LocalRepository,
    ) {
        val enabledStates =
            runtime.listDesiredStates(GROUP_ITERATION_JOB_TYPE).filter { row ->
                row.enabled && row.scopeId.isNotBlank()
            }
        val hasEnabledRoom = enabledStates.isNotEmpty()
        val scopeId = enabledStates.firstOrNull()?.scopeId?.trim().orEmpty()
        val room =
            if (scopeId.isBlank()) {
                null
            } else {
                findRoomById(readStoreArray(repository, "groupRooms"), scopeId)
            }
        val blockingReason = resolveRoomBlockingReason(room)
        val hasLeasedJobs =
            jobs.countJobs(
                status = BackgroundJobRepository.STATUS_LEASED,
                type = GROUP_ITERATION_JOB_TYPE,
            ) > 0
        val hasPendingJobs =
            jobs.countJobs(
                status = BackgroundJobRepository.STATUS_PENDING,
                type = GROUP_ITERATION_JOB_TYPE,
            ) > 0
        val state =
            when {
                !hasEnabledRoom -> "idle"
                blockingReason.isNotBlank() -> "idle"
                else -> "running"
            }
        val detail =
            when {
                !hasEnabledRoom -> "no_active_room"
                blockingReason.isNotBlank() -> blockingReason
                hasLeasedJobs && !hasPendingJobs -> "awaiting_bridge_ack"
                else -> "awaiting_due_job"
            }
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
            state = state,
            scopeId = scopeId,
            detail = detail,
            progress = false,
            claimed = false,
            lastError = "",
        )
    }

    private fun processClaimedJob(
        context: Context,
        jobs: BackgroundJobRepository,
        runtime: BackgroundRuntimeRepository,
        repository: LocalRepository,
        job: BackgroundJobRecord,
    ) {
        val payload = parseJsonObject(job.payloadJson)
        val roomId =
            payload.optString("roomId", parseRoomIdFromJobId(job.id)).trim()
        if (roomId.isEmpty()) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = "unknown",
                jobId = job.id,
                stage = "job_scope_missing",
                level = "error",
                message = "Failed to resolve roomId for group iteration job",
                details = JSONObject().apply {
                    put("jobId", job.id)
                    put("payload", payload)
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "idle",
                scopeId = "",
                detail = "room_missing",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }

        val intervalMs = max(1_000L, payload.optLong("intervalMs", GROUP_ITERATION_DEFAULT_INTERVAL_MS))
        val desiredState = runtime.getDesiredState(GROUP_ITERATION_JOB_TYPE, roomId)
        if (desiredState == null || !desiredState.enabled) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "desired_state_disabled",
                level = "info",
                message = "Cancelled group iteration job because desired-state is disabled",
                details = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "idle",
                scopeId = roomId,
                detail = "desired_state_disabled",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }

        val room = findRoomById(readStoreArray(repository, "groupRooms"), roomId)
        if (room == null) {
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + CONTEXT_SYNC_RETRY_DELAY_MS,
                incrementAttempts = false,
                lastError = "room_missing",
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "running",
                scopeId = roomId,
                detail = "awaiting_room_sync",
                progress = false,
                claimed = true,
                lastError = "room_missing",
            )
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "room_missing",
                level = "warn",
                message = "Group room is missing while job is claimed",
                details = null,
            )
            return
        }

        val blockingReason = resolveRoomBlockingReason(room)

        if (blockingReason.isNotBlank()) {
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + intervalMs,
                incrementAttempts = false,
                lastError = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "idle",
                scopeId = roomId,
                detail = blockingReason,
                progress = false,
                claimed = false,
                lastError = "",
            )
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "room_blocked",
                level = "info",
                message = "Skipped group iteration dispatch because room is blocked",
                details = JSONObject().apply {
                    put("reason", blockingReason)
                },
            )
            return
        }

        val requestedAtMs = System.currentTimeMillis()
        LocalApiBridgePlugin.emitGroupIterationRunRequest(
            source = "native_group_executor",
            roomId = roomId,
            jobId = job.id,
            intervalMs = intervalMs,
            leaseUntilMs = job.leaseUntilMs ?: requestedAtMs + GROUP_ITERATION_LEASE_MS,
        )
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
            state = "running",
            scopeId = roomId,
            detail = "native_dispatched",
            progress = false,
            claimed = true,
            lastError = "",
        )
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = roomId,
            jobId = job.id,
            stage = "dispatch_requested",
            level = "info",
            message = "Dispatched group iteration run request to web bridge",
            details = JSONObject().apply {
                put("intervalMs", intervalMs)
                put("requestedAtMs", requestedAtMs)
            },
        )
        val fallbackRunAtMs = System.currentTimeMillis() + GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS
        val scheduledFallback =
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = fallbackRunAtMs,
                incrementAttempts = false,
                lastError = null,
            )
        if (scheduledFallback) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "dispatch_watchdog_scheduled",
                level = "info",
                message = "Scheduled fallback reschedule in case bridge ACK is missing",
                details = JSONObject().apply {
                    put("fallbackRunAtMs", fallbackRunAtMs)
                    put("ackTimeoutMs", GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS)
                },
            )
        } else {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "dispatch_watchdog_schedule_failed",
                level = "warn",
                message = "Failed to schedule fallback reschedule for dispatched job",
                details = JSONObject().apply {
                    put("ackTimeoutMs", GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS)
                },
            )
        }
    }

    private fun readStoreArray(repository: LocalRepository, storeName: String): JSONArray {
        val raw = repository.readStoreJson(storeName)
        if (raw.isNullOrBlank()) return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun findRoomById(rooms: JSONArray, roomId: String): JSONObject? {
        for (index in 0 until rooms.length()) {
            val room = rooms.optJSONObject(index) ?: continue
            if (room.optString("id", "").trim() == roomId) {
                return room
            }
        }
        return null
    }

    private fun parseRoomIdFromJobId(jobId: String): String {
        if (!jobId.startsWith(GROUP_ITERATION_JOB_PREFIX)) return ""
        return jobId.removePrefix(GROUP_ITERATION_JOB_PREFIX).trim()
    }

    private fun parseJsonObject(raw: String?): JSONObject {
        if (raw.isNullOrBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun resolveRoomBlockingReason(room: JSONObject?): String {
        if (room == null) return "room_missing"
        val status = room.optString("status", "paused").trim().lowercase()
        if (status != "active") {
            return "room_$status"
        }
        val mode = room.optString("mode", "personas_plus_user").trim().lowercase()
        val waitingForUser = room.optBoolean("waitingForUser", false)
        if (mode == "personas_plus_user" && waitingForUser) {
            return "waiting_for_user"
        }
        return ""
    }

    private fun appendRuntimeEvent(
        runtime: BackgroundRuntimeRepository,
        scopeId: String,
        jobId: String?,
        stage: String,
        level: String,
        message: String,
        details: JSONObject?,
    ) {
        runtime.appendEvent(
            taskType = GROUP_ITERATION_JOB_TYPE,
            scopeId = scopeId.ifBlank { "unknown" },
            jobId = jobId,
            stage = stage,
            level = level,
            message = message,
            detailsJson = details?.toString(),
        )
    }
}
