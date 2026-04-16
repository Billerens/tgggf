package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

object TopicGenerationNativeExecutor {
    private const val TOPIC_GENERATION_JOB_TYPE = "topic_generation"
    private const val TOPIC_GENERATION_JOB_PREFIX = "topic_generation:"
    private const val TOPIC_GENERATION_LEASE_MS = 45_000L
    private const val COMFY_SEED_MAX = 1_125_899_906_842_624L
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L

    private val inFlight = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-topic-native").apply {
            isDaemon = true
        }
    }

    data class ComfyRunResult(
        val imageUrls: List<String>,
        val seed: Long,
        val model: String?,
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
        val prompt = buildFallbackPrompt(session, persona, iteration)

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
            },
        )

        try {
            val comfyResult = runBaseComfyGeneration(
                context = context,
                settings = settings,
                persona = persona,
                session = session,
                prompt = prompt,
                iteration = iteration,
            )
            if (comfyResult.imageUrls.isEmpty()) {
                throw IllegalStateException("Comfy не вернул ни одного изображения")
            }

            val nowIso = nowIsoUtc()
            val meta = JSONObject().apply {
                put("prompt", prompt)
                put("seed", comfyResult.seed)
                put("flow", "base")
                if (!comfyResult.model.isNullOrBlank()) {
                    put("model", comfyResult.model)
                }
            }
            appendImageAssets(repository, comfyResult.imageUrls, meta, nowIso)

            val entry = JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("iteration", iteration)
                put("prompt", prompt)
                put("imageUrls", JSONArray(comfyResult.imageUrls))
                put("createdAt", nowIso)
                val imageMetaByUrl = JSONObject()
                for (url in comfyResult.imageUrls) {
                    imageMetaByUrl.put(url, JSONObject(meta.toString()))
                }
                put("imageMetaByUrl", imageMetaByUrl)
            }
            val entries = session.optJSONArray("entries") ?: JSONArray()
            entries.put(entry)
            session.put("entries", entries)
            session.put("completedCount", iteration)

            val nextStatus =
                if (requestedCount != null && iteration >= requestedCount) {
                    "completed"
                } else {
                    "running"
                }
            session.put("status", nextStatus)
            session.put("updatedAt", nowIso)
            sessions.put(sessionIndex, session)
            repository.writeStoreJson("generatorSessions", sessions.toString())

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
            val errorMessage = error.message?.trim().takeUnless { it.isNullOrBlank() }
                ?: "Ошибка native topic generation"
            markSessionError(sessions, sessionIndex, errorMessage)
            repository.writeStoreJson("generatorSessions", sessions.toString())
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
                stage = "iteration_failed",
                level = "error",
                message = "Topic generation native iteration failed",
                details = JSONObject().apply {
                    put("error", errorMessage)
                },
            )
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
    ) {
        appendImageAssets(repository, imageUrls, meta, createdAt)
    }

    private fun runBaseComfyGeneration(
        context: Context,
        settings: JSONObject,
        persona: JSONObject,
        session: JSONObject,
        prompt: String,
        iteration: Int,
    ): ComfyRunResult {
        val sessionId = session.optString("id", "")
        val topic = session.optString("topic", "").trim()
        val seed = stableSeedFromText("$sessionId:$iteration:$topic")
        val checkpointName = persona.optString("imageCheckpoint", "").trim()
        val styleReferenceImage =
            persona.optString("avatarUrl", "").trim().ifEmpty {
                persona.optString("fullBodyUrl", "").trim()
            }.ifEmpty { null }
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
                ),
            )
        return ComfyRunResult(
            imageUrls = result.imageUrls,
            seed = result.seed,
            model = result.model,
        )
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
    ) {
        val imageAssets = readStoreArray(repository, "imageAssets")
        for (url in imageUrls) {
            imageAssets.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("dataUrl", url)
                    put("meta", JSONObject(meta.toString()))
                    put("createdAt", createdAt)
                },
            )
        }
        repository.writeStoreJson("imageAssets", imageAssets.toString())
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

    private fun appendRuntimeEvent(
        runtimeRepository: BackgroundRuntimeRepository,
        scopeId: String,
        jobId: String?,
        stage: String,
        level: String,
        message: String,
        details: JSONObject? = null,
    ) {
        runtimeRepository.appendEvent(
            taskType = TOPIC_GENERATION_JOB_TYPE,
            scopeId = scopeId.ifBlank { "unknown" },
            jobId = jobId,
            stage = stage,
            level = level,
            message = message,
            detailsJson = details?.toString(),
        )
    }
}

