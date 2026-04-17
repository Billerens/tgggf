package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

object TopicGenerationNativeExecutor {
    private const val TOPIC_GENERATION_JOB_TYPE = "topic_generation"
    private const val TOPIC_GENERATION_JOB_PREFIX = "topic_generation:"
    private const val TOPIC_GENERATION_LEASE_MS = 45_000L
    private const val COMFY_SEED_MAX = 1_125_899_906_842_624L
    private const val THEMED_PROMPT_BATCH_SIZE = 8
    private const val THEMED_PROMPT_REFILL_THRESHOLD = 1
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L
    private const val IMAGE_REF_PREFIX = "idb://"
    private const val IMAGE_ASSET_GC_INTERVAL_MS = 15 * 60 * 1000L
    private const val IMAGE_ASSET_GC_LAST_RUN_MARKER_KEY = "image_asset_gc_last_run_ms_v1"

    private val inFlight = AtomicBoolean(false)
    private val cancelledScopes = Collections.synchronizedSet(mutableSetOf<String>())
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-topic-native").apply {
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

    data class ComfyRunResult(
        val imageUrls: List<String>,
        val seed: Long,
        val model: String?,
    )

    data class ImageAssetAppendResult(
        val id: String,
        val ref: String,
        val meta: JSONObject,
        val createdAt: String,
    )

    private data class TopicPromptResolution(
        val prompt: String,
        val source: String,
        val themeTags: List<String>,
    )

    private data class TopicPromptQueueResolution(
        val promptResolution: TopicPromptResolution,
        val nextThemePromptQueue: List<String>,
    )

