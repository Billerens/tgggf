package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.time.Instant
import java.util.UUID
import kotlin.math.max

object GroupIterationNativeExecutor {
    private const val GROUP_ITERATION_JOB_TYPE = "group_iteration"
    private const val GROUP_ITERATION_JOB_PREFIX = "group_iteration:"
    private const val GROUP_ITERATION_LEASE_MS = 120_000L
    private const val GROUP_ITERATION_DEFAULT_INTERVAL_MS = 4_200L
    private const val GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS = 8_000L
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L
    private const val HEADLESS_FALLBACK_MESSAGE = "native_headless_v1"

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
        val enabledScopeIds = enabledStates.map { row -> row.scopeId.trim() }.filter { it.isNotEmpty() }.toSet()
        recoverLeasedJobsWithoutBridgeAck(
            runtime = runtime,
            jobs = jobs,
            enabledScopeIds = enabledScopeIds,
        )
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

    private fun recoverLeasedJobsWithoutBridgeAck(
        runtime: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        enabledScopeIds: Set<String>,
    ) {
        val leasedJobs =
            jobs.listJobs(status = BackgroundJobRepository.STATUS_LEASED, limit = 120).filter { row ->
                row.type == GROUP_ITERATION_JOB_TYPE
            }
        if (leasedJobs.isEmpty()) return

        val retryAtMs = System.currentTimeMillis() + GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS
        for (job in leasedJobs) {
            val roomId =
                parseRoomIdFromJobId(job.id).ifBlank {
                    parseJsonObject(job.payloadJson).optString("roomId", "").trim()
                }
            if (roomId.isBlank() || !enabledScopeIds.contains(roomId)) {
                jobs.cancelJob(job.id)
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = roomId.ifBlank { "unknown" },
                    jobId = job.id,
                    stage = "bridge_ack_cancelled",
                    level = "info",
                    message = "Cancelled leased group job because desired-state is disabled",
                    details = null,
                )
                continue
            }

            val released =
                jobs.rescheduleJob(
                    id = job.id,
                    runAtMs = retryAtMs,
                    incrementAttempts = false,
                    lastError = null,
                )
            if (released) {
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = roomId,
                    jobId = job.id,
                    stage = "bridge_ack_released",
                    level = "info",
                    message = "Released leased group job without bridge ACK",
                    details = JSONObject().apply {
                        put("retryAtMs", retryAtMs)
                        put("ackTimeoutMs", GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS)
                    },
                )
            }
        }
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

        val nativeHeadlessEnabled = isNativeHeadlessModeEnabled(repository)
        if (nativeHeadlessEnabled) {
            val headlessCompleted =
                try {
                    executeHeadlessIteration(
                        context = context,
                        repository = repository,
                        jobs = jobs,
                        runtime = runtime,
                        job = job,
                        roomId = roomId,
                        intervalMs = intervalMs,
                    )
                    true
                } catch (error: Exception) {
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "headless_iteration_failed",
                        level = "warn",
                        message = "Native headless iteration failed, falling back to bridge dispatch",
                        details = JSONObject().apply {
                            put("error", error.message ?: "unknown_error")
                        },
                    )
                    ForegroundSyncService.updateWorkerStatus(
                        context = context,
                        worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                        state = "running",
                        scopeId = roomId,
                        detail = "headless_failed_bridge_fallback",
                        progress = false,
                        claimed = true,
                        lastError = error.message ?: "headless_failed",
                    )
                    false
                }
            if (headlessCompleted) {
                return
            }
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

    private fun isNativeHeadlessModeEnabled(repository: LocalRepository): Boolean {
        val settings = parseJsonObject(repository.readSettingsJson())
        return settings.optBoolean("androidNativeGroupIterationV1", false)
    }

    private fun executeHeadlessIteration(
        context: Context,
        repository: LocalRepository,
        jobs: BackgroundJobRepository,
        runtime: BackgroundRuntimeRepository,
        job: BackgroundJobRecord,
        roomId: String,
        intervalMs: Long,
    ) {
        val rooms = readStoreArray(repository, "groupRooms")
        val roomIndex = findObjectIndexById(rooms, roomId)
        if (roomIndex < 0) {
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + CONTEXT_SYNC_RETRY_DELAY_MS,
                incrementAttempts = false,
                lastError = "room_missing",
            )
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "headless_room_missing",
                level = "warn",
                message = "Headless iteration deferred because room is missing",
                details = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "running",
                scopeId = roomId,
                detail = "headless_awaiting_room_sync",
                progress = false,
                claimed = true,
                lastError = "room_missing",
            )
            return
        }

        val room = rooms.optJSONObject(roomIndex) ?: JSONObject()
        val participants = readStoreArray(repository, "groupParticipants")
        val personas = readStoreArray(repository, "personas")
        val events = readStoreArray(repository, "groupEvents")
        val messages = readStoreArray(repository, "groupMessages")
        val settings = parseJsonObject(repository.readSettingsJson())
        val userName = settings.optString("userName", "Пользователь").trim().ifEmpty { "Пользователь" }
        val deterministicSpeakerPersonaId = selectNextSpeakerPersonaId(participants, events, roomId)
        var speakerPersonaId: String? = deterministicSpeakerPersonaId
        val personasPlusUserMode =
            room.optString("mode", "personas_plus_user")
                .equals("personas_plus_user", ignoreCase = true)
        var tickStatus = if (speakerPersonaId.isNullOrBlank()) "skipped" else "spoke"
        var tickReason = "native_headless_tick"
        var tickWaitForUser = !speakerPersonaId.isNullOrBlank() && personasPlusUserMode
        var tickWaitReason: String? =
            if (tickWaitForUser) {
                "Ожидается ответ пользователя ($userName)"
            } else {
                null
            }
        var userContextAction = "keep"
        var orchestrationSource = "native_headless_deterministic"
        var orchestratorDecisionApplied = false

        try {
            val llmDecision =
                NativeLlmClient.requestGroupOrchestratorDecision(
                    settings = settings,
                    room = room,
                    participants = participants,
                    personas = personas,
                    messages = messages,
                    roomId = roomId,
                    userName = userName,
                )
            if (llmDecision != null) {
                orchestratorDecisionApplied = true
                val llmSpeakerId = llmDecision.speakerPersonaId?.trim().orEmpty()
                val validatedSpeakerId =
                    if (llmSpeakerId.isNotBlank() && participantHasPersona(participants, roomId, llmSpeakerId)) {
                        llmSpeakerId
                    } else {
                        ""
                    }
                when (llmDecision.status) {
                    "spoke" -> {
                        if (validatedSpeakerId.isNotBlank()) {
                            speakerPersonaId = validatedSpeakerId
                            tickStatus = "spoke"
                            tickReason = llmDecision.reason
                            tickWaitForUser =
                                if (llmDecision.waitForUser) {
                                    true
                                } else {
                                    personasPlusUserMode
                                }
                            tickWaitReason =
                                llmDecision.waitReason
                                    ?: if (tickWaitForUser) {
                                        "Ожидается ответ пользователя ($userName)"
                                    } else {
                                        null
                                    }
                            userContextAction = llmDecision.userContextAction ?: "keep"
                            orchestrationSource = "native_llm"
                        } else {
                            appendRuntimeEvent(
                                runtime = runtime,
                                scopeId = roomId,
                                jobId = job.id,
                                stage = "llm_orchestrator_invalid_speaker",
                                level = "warn",
                                message = "LLM orchestrator returned invalid speaker, using deterministic fallback",
                                details = JSONObject().apply {
                                    put("llmSpeakerPersonaId", llmSpeakerId)
                                    put("deterministicSpeakerPersonaId", deterministicSpeakerPersonaId)
                                },
                            )
                        }
                    }
                    "waiting", "skipped" -> {
                        speakerPersonaId = null
                        tickStatus = llmDecision.status
                        tickReason = llmDecision.reason
                        tickWaitForUser = llmDecision.waitForUser || llmDecision.status == "waiting"
                        tickWaitReason = llmDecision.waitReason
                        userContextAction = llmDecision.userContextAction ?: "keep"
                        orchestrationSource = "native_llm"
                    }
                }
            }
        } catch (error: Exception) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "llm_orchestrator_failed",
                level = "warn",
                message = "Native LLM orchestrator failed, using deterministic fallback",
                details = JSONObject().apply {
                    put("error", error.message ?: "unknown_error")
                },
            )
        }

        val turnId = UUID.randomUUID().toString()
        val nowIso = nowIsoUtc()

        events.put(
            JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("roomId", roomId)
                put("turnId", turnId)
                put("type", "orchestrator_tick_started")
                put(
                    "payload",
                    JSONObject().apply {
                        put("roomMode", room.optString("mode", "personas_plus_user"))
                        put("model", settings.optString("groupOrchestratorModel", settings.optString("model", "")))
                        put("source", orchestrationSource)
                        put("reason", tickReason)
                        put("status", tickStatus)
                        put("waitForUser", tickWaitForUser)
                        if (!tickWaitReason.isNullOrBlank()) {
                            put("waitReason", tickWaitReason)
                        }
                        put("userContextAction", userContextAction)
                        put(
                            "debug",
                            JSONObject().apply {
                                put("nativeHeadless", true)
                                put("headlessVersion", "v1")
                                put("orchestratorDecisionApplied", orchestratorDecisionApplied)
                                put("deterministicSpeakerPersonaId", deterministicSpeakerPersonaId)
                                put("finalSpeakerPersonaId", speakerPersonaId)
                            },
                        )
                    },
                )
                put("createdAt", nowIso)
            },
        )

        var persistedMessageId: String? = null
        var speakerName = "Native Orchestrator"
        var speechSource = "native_headless_deterministic"
        var speechResponseId = ""
        if (!speakerPersonaId.isNullOrBlank()) {
            val speakerPersona = findObjectById(personas, speakerPersonaId)
            speakerName = speakerPersona?.optString("name", "").orEmpty().ifBlank { speakerName }
            val latestUserMessage = findLatestUserMessage(messages, roomId)
            var speechText =
                if (latestUserMessage != null) {
                    "Продолжаю диалог без активного UI. ($HEADLESS_FALLBACK_MESSAGE)"
                } else {
                    "Фоновая автономная итерация выполнена. ($HEADLESS_FALLBACK_MESSAGE)"
                }
            if (speakerPersona != null) {
                try {
                    val llmSpeech =
                        NativeLlmClient.requestGroupPersonaSpeech(
                            settings = settings,
                            room = room,
                            speakerPersona = speakerPersona,
                            messages = messages,
                            roomId = roomId,
                            userName = userName,
                        )
                    if (llmSpeech != null && llmSpeech.content.isNotBlank()) {
                        speechText = llmSpeech.content
                        speechSource = "native_llm"
                        speechResponseId = llmSpeech.responseId ?: ""
                    } else {
                        appendRuntimeEvent(
                            runtime = runtime,
                            scopeId = roomId,
                            jobId = job.id,
                            stage = "llm_persona_empty_fallback",
                            level = "warn",
                            message = "Native LLM persona returned empty content, using deterministic fallback text",
                            details = JSONObject().apply {
                                put("speakerPersonaId", speakerPersonaId)
                            },
                        )
                    }
                } catch (error: Exception) {
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "llm_persona_failed",
                        level = "warn",
                        message = "Native LLM persona generation failed, using deterministic fallback text",
                        details = JSONObject().apply {
                            put("speakerPersonaId", speakerPersonaId)
                            put("error", error.message ?: "unknown_error")
                        },
                    )
                }
            }
            val messageId = UUID.randomUUID().toString()
            val nextMessage =
                JSONObject().apply {
                    put("id", messageId)
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("authorType", "persona")
                    put("authorPersonaId", speakerPersonaId)
                    put("authorDisplayName", speakerName)
                    val avatarUrl =
                        speakerPersona?.optString("avatarUrl", "")?.trim().orEmpty()
                    if (avatarUrl.isNotBlank()) {
                        put("authorAvatarUrl", avatarUrl)
                    }
                    put("content", speechText)
                    put("createdAt", nowIso)
                }
            messages.put(nextMessage)
            persistedMessageId = messageId

            events.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("type", "speaker_selected")
                    put(
                        "payload",
                        JSONObject().apply {
                            put("personaId", speakerPersonaId)
                            put("personaName", speakerName)
                        },
                    )
                    put("createdAt", nowIso)
                },
            )
            events.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("type", "persona_spoke")
                    put(
                        "payload",
                        JSONObject().apply {
                            put("personaId", speakerPersonaId)
                            put("messagePreview", speechText.take(180))
                            put("source", speechSource)
                            put("responseId", speechResponseId)
                        },
                    )
                    put("createdAt", nowIso)
                },
            )
        }

        val wasWaitingForUser = room.optBoolean("waitingForUser", false)
        val previousWaitingReason = room.optString("waitingReason", "").trim()
        val nextRoom = JSONObject(room.toString())
        nextRoom.put("updatedAt", nowIso)
        nextRoom.put("lastTickAt", nowIso)
        nextRoom.put("waitingForUser", tickWaitForUser)
        if (tickWaitForUser) {
            if (!tickWaitReason.isNullOrBlank()) {
                nextRoom.put("waitingReason", tickWaitReason)
            }
        } else {
            nextRoom.remove("waitingReason")
        }
        if (userContextAction == "clear") {
            nextRoom.remove("orchestratorUserFocusMessageId")
        }
        nextRoom.put(
            "state",
            JSONObject().apply {
                put("phase", if (tickWaitForUser) "waiting_user" else "idle")
                put("updatedAt", nowIso)
                put("turnId", turnId)
                if (!speakerPersonaId.isNullOrBlank()) {
                    put("speakerPersonaId", speakerPersonaId)
                }
                put("reason", tickReason)
            },
        )
        upsertObjectById(rooms, roomId, nextRoom)

        if (tickWaitForUser && (!wasWaitingForUser || previousWaitingReason != (tickWaitReason ?: ""))) {
            events.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("type", "room_waiting_user")
                    put(
                        "payload",
                        JSONObject().apply {
                            put("userName", userName)
                            put("reason", tickWaitReason ?: "native_waiting")
                        },
                    )
                    put("createdAt", nowIso)
                },
            )
        }
        if (!tickWaitForUser && wasWaitingForUser) {
            events.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("type", "room_resumed")
                    put(
                        "payload",
                        JSONObject().apply {
                            put("reason", tickReason.ifBlank { "native_resumed" })
                        },
                    )
                    put("createdAt", nowIso)
                },
            )
        }

        repository.writeStoreJson("groupRooms", rooms.toString())
        repository.writeStoreJson("groupEvents", events.toString())
        if (persistedMessageId != null) {
            repository.writeStoreJson("groupMessages", messages.toString())
        }

        jobs.rescheduleJob(
            id = job.id,
            runAtMs = System.currentTimeMillis() + intervalMs,
            incrementAttempts = false,
            lastError = null,
        )
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = roomId,
            jobId = job.id,
            stage = "headless_iteration_completed",
            level = "info",
            message = "Group iteration completed via native headless path",
            details = JSONObject().apply {
                put("turnId", turnId)
                put("status", tickStatus)
                put("reason", tickReason)
                put("source", orchestrationSource)
                put("speechSource", speechSource)
                put("speakerPersonaId", speakerPersonaId)
                put("speakerName", speakerName)
                put("messageId", persistedMessageId)
                put("intervalMs", intervalMs)
                put("userName", userName)
                put("waitForUser", tickWaitForUser)
                put("waitReason", tickWaitReason)
                put("userContextAction", userContextAction)
            },
        )
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
            state = "running",
            scopeId = roomId,
            detail =
                if (persistedMessageId == null) {
                    "native_headless_skipped"
                } else {
                    "native_headless_progress"
                },
            progress = true,
            claimed = true,
            lastError = "",
        )
    }

    private fun findObjectIndexById(items: JSONArray, targetId: String): Int {
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.optString("id", "").trim() == targetId) {
                return index
            }
        }
        return -1
    }

    private fun findObjectById(items: JSONArray, targetId: String): JSONObject? {
        val index = findObjectIndexById(items, targetId)
        if (index < 0) return null
        return items.optJSONObject(index)
    }

    private fun upsertObjectById(items: JSONArray, targetId: String, next: JSONObject) {
        val index = findObjectIndexById(items, targetId)
        if (index >= 0) {
            items.put(index, next)
        } else {
            items.put(next)
        }
    }

    private fun participantHasPersona(
        participants: JSONArray,
        roomId: String,
        personaId: String,
    ): Boolean {
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            if (participant.optString("personaId", "").trim() == personaId.trim()) {
                return true
            }
        }
        return false
    }

    private fun selectNextSpeakerPersonaId(
        participants: JSONArray,
        events: JSONArray,
        roomId: String,
    ): String? {
        val participantIds = mutableListOf<String>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val role = participant.optString("role", "member").trim().lowercase()
            if (role == "observer") continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            if (!participantIds.contains(personaId)) {
                participantIds.add(personaId)
            }
        }
        if (participantIds.isEmpty()) return null

        var previousSpeakerId = ""
        for (index in events.length() - 1 downTo 0) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            if (event.optString("type", "").trim() != "speaker_selected") continue
            previousSpeakerId = event.optJSONObject("payload")?.optString("personaId", "")?.trim().orEmpty()
            if (previousSpeakerId.isNotBlank()) break
        }
        if (previousSpeakerId.isBlank()) {
            return participantIds.firstOrNull()
        }
        val previousIndex = participantIds.indexOf(previousSpeakerId)
        if (previousIndex < 0) {
            return participantIds.firstOrNull()
        }
        val nextIndex = (previousIndex + 1) % participantIds.size
        return participantIds[nextIndex]
    }

    private fun findLatestUserMessage(messages: JSONArray, roomId: String): JSONObject? {
        var latest: JSONObject? = null
        var latestCreatedAt = ""
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            if (!message.optString("authorType", "").trim().equals("user", ignoreCase = true)) continue
            val createdAt = message.optString("createdAt", "").trim()
            if (latest == null || createdAt > latestCreatedAt) {
                latest = message
                latestCreatedAt = createdAt
            }
        }
        return latest
    }

    private fun nowIsoUtc(): String = Instant.now().toString()

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
