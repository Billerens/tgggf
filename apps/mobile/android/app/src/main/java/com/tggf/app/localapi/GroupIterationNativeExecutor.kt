package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Collections
import java.time.Instant
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

object GroupIterationNativeExecutor {
    private const val GROUP_ITERATION_JOB_TYPE = "group_iteration"
    private const val GROUP_ITERATION_JOB_PREFIX = "group_iteration:"
    private const val GROUP_ITERATION_LEASE_MS = 120_000L
    private const val GROUP_ITERATION_DEFAULT_INTERVAL_MS = 4_200L
    private const val GROUP_ITERATION_RETRY_DELAY_MS = 6_500L
    private const val GROUP_ITERATION_BRIDGE_ACK_TIMEOUT_MS = 8_000L
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L
    private val DETERMINISTIC_HARD_BLOCK_REASONS =
        setOf(
            "room_not_active",
            "waiting_for_user",
            "no_active_participants",
            "typing_delay",
            "pending_image_generation",
        )

    private data class HeadlessTickDecision(
        val status: String,
        val reason: String,
        val speakerPersonaId: String? = null,
        val waitForUser: Boolean = false,
        val waitReason: String? = null,
        val userContextAction: String? = null,
        val debug: JSONObject = JSONObject(),
    )

    private data class ActiveParticipant(
        val personaId: String,
        val initiativeBias: Double,
        val aliveScore: Double,
        val joinedAt: String,
    )

    private data class ScoredParticipant(
        val participant: ActiveParticipant,
        val score: Int,
        val explain: JSONObject,
    )