    @JvmStatic
    fun requestTick(context: Context) {
        if (!inFlight.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        executor.execute {
            try {
                processTick(appContext)
            } catch (error: Exception) {
                ForegroundSyncService.updateWorkerStatus(
                    context = appContext,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "error",
                    scopeId = "",
                    detail = "native_executor_crash",
                    progress = false,
                    claimed = false,
                    lastError = error.message ?: "native_executor_crash",
                )
            } finally {
                inFlight.set(false)
            }
        }
    }

    private fun processTick(context: Context) {
        val jobs = BackgroundJobRepository(context)
        val runtimeRepository = BackgroundRuntimeRepository(context)
        val repository = LocalRepository(context)
        try {
            val claimed = jobs.claimDueJobs(
                limit = 1,
                leaseMs = TOPIC_GENERATION_LEASE_MS,
                type = TOPIC_GENERATION_JOB_TYPE,
            )

            if (claimed.isEmpty()) {
                emitAwaitingState(context, repository, jobs)
                return
            }

            for (job in claimed) {
                processClaimedJob(
                    context = context,
                    repository = repository,
                    jobs = jobs,
                    runtimeRepository = runtimeRepository,
                    job = job,
                )
            }
        } finally {
            repository.close()
            jobs.closeQuietly()
            runtimeRepository.closeQuietly()
        }
    }

    private fun emitAwaitingState(
        context: Context,
        repository: LocalRepository,
        jobs: BackgroundJobRepository,
    ) {
        val sessions = readStoreArray(repository, "generatorSessions")
        val activeSession = findRunningSession(sessions)
        if (activeSession == null) {
            val hasPendingTopicJobs =
                jobs.listJobs(status = null, limit = 40)
                    .any { row ->
                        row.type == TOPIC_GENERATION_JOB_TYPE &&
                            (
                                row.status == BackgroundJobRepository.STATUS_PENDING ||
                                    row.status == BackgroundJobRepository.STATUS_LEASED
                            )
                    }
            if (hasPendingTopicJobs) {
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "running",
                    scopeId = "",
                    detail = "awaiting_context_sync",
                    progress = false,
                    claimed = false,
                    lastError = "",
                )
                return
            }
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = "",
                detail = "no_session",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }

        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
            state = "running",
            scopeId = activeSession.optString("id", ""),
            detail = "awaiting_due_job",
            progress = false,
            claimed = false,
            lastError = "",
        )
    }

    private fun processClaimedJob(
        context: Context,
        repository: LocalRepository,
        jobs: BackgroundJobRepository,
        runtimeRepository: BackgroundRuntimeRepository,
        job: BackgroundJobRecord,
    ) {
        val payload = parseJsonObject(job.payloadJson)
        val sessionId =
            payload.optString("sessionId", "").trim().ifEmpty {
                parseSessionIdFromJobId(job.id)
            }
        if (sessionId.isEmpty()) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = "unknown",
                jobId = job.id,
                stage = "job_scope_missing",
                level = "error",
                message = "Failed to resolve sessionId for topic generation job",
                details = JSONObject().apply {
                    put("jobId", job.id)
                    put("payload", payload)
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = "",
                detail = "session_missing",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }

        val sessions = readStoreArray(repository, "generatorSessions")
        val sessionIndex = findObjectIndexById(sessions, sessionId)
        if (sessionIndex < 0) {
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + CONTEXT_SYNC_RETRY_DELAY_MS,
                incrementAttempts = false,
                lastError = "session_missing",
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "running",
                scopeId = sessionId,
                detail = "awaiting_session_sync",
                progress = false,
                claimed = true,
                lastError = "session_missing",
            )
            return
        }

        val session = sessions.optJSONObject(sessionIndex) ?: JSONObject()
        val migratedSessionAssetIds =
            migrateSessionInlineImageRefs(
                repository = repository,
                session = session,
            )
        if (migratedSessionAssetIds.isNotEmpty()) {
            session.put("updatedAt", nowIsoUtc())
            sessions.put(sessionIndex, session)
            repository.writeStoreJson("generatorSessions", sessions.toString())
        }
        if (!isDesiredStateEnabled(runtimeRepository, sessionId)) {
            requestCancellation(sessionId)
            val sessionStatus = session.optString("status", "stopped")
            if (sessionStatus.equals("running", ignoreCase = true)) {
                session.put("status", "stopped")
                session.put("updatedAt", nowIsoUtc())
                sessions.put(sessionIndex, session)
                repository.writeStoreJson("generatorSessions", sessions.toString())
                appendStatePatch(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stores =
                        JSONObject().apply {
                            put(
                                "generatorSessionPatches",
                                JSONArray().apply {
                                    put(buildGeneratorSessionPatch(session))
                                },
                            )
                        },
                    assetIds = migratedSessionAssetIds,
                )
                maybeRunImageAssetGc(repository)
            }
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stage = "desired_state_disabled",
                level = "info",
                message = "Topic generation skipped because desired-state is disabled",
                details = JSONObject().apply {
                    put("sessionStatus", sessionStatus)
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = sessionId,
                detail = "desired_state_disabled",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }
        if (isScopeCancellationRequested(sessionId)) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stage = "cancelled",
                level = "info",
                message = "Topic generation job cancelled by desired-state",
                details = null,
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = sessionId,
                detail = "cancelled",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }
        if (!session.optString("status", "stopped").equals("running", ignoreCase = true)) {
            val statusDelayMs =
                max(0L, (session.optDouble("delaySeconds", 0.0) * 1_000.0).toLong())
            jobs.cancelJob(job.id)
            syncDesiredState(
                runtimeRepository = runtimeRepository,
                sessionId = sessionId,
                enabled = false,
                delayMs = statusDelayMs,
            )
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stage = "session_not_running",
                level = "info",
                message = "Topic generation stopped because session is not running",
                details = JSONObject().apply {
                    put("sessionStatus", session.optString("status", "stopped"))
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = sessionId,
                detail = "session_${session.optString("status", "stopped")}",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }

        val delayMs =
            max(
                0L,
                payload.optLong(
                    "delayMs",
                    (session.optDouble("delaySeconds", 0.0) * 1_000.0).toLong(),
                ),
            )

        val requestedCount = resolveRequestedCount(session)
        val completedCount = session.optInt("completedCount", 0)
        if (requestedCount != null && completedCount >= requestedCount) {
            session.put("status", "completed")
            session.put("updatedAt", nowIsoUtc())
            sessions.put(sessionIndex, session)
            repository.writeStoreJson("generatorSessions", sessions.toString())
            appendStatePatch(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stores =
                    JSONObject().apply {
                        put(
                            "generatorSessionPatches",
                            JSONArray().apply {
                                put(buildGeneratorSessionPatch(session))
                            },
                        )
                    },
                assetIds = migratedSessionAssetIds,
            )
            maybeRunImageAssetGc(repository)
            jobs.cancelJob(job.id)
            syncDesiredState(
                runtimeRepository = runtimeRepository,
                sessionId = sessionId,
                enabled = false,
                delayMs = delayMs,
            )
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stage = "session_completed",
                level = "info",
                message = "Topic generation session reached requested count",
                details = JSONObject().apply {
                    put("requestedCount", requestedCount)
                    put("completedCount", completedCount)
                },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "idle",
                scopeId = sessionId,
                detail = "result_completed",
                progress = true,
                claimed = true,
                lastError = "",
            )
            return
        }

        val personas = readStoreArray(repository, "personas")
        val personaId = session.optString("personaId", "").trim()
        val persona = findObjectById(personas, personaId)
        if (persona == null) {
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = System.currentTimeMillis() + CONTEXT_SYNC_RETRY_DELAY_MS,
                incrementAttempts = false,
                lastError = "persona_missing",
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "running",
                scopeId = sessionId,
                detail = "awaiting_persona_sync",
                progress = false,
                claimed = true,
                lastError = "persona_missing",
            )
            return
        }

        val settings = parseJsonObject(repository.readSettingsJson())
        val iteration = completedCount + 1
        val promptMode = resolvePromptMode(session)
        val singleRunRequested = session.optBoolean("singleRunRequested", false)
        val directPromptSeed = resolveDirectPromptSeed(session)
        val shouldUseDirectOneShotSeed =
            promptMode == "direct_prompt" &&
                session.optBoolean("directPromptSeedArmed", false) &&
                directPromptSeed != null
        val comfySeed =
            when {
                promptMode == "direct_prompt" && shouldUseDirectOneShotSeed ->
                    directPromptSeed!!
                promptMode == "direct_prompt" -> randomComfySeed()
                else -> {
                    val topicSeedSource = session.optString("topic", "").trim()
                    stableSeedFromText("$sessionId:$iteration:$topicSeedSource")
                }
            }
        val promptResolution =
            resolveTopicPrompt(
                runtimeRepository = runtimeRepository,
                session = session,
                persona = persona,
                settings = settings,
                iteration = iteration,
                scopeId = sessionId,
                jobId = job.id,
                requestedCount = requestedCount,
                singleRunRequested = singleRunRequested,
            )
        val prompt = promptResolution.promptResolution.prompt

        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
            state = "running",
            scopeId = sessionId,
            detail = "native_claimed",
            progress = false,
            claimed = true,
            lastError = "",
        )
        appendRuntimeEvent(
            runtimeRepository = runtimeRepository,
            scopeId = sessionId,
            jobId = job.id,
            stage = "job_claimed",
            level = "info",
            message = "Topic generation job claimed by native executor",
            details = JSONObject().apply {
                put("iteration", iteration)
                put("delayMs", delayMs)
                put("promptMode", promptMode)
                put("singleRunRequested", singleRunRequested)
                put("directOneShotSeed", shouldUseDirectOneShotSeed)
            },
        )

        try {
            if (isScopeCancellationRequested(sessionId)) {
                throw IllegalStateException("cancelled")
            }
            val comfyResult = runBaseComfyGeneration(
                context = context,
                settings = settings,
                persona = persona,
                session = session,
                prompt = prompt,
                seed = comfySeed,
                iteration = iteration,
                runtimeRepository = runtimeRepository,
                jobId = job.id,
            )
            if (comfyResult.imageUrls.isEmpty()) {
                throw IllegalStateException("Comfy не вернул ни одного изображения")
            }

            val nowIso = nowIsoUtc()
            val meta = JSONObject().apply {
                put("prompt", prompt)
                put("promptSource", promptResolution.promptResolution.source)
                put("seed", comfyResult.seed)
                put("flow", "base")
                if (promptResolution.promptResolution.themeTags.isNotEmpty()) {
                    put("themeTags", JSONArray(promptResolution.promptResolution.themeTags))
                }
                if (!comfyResult.model.isNullOrBlank()) {
                    put("model", comfyResult.model)
                }
            }
            val newImageAssets =
                appendImageAssets(repository, comfyResult.imageUrls, meta, nowIso)
            val imageRefs = newImageAssets.map { appended -> appended.ref }
            val imageAssetIds = newImageAssets.map { appended -> appended.id }

            val entry = JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("iteration", iteration)
                put("prompt", prompt)
                put("promptSource", promptResolution.promptResolution.source)
                if (promptResolution.promptResolution.themeTags.isNotEmpty()) {
                    put("themeTags", JSONArray(promptResolution.promptResolution.themeTags))
                }
                put("imageUrls", JSONArray(imageRefs))
                put("createdAt", nowIso)
                val imageMetaByUrl = JSONObject()
                for (ref in imageRefs) {
                    imageMetaByUrl.put(ref, JSONObject(meta.toString()))
                }
                put("imageMetaByUrl", imageMetaByUrl)
            }
            val entries = session.optJSONArray("entries") ?: JSONArray()
            entries.put(entry)
            session.put("entries", entries)
            session.put("completedCount", iteration)
            session.put("themePromptQueue", JSONArray(promptResolution.nextThemePromptQueue))
            if (shouldUseDirectOneShotSeed) {
                session.put("directPromptSeed", JSONObject.NULL)
                session.put("directPromptSeedArmed", false)
            }
            if (singleRunRequested) {
                session.put("singleRunRequested", false)
            }

            val shouldStopByDesiredState =
                isScopeCancellationRequested(sessionId) ||
                    !isDesiredStateEnabled(runtimeRepository, sessionId)
            val shouldStopBySingleRun = singleRunRequested
            val nextStatus =
                when {
                    requestedCount != null && iteration >= requestedCount -> "completed"
                    shouldStopByDesiredState || shouldStopBySingleRun -> "stopped"
                    else -> "running"
                }
            session.put("status", nextStatus)
            session.put("updatedAt", nowIso)
            sessions.put(sessionIndex, session)
            repository.writeStoreJson("generatorSessions", sessions.toString())
            appendStatePatch(
                runtimeRepository = runtimeRepository,
                scopeId = sessionId,
                jobId = job.id,
                stores =
                    JSONObject().apply {
                        put(
                            "generatorSessionPatches",
                            JSONArray().apply {
                                put(
                                    buildGeneratorSessionPatch(
                                        session = session,
                                        appendedEntries = JSONArray().apply {
                                            put(JSONObject(entry.toString()))
                                        },
                                    ),
                                )
                            },
                        )
                    },
                assetIds = (migratedSessionAssetIds + imageAssetIds).distinct(),
            )
            maybeRunImageAssetGc(repository)

            if (nextStatus == "completed") {
                jobs.cancelJob(job.id)
                syncDesiredState(
                    runtimeRepository = runtimeRepository,
                    sessionId = sessionId,
                    enabled = false,
                    delayMs = delayMs,
                )
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage = "iteration_completed",
                    level = "info",
                    message = "Topic generation iteration completed",
                    details = JSONObject().apply {
                        put("iteration", iteration)
                        put("delayMs", delayMs)
                        put("imageCount", comfyResult.imageUrls.size)
                    },
                )
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage = "session_completed",
                    level = "info",
                    message = "Topic generation session completed",
                    details = JSONObject().apply {
                        put("completedCount", iteration)
                        put("requestedCount", requestedCount)
                    },
                )
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "idle",
                    scopeId = sessionId,
                    detail = "result_completed",
                    progress = true,
                    claimed = true,
                    lastError = "",
                )
            } else if (nextStatus == "stopped") {
                jobs.cancelJob(job.id)
                syncDesiredState(
                    runtimeRepository = runtimeRepository,
                    sessionId = sessionId,
                    enabled = false,
                    delayMs = delayMs,
                )
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage =
                        if (shouldStopBySingleRun) {
                            "single_run_completed"
                        } else {
                            "desired_state_disabled_during_iteration"
                        },
                    level = "info",
                    message =
                        if (shouldStopBySingleRun) {
                            "Topic generation stopped after single-run iteration"
                        } else {
                            "Topic generation stopped after iteration by desired-state"
                        },
                    details = JSONObject().apply {
                        put("iteration", iteration)
                        put("delayMs", delayMs)
                        put("imageCount", comfyResult.imageUrls.size)
                        put("singleRunRequested", shouldStopBySingleRun)
                    },
                )
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "idle",
                    scopeId = sessionId,
                    detail =
                        if (shouldStopBySingleRun) {
                            "single_run_completed"
                        } else {
                            "desired_state_disabled"
                        },
                    progress = true,
                    claimed = true,
                    lastError = "",
                )
            } else {
                jobs.rescheduleJob(
                    id = job.id,
                    runAtMs = System.currentTimeMillis() + delayMs,
                    incrementAttempts = false,
                    lastError = null,
                )
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage = "iteration_completed",
                    level = "info",
                    message = "Topic generation iteration completed",
                    details = JSONObject().apply {
                        put("iteration", iteration)
                        put("delayMs", delayMs)
                        put("imageCount", comfyResult.imageUrls.size)
                    },
                )
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "running",
                    scopeId = sessionId,
                    detail = "native_progress",
                    progress = true,
                    claimed = true,
                    lastError = "",
                )
            }
        } catch (error: Exception) {
            if (isScopeCancellationRequested(sessionId)) {
                jobs.cancelJob(job.id)
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage = "cancelled",
                    level = "info",
                    message = "Topic generation cancelled while processing iteration",
                    details = null,
                )
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    state = "idle",
                    scopeId = sessionId,
                    detail = "cancelled",
                    progress = false,
                    claimed = false,
                    lastError = "",
                )
                return
            }
            val errorMessage = error.message?.trim().takeUnless { it.isNullOrBlank() }
                ?: "Ошибка native topic generation"
            runCatching {
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stage = "iteration_failed",
                    level = "error",
                    message = "Topic generation native iteration failed",
                    details = JSONObject().apply {
                        put("error", errorMessage)
                    },
                )
            }
            runCatching {
                markSessionError(sessions, sessionIndex, errorMessage)
                repository.writeStoreJson("generatorSessions", sessions.toString())
                val erroredSession = sessions.optJSONObject(sessionIndex)
                appendStatePatch(
                    runtimeRepository = runtimeRepository,
                    scopeId = sessionId,
                    jobId = job.id,
                    stores =
                        JSONObject().apply {
                            if (erroredSession != null) {
                                put(
                                    "generatorSessionPatches",
                                    JSONArray().apply {
                                        put(buildGeneratorSessionPatch(erroredSession))
                                    },
                                )
                            }
                        },
                    assetIds = migratedSessionAssetIds,
                )
                maybeRunImageAssetGc(repository)
            }.onFailure { stateSyncError ->
                runCatching {
                    appendRuntimeEvent(
                        runtimeRepository = runtimeRepository,
                        scopeId = sessionId,
                        jobId = job.id,
                        stage = "iteration_failure_state_sync_failed",
                        level = "warn",
                        message = "Failed to persist topic error state patch",
                        details = JSONObject().apply {
                            put("error", stateSyncError.message?.trim().orEmpty())
                        },
                    )
                }
            }
            runCatching {
                jobs.cancelJob(job.id)
            }.onFailure { cancelError ->
                runCatching {
                    appendRuntimeEvent(
                        runtimeRepository = runtimeRepository,
                        scopeId = sessionId,
                        jobId = job.id,
                        stage = "iteration_failure_cancel_failed",
                        level = "warn",
                        message = "Failed to cancel topic job after iteration failure",
                        details = JSONObject().apply {
                            put("error", cancelError.message?.trim().orEmpty())
                        },
                    )
                }
            }
            runCatching {
                syncDesiredState(
                    runtimeRepository = runtimeRepository,
                    sessionId = sessionId,
                    enabled = false,
                    delayMs = delayMs,
                )
            }.onFailure { desiredStateError ->
                runCatching {
                    appendRuntimeEvent(
                        runtimeRepository = runtimeRepository,
                        scopeId = sessionId,
                        jobId = job.id,
                        stage = "iteration_failure_desired_state_sync_failed",
                        level = "warn",
                        message = "Failed to disable desired-state after iteration failure",
                        details = JSONObject().apply {
                            put("error", desiredStateError.message?.trim().orEmpty())
                        },
                    )
                }
            }
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                state = "error",
                scopeId = sessionId,
                detail = "native_failed",
                progress = false,
                claimed = true,
                lastError = errorMessage,
            )
        }
    }

    @JvmStatic
    fun generateComfyImageForGroup(
        context: Context,
        settings: JSONObject,
        prompt: String,
        checkpointName: String?,
        styleReferenceImage: String?,
        seedKey: String,
        scopeId: String,
    ): ComfyRunResult {
        val seed = stableSeedFromText(seedKey)
        val result =
            ComfyNativeClient.runBaseGeneration(
                ComfyNativeClient.BaseGenerationRequest(
                    context = context,
                    settings = settings,
                    prompt = prompt,
                    seed = seed,
                    checkpointName = checkpointName?.trim().orEmpty().ifEmpty { null },
                    styleReferenceImage = styleReferenceImage?.trim().orEmpty().ifEmpty { null },
                    preferredTitleIncludes = emptyList(),
                    strictPreferredMatch = false,
                    pickLatestImageOnly = false,
                    worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
                    workerScopeId = scopeId.ifBlank { "group" },
                    workerQueueDetail = "native_queue_image_prompt",
                    workerWaitDetail = "native_wait_image_history",
                ),
            )
        return ComfyRunResult(
            imageUrls = result.imageUrls,
            seed = result.seed,
            model = result.model,
        )
    }

    @JvmStatic
    fun appendGeneratedImageAssets(
        repository: LocalRepository,
        imageUrls: List<String>,
        meta: JSONObject,
        createdAt: String,
    ): List<ImageAssetAppendResult> {
        return appendImageAssets(repository, imageUrls, meta, createdAt)
    }

    private fun runBaseComfyGeneration(
        context: Context,
        settings: JSONObject,
        persona: JSONObject,
        session: JSONObject,
        prompt: String,
        seed: Long,
        iteration: Int,
        runtimeRepository: BackgroundRuntimeRepository,
        jobId: String,
    ): ComfyRunResult {
        val sessionId = session.optString("id", "")
        val checkpointName = persona.optString("imageCheckpoint", "").trim()
        val styleReferenceImage =
            persona.optString("avatarUrl", "").trim().ifEmpty {
                persona.optString("fullBodyUrl", "").trim()
            }.ifEmpty { null }
        val comfyDebugEmitter =
            comfyDebug@{ stage: String, details: JSONObject ->
                if (!shouldForwardComfyDebugEvent(stage, details)) return@comfyDebug
                runCatching {
                    appendRuntimeEvent(
                        runtimeRepository = runtimeRepository,
                        scopeId = sessionId,
                        jobId = jobId,
                        stage = "comfy_$stage",
                        level = comfyDebugLevelForStage(stage),
                        message = "Comfy debug: $stage",
                        details = JSONObject(details.toString()),
                    )
                }
            }
        val result =
            ComfyNativeClient.runBaseGeneration(
                ComfyNativeClient.BaseGenerationRequest(
                    context = context,
                    settings = settings,
                    prompt = prompt,
                    seed = seed,
                    checkpointName = checkpointName.ifEmpty { null },
                    styleReferenceImage = styleReferenceImage,
                    preferredTitleIncludes = parseStringList(session.optJSONArray("outputNodeTitleIncludes")),
                    strictPreferredMatch = session.optBoolean("strictOutputNodeMatch", false),
                    pickLatestImageOnly = session.optBoolean("pickLatestImageOnly", false),
                    worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
                    workerScopeId = sessionId,
                    workerQueueDetail = "native_queue_prompt",
                    workerWaitDetail = "native_wait_history",
                    debugEmitter = comfyDebugEmitter,
                ),
            )
        return ComfyRunResult(
            imageUrls = result.imageUrls,
            seed = result.seed,
            model = result.model,
        )
    }

    private fun shouldForwardComfyDebugEvent(stage: String, details: JSONObject): Boolean {
        if (stage.startsWith("localize_", ignoreCase = true)) {
            return true
        }
        if (stage.startsWith("http_", ignoreCase = true)) {
            val traceLabel = details.optString("traceLabel", "")
            return traceLabel.startsWith("localize_", ignoreCase = true)
        }
        return false
    }

    private fun comfyDebugLevelForStage(stage: String): String {
        val normalized = stage.lowercase(Locale.ROOT)
        return when {
            normalized.contains("exception") ||
                normalized.contains("failed") ||
                normalized.contains("error") -> "error"
            normalized.contains("fallback") ||
                normalized.contains("retry") -> "warn"
            else -> "info"
        }
    }

    private fun parseStringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val result = mutableListOf<String>()
        for (index in 0 until array.length()) {
            val value = array.optString(index, "").trim()
            if (value.isNotEmpty()) {
                result.add(value)
            }
        }
        return result
    }

    private fun appendImageAssets(
        repository: LocalRepository,
        imageUrls: List<String>,
        meta: JSONObject,
        createdAt: String,
    ): List<ImageAssetAppendResult> {
        val imageAssets = readStoreArray(repository, "imageAssets")
        val appended = mutableListOf<ImageAssetAppendResult>()
        val existingAssetIdByDataUrl = mutableMapOf<String, String>()
        for (index in 0 until imageAssets.length()) {
            val item = imageAssets.optJSONObject(index) ?: continue
            val assetId = item.optString("id", "").trim()
            val dataUrl = item.optString("dataUrl", "").trim()
            if (assetId.isNotEmpty() && dataUrl.isNotEmpty()) {
                existingAssetIdByDataUrl[dataUrl] = assetId
            }
        }

        var didAppend = false
        for (url in imageUrls) {
            val normalizedUrl = url.trim()
            if (normalizedUrl.isEmpty()) continue
            val existingAssetId = existingAssetIdByDataUrl[normalizedUrl]
            if (existingAssetId != null) {
                appended.add(
                    ImageAssetAppendResult(
                        id = existingAssetId,
                        ref = toImageRef(existingAssetId),
                        meta = JSONObject(meta.toString()),
                        createdAt = createdAt,
                    ),
                )
                continue
            }
            val assetId = UUID.randomUUID().toString()
            val asset =
                JSONObject().apply {
                    put("id", assetId)
                    put("dataUrl", normalizedUrl)
                    put("meta", JSONObject(meta.toString()))
                    put("createdAt", createdAt)
                }
            imageAssets.put(asset)
            existingAssetIdByDataUrl[normalizedUrl] = assetId
            appended.add(
                ImageAssetAppendResult(
                    id = assetId,
                    ref = toImageRef(assetId),
                    meta = JSONObject(meta.toString()),
                    createdAt = createdAt,
                ),
            )
            didAppend = true
        }
        if (didAppend) {
            repository.writeStoreJson("imageAssets", imageAssets.toString())
        }
        return appended
    }

    private fun migrateSessionInlineImageRefs(
        repository: LocalRepository,
        session: JSONObject,
    ): List<String> {
        val entries = session.optJSONArray("entries") ?: return emptyList()
        if (entries.length() == 0) return emptyList()

        val ensuredAssetsByDataUrl = mutableMapOf<String, ImageAssetAppendResult>()
        val migratedAssetIds = linkedSetOf<String>()
        var didChange = false

        fun ensureInlineDataUrlRef(
            rawDataUrl: String,
            meta: JSONObject?,
            createdAt: String,
        ): ImageAssetAppendResult? {
            val normalizedDataUrl = rawDataUrl.trim()
            if (!isInlineDataUrl(normalizedDataUrl)) return null
            val cached = ensuredAssetsByDataUrl[normalizedDataUrl]
            if (cached != null) return cached
            val normalizedMeta = meta?.let { value -> JSONObject(value.toString()) } ?: JSONObject()
            val appended =
                appendImageAssets(
                    repository = repository,
                    imageUrls = listOf(normalizedDataUrl),
                    meta = normalizedMeta,
                    createdAt = createdAt,
                ).firstOrNull() ?: return null
            ensuredAssetsByDataUrl[normalizedDataUrl] = appended
            return appended
        }

        for (entryIndex in 0 until entries.length()) {
            val entry = entries.optJSONObject(entryIndex) ?: continue
            val createdAt = entry.optString("createdAt", "").trim().ifBlank { nowIsoUtc() }
            val imageMetaByUrl = entry.optJSONObject("imageMetaByUrl")
            val imageUrls = entry.optJSONArray("imageUrls") ?: JSONArray()

            var entryChanged = false
            val migratedImageUrls = JSONArray()
            for (urlIndex in 0 until imageUrls.length()) {
                val rawUrl = imageUrls.optString(urlIndex, "").trim()
                if (rawUrl.isEmpty()) continue
                if (!isInlineDataUrl(rawUrl)) {
                    migratedImageUrls.put(rawUrl)
                    continue
                }
                val metaForUrl = imageMetaByUrl?.optJSONObject(rawUrl)
                val ensured = ensureInlineDataUrlRef(rawUrl, metaForUrl, createdAt)
                if (ensured == null) {
                    migratedImageUrls.put(rawUrl)
                    continue
                }
                migratedImageUrls.put(ensured.ref)
                migratedAssetIds.add(ensured.id)
                if (ensured.ref != rawUrl) {
                    entryChanged = true
                }
            }
            if (entryChanged) {
                entry.put("imageUrls", migratedImageUrls)
            }

            if (imageMetaByUrl != null && imageMetaByUrl.length() > 0) {
                val migratedMetaByUrl = JSONObject()
                var metaChanged = false
                val keys = imageMetaByUrl.keys()
                while (keys.hasNext()) {
                    val key = keys.next().trim()
                    if (key.isEmpty()) continue
                    val value = imageMetaByUrl.opt(key)
                    var targetKey = key
                    if (isInlineDataUrl(key)) {
                        val ensured = ensureInlineDataUrlRef(key, value as? JSONObject, createdAt)
                        if (ensured != null) {
                            targetKey = ensured.ref
                            migratedAssetIds.add(ensured.id)
                        }
                    }
                    if (targetKey != key) {
                        metaChanged = true
                    }
                    if (!migratedMetaByUrl.has(targetKey)) {
                        migratedMetaByUrl.put(targetKey, value)
                    }
                }
                if (metaChanged) {
                    entry.put("imageMetaByUrl", migratedMetaByUrl)
                    entryChanged = true
                }
            }

            if (entryChanged) {
                entries.put(entryIndex, entry)
                didChange = true
            }
        }

        if (didChange) {
            session.put("entries", entries)
        }
        return migratedAssetIds.toList()
    }

    @JvmStatic
    fun isImageRef(value: String?): Boolean {
        val normalized = value?.trim().orEmpty()
        return normalized.startsWith(IMAGE_REF_PREFIX) && normalized.length > IMAGE_REF_PREFIX.length
    }

    @JvmStatic
    fun parseImageRefAssetId(value: String?): String {
        val normalized = value?.trim().orEmpty()
        if (!isImageRef(normalized)) return ""
        return normalized.removePrefix(IMAGE_REF_PREFIX).trim()
    }

    @JvmStatic
    fun toImageRef(assetId: String): String {
        return "$IMAGE_REF_PREFIX${assetId.trim()}"
    }

    @JvmStatic
    fun isInlineDataUrl(value: String?): Boolean {
        return value?.trim()?.startsWith("data:", ignoreCase = true) == true
    }

    @JvmStatic
    fun maybeRunImageAssetGc(repository: LocalRepository) {
        val nowMs = System.currentTimeMillis()
        val lastRunMs = repository.readLongMarker(IMAGE_ASSET_GC_LAST_RUN_MARKER_KEY, 0L)
        if (nowMs - lastRunMs < IMAGE_ASSET_GC_INTERVAL_MS) return
        val imageAssets = readStoreArray(repository, "imageAssets")
        if (imageAssets.length() == 0) {
            repository.writeLongMarker(IMAGE_ASSET_GC_LAST_RUN_MARKER_KEY, nowMs)
            return
        }
        val referencedAssetIds = mutableSetOf<String>()
        val storesToScan =
            listOf("personas", "messages", "generatorSessions", "groupMessages", "groupEvents")
        for (storeName in storesToScan) {
            collectImageAssetIdsFromValue(readStoreArray(repository, storeName), referencedAssetIds)
        }
        if (referencedAssetIds.isEmpty()) {
            repository.writeLongMarker(IMAGE_ASSET_GC_LAST_RUN_MARKER_KEY, nowMs)
            return
        }
        val filtered = JSONArray()
        var removedCount = 0
        for (index in 0 until imageAssets.length()) {
            val item = imageAssets.optJSONObject(index) ?: continue
            val assetId = item.optString("id", "").trim()
            if (assetId.isNotEmpty() && !referencedAssetIds.contains(assetId)) {
                removedCount += 1
                continue
            }
            filtered.put(item)
        }
        if (removedCount > 0) {
            repository.writeStoreJson("imageAssets", filtered.toString())
        }
        repository.writeLongMarker(IMAGE_ASSET_GC_LAST_RUN_MARKER_KEY, nowMs)
    }

    private fun collectImageAssetIdsFromValue(value: Any?, out: MutableSet<String>) {
        when (value) {
            is JSONArray -> {
                for (index in 0 until value.length()) {
                    collectImageAssetIdsFromValue(value.opt(index), out)
                }
            }
            is JSONObject -> {
                val keys = value.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val raw = value.opt(key)
                    if (key == "imageId") {
                        val directId = (raw as? String)?.trim().orEmpty()
                        if (directId.isNotEmpty()) {
                            out.add(directId)
                        }
                    }
                    collectImageAssetIdsFromValue(raw, out)
                }
            }
            is String -> {
                val assetId = parseImageRefAssetId(value)
                if (assetId.isNotEmpty()) {
                    out.add(assetId)
                }
            }
        }
    }

    private fun markSessionError(sessions: JSONArray, index: Int, message: String) {
        val session = sessions.optJSONObject(index) ?: return
        session.put("status", "error")
        session.put("updatedAt", nowIsoUtc())
        session.put("lastError", message)
        sessions.put(index, session)
    }

    private fun resolveRequestedCount(session: JSONObject): Int? {
        if (session.optBoolean("isInfinite", false)) return null
        val raw = session.opt("requestedCount")
        val value = when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull()
            else -> null
        } ?: return null
        if (value <= 0) return null
        return value
    }

    private fun findRunningSession(sessions: JSONArray): JSONObject? {
        for (index in 0 until sessions.length()) {
            val session = sessions.optJSONObject(index) ?: continue
            if (session.optString("status", "").equals("running", ignoreCase = true)) {
                return session
            }
        }
        return null
    }

    private fun findObjectById(items: JSONArray, id: String): JSONObject? {
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.optString("id", "").trim() == id) {
                return item
            }
        }
        return null
    }

    private fun findObjectIndexById(items: JSONArray, id: String): Int {
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.optString("id", "").trim() == id) {
                return index
            }
        }
        return -1
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

    private fun parseSessionIdFromJobId(jobId: String): String {
        if (jobId.startsWith(TOPIC_GENERATION_JOB_PREFIX)) {
            return jobId.removePrefix(TOPIC_GENERATION_JOB_PREFIX).trim()
        }
        return ""
    }

    private fun buildFallbackPrompt(session: JSONObject, persona: JSONObject, iteration: Int): String {
        val parts = mutableListOf<String>()
        parts.add("masterpiece")
        parts.add("best quality")
        parts.add("high detail")
        parts.add("solo")
        parts.add("one person")

        val topic = session.optString("topic", "").trim()
        if (topic.isNotEmpty()) {
            parts.add(topic)
        }

        val personaName = persona.optString("name", "").trim()
        if (personaName.isNotEmpty()) {
            parts.add("character ${personaName.lowercase(Locale.ROOT)}")
        }

        val stylePrompt = persona.optString("stylePrompt", "").trim()
        if (stylePrompt.isNotEmpty()) {
            parts.add(stylePrompt)
        }

        val personalityPrompt = persona.optString("personalityPrompt", "").trim()
        if (personalityPrompt.isNotEmpty()) {
            parts.add(personalityPrompt.take(180))
        }

        val appearance = persona.optJSONObject("appearance")
        if (appearance != null) {
            val appearanceTokens = mutableListOf<String>()
            collectAppearanceTokens(appearance, appearanceTokens)
            appearanceTokens
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .take(10)
                .forEach { parts.add(it) }
        }

        parts.add("variation ${max(1, iteration)}")
        return parts
            .joinToString(", ")
            .replace("\n", " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    private fun resolveTopicPrompt(
        runtimeRepository: BackgroundRuntimeRepository,
        session: JSONObject,
        persona: JSONObject,
        settings: JSONObject,
        iteration: Int,
        scopeId: String,
        jobId: String?,
        requestedCount: Int?,
        singleRunRequested: Boolean,
    ): TopicPromptQueueResolution {
        val fallback = buildFallbackPrompt(session, persona, iteration)
        val topic = session.optString("topic", "").trim()
        val promptMode = resolvePromptMode(session)
        if (promptMode == "direct_prompt") {
            if (topic.isBlank()) {
                appendRuntimeEvent(
                    runtimeRepository = runtimeRepository,
                    scopeId = scopeId,
                    jobId = jobId,
                    stage = "topic_prompt_fallback",
                    level = "warn",
                    message = "Direct prompt is empty, fallback prompt applied",
                    details =
                        JSONObject().apply {
                            put("reason", "direct_prompt_missing")
                        },
                )
                return TopicPromptQueueResolution(
                    promptResolution =
                        TopicPromptResolution(
                            prompt = fallback,
                            source = "fallback",
                            themeTags = emptyList(),
                        ),
                    nextThemePromptQueue = emptyList(),
                )
            }
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = scopeId,
                jobId = jobId,
                stage = "topic_prompt_direct",
                level = "info",
                message = "Direct prompt mode applied without LLM",
                details = JSONObject().apply {
                    put("source", "session.topic")
                },
            )
            return TopicPromptQueueResolution(
                promptResolution =
                    TopicPromptResolution(
                        prompt = topic,
                        source = "direct",
                        themeTags = emptyList(),
                    ),
                nextThemePromptQueue = emptyList(),
            )
        }
        if (topic.isBlank()) {
            appendRuntimeEvent(
                runtimeRepository = runtimeRepository,
                scopeId = scopeId,
                jobId = jobId,
                stage = "topic_prompt_fallback",
                level = "warn",
                message = "Topic is empty, fallback prompt applied",
                details =
                    JSONObject().apply {
                        put("reason", "topic_missing")
                    },
            )
            throw IllegalStateException("topic_missing")
        }

        val queue = resolveThemePromptQueue(session).toMutableList()
        val remainingIterations = requestedCount?.let { count -> max(1, count - session.optInt("completedCount", 0)) }
        val refillTargetSize = if (singleRunRequested) 1 else THEMED_PROMPT_BATCH_SIZE

        var refillThemeTags = emptyList<String>()
        if (queue.size <= THEMED_PROMPT_REFILL_THRESHOLD) {
            val desiredQueueSize =
                if (remainingIterations == null) {
                    refillTargetSize
                } else {
                    minOf(refillTargetSize, remainingIterations)
                }
            val refillCount = max(0, desiredQueueSize - queue.size)
            if (refillCount > 0) {
                try {
                    val result =
                        NativeLlmClient.generateThemedComfyPromptsForTopic(
                        settings = settings,
                        persona = persona,
                        topic = topic,
                        iteration = iteration,
                        promptCount = refillCount,
                    )
                    val prompts =
                        result?.prompts
                            ?.map { it.trim() }
                            ?.filter { it.isNotEmpty() }
                            .orEmpty()
                    if (prompts.isEmpty()) {
                        throw IllegalStateException("empty_llm_prompt_batch")
                    }
                    refillThemeTags =
                        result?.themeTags
                            ?.map { it.trim() }
                            ?.filter { it.isNotEmpty() }
                            .orEmpty()
                    queue.addAll(prompts)
                    appendRuntimeEvent(
                        runtimeRepository = runtimeRepository,
                        scopeId = scopeId,
                        jobId = jobId,
                        stage = "topic_prompt_refilled",
                        level = "info",
                        message = "Native LLM themed prompt batch generated",
                        details =
                            JSONObject().apply {
                                put("addedCount", prompts.size)
                                put("queueSize", queue.size)
                            },
                    )
                } catch (error: Exception) {
                    if (queue.isNotEmpty()) {
                        appendRuntimeEvent(
                            runtimeRepository = runtimeRepository,
                            scopeId = scopeId,
                            jobId = jobId,
                            stage = "topic_prompt_refill_failed_queue_used",
                            level = "warn",
                            message = "Native LLM themed prompt refill failed, using queued prompt",
                            details =
                                JSONObject().apply {
                                    put("queueSize", queue.size)
                                    put("error", error.message?.trim().orEmpty())
                                },
                        )
                    } else {
                        appendRuntimeEvent(
                            runtimeRepository = runtimeRepository,
                            scopeId = scopeId,
                            jobId = jobId,
                            stage = "topic_prompt_refill_failed",
                            level = "error",
                            message = "Native LLM themed prompt refill failed",
                            details =
                                JSONObject().apply {
                                    put("error", error.message?.trim().orEmpty())
                                },
                        )
                        throw error
                    }
                }
            }
        }

        if (queue.isEmpty()) {
            throw IllegalStateException("empty_llm_prompt_batch")
        }
        val prompt = queue.removeAt(0).trim()
        if (prompt.isBlank()) {
            throw IllegalStateException("empty_llm_prompt_batch")
        }

        appendRuntimeEvent(
            runtimeRepository = runtimeRepository,
            scopeId = scopeId,
            jobId = jobId,
            stage = "topic_prompt_llm_queue",
            level = "info",
            message = "Topic prompt dequeued from themed prompt queue",
            details =
                JSONObject().apply {
                    put("queueSizeAfterDequeue", queue.size)
                },
        )
        return TopicPromptQueueResolution(
            promptResolution =
                TopicPromptResolution(
                    prompt = prompt,
                    source = "llm_queue",
                    themeTags = refillThemeTags,
                ),
            nextThemePromptQueue = queue,
        )
    }

    private fun collectAppearanceTokens(node: JSONObject, out: MutableList<String>) {
        val keys = node.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = node.opt(key)
            when (value) {
                is String -> {
                    val normalized = value.trim()
                    if (normalized.isNotEmpty()) out.add(normalized)
                }
                is JSONObject -> collectAppearanceTokens(value, out)
                is JSONArray -> {
                    for (index in 0 until value.length()) {
                        val item = value.opt(index)
                        if (item is String && item.trim().isNotEmpty()) out.add(item.trim())
                    }
                }
            }
        }
    }

    private fun stableSeedFromText(input: String): Long {
        var hash = 1125899906842597L
        for (char in input) {
            hash = 31L * hash + char.code.toLong()
        }
        val positive =
            when {
                hash >= 0L -> hash
                hash == Long.MIN_VALUE -> Long.MAX_VALUE
                else -> -hash
            }
        val normalized = positive % COMFY_SEED_MAX
        return if (normalized == 0L) 1L else normalized
    }

    private fun resolvePromptMode(session: JSONObject): String {
        return if (session.optString("promptMode", "").trim() == "direct_prompt") {
            "direct_prompt"
        } else {
            "theme_llm"
        }
    }

    private fun resolveDirectPromptSeed(session: JSONObject): Long? {
        val raw = session.opt("directPromptSeed")
        val parsed =
            when (raw) {
                is Number -> raw.toLong()
                is String -> raw.trim().toLongOrNull()
                else -> null
            } ?: return null
        if (parsed <= 0L) return null
        return if (parsed > COMFY_SEED_MAX) COMFY_SEED_MAX else parsed
    }

    private fun resolveThemePromptQueue(session: JSONObject): List<String> {
        val raw = session.optJSONArray("themePromptQueue") ?: return emptyList()
        val prompts = mutableListOf<String>()
        for (index in 0 until raw.length()) {
            val prompt = raw.optString(index, "").trim()
            if (prompt.isNotEmpty()) {
                prompts.add(prompt)
            }
        }
        return prompts
    }

    private fun randomComfySeed(): Long {
        return ThreadLocalRandom.current().nextLong(1L, COMFY_SEED_MAX + 1L)
    }

    private fun parseJsonObject(raw: String?): JSONObject {
        if (raw.isNullOrBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun nowIsoUtc(): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        return formatter.format(Date())
    }

    private fun syncDesiredState(
        runtimeRepository: BackgroundRuntimeRepository,
        sessionId: String,
        enabled: Boolean,
        delayMs: Long,
    ) {
        if (sessionId.isBlank()) return
        if (enabled) {
            clearCancellation(sessionId)
        } else {
            requestCancellation(sessionId)
        }
        runtimeRepository.upsertDesiredState(
            taskType = TOPIC_GENERATION_JOB_TYPE,
            scopeId = sessionId.trim(),
            enabled = enabled,
            payloadJson =
                JSONObject().apply {
                    put("sessionId", sessionId.trim())
                    put("delayMs", max(0L, delayMs))
                }.toString(),
        )
    }

    private fun isDesiredStateEnabled(
        runtimeRepository: BackgroundRuntimeRepository,
        sessionId: String,
    ): Boolean {
        if (sessionId.isBlank()) return false
        val record =
            runtimeRepository.getDesiredState(
                taskType = TOPIC_GENERATION_JOB_TYPE,
                scopeId = sessionId.trim(),
            )
        return record?.enabled ?: true
    }

    private fun isScopeCancellationRequested(scopeId: String): Boolean {
        val normalized = scopeId.trim()
        if (normalized.isEmpty()) return false
        return cancelledScopes.contains(normalized)
    }

    private fun buildGeneratorSessionPatch(
        session: JSONObject,
        appendedEntries: JSONArray? = null,
    ): JSONObject {
        return JSONObject().apply {
            put("id", session.optString("id", "").trim())
            put("status", session.optString("status", "stopped"))
            put("completedCount", session.optInt("completedCount", 0))
            put("updatedAt", session.optString("updatedAt", nowIsoUtc()))
            val lastError = session.optString("lastError", "").trim()
            if (lastError.isNotEmpty()) {
                put("lastError", lastError)
            } else {
                put("lastError", "")
            }
            put("promptMode", resolvePromptMode(session))
            val directPromptSeed = resolveDirectPromptSeed(session)
            if (directPromptSeed == null) {
                put("directPromptSeed", JSONObject.NULL)
            } else {
                put("directPromptSeed", directPromptSeed)
            }
            put("directPromptSeedArmed", session.optBoolean("directPromptSeedArmed", false))
            put("singleRunRequested", session.optBoolean("singleRunRequested", false))
            put("themePromptQueue", JSONArray(resolveThemePromptQueue(session)))
            if (appendedEntries != null && appendedEntries.length() > 0) {
                put("appendEntries", appendedEntries)
            }
        }
    }

    private fun appendStatePatch(
        runtimeRepository: BackgroundRuntimeRepository,
        scopeId: String,
        jobId: String?,
        stores: JSONObject,
        assetIds: List<String> = emptyList(),
    ) {
        val normalizedScopeId = scopeId.ifBlank { BackgroundRuntimeRepository.GLOBAL_SCOPE_ID }
        val normalizedAssetIds =
            assetIds.map { id -> id.trim() }.filter { id -> id.isNotEmpty() }.distinct()
        runtimeRepository.appendDelta(
            taskType = TOPIC_GENERATION_JOB_TYPE,
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
                                put("source", TOPIC_GENERATION_JOB_TYPE)
                            },
                        )
                    }
                }.toString(),
        )
    }

    private fun appendRuntimeEvent(
        runtimeRepository: BackgroundRuntimeRepository,
        scopeId: String,
        jobId: String?,
        stage: String,
        level: String,
        message: String,
        details: JSONObject? = null,
    ) {
        val normalizedScopeId = scopeId.ifBlank { "unknown" }
        runtimeRepository.appendEvent(
            taskType = TOPIC_GENERATION_JOB_TYPE,
            scopeId = normalizedScopeId,
            jobId = jobId,
            stage = stage,
            level = level,
            message = message,
            detailsJson = details?.toString(),
        )
        runtimeRepository.appendDelta(
            taskType = TOPIC_GENERATION_JOB_TYPE,
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

