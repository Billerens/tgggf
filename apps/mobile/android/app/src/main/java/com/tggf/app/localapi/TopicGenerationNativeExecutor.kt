package com.tggf.app.localapi

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
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
    private const val COMFY_DEFAULT_BASE_URL = "http://127.0.0.1:8188"
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L
    private const val COMFY_TEMPLATE_PATH_PRIMARY = "public/comfy_api.json"
    private const val COMFY_TEMPLATE_PATH_FALLBACK = "comfy_api.json"
    private const val COMFY_PROMPT_NODE_ID = "1050"
    private const val COMFY_SEED_NODE_ID = "137"
    private const val COMFY_HIRES_NODE_ID = "849"
    private const val COMFY_SIZE_NODE_ID = "141"
    private const val COMFY_HISTORY_TIMEOUT_MS = 600_000L
    private const val COMFY_HISTORY_POLL_INTERVAL_MS = 1_200L
    private const val COMFY_WEBP_QUALITY = 82
    private val BASE_OUTPUT_TITLE_PREFERENCES =
        listOf(
            "Preview after Detailing",
            "Preview after Inpaint",
        )

    private val inFlight = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-topic-native").apply {
            isDaemon = true
        }
    }
    private val templateLock = Any()

    @Volatile
    private var baseWorkflowTemplateJson: String? = null

    private data class HttpResult(
        val code: Int,
        val body: String,
    )

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
        seedKey: String,
        scopeId: String,
    ): ComfyRunResult {
        val seed = stableSeedFromText(seedKey)
        return runComfyGenerationInternal(
            context = context,
            worker = ForegroundSyncService.WORKER_GROUP_ITERATION,
            workerScopeId = scopeId.ifBlank { "group" },
            workerQueueDetail = "native_queue_image_prompt",
            workerWaitDetail = "native_wait_image_history",
            settings = settings,
            prompt = prompt,
            seed = seed,
            checkpointName = checkpointName?.trim().orEmpty().ifEmpty { null },
            preferredTitleIncludes = emptyList(),
            strictPreferredMatch = false,
            pickLatestImageOnly = false,
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
        return runComfyGenerationInternal(
            context = context,
            worker = ForegroundSyncService.WORKER_TOPIC_GENERATION,
            workerScopeId = sessionId,
            workerQueueDetail = "native_queue_prompt",
            workerWaitDetail = "native_wait_history",
            settings = settings,
            prompt = prompt,
            seed = seed,
            checkpointName = checkpointName.ifEmpty { null },
            preferredTitleIncludes = parseStringList(session.optJSONArray("outputNodeTitleIncludes")),
            strictPreferredMatch = session.optBoolean("strictOutputNodeMatch", false),
            pickLatestImageOnly = session.optBoolean("pickLatestImageOnly", false),
        )
    }

    private fun runComfyGenerationInternal(
        context: Context,
        worker: String?,
        workerScopeId: String,
        workerQueueDetail: String?,
        workerWaitDetail: String?,
        settings: JSONObject,
        prompt: String,
        seed: Long,
        checkpointName: String?,
        preferredTitleIncludes: List<String>,
        strictPreferredMatch: Boolean,
        pickLatestImageOnly: Boolean,
    ): ComfyRunResult {
        val baseUrl =
            normalizeBaseUrl(
                settings.optString("comfyBaseUrl", COMFY_DEFAULT_BASE_URL).ifBlank {
                    COMFY_DEFAULT_BASE_URL
                },
            )
        val auth = settings.optJSONObject("comfyAuth")
        val workflowTemplate = loadBaseWorkflowTemplate(context)
        val workflow = JSONObject(workflowTemplate)

        val promptNode =
            workflow.optJSONObject(COMFY_PROMPT_NODE_ID)
                ?.optJSONObject("inputs")
                ?: throw IllegalStateException("Comfy workflow missing positive prompt node")
        promptNode.put("text", prompt)
        workflow.optJSONObject(COMFY_SEED_NODE_ID)?.optJSONObject("inputs")?.put("seed", seed)

        workflow.optJSONObject(COMFY_SIZE_NODE_ID)?.optJSONObject("inputs")?.let { sizeInputs ->
            if (!sizeInputs.has("Xi")) sizeInputs.put("Xi", 1024)
            if (!sizeInputs.has("Xf")) sizeInputs.put("Xf", 1024)
            if (!sizeInputs.has("Yi")) sizeInputs.put("Yi", 1536)
            if (!sizeInputs.has("Yf")) sizeInputs.put("Yf", 1536)
        }

        workflow.optJSONObject(COMFY_HIRES_NODE_ID)?.optJSONObject("inputs")?.put("toggle", false)
        if (!checkpointName.isNullOrBlank()) {
            setCheckpointName(workflow, checkpointName)
        }

        sanitizeWorkflowForApi(workflow)
        if (!settings.optBoolean("saveComfyOutputs", false)) {
            stripImageSaverNodes(workflow)
        }

        if (!worker.isNullOrBlank() && !workerQueueDetail.isNullOrBlank()) {
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = worker,
                state = "running",
                scopeId = workerScopeId,
                detail = workerQueueDetail,
                progress = false,
                claimed = true,
                lastError = "",
            )
        }

        val queued = queuePrompt(baseUrl, workflow, auth)
        val promptId = queued.optString("prompt_id", "").trim()
        if (promptId.isEmpty()) {
            throw IllegalStateException("Comfy /prompt did not return prompt_id")
        }

        val historyEntry =
            waitForHistory(
                context = context,
                worker = worker,
                scopeId = workerScopeId,
                workerWaitDetail = workerWaitDetail,
                baseUrl = baseUrl,
                promptId = promptId,
                auth = auth,
            )
        val urls =
            collectImageUrls(
                baseUrl = baseUrl,
                workflow = workflow,
                historyEntry = historyEntry,
                outputTitlePreferences = BASE_OUTPUT_TITLE_PREFERENCES,
                preferredTitleIncludes = preferredTitleIncludes,
                strictPreferredMatch = strictPreferredMatch,
                pickLatestImageOnly = pickLatestImageOnly,
            )
        return ComfyRunResult(
            imageUrls = urls,
            seed = seed,
            model = checkpointName,
        )
    }

    private fun queuePrompt(baseUrl: String, workflow: JSONObject, auth: JSONObject?): JSONObject {
        val uiWorkflow = buildUiWorkflowForExtraPngInfo(workflow)
        val payload = JSONObject().apply {
            put("client_id", UUID.randomUUID().toString())
            put("prompt", workflow)
            put(
                "extra_data",
                JSONObject().put(
                    "extra_pnginfo",
                    JSONObject().put("workflow", uiWorkflow),
                ),
            )
        }
        val response = requestJson(
            url = "$baseUrl/prompt",
            method = "POST",
            payload = payload.toString(),
            auth = auth,
            connectTimeoutMs = 15_000,
            readTimeoutMs = 120_000,
        )
        if (response.code !in 200..299) {
            throw IllegalStateException("Comfy /prompt error (${response.code}): ${response.body}")
        }
        return parseJsonObject(response.body)
    }

    private fun buildUiWorkflowForExtraPngInfo(workflow: JSONObject): JSONObject {
        val nodes = JSONArray()
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val nodeId = keys.next()
            val node = workflow.optJSONObject(nodeId) ?: continue
            val entry =
                JSONObject().apply {
                    put("id", nodeId)
                    put("type", node.optString("class_type", ""))
                    val title = node.optJSONObject("_meta")?.optString("title", "")
                    if (!title.isNullOrBlank()) {
                        put("title", title)
                    }
                    // Matches web behavior for Impact Pack wildcard hooks.
                    put(
                        "widgets_values",
                        JSONArray().apply {
                            put(JSONObject.NULL)
                            put(JSONObject.NULL)
                            put(JSONObject.NULL)
                        },
                    )
                }
            nodes.put(entry)
        }
        return JSONObject().put("nodes", nodes)
    }

    private fun waitForHistory(
        context: Context,
        worker: String?,
        scopeId: String,
        workerWaitDetail: String?,
        baseUrl: String,
        promptId: String,
        auth: JSONObject?,
    ): JSONObject {
        val deadline = System.currentTimeMillis() + COMFY_HISTORY_TIMEOUT_MS
        while (System.currentTimeMillis() <= deadline) {
            if (!worker.isNullOrBlank() && !workerWaitDetail.isNullOrBlank()) {
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = worker,
                    state = "running",
                    scopeId = scopeId,
                    detail = workerWaitDetail,
                    progress = false,
                    claimed = true,
                    lastError = "",
                )
            }
            val response =
                try {
                    requestJson(
                        url = "$baseUrl/history/${urlEncode(promptId)}",
                        method = "GET",
                        payload = null,
                        auth = auth,
                        connectTimeoutMs = 10_000,
                        readTimeoutMs = 120_000,
                    )
                } catch (error: Exception) {
                    if (isTransientComfyNetworkError(error)) {
                        if (!worker.isNullOrBlank()) {
                            ForegroundSyncService.updateWorkerStatus(
                                context = context,
                                worker = worker,
                                state = "running",
                                scopeId = scopeId,
                                detail = "native_wait_history_retry",
                                progress = false,
                                claimed = true,
                                lastError = error.message ?: "history_request_retry",
                            )
                        }
                        Thread.sleep(COMFY_HISTORY_POLL_INTERVAL_MS)
                        continue
                    }
                    throw IllegalStateException(
                        "Comfy history request failed for prompt_id=$promptId: ${error.message ?: "request_failed"}",
                        error,
                    )
                }
            if (response.code in 200..299) {
                val payload = parseJsonObject(response.body)
                val entry = payload.optJSONObject(promptId)
                val outputs = entry?.optJSONObject("outputs")
                if (outputs != null && outputs.length() > 0) {
                    return entry
                }
            }
            Thread.sleep(COMFY_HISTORY_POLL_INTERVAL_MS)
        }
        throw IllegalStateException("Comfy history timeout for prompt_id=$promptId")
    }

    private fun isTransientComfyNetworkError(error: Exception): Boolean {
        if (error is SocketTimeoutException) return true
        if (error is SocketException) return true
        if (error is IOException) {
            val normalizedMessage = error.message?.lowercase(Locale.ROOT).orEmpty()
            if (
                normalizedMessage.contains("connection reset") ||
                    normalizedMessage.contains("connection aborted") ||
                    normalizedMessage.contains("broken pipe") ||
                    normalizedMessage.contains("socket closed") ||
                    normalizedMessage.contains("timed out") ||
                    normalizedMessage.contains("eof")
            ) {
                return true
            }
        }
        return false
    }

    private fun collectImageUrls(
        baseUrl: String,
        workflow: JSONObject,
        historyEntry: JSONObject,
        outputTitlePreferences: List<String>,
        preferredTitleIncludes: List<String>,
        strictPreferredMatch: Boolean,
        pickLatestImageOnly: Boolean,
    ): List<String> {
        val outputs = historyEntry.optJSONObject("outputs") ?: return emptyList()
        val nodeGroups = resolveOutputNodeGroups(workflow, outputTitlePreferences)
        val preferredNodes = resolvePreferredOutputNodes(workflow, preferredTitleIncludes)
        val preferredImages = collectImagesForNodes(outputs, preferredNodes)
        val saverImages = collectImagesForNodes(outputs, nodeGroups.saver)
        val previewImages = collectImagesForNodes(outputs, nodeGroups.preview)
        val fallbackImages = collectAllImages(outputs)
        val hasAnyImages =
            preferredImages.isNotEmpty() ||
                previewImages.isNotEmpty() ||
                saverImages.isNotEmpty() ||
                fallbackImages.isNotEmpty()

        val images =
            when {
                preferredImages.isNotEmpty() -> preferredImages
                previewImages.isNotEmpty() -> previewImages
                saverImages.isNotEmpty() -> saverImages
                else -> fallbackImages
            }

        if (strictPreferredMatch && preferredNodes.isNotEmpty() && preferredImages.isEmpty()) {
            if (!hasAnyImages) {
                throw IllegalStateException(
                    "ComfyUI: no image returned from preferred preview output node",
                )
            }
        }

        val normalizedImages =
            if (pickLatestImageOnly && images.isNotEmpty()) {
                listOf(images.last())
            } else {
                images
            }

        val urls = LinkedHashSet<String>()
        for (image in normalizedImages) {
            val filename = image.optString("filename", "").trim()
            if (filename.isEmpty()) continue
            val subfolder = image.optString("subfolder", "")
            val type = image.optString("type", "output").ifEmpty { "output" }
            val viewUrl =
                "$baseUrl/view?filename=${urlEncode(filename)}&subfolder=${urlEncode(subfolder)}&type=${urlEncode(type)}"
            urls.add(viewUrl)
        }
        return urls.toList()
    }

    private data class OutputNodeGroups(
        val saver: List<String>,
        val preview: List<String>,
    )

    private data class OutputNodeCandidate(
        val nodeId: String,
        val title: String,
    )

    private fun resolveOutputNodeGroups(
        workflow: JSONObject,
        outputTitlePreferences: List<String>,
    ): OutputNodeGroups {
        val saverNodes = mutableListOf<String>()
        val previewCandidates = mutableListOf<OutputNodeCandidate>()
        val titleTokens = outputTitlePreferences.map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }

        val keys = workflow.keys()
        while (keys.hasNext()) {
            val nodeId = keys.next()
            val node = workflow.optJSONObject(nodeId) ?: continue
            if (node.optString("class_type", "") == "Image Saver") {
                saverNodes.add(nodeId)
            }
            val title = node.optJSONObject("_meta")?.optString("title", "")?.trim()?.lowercase(Locale.ROOT) ?: ""
            if (title.isEmpty()) continue
            if (titleTokens.any { token -> title.contains(token) }) {
                previewCandidates.add(OutputNodeCandidate(nodeId, title))
            }
        }

        val preview = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (token in titleTokens) {
            for (candidate in previewCandidates) {
                if (!candidate.title.contains(token)) continue
                if (!seen.add(candidate.nodeId)) continue
                preview.add(candidate.nodeId)
            }
        }

        return OutputNodeGroups(saver = saverNodes, preview = preview)
    }

    private fun resolvePreferredOutputNodes(
        workflow: JSONObject,
        preferredTitleIncludes: List<String>,
    ): List<String> {
        if (preferredTitleIncludes.isEmpty()) return emptyList()
        val tokens =
            preferredTitleIncludes
                .map { it.trim().lowercase(Locale.ROOT) }
                .filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return emptyList()

        val candidates = mutableListOf<OutputNodeCandidate>()
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val nodeId = keys.next()
            val node = workflow.optJSONObject(nodeId) ?: continue
            val title = node.optJSONObject("_meta")?.optString("title", "")?.trim()?.lowercase(Locale.ROOT) ?: ""
            if (title.isEmpty()) continue
            if (tokens.any { token -> title.contains(token) }) {
                candidates.add(OutputNodeCandidate(nodeId, title))
            }
        }

        val preferred = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (token in tokens) {
            for (candidate in candidates) {
                if (!candidate.title.contains(token)) continue
                if (!seen.add(candidate.nodeId)) continue
                preferred.add(candidate.nodeId)
            }
        }
        return preferred
    }

    private fun collectImagesForNodes(outputs: JSONObject, nodeIds: List<String>): List<JSONObject> {
        val images = mutableListOf<JSONObject>()
        for (nodeId in nodeIds) {
            val nodeOutput = outputs.optJSONObject(nodeId) ?: continue
            val nodeImages = nodeOutput.optJSONArray("images") ?: continue
            for (index in 0 until nodeImages.length()) {
                val image = nodeImages.optJSONObject(index) ?: continue
                images.add(image)
            }
        }
        return images
    }

    private fun collectAllImages(outputs: JSONObject): List<JSONObject> {
        val images = mutableListOf<JSONObject>()
        val outputKeys = outputs.keys()
        while (outputKeys.hasNext()) {
            val outputKey = outputKeys.next()
            val output = outputs.optJSONObject(outputKey) ?: continue
            val outputImages = output.optJSONArray("images") ?: continue
            for (index in 0 until outputImages.length()) {
                val image = outputImages.optJSONObject(index) ?: continue
                images.add(image)
            }
        }
        return images
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

    private fun resolveCheckpointName(workflow: JSONObject): String {
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val node = workflow.optJSONObject(key) ?: continue
            val inputs = node.optJSONObject("inputs") ?: continue
            val checkpointName = inputs.optString("ckpt_name", "").trim()
            if (checkpointName.isNotEmpty()) {
                return checkpointName
            }
        }
        return "api-model"
    }

    private fun sanitizeWorkflowForApi(workflow: JSONObject) {
        val checkpointName = resolveCheckpointName(workflow)
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val node = workflow.optJSONObject(key) ?: continue
            if (node.optString("class_type", "") != "Image Saver") continue
            val inputs = node.optJSONObject("inputs") ?: continue
            val modelname = inputs.opt("modelname")
            val dependsOnWidgetToString =
                modelname is JSONArray &&
                    modelname.length() >= 1 &&
                    modelname.opt(0)?.toString() == "282"
            if (dependsOnWidgetToString) {
                inputs.put("modelname", checkpointName)
            }
            inputs.put("extension", "webp")
            inputs.put("lossless_webp", false)
            inputs.put("quality_jpeg_or_webp", COMFY_WEBP_QUALITY)
        }
    }

    private fun stripImageSaverNodes(workflow: JSONObject) {
        val toRemove = mutableListOf<String>()
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val node = workflow.optJSONObject(key) ?: continue
            if (node.optString("class_type", "") == "Image Saver") {
                toRemove.add(key)
            }
        }
        for (key in toRemove) {
            workflow.remove(key)
        }
    }

    private fun setCheckpointName(workflow: JSONObject, checkpointName: String) {
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val node = workflow.optJSONObject(key) ?: continue
            val inputs = node.optJSONObject("inputs") ?: continue
            if (inputs.has("ckpt_name")) {
                inputs.put("ckpt_name", checkpointName)
            }
        }
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
        return kotlin.math.abs(hash)
    }

    private fun loadBaseWorkflowTemplate(context: Context): String {
        baseWorkflowTemplateJson?.let { return it }
        synchronized(templateLock) {
            baseWorkflowTemplateJson?.let { return it }
            val template =
                try {
                    context.assets.open(COMFY_TEMPLATE_PATH_PRIMARY).bufferedReader(Charsets.UTF_8).use { it.readText() }
                } catch (_: IOException) {
                    context.assets.open(COMFY_TEMPLATE_PATH_FALLBACK).bufferedReader(Charsets.UTF_8).use { it.readText() }
                }
            baseWorkflowTemplateJson = template
            return template
        }
    }

    private fun normalizeBaseUrl(baseUrl: String): String {
        var normalized = baseUrl.trim()
        while (normalized.endsWith("/")) {
            normalized = normalized.dropLast(1)
        }
        return if (normalized.isEmpty()) COMFY_DEFAULT_BASE_URL else normalized
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

    private fun requestJson(
        url: String,
        method: String,
        payload: String?,
        auth: JSONObject?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): HttpResult {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.instanceFollowRedirects = true
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.useCaches = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-store")
        connection.setRequestProperty("Pragma", "no-cache")
        // Avoid reusing stale keep-alive sockets with long history polling.
        connection.setRequestProperty("Connection", "close")
        val authHeaders = buildAuthHeaders(auth)
        for ((name, value) in authHeaders) {
            connection.setRequestProperty(name, value)
        }
        if (!payload.isNullOrBlank()) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            BufferedOutputStream(connection.outputStream).use { stream ->
                stream.write(payload.toByteArray(StandardCharsets.UTF_8))
            }
        }

        val code = connection.responseCode
        val body =
            try {
                val stream =
                    if (code in 200..299) {
                        connection.inputStream
                    } else {
                        connection.errorStream ?: connection.inputStream
                    }
                BufferedInputStream(stream).use { input ->
                    InputStreamReader(input, StandardCharsets.UTF_8).use { reader ->
                        reader.readText()
                    }
                }
            } catch (_: Exception) {
                ""
            } finally {
                connection.disconnect()
            }
        return HttpResult(code = code, body = body)
    }

    private fun buildAuthHeaders(auth: JSONObject?): Map<String, String> {
        if (auth == null) return emptyMap()
        val mode = auth.optString("mode", "none").trim().ifEmpty { "none" }
        if (mode == "none") return emptyMap()

        val headers = mutableMapOf<String, String>()
        val token = auth.optString("token", "").trim()

        when (mode) {
            "basic" -> {
                val username = auth.optString("username", "")
                val password = auth.optString("password", "")
                if (username.isNotEmpty() || password.isNotEmpty()) {
                    val encoded = Base64.encodeToString(
                        "$username:$password".toByteArray(StandardCharsets.UTF_8),
                        Base64.NO_WRAP,
                    )
                    headers["Authorization"] = "Basic $encoded"
                }
            }
            "custom" -> {
                if (token.isNotEmpty()) {
                    val headerName = auth.optString("headerName", "Authorization").trim().ifEmpty {
                        "Authorization"
                    }
                    val prefix = auth.optString("headerPrefix", "").trim()
                    headers[headerName] =
                        if (prefix.isNotEmpty()) {
                            "$prefix $token"
                        } else {
                            token
                        }
                }
            }
            "token" -> {
                if (token.isNotEmpty()) {
                    headers["Authorization"] = "Token $token"
                }
            }
            else -> {
                if (token.isNotEmpty()) {
                    headers["Authorization"] = "Bearer $token"
                }
            }
        }
        return headers
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

    private fun urlEncode(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")
    }
}