    private val inFlight = AtomicBoolean(false)
    private val cancelledScopes = Collections.synchronizedSet(mutableSetOf<String>())
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-group-native").apply {
            isDaemon = true
        }
    }

    @JvmStatic
    fun requestCancellation(scopeId: String) {
        val normalized = scopeId.trim()
        if (normalized.isEmpty()) return
        cancelledScopes.add(normalized)
    }

    @JvmStatic
    fun clearCancellation(scopeId: String) {
        val normalized = scopeId.trim()
        if (normalized.isEmpty()) return
        cancelledScopes.remove(normalized)
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
        try {
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
        } finally {
            repository.close()
            jobs.closeQuietly()
            runtime.closeQuietly()
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

        if (isScopeCancellationRequested(roomId)) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "cancelled",
                level = "info",
                message = "Group iteration cancelled by desired-state",
                details = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "idle",
                scopeId = roomId,
                detail = "cancelled",
                progress = false,
                claimed = false,
                lastError = "",
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
        } catch (error: Exception) {
            val errorMessage = error.message ?: "headless_failed"
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + GROUP_ITERATION_RETRY_DELAY_MS,
                incrementAttempts = true,
                lastError = errorMessage,
            )
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "headless_iteration_failed",
                level = "error",
                message = "Native headless iteration failed",
                details = JSONObject().apply {
                    put("error", errorMessage)
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "error",
                scopeId = roomId,
                detail = "headless_failed",
                progress = false,
                claimed = true,
                lastError = errorMessage,
            )
        }
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
        if (isScopeCancellationRequested(roomId)) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "cancelled",
                level = "info",
                message = "Skipped headless iteration because scope is cancelled",
                details = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                state = "idle",
                scopeId = roomId,
                detail = "cancelled",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }
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
        val initialEventsLength = events.length()
        val personaStates = readStoreArray(repository, "groupPersonaStates")
        val relationEdges = readStoreArray(repository, "groupRelationEdges")
        val sharedMemories = readStoreArray(repository, "groupSharedMemories")
        val privateMemories = readStoreArray(repository, "groupPrivateMemories")
        val settings = parseJsonObject(repository.readSettingsJson())
        val userName = settings.optString("userName", "Пользователь").trim().ifEmpty { "Пользователь" }
        val nativeGroupImagesEnabled = isNativeGroupImagesEnabled(settings)
        val roomMode =
            if (room.optString("mode", "personas_plus_user").trim().equals("personas_plus_user", ignoreCase = true)) {
                "personas_plus_user"
            } else {
                "personas_only"
            }
        val deterministicDecision =
            runNativeDeterministicOrchestratorTick(
                room = room,
                participants = participants,
                messages = messages,
                events = events,
                relationEdges = relationEdges,
                personas = personas,
                roomId = roomId,
                userName = userName,
                settingsModel = settings.optString("model", "").trim(),
            )
        val isStrictWaitingLock =
            roomMode == "personas_plus_user" &&
                room.optBoolean("waitingForUser", false) &&
                deterministicDecision.status == "waiting" &&
                deterministicDecision.waitForUser
        val isDeterministicHardBlock =
            deterministicDecision.status != "spoke" &&
                DETERMINISTIC_HARD_BLOCK_REASONS.contains(deterministicDecision.reason)

        var llmDecision: HeadlessTickDecision? = null
        var orchestratorDecisionApplied = false
        if (!isStrictWaitingLock && !isDeterministicHardBlock) {
            try {
                val nativeLlmDecision =
                    NativeLlmClient.requestGroupOrchestratorDecision(
                        settings = settings,
                        room = room,
                        participants = participants,
                        personas = personas,
                        messages = messages,
                        events = events,
                        roomId = roomId,
                        userName = userName,
                    )
                if (nativeLlmDecision != null) {
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "llm_orchestrator_contract",
                        level = "info",
                        message = "Native LLM orchestrator contract trace",
                        details =
                            JSONObject().apply {
                                put("status", nativeLlmDecision.status)
                                if (!nativeLlmDecision.speakerPersonaId.isNullOrBlank()) {
                                    put("speakerPersonaId", nativeLlmDecision.speakerPersonaId)
                                }
                                put("waitForUser", nativeLlmDecision.waitForUser)
                                if (!nativeLlmDecision.waitReason.isNullOrBlank()) {
                                    put("waitReason", nativeLlmDecision.waitReason)
                                }
                                if (!nativeLlmDecision.reason.isBlank()) {
                                    put("reason", nativeLlmDecision.reason)
                                }
                                putLlmCallDebugDetails(this, nativeLlmDecision.llmDebug)
                            },
                    )
                    orchestratorDecisionApplied = true
                    val llmStatus = nativeLlmDecision.status.trim().lowercase()
                    if (llmStatus == "spoke" || llmStatus == "waiting" || llmStatus == "skipped") {
                        val llmSpeakerId = nativeLlmDecision.speakerPersonaId?.trim().orEmpty()
                        val validatedSpeakerId =
                            if (
                                llmStatus == "spoke" &&
                                    llmSpeakerId.isNotBlank() &&
                                    participantHasPersona(participants, roomId, llmSpeakerId)
                            ) {
                                llmSpeakerId
                            } else {
                                ""
                            }
                        if (llmStatus == "spoke" && validatedSpeakerId.isBlank()) {
                            appendRuntimeEvent(
                                runtime = runtime,
                                scopeId = roomId,
                                jobId = job.id,
                                stage = "llm_orchestrator_invalid_speaker",
                                level = "warn",
                                message = "LLM orchestrator returned invalid speaker, using deterministic fallback",
                                details = JSONObject().apply {
                                    put("llmSpeakerPersonaId", llmSpeakerId)
                                    put("deterministicSpeakerPersonaId", deterministicDecision.speakerPersonaId)
                                    putLlmCallDebugDetails(this, nativeLlmDecision.llmDebug)
                                },
                            )
                        } else {
                            llmDecision =
                                HeadlessTickDecision(
                                    status = llmStatus,
                                    reason = nativeLlmDecision.reason.trim().ifEmpty { "llm_orchestrator_decision" },
                                    speakerPersonaId =
                                        if (llmStatus == "spoke") {
                                            validatedSpeakerId
                                        } else {
                                            null
                                        },
                                    waitForUser =
                                        if (nativeLlmDecision.waitForUser) {
                                            true
                                        } else {
                                            llmStatus == "waiting"
                                        },
                                    waitReason = nativeLlmDecision.waitReason,
                                    userContextAction = nativeLlmDecision.userContextAction,
                                    debug =
                                        JSONObject().apply {
                                            put("status", llmStatus)
                                            if (llmSpeakerId.isNotBlank()) {
                                                put("speakerPersonaId", llmSpeakerId)
                                            }
                                            put("waitForUser", nativeLlmDecision.waitForUser)
                                            if (!nativeLlmDecision.reason.isNullOrBlank()) {
                                                put("reason", nativeLlmDecision.reason)
                                            }
                                        },
                                )
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
        }

        val effectiveDeterministicDecision =
            if (isStrictWaitingLock || isDeterministicHardBlock) {
                deterministicDecision.copy(
                    debug =
                        JSONObject(deterministicDecision.debug.toString()).apply {
                            put("waitingLock", true)
                        },
                )
            } else {
                deterministicDecision
            }
        val mergedOutcome =
            mergeHeadlessSpeakerDecision(
                deterministicDecision = effectiveDeterministicDecision,
                llmDecision = llmDecision,
                roomMode = roomMode,
                events = events,
                participants = participants,
                roomId = roomId,
            )
        val mergedDecision = mergedOutcome.first
        val orchestrationSource = mergedOutcome.second
        var speakerPersonaId =
            if (mergedDecision.status == "spoke") {
                mergedDecision.speakerPersonaId?.trim().orEmpty().ifBlank { null }
            } else {
                null
            }
        var tickStatus = mergedDecision.status
        var tickReason = mergedDecision.reason
        var tickWaitForUser = mergedDecision.waitForUser
        var tickWaitReason = mergedDecision.waitReason
        val userContextAction =
            if ((mergedDecision.userContextAction ?: "").trim().lowercase() == "clear") {
                "clear"
            } else {
                "keep"
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
                                put("deterministicSpeakerPersonaId", deterministicDecision.speakerPersonaId)
                                put("finalSpeakerPersonaId", speakerPersonaId)
                                put("strictWaitingLock", isStrictWaitingLock)
                                put("deterministicHardBlock", isDeterministicHardBlock)
                                put("nativeGroupImagesEnabled", nativeGroupImagesEnabled)
                                put("decisionDebug", mergedDecision.debug)
                                if (llmDecision != null) {
                                    put("llmDecision", headlessDecisionToJson(llmDecision))
                                }
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
        var imageGenerationStatus = "not_requested"
        var imageGenerationExpected = 0
        var imageGenerationCompleted = 0
        var generatedAssetIds: List<String> = emptyList()
        if (!speakerPersonaId.isNullOrBlank()) {
            val activeSpeakerPersonaId = speakerPersonaId.trim()
            val speakerPersona = findObjectById(personas, activeSpeakerPersonaId)
            speakerName = speakerPersona?.optString("name", "").orEmpty().ifBlank { speakerName }
            val mentionUserName = findMostRecentUserDisplayName(messages, roomId).ifBlank { userName }
            var speechText = ""
            var speechComfyPrompt: String? = null
            var speechComfyPrompts: List<String> = emptyList()
            var speechComfyImageDescription: String? = null
            var speechComfyImageDescriptions: List<String> = emptyList()
            var skipPersonaCommit = false
            var skipReason = ""
            var skipErrorMessage = ""
            if (speakerPersona == null) {
                skipPersonaCommit = true
                skipReason = "speaker_not_found"
            } else {
                try {
                    val llmSpeech =
                        NativeLlmClient.requestGroupPersonaSpeech(
                            settings = settings,
                            room = room,
                            speakerPersona = speakerPersona,
                            participants = participants,
                            personas = personas,
                            messages = messages,
                            events = events,
                            personaStates = personaStates,
                            relationEdges = relationEdges,
                            sharedMemories = sharedMemories,
                            privateMemories = privateMemories,
                            roomId = roomId,
                            userName = mentionUserName,
                        )
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "llm_persona_contract",
                        level = if (llmSpeech?.content?.isNotBlank() == true) "info" else "warn",
                        message = "Native LLM persona contract trace",
                        details =
                            JSONObject().apply {
                                put("speakerPersonaId", activeSpeakerPersonaId)
                                put("hasContent", llmSpeech?.content?.isNotBlank() == true)
                                put("contentLength", llmSpeech?.content?.length ?: 0)
                                putLlmCallDebugDetails(this, llmSpeech?.llmDebug)
                            },
                    )
                    if (llmSpeech != null && llmSpeech.content.isNotBlank()) {
                        speechText = llmSpeech.content
                        speechSource = "native_llm"
                        speechResponseId = llmSpeech.responseId ?: ""
                        speechComfyPrompt = llmSpeech.comfyPrompt
                        speechComfyPrompts = llmSpeech.comfyPrompts
                        speechComfyImageDescription = llmSpeech.comfyImageDescription
                        speechComfyImageDescriptions = llmSpeech.comfyImageDescriptions
                    } else {
                        skipPersonaCommit = true
                        skipReason = "empty_llm_speech"
                        appendRuntimeEvent(
                            runtime = runtime,
                            scopeId = roomId,
                            jobId = job.id,
                            stage = "llm_persona_empty",
                            level = "warn",
                            message = "Native LLM persona returned empty content, skipping persona message commit",
                            details = JSONObject().apply {
                                put("speakerPersonaId", speakerPersonaId)
                                put("hasContent", false)
                                putLlmCallDebugDetails(this, llmSpeech?.llmDebug)
                            },
                        )
                    }
                } catch (error: Exception) {
                    skipPersonaCommit = true
                    skipReason = "llm_generation_failed"
                    skipErrorMessage = error.message ?: "unknown_error"
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "llm_persona_failed",
                        level = "warn",
                        message = "Native LLM persona generation failed, skipping persona message commit",
                        details = JSONObject().apply {
                            put("speakerPersonaId", speakerPersonaId)
                            put("error", skipErrorMessage)
                        },
                    )
                }
            }
            if (skipPersonaCommit) {
                events.put(
                    JSONObject().apply {
                        put("id", UUID.randomUUID().toString())
                        put("roomId", roomId)
                        put("turnId", turnId)
                        put("type", "orchestrator_invariant_blocked")
                        put(
                            "payload",
                            JSONObject().apply {
                                put("speakerPersonaId", activeSpeakerPersonaId)
                                put("reason", skipReason.ifBlank { "llm_generation_failed" })
                                if (skipErrorMessage.isNotBlank()) {
                                    put("error", skipErrorMessage)
                                }
                            },
                        )
                        put("createdAt", nowIso)
                    },
                )
                speakerPersonaId = null
                tickStatus = "skipped"
                tickReason = skipReason.ifBlank { "llm_generation_failed" }
                tickWaitForUser = false
                tickWaitReason = null
            }
            if (skipPersonaCommit) {
                // Keep processing room/event updates below, but without persisting placeholder persona text.
            } else {
                val descriptionBlocksForPromptConversion =
                    resolveImageDescriptionsForPromptConversion(
                        comfyImageDescriptions = speechComfyImageDescriptions,
                        comfyImageDescription = speechComfyImageDescription,
                    )
                if (
                    speechComfyPrompts.isEmpty() &&
                        speechComfyPrompt.isNullOrBlank() &&
                        descriptionBlocksForPromptConversion.isNotEmpty()
                ) {
                    try {
                        val convertedPrompts =
                            NativeLlmClient.generateComfyPromptsFromImageDescriptions(
                                settings = settings,
                                speakerPersona = speakerPersona ?: JSONObject(),
                                imageDescriptions = descriptionBlocksForPromptConversion,
                            )
                        if (convertedPrompts.isNotEmpty()) {
                            speechComfyPrompts = convertedPrompts
                            speechComfyPrompt = convertedPrompts.firstOrNull()
                            appendRuntimeEvent(
                                runtime = runtime,
                                scopeId = roomId,
                                jobId = job.id,
                                stage = "comfy_prompt_conversion_applied",
                                level = "info",
                                message = "Native converted comfyImageDescriptions to comfyPrompts",
                                details = JSONObject().apply {
                                    put("speakerPersonaId", activeSpeakerPersonaId)
                                    put("descriptions", descriptionBlocksForPromptConversion.size)
                                    put("prompts", convertedPrompts.size)
                                },
                            )
                        }
                    } catch (error: Exception) {
                        appendRuntimeEvent(
                            runtime = runtime,
                            scopeId = roomId,
                            jobId = job.id,
                            stage = "comfy_prompt_conversion_failed",
                            level = "warn",
                            message = "Native failed to convert comfyImageDescriptions to comfyPrompts",
                            details = JSONObject().apply {
                                put("speakerPersonaId", activeSpeakerPersonaId)
                                put("descriptions", descriptionBlocksForPromptConversion.size)
                                put("error", error.message ?: "unknown_error")
                            },
                        )
                    }
                }
                val promptsForImageGeneration =
                    resolveImagePromptsForGeneration(
                        comfyPrompts = speechComfyPrompts,
                        comfyPrompt = speechComfyPrompt,
                    )
                val messageId = UUID.randomUUID().toString()
                val nextMessage =
                    JSONObject().apply {
                    put("id", messageId)
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("authorType", "persona")
                    put("authorPersonaId", activeSpeakerPersonaId)
                    put("authorDisplayName", speakerName)
                    val avatarUrl =
                        speakerPersona?.optString("avatarUrl", "")?.trim().orEmpty()
                    if (avatarUrl.isNotBlank()) {
                        put("authorAvatarUrl", avatarUrl)
                    }
                    put("content", speechText)
                    if (!speechComfyPrompt.isNullOrBlank()) {
                        put("comfyPrompt", speechComfyPrompt)
                    }
                    if (speechComfyPrompts.isNotEmpty()) {
                        put(
                            "comfyPrompts",
                            JSONArray().apply {
                                for (item in speechComfyPrompts) {
                                    put(item)
                                }
                            },
                        )
                    }
                    if (!speechComfyImageDescription.isNullOrBlank()) {
                        put("comfyImageDescription", speechComfyImageDescription)
                    }
                    if (speechComfyImageDescriptions.isNotEmpty()) {
                        put(
                            "comfyImageDescriptions",
                            JSONArray().apply {
                                for (item in speechComfyImageDescriptions) {
                                    put(item)
                                }
                            },
                        )
                    }
                    if (promptsForImageGeneration.isNotEmpty()) {
                        if (nativeGroupImagesEnabled) {
                            put("imageGenerationPending", true)
                            put("imageGenerationExpected", promptsForImageGeneration.size)
                            put("imageGenerationCompleted", 0)
                        } else {
                            put("imageGenerationPending", false)
                            put("imageGenerationExpected", promptsForImageGeneration.size)
                            put("imageGenerationCompleted", 0)
                        }
                    }
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
                                put("personaId", activeSpeakerPersonaId)
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
                                put("personaId", activeSpeakerPersonaId)
                                put("messagePreview", speechText.take(180))
                                put("source", speechSource)
                                put("responseId", speechResponseId)
                        },
                    )
                    put("createdAt", nowIso)
                },
            )

            if (promptsForImageGeneration.isNotEmpty()) {
                imageGenerationExpected = promptsForImageGeneration.size
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = roomId,
                    jobId = job.id,
                    stage = "group_image_generation_plan",
                    level = "info",
                    message = "Native group image generation plan prepared",
                    details = JSONObject().apply {
                        put("messageId", messageId)
                        put("personaId", activeSpeakerPersonaId)
                        put("promptCount", promptsForImageGeneration.size)
                        put("nativeGroupImagesEnabled", nativeGroupImagesEnabled)
                    },
                )
                if (nativeGroupImagesEnabled) {
                    val imageResult =
                        runGroupImageGeneration(
                            context = context,
                            repository = repository,
                            runtime = runtime,
                            job = job,
                            settings = settings,
                            roomId = roomId,
                            turnId = turnId,
                            speakerPersona = speakerPersona,
                            speakerPersonaId = activeSpeakerPersonaId,
                            message = nextMessage,
                            promptsForGeneration = promptsForImageGeneration,
                            events = events,
                        )
                    imageGenerationStatus = imageResult.status
                    imageGenerationExpected = imageResult.expected
                    imageGenerationCompleted = imageResult.completed
                    generatedAssetIds = imageResult.assetIds
                } else {
                    imageGenerationStatus = "disabled"
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = roomId,
                        jobId = job.id,
                        stage = "group_image_pipeline_disabled",
                        level = "info",
                        message = "Native group image pipeline is disabled by settings",
                        details = JSONObject().apply {
                            put("messageId", messageId)
                            put("expected", promptsForImageGeneration.size)
                            put("nativeGroupImagesEnabled", nativeGroupImagesEnabled)
                            put(
                                "androidNativeGroupImagesV1",
                                if (settings.has("androidNativeGroupImagesV1")) {
                                    settings.optBoolean("androidNativeGroupImagesV1", true)
                                } else {
                                    JSONObject.NULL
                                },
                            )
                            put(
                                "androidNativeGroupImagesV1Disable",
                                if (settings.has("androidNativeGroupImagesV1Disable")) {
                                    settings.optBoolean("androidNativeGroupImagesV1Disable", false)
                                } else {
                                    JSONObject.NULL
                                },
                            )
                            put(
                                "androidNativeGroupIterationV1",
                                if (settings.has("androidNativeGroupIterationV1")) {
                                    settings.optBoolean("androidNativeGroupIterationV1", true)
                                } else {
                                    JSONObject.NULL
                                },
                            )
                        },
                    )
                }
            }
        }
        }

        val wasWaitingForUser = room.optBoolean("waitingForUser", false)
        val previousWaitingReason = room.optString("waitingReason", "").trim()
        val roomIsActive = room.optString("status", "paused").trim().lowercase() == "active"
        val nextRoom = JSONObject(room.toString())
        nextRoom.put("updatedAt", nowIso)
        nextRoom.put("lastTickAt", nowIso)
        nextRoom.put("waitingForUser", if (roomIsActive) tickWaitForUser else wasWaitingForUser)
        if (roomIsActive) {
            if (tickWaitForUser && !tickWaitReason.isNullOrBlank()) {
                nextRoom.put("waitingReason", tickWaitReason)
            } else if (!tickWaitForUser) {
                nextRoom.remove("waitingReason")
            }
        } else {
            if (previousWaitingReason.isNotBlank()) {
                nextRoom.put("waitingReason", previousWaitingReason)
            } else {
                nextRoom.remove("waitingReason")
            }
        }
        if (userContextAction == "clear") {
            nextRoom.remove("orchestratorUserFocusMessageId")
        }
        nextRoom.put(
            "state",
            JSONObject().apply {
                val roomStatus = room.optString("status", "paused").trim().lowercase()
                val nextPhase =
                    if (roomIsActive && tickWaitForUser) {
                        "waiting_user"
                    } else if (roomStatus == "paused") {
                        "paused"
                    } else {
                        "idle"
                    }
                put("phase", nextPhase)
                put("updatedAt", nowIso)
                put("turnId", turnId)
                if (!speakerPersonaId.isNullOrBlank()) {
                    put("speakerPersonaId", speakerPersonaId)
                }
                put("reason", tickReason)
            },
        )
        upsertObjectById(rooms, roomId, nextRoom)

        if (
            roomIsActive &&
                tickWaitForUser &&
                (!wasWaitingForUser || previousWaitingReason != (tickWaitReason ?: ""))
        ) {
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
                            if (!tickWaitReason.isNullOrBlank()) {
                                put("reason", tickWaitReason)
                            }
                        },
                    )
                    put("createdAt", nowIso)
                },
            )
        }
        if (roomIsActive && !tickWaitForUser && wasWaitingForUser) {
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
        val patchEvents = JSONArray()
        if (events.length() > initialEventsLength) {
            for (index in initialEventsLength until events.length()) {
                val event = events.optJSONObject(index) ?: continue
                patchEvents.put(JSONObject(event.toString()))
            }
        }
        val patchStores =
            JSONObject().apply {
                put(
                    "groupRooms",
                    JSONArray().apply {
                        put(JSONObject(nextRoom.toString()))
                    },
                )
                if (patchEvents.length() > 0) {
                    put("groupEvents", patchEvents)
                }
                if (persistedMessageId != null) {
                    val persistedMessage = findObjectById(messages, persistedMessageId)
                    if (persistedMessage != null) {
                        put(
                            "groupMessages",
                            JSONArray().apply {
                                put(JSONObject(persistedMessage.toString()))
                            },
                        )
                    }
                }
            }
        appendStatePatch(
            runtime = runtime,
            scopeId = roomId,
            jobId = job.id,
            stores = patchStores,
            assetIds = generatedAssetIds,
        )
        TopicGenerationNativeExecutor.maybeRunImageAssetGc(repository)

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
                put("imageGenerationStatus", imageGenerationStatus)
                put("imageGenerationExpected", imageGenerationExpected)
                put("imageGenerationCompleted", imageGenerationCompleted)
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

    private fun runNativeDeterministicOrchestratorTick(
        room: JSONObject,
        participants: JSONArray,
        messages: JSONArray,
        events: JSONArray,
        relationEdges: JSONArray,
        personas: JSONArray,
        roomId: String,
        userName: String,
        settingsModel: String,
    ): HeadlessTickDecision {
        val roomStatus = room.optString("status", "paused").trim().lowercase()
        if (roomStatus != "active") {
            val waitingReason = room.optString("waitingReason", "").trim().ifEmpty { null }
            return HeadlessTickDecision(
                status = "skipped",
                reason = "room_not_active",
                waitForUser = room.optBoolean("waitingForUser", false),
                waitReason = waitingReason,
                debug =
                    JSONObject().apply {
                        put("roomStatus", roomStatus)
                    },
            )
        }

        val roomMode = normalizeRoomMode(room)
        if (roomMode == "personas_plus_user" && room.optBoolean("waitingForUser", false)) {
            return HeadlessTickDecision(
                status = "waiting",
                reason = "waiting_for_user",
                waitForUser = true,
                waitReason =
                    room.optString("waitingReason", "").trim().ifEmpty {
                        "Ожидается ответ пользователя (${userName.trim().ifEmpty { "Пользователь" }})"
                    },
                debug =
                    JSONObject().apply {
                        put("waitingForUser", true)
                    },
            )
        }

        val nowMs = System.currentTimeMillis()
        val pendingImageMessage = findLatestPendingImageMessage(messages, roomId)
        if (pendingImageMessage != null) {
            return HeadlessTickDecision(
                status = "skipped",
                reason = "pending_image_generation",
                waitForUser = false,
                waitReason = null,
                debug =
                    JSONObject().apply {
                        put("pendingMessageId", pendingImageMessage.optString("id", ""))
                        put("pendingAuthorType", pendingImageMessage.optString("authorType", ""))
                        put("pendingExpected", pendingImageMessage.optInt("imageGenerationExpected", 0))
                        put("pendingCompleted", pendingImageMessage.optInt("imageGenerationCompleted", 0))
                    },
            )
        }

        val lastRoomMessage = findLatestRoomMessage(messages, roomId)
        if (lastRoomMessage != null) {
            val createdAtMs = parseIsoToMillisOrNull(lastRoomMessage.optString("createdAt", "").trim())
            if (createdAtMs != null) {
                val elapsedMs = max(0L, nowMs - createdAtMs)
                val requiredDelayMs =
                    if (lastRoomMessage.optString("authorType", "").trim().equals("persona", ignoreCase = true)) {
                        estimatePersonaTypingDelayMs(lastRoomMessage)
                    } else {
                        2_000L
                    }
                if (elapsedMs < requiredDelayMs) {
                    return HeadlessTickDecision(
                        status = "skipped",
                        reason = "typing_delay",
                        waitForUser = false,
                        waitReason = null,
                        debug =
                            JSONObject().apply {
                                put("lastAuthorType", lastRoomMessage.optString("authorType", ""))
                                put("elapsedMs", elapsedMs)
                                put("requiredDelayMs", requiredDelayMs)
                            },
                    )
                }
            }
        }

        val activeParticipants = collectActiveParticipants(participants, roomId, nowMs)
        if (activeParticipants.isEmpty()) {
            return HeadlessTickDecision(
                status = "skipped",
                reason = "no_active_participants",
                waitForUser = false,
                waitReason = null,
                debug =
                    JSONObject().apply {
                        put("participantCount", countRoomParticipants(participants, roomId))
                    },
            )
        }

        val personaById = buildPersonaMap(personas)
        val lastUserMessage = findLatestUserMessage(messages, roomId)
        val focusedUserMessage = findFocusedUserMessage(messages, room, roomId)
        val lastMessageId = lastRoomMessage?.optString("id", "")?.trim().orEmpty()
        val lastUserMessageId = lastUserMessage?.optString("id", "")?.trim().orEmpty()
        val mentionDrivenPersonaId =
            if (lastUserMessage != null && lastMessageId.isNotBlank() && lastMessageId == lastUserMessageId) {
                getMentionDrivenPersonaId(lastUserMessage, activeParticipants)
            } else {
                ""
            }
        val lastSpeakerPersonaId = findLastSelectedSpeakerPersonaId(events, roomId)
        val recentSpeakers = buildRecentSpeakerIds(events, roomId, limit = 24)
        val recentWindowSize = max(8, minOf(24, activeParticipants.size * 4))
        val recentWindow = recentSpeakers.take(recentWindowSize)
        val frequencyByPersonaId = mutableMapOf<String, Int>()
        for (personaId in recentWindow) {
            frequencyByPersonaId[personaId] = (frequencyByPersonaId[personaId] ?: 0) + 1
        }
        val allSpeakerCounts = buildAllSpeakerCounts(events, roomId)
        val minAllSpeakerCount =
            activeParticipants
                .map { participant -> allSpeakerCounts[participant.personaId] ?: 0 }
                .minOrNull() ?: 0
        val relationByTargetId =
            buildRelationByTargetId(
                relationEdges = relationEdges,
                roomId = roomId,
                fromPersonaId = lastSpeakerPersonaId,
            )

        val scoredParticipants =
            activeParticipants
                .map { participant ->
                    val recentFrequency = frequencyByPersonaId[participant.personaId] ?: 0
                    val allTimeFrequency = allSpeakerCounts[participant.personaId] ?: 0
                    val recentIndex = recentWindow.indexOf(participant.personaId)
                    val mentionBoost = if (participant.personaId == mentionDrivenPersonaId) 40 else 0
                    val repeatPenalty = if (participant.personaId == lastSpeakerPersonaId) 46 else 0
                    val recentDominancePenalty =
                        recentFrequency * 12 +
                            if (recentFrequency >= ceil(recentWindowSize * 0.45).toInt()) {
                                18
                            } else {
                                0
                            }
                    val historicalGap = max(0, minAllSpeakerCount + 1 - allTimeFrequency)
                    val fairnessBoost = historicalGap * 14
                    val neverSpokeBoost =
                        if (allTimeFrequency == 0 && mentionBoost == 0) {
                            10
                        } else {
                            0
                        }
                    val relationBias = computeRelationBias(relationByTargetId[participant.personaId])
                    val dormancyBoost =
                        when {
                            recentIndex < 0 -> 16
                            recentIndex >= 7 -> 10
                            recentIndex >= 4 -> 5
                            else -> 0
                        }
                    val score =
                        (
                            participant.initiativeBias * 0.25 +
                                participant.aliveScore * 0.2 +
                                22 +
                                mentionBoost +
                                fairnessBoost +
                                neverSpokeBoost +
                                relationBias +
                                dormancyBoost -
                                recentDominancePenalty -
                                repeatPenalty
                        ).roundToInt()

                    ScoredParticipant(
                        participant = participant,
                        score = score,
                        explain =
                            JSONObject().apply {
                                put("initiativeBias", participant.initiativeBias)
                                put("aliveScore", participant.aliveScore)
                                put("recentFrequency", recentFrequency)
                                put("allTimeFrequency", allTimeFrequency)
                                put("recentIndex", recentIndex)
                                put("mentionBoost", mentionBoost)
                                put("fairnessBoost", fairnessBoost)
                                put("neverSpokeBoost", neverSpokeBoost)
                                put("relationBias", relationBias)
                                put("dormancyBoost", dormancyBoost)
                                put("recentDominancePenalty", recentDominancePenalty)
                                put("repeatPenalty", repeatPenalty)
                            },
                    )
                }.sortedWith(
                    compareByDescending<ScoredParticipant> { scored -> scored.score }
                        .thenByDescending { scored -> scored.participant.aliveScore }
                        .thenBy { scored -> scored.participant.joinedAt },
                )

        var selectedParticipant = scoredParticipants.firstOrNull()?.participant
        var selectedBy =
            if (
                selectedParticipant?.personaId == mentionDrivenPersonaId &&
                    mentionDrivenPersonaId.isNotBlank()
            ) {
                "mention"
            } else {
                "score"
            }
        if (
            roomMode == "personas_only" &&
                activeParticipants.size > 1 &&
                selectedParticipant?.personaId == lastSpeakerPersonaId
        ) {
            val alternate =
                scoredParticipants
                    .firstOrNull { scored -> scored.participant.personaId != lastSpeakerPersonaId }
                    ?.participant
            if (alternate != null) {
                selectedParticipant = alternate
                selectedBy = "anti_repeat"
            }
        }

        val selectedSpeakerPersonaId = selectedParticipant?.personaId.orEmpty()
        if (selectedSpeakerPersonaId.isBlank()) {
            return HeadlessTickDecision(
                status = "skipped",
                reason = "speaker_not_found",
                waitForUser = false,
                waitReason = null,
                debug =
                    JSONObject().apply {
                        put("participantCount", activeParticipants.size)
                    },
            )
        }

        val selectedSpeakerPersona = personaById[selectedSpeakerPersonaId]
        if (selectedSpeakerPersona == null) {
            return HeadlessTickDecision(
                status = "skipped",
                reason = "speaker_not_found",
                waitForUser = false,
                waitReason = null,
                debug =
                    JSONObject().apply {
                        put("selectedPersonaId", selectedSpeakerPersonaId)
                    },
            )
        }

        val selectedSpeakerName =
            selectedSpeakerPersona
                .optString("name", "")
                .trim()
                .ifEmpty { selectedSpeakerPersonaId }
        val waitForUser = roomMode == "personas_plus_user"
        val waitReason =
            if (waitForUser) {
                "Ожидаем ответ пользователя (${userName.trim().ifEmpty { "Пользователь" }}) после реплики $selectedSpeakerName"
            } else {
                null
            }
        return HeadlessTickDecision(
            status = "spoke",
            reason = "speaker_selected",
            speakerPersonaId = selectedSpeakerPersonaId,
            waitForUser = waitForUser,
            waitReason = waitReason,
            debug =
                JSONObject().apply {
                    put("selectedBy", selectedBy)
                    put("mentionDrivenPersonaId", mentionDrivenPersonaId)
                    put("lastSpeakerPersonaId", lastSpeakerPersonaId)
                    put(
                        "scoreBoard",
                        JSONArray().apply {
                            for (scored in scoredParticipants.take(5)) {
                                put(
                                    JSONObject().apply {
                                        put("personaId", scored.participant.personaId)
                                        put("score", scored.score)
                                        put("explain", scored.explain)
                                    },
                                )
                            }
                        },
                    )
                    put("model", settingsModel)
                    put("participantCount", activeParticipants.size)
                    put(
                        "focusedUserMessageId",
                        focusedUserMessage?.optString("id", "")?.trim().orEmpty(),
                    )
                },
        )
    }

    private fun mergeHeadlessSpeakerDecision(
        deterministicDecision: HeadlessTickDecision,
        llmDecision: HeadlessTickDecision?,
        roomMode: String,
        events: JSONArray,
        participants: JSONArray,
        roomId: String,
    ): Pair<HeadlessTickDecision, String> {
        var decision = deterministicDecision
        var source = "deterministic"
        val llmDecisionStatus = llmDecision?.status

        if (llmDecision != null) {
            val mergedDebug = JSONObject(deterministicDecision.debug.toString())
            mergedDebug.put("llmDecision", headlessDecisionToJson(llmDecision))
            decision =
                HeadlessTickDecision(
                    status = llmDecision.status.ifBlank { deterministicDecision.status },
                    reason = llmDecision.reason.ifBlank { deterministicDecision.reason },
                    speakerPersonaId = llmDecision.speakerPersonaId ?: deterministicDecision.speakerPersonaId,
                    waitForUser = llmDecision.waitForUser,
                    waitReason = llmDecision.waitReason ?: deterministicDecision.waitReason,
                    userContextAction = llmDecision.userContextAction ?: deterministicDecision.userContextAction,
                    debug = mergedDebug,
                )
            source = "llm"
        }

        val deterministicSpeaker = deterministicDecision.speakerPersonaId?.trim().orEmpty()
        val decisionSpeakerBeforeForce = decision.speakerPersonaId?.trim().orEmpty()
        val forceDeterministicSpeaker =
            deterministicDecision.status == "spoke" &&
                deterministicSpeaker.isNotBlank() &&
                (decision.status != "spoke" || decisionSpeakerBeforeForce.isBlank())
        if (forceDeterministicSpeaker) {
            val debug = JSONObject(deterministicDecision.debug.toString())
            debug.put("llmDecisionStatus", llmDecisionStatus ?: "")
            debug.put("llmOverriddenByDeterministic", true)
            decision =
                deterministicDecision.copy(
                    debug = debug,
                )
            source = "deterministic"
        }

        val mentionDrivenPersonaId =
            deterministicDecision.debug.optString("mentionDrivenPersonaId", "").trim()
        val decisionSpeaker = decision.speakerPersonaId?.trim().orEmpty()
        if (
            decision.status == "spoke" &&
                decisionSpeaker.isNotBlank() &&
                deterministicDecision.status == "spoke" &&
                deterministicSpeaker.isNotBlank() &&
                decisionSpeaker != deterministicSpeaker &&
                (mentionDrivenPersonaId.isBlank() || mentionDrivenPersonaId != decisionSpeaker)
        ) {
            val roomParticipantsCount = countRoomParticipants(participants, roomId)
            val recentSpeakerIds =
                collectRecentSpeakerIds(
                    events = events,
                    roomId = roomId,
                    participantsCount = roomParticipantsCount,
                )
            val llmCount = countRecentSpeaks(recentSpeakerIds, decisionSpeaker)
            val deterministicCount = countRecentSpeaks(recentSpeakerIds, deterministicSpeaker)
            val dominantCountThreshold =
                max(3, ceil(recentSpeakerIds.size * 0.45).toInt())
            if (
                recentSpeakerIds.size >= 6 &&
                    llmCount >= dominantCountThreshold &&
                    deterministicCount < llmCount
            ) {
                val debug = JSONObject(deterministicDecision.debug.toString())
                debug.put("llmDecisionStatus", llmDecisionStatus ?: "")
                debug.put("llmOverriddenByDiversity", true)
                debug.put("llmSpeakerPersonaId", decisionSpeaker)
                debug.put("llmRecentCount", llmCount)
                debug.put("deterministicRecentCount", deterministicCount)
                debug.put("dominantCountThreshold", dominantCountThreshold)
                decision = deterministicDecision.copy(debug = debug)
                source = "deterministic"
            }
        }

        if (roomMode == "personas_only") {
            val originalStatus = decision.status
            val normalizedStatus =
                if (originalStatus == "waiting") {
                    if (deterministicDecision.status == "spoke" && deterministicSpeaker.isNotBlank()) {
                        "spoke"
                    } else {
                        "skipped"
                    }
                } else {
                    originalStatus
                }
            val debug = JSONObject(decision.debug.toString())
            debug.put("personasOnlyGuard", true)
            debug.put("originalStatus", originalStatus)
            decision =
                decision.copy(
                    status = normalizedStatus,
                    speakerPersonaId =
                        if (normalizedStatus == "spoke") {
                            decision.speakerPersonaId ?: deterministicDecision.speakerPersonaId
                        } else {
                            null
                        },
                    waitForUser = false,
                    waitReason = null,
                    debug = debug,
                )
        }

        return Pair(decision, source)
    }

    private fun normalizeRoomMode(room: JSONObject): String {
        val mode = room.optString("mode", "personas_plus_user").trim().lowercase()
        return if (mode == "personas_plus_user") "personas_plus_user" else "personas_only"
    }

    private fun countRoomParticipants(participants: JSONArray, roomId: String): Int {
        var count = 0
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() == roomId) {
                count += 1
            }
        }
        return count
    }

    private fun collectActiveParticipants(
        participants: JSONArray,
        roomId: String,
        nowMs: Long,
    ): List<ActiveParticipant> {
        val active = mutableListOf<ActiveParticipant>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            val muteUntil = participant.optString("muteUntil", "").trim()
            val isActive =
                if (muteUntil.isBlank()) {
                    true
                } else {
                    val muteUntilMs = parseIsoToMillisOrNull(muteUntil)
                    muteUntilMs != null && muteUntilMs <= nowMs
                }
            if (!isActive) continue
            active.add(
                ActiveParticipant(
                    personaId = personaId,
                    initiativeBias = sanitizeFiniteDouble(participant.optDouble("initiativeBias", 0.0)),
                    aliveScore = sanitizeFiniteDouble(participant.optDouble("aliveScore", 0.0)),
                    joinedAt = participant.optString("joinedAt", "").trim(),
                ),
            )
        }
        return active.sortedBy { participant -> participant.joinedAt }
    }

    private fun buildPersonaMap(personas: JSONArray): Map<String, JSONObject> {
        val result = mutableMapOf<String, JSONObject>()
        for (index in 0 until personas.length()) {
            val persona = personas.optJSONObject(index) ?: continue
            val personaId = persona.optString("id", "").trim()
            if (personaId.isNotBlank()) {
                result[personaId] = persona
            }
        }
        return result
    }

    private fun findFocusedUserMessage(messages: JSONArray, room: JSONObject, roomId: String): JSONObject? {
        val marker = room.optString("orchestratorUserFocusMessageId", "").trim()
        if (marker.isNotBlank()) {
            for (index in 0 until messages.length()) {
                val message = messages.optJSONObject(index) ?: continue
                if (message.optString("roomId", "").trim() != roomId) continue
                if (!message.optString("authorType", "").trim().equals("user", ignoreCase = true)) continue
                if (message.optString("id", "").trim() == marker) {
                    return message
                }
            }
        }
        return findLatestUserMessage(messages, roomId)
    }

    private fun getMentionDrivenPersonaId(
        lastUserMessage: JSONObject,
        activeParticipants: List<ActiveParticipant>,
    ): String {
        val mentions = lastUserMessage.optJSONArray("mentions") ?: return ""
        if (mentions.length() == 0) return ""
        val allowedPersonaIds = activeParticipants.map { participant -> participant.personaId }.toSet()
        for (index in 0 until mentions.length()) {
            val mention = mentions.optJSONObject(index) ?: continue
            val targetType = mention.optString("targetType", "").trim()
            val targetId = mention.optString("targetId", "").trim()
            if (targetType.equals("persona", ignoreCase = true) && allowedPersonaIds.contains(targetId)) {
                return targetId
            }
        }
        return ""
    }

    private fun buildRecentSpeakerIds(events: JSONArray, roomId: String, limit: Int): List<String> {
        val speakerIds = mutableListOf<String>()
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            if (event.optString("type", "").trim() != "speaker_selected") continue
            val personaId = event.optJSONObject("payload")?.optString("personaId", "")?.trim().orEmpty()
            if (personaId.isNotBlank()) {
                speakerIds.add(personaId)
            }
        }
        val boundedLimit = max(0, limit)
        val fromIndex = max(0, speakerIds.size - boundedLimit)
        return speakerIds.subList(fromIndex, speakerIds.size).asReversed()
    }

    private fun buildAllSpeakerCounts(events: JSONArray, roomId: String): Map<String, Int> {
        val counts = mutableMapOf<String, Int>()
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            if (event.optString("type", "").trim() != "speaker_selected") continue
            val personaId = event.optJSONObject("payload")?.optString("personaId", "")?.trim().orEmpty()
            if (personaId.isBlank()) continue
            counts[personaId] = (counts[personaId] ?: 0) + 1
        }
        return counts
    }

    private fun buildRelationByTargetId(
        relationEdges: JSONArray,
        roomId: String,
        fromPersonaId: String,
    ): Map<String, JSONObject> {
        if (fromPersonaId.isBlank()) return emptyMap()
        val map = mutableMapOf<String, JSONObject>()
        for (index in 0 until relationEdges.length()) {
            val edge = relationEdges.optJSONObject(index) ?: continue
            if (edge.optString("roomId", "").trim() != roomId) continue
            if (edge.optString("fromPersonaId", "").trim() != fromPersonaId) continue
            val targetId = edge.optString("toPersonaId", "").trim()
            if (targetId.isBlank()) continue
            map[targetId] = edge
        }
        return map
    }

    private fun computeRelationBias(edge: JSONObject?): Int {
        if (edge == null) return 0
        val affinity = sanitizeFiniteDouble(edge.optDouble("affinity", 50.0))
        val trust = sanitizeFiniteDouble(edge.optDouble("trust", 50.0))
        val respect = sanitizeFiniteDouble(edge.optDouble("respect", 50.0))
        val tension = sanitizeFiniteDouble(edge.optDouble("tension", 20.0))
        val raw =
            (affinity - 50.0) * 0.2 +
                (trust - 50.0) * 0.15 +
                (respect - 50.0) * 0.1 -
                (tension - 20.0) * 0.2
        return raw.roundToInt()
    }

    private fun collectRecentSpeakerIds(
        events: JSONArray,
        roomId: String,
        participantsCount: Int,
    ): List<String> {
        val limit = max(8, participantsCount * 3)
        return buildRecentSpeakerIds(events = events, roomId = roomId, limit = limit)
    }

    private fun countRecentSpeaks(recentSpeakerIds: List<String>, personaId: String): Int {
        if (personaId.isBlank()) return 0
        var count = 0
        for (recentId in recentSpeakerIds) {
            if (recentId == personaId) {
                count += 1
            }
        }
        return count
    }

    private fun headlessDecisionToJson(decision: HeadlessTickDecision): JSONObject {
        return JSONObject().apply {
            put("status", decision.status)
            put("reason", decision.reason)
            if (!decision.speakerPersonaId.isNullOrBlank()) {
                put("speakerPersonaId", decision.speakerPersonaId)
            }
            put("waitForUser", decision.waitForUser)
            if (!decision.waitReason.isNullOrBlank()) {
                put("waitReason", decision.waitReason)
            }
            if (!decision.userContextAction.isNullOrBlank()) {
                put("userContextAction", decision.userContextAction)
            }
            put("debug", decision.debug)
        }
    }

    private fun findLastSelectedSpeakerPersonaId(events: JSONArray, roomId: String): String {
        for (index in events.length() - 1 downTo 0) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            if (event.optString("type", "").trim() != "speaker_selected") continue
            val personaId = event.optJSONObject("payload")?.optString("personaId", "")?.trim().orEmpty()
            if (personaId.isNotBlank()) return personaId
        }
        return ""
    }

    private fun findLatestRoomMessage(messages: JSONArray, roomId: String): JSONObject? {
        var latest: JSONObject? = null
        var latestCreatedAt = ""
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            val createdAt = message.optString("createdAt", "").trim()
            if (latest == null || createdAt > latestCreatedAt) {
                latest = message
                latestCreatedAt = createdAt
            }
        }
        return latest
    }

    private fun estimatePersonaTypingDelayMs(message: JSONObject): Long {
        val textLength = message.optString("content", "").trim().length
        val boundedLength = max(18, minOf(420, textLength))
        val byLength = boundedLength * 32L
        return max(6_500L, minOf(22_000L, byLength))
    }

    private fun sanitizeFiniteDouble(raw: Double): Double {
        return if (raw.isFinite()) raw else 0.0
    }

    private fun parseIsoToMillisOrNull(raw: String): Long? {
        return try {
            Instant.parse(raw).toEpochMilli()
        } catch (_: Exception) {
            null
        }
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

    private fun findMostRecentUserDisplayName(messages: JSONArray, roomId: String): String {
        for (index in messages.length() - 1 downTo 0) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            if (!message.optString("authorType", "").trim().equals("user", ignoreCase = true)) continue
            val displayName = message.optString("authorDisplayName", "").trim()
            if (displayName.isNotBlank()) return displayName
        }
        return ""
    }

    private data class GroupImageGenerationResult(
        val status: String,
        val expected: Int,
        val completed: Int,
        val assetIds: List<String> = emptyList(),
    )

    private fun isNativeGroupImagesEnabled(settings: JSONObject): Boolean {
        // Only explicit image-pipeline flags can disable native image generation.
        // Legacy group iteration flag must not disable images implicitly.
        if (settings.has("androidNativeGroupImagesV1Disable")) {
            return !settings.optBoolean("androidNativeGroupImagesV1Disable", false)
        }
        if (settings.has("androidNativeGroupImagesV1")) {
            return settings.optBoolean("androidNativeGroupImagesV1", true)
        }
        return true
    }

    private fun findLatestPendingImageMessage(messages: JSONArray, roomId: String): JSONObject? {
        var latest: JSONObject? = null
        var latestCreatedAt = ""
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            if (!message.optBoolean("imageGenerationPending", false)) continue
            val createdAt = message.optString("createdAt", "").trim()
            if (latest == null || createdAt > latestCreatedAt) {
                latest = message
                latestCreatedAt = createdAt
            }
        }
        return latest
    }

    private fun resolveImagePromptsForGeneration(
        comfyPrompts: List<String>,
        comfyPrompt: String?,
    ): List<String> {
        val normalizedPrompts = LinkedHashSet<String>()
        for (prompt in comfyPrompts) {
            val value = prompt.trim()
            if (value.isNotBlank()) {
                normalizedPrompts.add(value)
            }
        }
        val singlePrompt = comfyPrompt?.trim().orEmpty()
        if (singlePrompt.isNotBlank()) {
            normalizedPrompts.add(singlePrompt)
        }
        return normalizedPrompts.toList()
    }

    private fun resolveImageDescriptionsForPromptConversion(
        comfyImageDescriptions: List<String>,
        comfyImageDescription: String?,
    ): List<String> {
        val normalizedDescriptions = LinkedHashSet<String>()
        for (description in comfyImageDescriptions) {
            val value = description.trim()
            if (value.isNotBlank()) {
                normalizedDescriptions.add(value)
            }
        }
        val singleDescription = comfyImageDescription?.trim().orEmpty()
        if (singleDescription.isNotBlank()) {
            normalizedDescriptions.add(singleDescription)
        }
        return normalizedDescriptions.toList()
    }

    private fun runGroupImageGeneration(
        context: Context,
        repository: LocalRepository,
        runtime: BackgroundRuntimeRepository,
        job: BackgroundJobRecord,
        settings: JSONObject,
        roomId: String,
        turnId: String,
        speakerPersona: JSONObject?,
        speakerPersonaId: String,
        message: JSONObject,
        promptsForGeneration: List<String>,
        events: JSONArray,
    ): GroupImageGenerationResult {
        if (promptsForGeneration.isEmpty()) {
            message.put("imageGenerationPending", false)
            message.put("imageGenerationExpected", 0)
            message.put("imageGenerationCompleted", 0)
            return GroupImageGenerationResult(
                status = "no_prompts",
                expected = 0,
                completed = 0,
                assetIds = emptyList(),
            )
        }

        val messageId = message.optString("id", "").trim()
        val expected = promptsForGeneration.size
        val checkpointName = speakerPersona?.optString("imageCheckpoint", "")?.trim().orEmpty()
        val styleReferenceImage =
            speakerPersona?.optString("avatarUrl", "")?.trim().orEmpty().ifEmpty {
                speakerPersona?.optString("fullBodyUrl", "")?.trim().orEmpty()
            }.ifEmpty { null }
        val nowIsoRequested = nowIsoUtc()

        events.put(
            JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("roomId", roomId)
                put("turnId", turnId)
                put("type", "message_image_requested")
                put(
                    "payload",
                    JSONObject().apply {
                        put("messageId", messageId)
                        put("personaId", speakerPersonaId)
                        put("expected", expected)
                        put("retry", false)
                    },
                )
                put("createdAt", nowIsoRequested)
            },
        )

        val imageAttachments =
            message.optJSONArray("imageAttachments")
                ?: JSONArray().also { message.put("imageAttachments", it) }
        val imageMetaByUrl =
            message.optJSONObject("imageMetaByUrl")
                ?: JSONObject().also { message.put("imageMetaByUrl", it) }

        var completed = 0
        val generatedAssetIds = LinkedHashSet<String>()

        try {
            for (index in promptsForGeneration.indices) {
                val prompt = promptsForGeneration[index]
                val seed = ComfyNativeClient.stableSeedFromText("$messageId:${index + 1}:$prompt")
                val comfyResult =
                    ComfyNativeClient.runBaseGeneration(
                        ComfyNativeClient.BaseGenerationRequest(
                            context = context,
                            settings = settings,
                            prompt = prompt,
                            seed = seed,
                            checkpointName = checkpointName.ifEmpty { null },
                            styleReferenceImage = styleReferenceImage,
                            preferredTitleIncludes = emptyList(),
                            strictPreferredMatch = false,
                            pickLatestImageOnly = false,
                            worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                            workerScopeId = roomId.ifBlank { "group" },
                            workerQueueDetail = "native_queue_image_prompt",
                            workerWaitDetail = "native_wait_image_history",
                        ),
                    )
                if (comfyResult.imageUrls.isEmpty()) {
                    throw IllegalStateException("group_comfy_empty_images")
                }
                val meta =
                    JSONObject().apply {
                        put("seed", comfyResult.seed)
                        put("prompt", prompt)
                        put("flow", "base")
                        if (!comfyResult.model.isNullOrBlank()) {
                            put("model", comfyResult.model)
                        }
                    }
                val appendedAssets =
                    TopicGenerationNativeExecutor.appendGeneratedImageAssets(
                    repository = repository,
                    imageUrls = comfyResult.imageUrls,
                    meta = meta,
                    createdAt = nowIsoUtc(),
                )
                for (appended in appendedAssets) {
                    generatedAssetIds.add(appended.id)
                    if (!imageAttachmentExists(imageAttachments, appended.ref)) {
                        imageAttachments.put(
                            JSONObject().apply {
                                put("url", appended.ref)
                                put("imageId", appended.id)
                                put("meta", JSONObject(appended.meta.toString()))
                            },
                        )
                    }
                    imageMetaByUrl.put(appended.ref, JSONObject(appended.meta.toString()))
                }
                completed += 1
                val progressStatus = if (completed >= expected) "completed" else "progress"

                message.put("imageGenerationPending", completed < expected)
                message.put("imageGenerationExpected", expected)
                message.put("imageGenerationCompleted", completed)
                message.put("imageAttachments", imageAttachments)
                message.put("imageMetaByUrl", imageMetaByUrl)

                events.put(
                    JSONObject().apply {
                        put("id", UUID.randomUUID().toString())
                        put("roomId", roomId)
                        put("turnId", turnId)
                        put("type", "message_image_generated")
                        put(
                            "payload",
                            JSONObject().apply {
                                put("messageId", messageId)
                                put("personaId", speakerPersonaId)
                                put("status", progressStatus)
                                put("expected", expected)
                                put("completed", completed)
                                put("generatedCount", comfyResult.imageUrls.size)
                            },
                        )
                        put("createdAt", nowIsoUtc())
                    },
                )
            }

            message.put("imageGenerationPending", false)
            message.put("imageGenerationExpected", expected)
            message.put("imageGenerationCompleted", expected)
            message.put("imageAttachments", imageAttachments)
            message.put("imageMetaByUrl", imageMetaByUrl)

            return GroupImageGenerationResult(
                status = "completed",
                expected = expected,
                completed = expected,
                assetIds = generatedAssetIds.toList(),
            )
        } catch (error: Exception) {
            message.put("imageGenerationPending", false)
            message.put("imageGenerationExpected", expected)
            message.put("imageGenerationCompleted", completed)
            if (imageAttachments.length() > 0) {
                message.put("imageAttachments", imageAttachments)
                message.put("imageMetaByUrl", imageMetaByUrl)
            }

            events.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("roomId", roomId)
                    put("turnId", turnId)
                    put("type", "message_image_generated")
                    put(
                        "payload",
                        JSONObject().apply {
                            put("messageId", messageId)
                            put("personaId", speakerPersonaId)
                            put("status", "generation_failed")
                            put("expected", expected)
                            put("completed", completed)
                        },
                    )
                    put("createdAt", nowIsoUtc())
                },
            )

            appendRuntimeEvent(
                runtime = runtime,
                scopeId = roomId,
                jobId = job.id,
                stage = "group_image_generation_failed",
                level = "warn",
                message = "Native group image generation failed",
                details = JSONObject().apply {
                    put("messageId", messageId)
                    put("personaId", speakerPersonaId)
                    put("expected", expected)
                    put("completed", completed)
                    put("error", error.message ?: "unknown_error")
                },
            )

            return GroupImageGenerationResult(
                status = "generation_failed",
                expected = expected,
                completed = completed,
                assetIds = generatedAssetIds.toList(),
            )
        }
    }

    private fun imageAttachmentExists(attachments: JSONArray, targetUrl: String): Boolean {
        val normalizedUrl = targetUrl.trim()
        if (normalizedUrl.isEmpty()) return false
        for (index in 0 until attachments.length()) {
            val item = attachments.optJSONObject(index) ?: continue
            if (item.optString("url", "").trim() == normalizedUrl) {
                return true
            }
        }
        return false
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

    private fun isScopeCancellationRequested(scopeId: String): Boolean {
        val normalized = scopeId.trim()
        if (normalized.isEmpty()) return false
        return cancelledScopes.contains(normalized)
    }

    private fun appendStatePatch(
        runtime: BackgroundRuntimeRepository,
        scopeId: String,
        jobId: String?,
        stores: JSONObject,
        assetIds: List<String> = emptyList(),
    ) {
        val normalizedScopeId = scopeId.ifBlank { BackgroundRuntimeRepository.GLOBAL_SCOPE_ID }
        val normalizedAssetIds =
            assetIds.map { id -> id.trim() }.filter { id -> id.isNotEmpty() }.distinct()
        runtime.appendDelta(
            taskType = GROUP_ITERATION_JOB_TYPE,
            scopeId = normalizedScopeId,
            kind = "state_patch",
            entityType = "stores",
            entityId = jobId?.trim()?.ifEmpty { null },
            payloadJson =
                JSONObject().apply {
                    put("stores", stores)
                    if (normalizedAssetIds.isNotEmpty()) {
                        put("assetIds", JSONArray(normalizedAssetIds))
                        put(
                            "assetContext",
                            JSONObject().apply {
                                put("scope", normalizedScopeId)
                                put("source", GROUP_ITERATION_JOB_TYPE)
                            },
                        )
                    }
                }.toString(),
        )
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

    private fun putLlmCallDebugDetails(
        details: JSONObject,
        debug: NativeLlmCallDebug?,
    ) {
        if (debug == null) return
        details.put("toolModeRequested", debug.toolModeRequested)
        details.put("toolModeActive", debug.toolModeActive)
        if (!debug.expectedToolName.isNullOrBlank()) {
            details.put("expectedToolName", debug.expectedToolName)
        }
        if (!debug.actualToolName.isNullOrBlank()) {
            details.put("actualToolName", debug.actualToolName)
        }
        if (debug.responseSource.isNotBlank()) {
            details.put("responseSource", debug.responseSource)
        }
        if (!debug.fallbackReason.isNullOrBlank()) {
            details.put("fallbackReason", debug.fallbackReason)
        }
        if (debug.httpStatus != null) {
            details.put("httpStatus", debug.httpStatus)
        }
        if (!debug.parsedField.isNullOrBlank()) {
            details.put("parsedField", debug.parsedField)
        }
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
        val normalizedScopeId = scopeId.ifBlank { "unknown" }
        runtime.appendEvent(
            taskType = GROUP_ITERATION_JOB_TYPE,
            scopeId = normalizedScopeId,
            jobId = jobId,
            stage = stage,
            level = level,
            message = message,
            detailsJson = details?.toString(),
        )
        runtime.appendDelta(
            taskType = GROUP_ITERATION_JOB_TYPE,
            scopeId = normalizedScopeId,
            kind = "worker_action",
            entityType = stage,
            entityId = jobId?.trim()?.ifEmpty { null },
            payloadJson =
                JSONObject().apply {
                    put("level", level)
                    put("message", message)
                    if (jobId != null) {
                        put("jobId", jobId)
                    }
                    if (details != null) {
                        put("details", details)
                    }
                }.toString(),
        )
    }
}
