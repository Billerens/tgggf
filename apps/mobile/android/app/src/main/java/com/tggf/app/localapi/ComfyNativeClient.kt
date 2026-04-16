package com.tggf.app.localapi

import android.content.Context
import android.util.Base64
import android.util.Log
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Native ComfyUI pipeline module aligned with web comfy.ts behavior for base generation.
 */
object ComfyNativeClient {
    private const val COMFY_DEBUG_TAG = "TgGfComfyNative"
    private const val COMFY_DEFAULT_BASE_URL = "http://127.0.0.1:8188"
    private const val COMFY_SEED_MAX = 1_125_899_906_842_624L
    private const val COMFY_TEMPLATE_PATH_PRIMARY = "public/comfy_api.json"
    private const val COMFY_TEMPLATE_PATH_FALLBACK = "comfy_api.json"
    private const val COMFY_PROMPT_NODE_ID = "1050"
    private const val COMFY_SEED_NODE_ID = "137"
    private const val COMFY_SIZE_NODE_ID = "141"
    private const val COMFY_STYLE_IMAGE_NODE_ID = "420"
    private const val COMFY_COMPOSITION_IMAGE_NODE_ID = "455"
    private const val COMFY_STYLE_STRENGTH_NODE_ID = "430"
    private const val COMFY_COMPOSITION_STRENGTH_NODE_ID = "431"
    private const val COMFY_HISTORY_TIMEOUT_MS = 600_000L
    private const val COMFY_HISTORY_POLL_INTERVAL_MS = 1_200L
    private const val COMFY_WEBP_QUALITY = 82
    private val BASE_OUTPUT_TITLE_PREFERENCES =
        listOf(
            "Preview after Detailing",
            "Preview after Inpaint",
        )

    private val httpClient = OkHttpClient()
    private val generationLock = Any()
    private val templateLock = Any()

    @Volatile
    private var baseWorkflowTemplateJson: String? = null

    private data class HttpResult(
        val code: Int,
        val body: String,
    )

    private data class BinaryHttpResult(
        val code: Int,
        val bytes: ByteArray,
        val bodyText: String,
        val contentType: String?,
    )

    private data class ReferenceImagePayload(
        val bytes: ByteArray,
        val extension: String,
        val mimeType: String,
    )

    data class BaseGenerationRequest(
        val context: Context,
        val settings: JSONObject,
        val prompt: String,
        val seed: Long,
        val checkpointName: String? = null,
        val styleReferenceImage: String? = null,
        val preferredTitleIncludes: List<String> = emptyList(),
        val strictPreferredMatch: Boolean = false,
        val pickLatestImageOnly: Boolean = false,
        val worker: String? = null,
        val workerScopeId: String = "",
        val workerQueueDetail: String? = null,
        val workerWaitDetail: String? = null,
        val debugEmitter: ((String, JSONObject) -> Unit)? = null,
    )

    data class ComfyRunResult(
        val imageUrls: List<String>,
        val seed: Long,
        val model: String?,
    )

    @JvmStatic
    fun runBaseGeneration(request: BaseGenerationRequest): ComfyRunResult {
        synchronized(generationLock) {
            return runBaseGenerationInternal(
                context = request.context.applicationContext,
                worker = request.worker,
                workerScopeId = request.workerScopeId,
                workerQueueDetail = request.workerQueueDetail,
                workerWaitDetail = request.workerWaitDetail,
                settings = request.settings,
                prompt = request.prompt,
                seed = request.seed,
                checkpointName = request.checkpointName,
                styleReferenceImage = request.styleReferenceImage,
                preferredTitleIncludes = request.preferredTitleIncludes,
                strictPreferredMatch = request.strictPreferredMatch,
                pickLatestImageOnly = request.pickLatestImageOnly,
                debugEmitter = request.debugEmitter,
            )
        }
    }

    fun stableSeedFromText(input: String): Long {
        var hash = 0L
        for (char in input) {
            hash = ((hash * 31L) + char.code.toLong()) and 0xFFFF_FFFFL
        }
        if (hash == 0L) {
            return 1L
        }
        return hash
    }

    @JvmStatic
    fun localizeOutputImageUrls(
        context: Context,
        settings: JSONObject,
        imageUrls: List<String>,
    ): List<String> {
        if (imageUrls.isEmpty()) return emptyList()
        val requestedBaseUrl =
            normalizeBaseUrl(
                settings.optString("comfyBaseUrl", COMFY_DEFAULT_BASE_URL).ifBlank {
                    COMFY_DEFAULT_BASE_URL
                },
            )
        val auth = settings.optJSONObject("comfyAuth")
        val baseUrl = resolveComfyBaseUrl(requestedBaseUrl, auth)
        val localized = LinkedHashSet<String>()
        for (rawSource in imageUrls) {
            val source = rawSource.trim()
            if (source.isEmpty()) continue
            if (source.startsWith("data:")) {
                localized.add(source)
                continue
            }
            try {
                val normalizedSource = normalizeReferenceSourceUrl(source, baseUrl)
                var response =
                    requestBinary(
                        url = normalizedSource,
                        method = "GET",
                        payload = null,
                        auth = null,
                        connectTimeoutMs = 10_000,
                        readTimeoutMs = 30_000,
                        cacheNoStore = true,
                    )
                if (response.code !in 200..299 && auth != null) {
                    response =
                        requestBinary(
                            url = normalizedSource,
                            method = "GET",
                            payload = null,
                            auth = auth,
                            connectTimeoutMs = 10_000,
                            readTimeoutMs = 30_000,
                            cacheNoStore = true,
                        )
                }
                if (response.code in 200..299 && response.bytes.isNotEmpty()) {
                    val mimeType =
                        normalizeReferenceMimeType(
                            response.contentType?.substringBefore(';')?.trim(),
                        )
                    localized.add(encodeBytesAsDataUrl(response.bytes, mimeType))
                    continue
                }
            } catch (_: Exception) {
                // Best-effort localization: keep original URL fallback.
            }
            localized.add(source)
        }
        return localized.toList()
    }

    private fun runBaseGenerationInternal(
        context: Context,
        worker: String?,
        workerScopeId: String,
        workerQueueDetail: String?,
        workerWaitDetail: String?,
        settings: JSONObject,
        prompt: String,
        seed: Long,
        checkpointName: String?,
        styleReferenceImage: String?,
        preferredTitleIncludes: List<String>,
        strictPreferredMatch: Boolean,
        pickLatestImageOnly: Boolean,
        debugEmitter: ((String, JSONObject) -> Unit)?,
    ): ComfyRunResult {
        val normalizedSeed = normalizeComfySeed(seed)
        val requestedBaseUrl =
            normalizeBaseUrl(
                settings.optString("comfyBaseUrl", COMFY_DEFAULT_BASE_URL).ifBlank {
                    COMFY_DEFAULT_BASE_URL
                },
            )
        val auth = settings.optJSONObject("comfyAuth")
        val baseUrl = resolveComfyBaseUrl(requestedBaseUrl, auth)
        val workflowTemplate = loadBaseWorkflowTemplate(context)
        val workflow = JSONObject(workflowTemplate)

        val promptNode =
            workflow.optJSONObject(COMFY_PROMPT_NODE_ID)
                ?.optJSONObject("inputs")
                ?: throw IllegalStateException("Comfy workflow missing positive prompt node")
        promptNode.put("text", prompt)
        workflow.optJSONObject(COMFY_SEED_NODE_ID)?.optJSONObject("inputs")?.put("seed", normalizedSeed)

        workflow.optJSONObject(COMFY_SIZE_NODE_ID)?.optJSONObject("inputs")?.let { sizeInputs ->
            if (!sizeInputs.has("Xi")) sizeInputs.put("Xi", 1024)
            if (!sizeInputs.has("Xf")) sizeInputs.put("Xf", 1024)
            if (!sizeInputs.has("Yi")) sizeInputs.put("Yi", 1536)
            if (!sizeInputs.has("Yf")) sizeInputs.put("Yf", 1536)
        }

        setBooleanByExactTitle(workflow, "Inpaint?", false)
        setSliderValue(workflow, COMFY_COMPOSITION_STRENGTH_NODE_ID, 0.0)
        if (!styleReferenceImage.isNullOrBlank()) {
            setSliderValue(
                workflow,
                COMFY_STYLE_STRENGTH_NODE_ID,
                settings.optDouble("chatStyleStrength", Double.NaN),
            )
        }
        if (!checkpointName.isNullOrBlank()) {
            setCheckpointName(workflow, checkpointName)
        }
        if (!styleReferenceImage.isNullOrBlank()) {
            try {
                val uploadedFilename =
                    uploadReferenceImage(
                        context = context,
                        source = styleReferenceImage,
                        baseUrl = baseUrl,
                        auth = auth,
                    )
                setImageFilenameOnNode(
                    workflow = workflow,
                    nodeId = COMFY_STYLE_IMAGE_NODE_ID,
                    filename = uploadedFilename,
                )
                setImageFilenameOnNode(
                    workflow = workflow,
                    nodeId = COMFY_COMPOSITION_IMAGE_NODE_ID,
                    filename = uploadedFilename,
                )
            } catch (error: Exception) {
                if (!shouldIgnoreReferenceImageError(error)) {
                    throw error
                }
            }
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
        emitDebug(
            debugEmitter,
            "run_started",
            JSONObject().apply {
                put("baseUrl", baseUrl)
                put("requestedBaseUrl", requestedBaseUrl)
                put("worker", worker ?: "")
                put("scopeId", workerScopeId)
                put("seed", normalizedSeed)
                put("promptLength", prompt.length)
                put("hasStyleReferenceImage", !styleReferenceImage.isNullOrBlank())
            },
        )
        var promptQueued = false
        try {
            val queued = queuePrompt(baseUrl, workflow, auth, debugEmitter)
            val promptId = queued.optString("prompt_id", "").trim()
            if (promptId.isEmpty()) {
                throw IllegalStateException("Comfy /prompt did not return prompt_id")
            }
            promptQueued = true
            emitDebug(
                debugEmitter,
                "prompt_queued",
                JSONObject().apply {
                    put("promptId", promptId)
                },
            )

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
                seed = normalizedSeed,
                model = checkpointName,
            )
        } catch (error: Exception) {
            emitDebug(
                debugEmitter,
                "run_failed",
                JSONObject().apply {
                    put("errorType", error::class.java.simpleName)
                    put("error", error.message ?: "unknown_error")
                    put("promptQueued", promptQueued)
                },
            )
            if (promptQueued) {
                stopComfyExecution(baseUrl, auth)
            }
            throw normalizeComfyError(error, requestedBaseUrl, baseUrl)
        }
    }

    private fun normalizeComfySeed(seed: Long): Long {
        val nonNegative =
            when {
                seed >= 0L -> seed
                seed == Long.MIN_VALUE -> Long.MAX_VALUE
                else -> -seed
            }
        return if (nonNegative > COMFY_SEED_MAX) COMFY_SEED_MAX else nonNegative
    }

    private fun queuePrompt(
        baseUrl: String,
        workflow: JSONObject,
        auth: JSONObject?,
        debugEmitter: ((String, JSONObject) -> Unit)?,
    ): JSONObject {
        val uiWorkflow = buildUiWorkflowForExtraPngInfo(workflow)
        val clientId = UUID.randomUUID().toString()
        val payload = JSONObject().apply {
            put("client_id", clientId)
            put("prompt", workflow)
            put(
                "extra_data",
                JSONObject().put(
                    "extra_pnginfo",
                    JSONObject().put("workflow", uiWorkflow),
                ),
            )
        }
        val payloadText = payload.toString()
        val payloadBytes = payloadText.toByteArray(StandardCharsets.UTF_8)
        emitDebug(
            debugEmitter,
            "prompt_request_prepared",
            JSONObject().apply {
                put("clientId", clientId)
                put("payloadBytes", payloadBytes.size)
                put("workflowNodes", workflow.length())
            },
        )
        var lastError: Exception? = null
        repeat(2) { attempt ->
            val startedAt = System.currentTimeMillis()
            emitDebug(
                debugEmitter,
                "prompt_attempt_start",
                JSONObject().apply {
                    put("attempt", attempt + 1)
                },
            )
            try {
                val response = requestJson(
                    url = "$baseUrl/prompt",
                    method = "POST",
                    payload = payloadText,
                    auth = auth,
                    connectTimeoutMs = 15_000,
                    // Match web semantics: no hard read timeout for prompt queue request.
                    readTimeoutMs = 0,
                    connectionClose = true,
                    traceLabel = "prompt_attempt_${attempt + 1}",
                    debugEmitter = debugEmitter,
                )
                emitDebug(
                    debugEmitter,
                    "prompt_attempt_response",
                    JSONObject().apply {
                        put("attempt", attempt + 1)
                        put("status", response.code)
                        put("elapsedMs", System.currentTimeMillis() - startedAt)
                        put("bodyLength", response.body.length)
                        put("bodyPreview", response.body.replace(Regex("\\s+"), " ").trim().take(260))
                    },
                )
                if (response.code in 200..299) {
                    return parseJsonObject(response.body)
                }
                throw IllegalStateException("Comfy /prompt error (${response.code}): ${response.body}")
            } catch (error: Exception) {
                lastError = error
                emitDebug(
                    debugEmitter,
                    "prompt_attempt_exception",
                    JSONObject().apply {
                        put("attempt", attempt + 1)
                        put("elapsedMs", System.currentTimeMillis() - startedAt)
                        put("errorType", error::class.java.simpleName)
                        put("error", error.message ?: "unknown_error")
                    },
                )
                if (attempt == 0 && isTransientComfyNetworkError(error)) {
                    Thread.sleep(250L)
                    return@repeat
                }
                throw error
            }
        }

        throw lastError ?: IllegalStateException("Comfy /prompt request failed")
    }

    private fun encodeBytesAsDataUrl(bytes: ByteArray, mimeType: String): String {
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return "data:$mimeType;base64,$encoded"
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
                        // Match web polling semantics: no hard read timeout for long-running generations.
                        readTimeoutMs = 0,
                        cacheNoStore = true,
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

    private fun resolveCheckpointName(workflow: JSONObject): String {
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val node = workflow.optJSONObject(key) ?: continue
            val inputs = node.optJSONObject("inputs") ?: continue
            val checkpointRaw = inputs.opt("ckpt_name")
            val checkpointName = (checkpointRaw as? String)?.trim().orEmpty()
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
            if (inputs.opt("ckpt_name") is String) {
                inputs.put("ckpt_name", checkpointName)
            }
        }
    }

    private fun setImageFilenameOnNode(workflow: JSONObject, nodeId: String, filename: String) {
        if (nodeId.isBlank() || filename.isBlank()) return
        val inputs = workflow.optJSONObject(nodeId)?.optJSONObject("inputs") ?: return
        inputs.put("image", filename)
    }

    private fun setSliderValue(workflow: JSONObject, nodeId: String, value: Double) {
        if (nodeId.isBlank() || value.isNaN() || value.isInfinite()) return
        val inputs = workflow.optJSONObject(nodeId)?.optJSONObject("inputs") ?: return
        inputs.put("Xi", value)
        inputs.put("Xf", value)
    }

    private fun setBooleanByExactTitle(workflow: JSONObject, title: String, value: Boolean) {
        val normalizedTitle = title.trim().lowercase(Locale.ROOT)
        if (normalizedTitle.isEmpty()) return
        val keys = workflow.keys()
        while (keys.hasNext()) {
            val nodeId = keys.next()
            val node = workflow.optJSONObject(nodeId) ?: continue
            val nodeTitle =
                node
                    .optJSONObject("_meta")
                    ?.optString("title", "")
                    ?.trim()
                    ?.lowercase(Locale.ROOT)
                    .orEmpty()
            if (nodeTitle != normalizedTitle) continue
            val inputs = node.optJSONObject("inputs") ?: continue
            inputs.put("value", value)
        }
    }

    private fun uploadReferenceImage(
        context: Context,
        source: String,
        baseUrl: String,
        auth: JSONObject?,
    ): String {
        val payload = resolveReferenceImagePayload(context, source, baseUrl, auth)
        val filename = "tg_gf_ref_${System.currentTimeMillis()}_${(Math.random() * 100_000).toInt()}.${payload.extension}"

        val response =
            uploadMultipartImage(
                url = "$baseUrl/upload/image",
                filename = filename,
                payload = payload,
                auth = auth,
            )
        if (response.code !in 200..299) {
            throw IllegalStateException("Comfy /upload/image error (${response.code}): ${response.body}")
        }
        val parsed = parseJsonObject(response.body)
        return parsed.optString("name", filename).trim().ifEmpty { filename }
    }

    private fun uploadMultipartImage(
        url: String,
        filename: String,
        payload: ReferenceImagePayload,
        auth: JSONObject?,
    ): HttpResult {
        val fileBody = payload.bytes.toRequestBody(payload.mimeType.toMediaTypeOrNull())
        val requestBody =
            MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("image", filename, fileBody)
                .addFormDataPart("overwrite", "true")
                .addFormDataPart("type", "input")
                .build()
        val requestBuilder =
            Request.Builder()
                .url(url)
                .post(requestBody)
                .header("Accept", "application/json")
        val authHeaders = buildAuthHeaders(auth)
        for ((name, value) in authHeaders) {
            requestBuilder.header(name, value)
        }
        val response =
            executeRequest(
                request = requestBuilder.build(),
                connectTimeoutMs = 15_000,
                readTimeoutMs = 30_000,
            )
        return HttpResult(
            code = response.code,
            body = response.bodyText,
        )
    }

    private data class BinaryRequestResult(
        val code: Int,
        val bodyBytes: ByteArray,
        val bodyText: String,
        val contentType: String?,
    )

    private fun executeRequest(
        request: Request,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
        traceLabel: String? = null,
        debugEmitter: ((String, JSONObject) -> Unit)? = null,
    ): BinaryRequestResult {
        val normalizedTraceLabel = traceLabel?.trim().orEmpty().ifEmpty { "http_call" }
        val requestBodyLength = safeRequestBodyLength(request.body)
        emitDebug(
            debugEmitter,
            "http_request_prepared",
            JSONObject().apply {
                put("traceLabel", normalizedTraceLabel)
                put("method", request.method)
                put("url", request.url.toString())
                put("connectTimeoutMs", connectTimeoutMs)
                put("readTimeoutMs", readTimeoutMs)
                put("requestBodyBytes", requestBodyLength)
                put("requestBodyContentType", request.body?.contentType()?.toString() ?: "")
                put("hasAuthorizationHeader", request.header("Authorization") != null)
                put("connectionClose", request.header("Connection")?.equals("close", ignoreCase = true) == true)
            },
        )
        val clientBuilder =
            httpClient.newBuilder().apply {
                connectTimeout(connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
                if (readTimeoutMs <= 0) {
                    readTimeout(0L, TimeUnit.MILLISECONDS)
                    writeTimeout(0L, TimeUnit.MILLISECONDS)
                } else {
                    readTimeout(readTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    writeTimeout(readTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
                }
                if (debugEmitter != null || traceLabel != null) {
                    eventListener(
                        object : EventListener() {
                            override fun callStart(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_call_start",
                                    JSONObject().apply {
                                        put("traceLabel", normalizedTraceLabel)
                                        put("method", request.method)
                                        put("url", request.url.toString())
                                    },
                                )
                            }

                            override fun requestHeadersStart(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_request_headers_start",
                                    JSONObject().put("traceLabel", normalizedTraceLabel),
                                )
                            }

                            override fun requestBodyStart(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_request_body_start",
                                    JSONObject().put("traceLabel", normalizedTraceLabel),
                                )
                            }

                            override fun requestBodyEnd(call: Call, byteCount: Long) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_request_body_end",
                                    JSONObject().apply {
                                        put("traceLabel", normalizedTraceLabel)
                                        put("byteCount", byteCount)
                                    },
                                )
                            }

                            override fun responseHeadersStart(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_response_headers_start",
                                    JSONObject().put("traceLabel", normalizedTraceLabel),
                                )
                            }

                            override fun responseBodyStart(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_response_body_start",
                                    JSONObject().put("traceLabel", normalizedTraceLabel),
                                )
                            }

                            override fun responseBodyEnd(call: Call, byteCount: Long) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_response_body_end",
                                    JSONObject().apply {
                                        put("traceLabel", normalizedTraceLabel)
                                        put("byteCount", byteCount)
                                    },
                                )
                            }

                            override fun callEnd(call: Call) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_call_end",
                                    JSONObject().put("traceLabel", normalizedTraceLabel),
                                )
                            }

                            override fun callFailed(call: Call, ioe: IOException) {
                                emitDebug(
                                    debugEmitter,
                                    "http_event_call_failed",
                                    JSONObject().apply {
                                        put("traceLabel", normalizedTraceLabel)
                                        put("errorType", ioe::class.java.simpleName)
                                        put("error", ioe.message ?: "io_exception")
                                    },
                                )
                            }
                        },
                    )
                }
            }
        val client = clientBuilder.build()
        val startedAt = System.currentTimeMillis()
        try {
            client.newCall(request).execute().use { response ->
                val contentType = response.body?.contentType()?.toString()
                val bodyBytes = response.body?.bytes() ?: ByteArray(0)
                val bodyText =
                    if (bodyBytes.isEmpty()) {
                        ""
                    } else {
                        try {
                            String(bodyBytes, StandardCharsets.UTF_8)
                        } catch (_: Exception) {
                            ""
                        }
                    }
                emitDebug(
                    debugEmitter,
                    "http_request_response",
                    JSONObject().apply {
                        put("traceLabel", normalizedTraceLabel)
                        put("method", request.method)
                        put("url", request.url.toString())
                        put("status", response.code)
                        put("elapsedMs", System.currentTimeMillis() - startedAt)
                        put("responseBodyBytes", bodyBytes.size)
                        put("contentType", contentType ?: "")
                    },
                )
                return BinaryRequestResult(
                    code = response.code,
                    bodyBytes = bodyBytes,
                    bodyText = bodyText,
                    contentType = contentType,
                )
            }
        } catch (error: Exception) {
            emitDebug(
                debugEmitter,
                "http_request_exception",
                JSONObject().apply {
                    put("traceLabel", normalizedTraceLabel)
                    put("method", request.method)
                    put("url", request.url.toString())
                    put("elapsedMs", System.currentTimeMillis() - startedAt)
                    put("errorType", error::class.java.simpleName)
                    put("error", error.message ?: "request_exception")
                },
            )
            throw error
        }
    }

    private fun resolveReferenceImagePayload(
        context: Context,
        source: String,
        baseUrl: String,
        auth: JSONObject?,
    ): ReferenceImagePayload {
        val normalizedSource = source.trim()
        if (normalizedSource.isBlank()) {
            throw IllegalStateException("Reference image source is empty.")
        }
        if (normalizedSource.startsWith("idb://")) {
            val imageAssetId = normalizedSource.removePrefix("idb://").trim()
            if (imageAssetId.isBlank()) {
                throw IllegalStateException("Invalid idb reference image source.")
            }
            val imageAssetDataUrl = readImageAssetDataUrlById(context, imageAssetId)
                ?: throw IllegalStateException("Reference image $imageAssetId not found in local imageAssets store.")
            return resolveReferenceImagePayload(
                context = context,
                source = imageAssetDataUrl,
                baseUrl = baseUrl,
                auth = auth,
            )
        }
        if (normalizedSource.startsWith("data:")) {
            return decodeDataUrlToReferencePayload(normalizedSource)
        }
        return downloadReferenceImagePayload(normalizedSource, baseUrl, auth)
    }

    private fun readImageAssetDataUrlById(context: Context, imageAssetId: String): String? {
        val repository = LocalRepository(context)
        try {
            val imageAssets = readStoreArray(repository, "imageAssets")
            for (index in 0 until imageAssets.length()) {
                val imageAsset = imageAssets.optJSONObject(index) ?: continue
                if (imageAsset.optString("id", "").trim() != imageAssetId) continue
                val dataUrl = imageAsset.optString("dataUrl", "").trim()
                if (dataUrl.isNotEmpty()) {
                    return dataUrl
                }
                return null
            }
            return null
        } finally {
            repository.close()
        }
    }

    private fun decodeDataUrlToReferencePayload(dataUrl: String): ReferenceImagePayload {
        val commaIndex = dataUrl.indexOf(',')
        if (commaIndex <= 0 || !dataUrl.startsWith("data:")) {
            throw IllegalStateException("Invalid data URL reference image payload.")
        }
        val metadata = dataUrl.substring(5, commaIndex)
        val payload = dataUrl.substring(commaIndex + 1)
        val mimeType = normalizeReferenceMimeType(metadata.substringBefore(';').trim())
        val isBase64Payload =
            metadata
                .split(";")
                .any { token -> token.equals("base64", ignoreCase = true) }
        val bytes =
            if (isBase64Payload) {
                Base64.decode(payload, Base64.DEFAULT)
            } else {
                URLDecoder.decode(payload, StandardCharsets.UTF_8.toString()).toByteArray(StandardCharsets.UTF_8)
            }
        if (bytes.isEmpty()) {
            throw IllegalStateException("Decoded data URL reference image is empty.")
        }
        return ReferenceImagePayload(
            bytes = bytes,
            extension = extensionFromMimeType(mimeType),
            mimeType = mimeType,
        )
    }

    private fun downloadReferenceImagePayload(
        source: String,
        baseUrl: String,
        auth: JSONObject?,
    ): ReferenceImagePayload {
        val normalizedSource = normalizeReferenceSourceUrl(source, baseUrl)
        var response =
            requestBinary(
                url = normalizedSource,
                method = "GET",
                payload = null,
                auth = null,
                connectTimeoutMs = 10_000,
                readTimeoutMs = 30_000,
                cacheNoStore = true,
            )
        if (response.code !in 200..299 && auth != null) {
            response =
                requestBinary(
                    url = normalizedSource,
                    method = "GET",
                    payload = null,
                    auth = auth,
                    connectTimeoutMs = 10_000,
                    readTimeoutMs = 30_000,
                    cacheNoStore = true,
                )
        }
        if (response.code !in 200..299 || response.bytes.isEmpty()) {
            val errorPreview = response.bodyText.replace(Regex("\\s+"), " ").trim().take(220)
            throw IllegalStateException(
                "Reference image fetch failed (${response.code}): $errorPreview",
            )
        }
        val mimeType =
            normalizeReferenceMimeType(
                response.contentType?.substringBefore(';')?.trim(),
            )
        return ReferenceImagePayload(
            bytes = response.bytes,
            extension = extensionFromMimeType(mimeType),
            mimeType = mimeType,
        )
    }

    private fun shouldIgnoreReferenceImageError(error: Exception): Boolean {
        val normalizedMessage = error.message?.trim()?.lowercase(Locale.ROOT).orEmpty()
        return normalizedMessage.contains("not found in local imageassets store") ||
            normalizedMessage.contains("invalid idb reference image source") ||
            normalizedMessage.contains("reference image source is empty") ||
            normalizedMessage.contains("reference image fetch failed") ||
            normalizedMessage.contains("comfy /upload/image error")
    }

    private fun normalizeReferenceSourceUrl(source: String, baseUrl: String): String {
        val sourceUri =
            try {
                URI(source)
            } catch (_: Exception) {
                return source
            }
        val sourceHost = sourceUri.host?.trim().orEmpty()
        if (!isLoopbackHost(sourceHost)) {
            return source
        }

        val baseUri =
            try {
                URI(baseUrl)
            } catch (_: Exception) {
                return source
            }
        val baseScheme = baseUri.scheme?.trim().orEmpty()
        val baseHost = baseUri.host?.trim().orEmpty()
        if (baseScheme.isEmpty() || baseHost.isEmpty()) {
            return source
        }

        return try {
            URI(
                baseScheme,
                sourceUri.userInfo,
                baseHost,
                baseUri.port,
                sourceUri.path,
                sourceUri.query,
                sourceUri.fragment,
            ).toString()
        } catch (_: Exception) {
            source
        }
    }

    private fun normalizeReferenceMimeType(raw: String?): String {
        val normalized = raw?.trim()?.lowercase(Locale.ROOT).orEmpty()
        return when {
            normalized.contains("webp") -> "image/webp"
            normalized.contains("jpeg") || normalized.contains("jpg") -> "image/jpeg"
            normalized.contains("png") -> "image/png"
            else -> "image/png"
        }
    }

    private fun extensionFromMimeType(mimeType: String): String {
        val normalized = mimeType.trim().lowercase(Locale.ROOT)
        return when {
            normalized.contains("webp") -> "webp"
            normalized.contains("jpeg") || normalized.contains("jpg") -> "jpg"
            else -> "png"
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

    private fun resolveComfyBaseUrl(baseUrl: String, auth: JSONObject?): String {
        val candidates = buildComfyBaseUrlCandidates(baseUrl)
        if (candidates.size <= 1) return baseUrl

        var lastError: Exception? = null
        for (candidate in candidates) {
            try {
                val response =
                    requestJson(
                        url = "$candidate/system_stats",
                        method = "GET",
                        payload = null,
                        auth = auth,
                        connectTimeoutMs = 4_000,
                        readTimeoutMs = 4_000,
                        cacheNoStore = true,
                    )
                if (response.code in 200..599) {
                    return candidate
                }
            } catch (error: Exception) {
                lastError = error
            }
        }

        if (lastError != null) {
            throw IllegalStateException(
                "ComfyUI is unreachable for candidates: ${candidates.joinToString(", ")}",
                lastError,
            )
        }
        return baseUrl
    }

    private fun buildComfyBaseUrlCandidates(baseUrl: String): List<String> {
        val normalized = normalizeBaseUrl(baseUrl)
        val candidates = linkedSetOf(normalized)
        val parsed =
            try {
                URI(normalized)
            } catch (_: Exception) {
                return candidates.toList()
            }
        val host = parsed.host?.trim()?.lowercase(Locale.ROOT).orEmpty()
        if (!isLoopbackHost(host)) {
            return candidates.toList()
        }

        listOf("10.0.2.2", "10.0.3.2")
            .mapNotNull { alias -> replaceUriHost(parsed, alias) }
            .map { candidate -> normalizeBaseUrl(candidate) }
            .forEach { candidate -> candidates.add(candidate) }
        return candidates.toList()
    }

    private fun isLoopbackHost(host: String): Boolean {
        val normalized = host.trim().lowercase(Locale.ROOT)
        return normalized == "127.0.0.1" ||
            normalized == "localhost" ||
            normalized == "::1" ||
            normalized == "0:0:0:0:0:0:0:1"
    }

    private fun replaceUriHost(uri: URI, host: String): String? {
        return try {
            URI(
                uri.scheme,
                uri.userInfo,
                host,
                uri.port,
                uri.path,
                uri.query,
                uri.fragment,
            ).toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun stopComfyExecution(baseUrl: String, auth: JSONObject?) {
        interruptComfyExecution(baseUrl, auth)
        clearComfyQueue(baseUrl, auth)
    }

    private fun interruptComfyExecution(baseUrl: String, auth: JSONObject?) {
        try {
            requestJson(
                url = "$baseUrl/interrupt",
                method = "POST",
                payload = null,
                auth = auth,
                connectTimeoutMs = 2_500,
                readTimeoutMs = 2_500,
            )
        } catch (_: Exception) {
            // Best-effort interrupt.
        }
    }

    private fun clearComfyQueue(baseUrl: String, auth: JSONObject?) {
        try {
            requestJson(
                url = "$baseUrl/queue",
                method = "POST",
                payload = JSONObject().put("clear", true).toString(),
                auth = auth,
                connectTimeoutMs = 2_500,
                readTimeoutMs = 2_500,
            )
            return
        } catch (_: Exception) {
            // Continue fallback payload.
        }

        try {
            requestJson(
                url = "$baseUrl/queue",
                method = "POST",
                payload = JSONObject().put("delete", "all").toString(),
                auth = auth,
                connectTimeoutMs = 2_500,
                readTimeoutMs = 2_500,
            )
        } catch (_: Exception) {
            // Best-effort queue clear.
        }
    }

    private fun normalizeComfyError(
        error: Exception,
        requestedBaseUrl: String,
        resolvedBaseUrl: String,
    ): Exception {
        if (!isLikelyNetworkError(error)) {
            return error
        }

        val hints = mutableListOf<String>()
        hints.add("Не удалось подключиться к ComfyUI ($resolvedBaseUrl).")
        if (isLoopbackComfyUrl(requestedBaseUrl)) {
            hints.add(
                "Локальный localhost обычно недоступен из Android устройства: для эмулятора укажи http://10.0.2.2:8188, для физического устройства — LAN IP хоста.",
            )
        }
        hints.add("Исходная ошибка: ${error.message ?: "network_error"}")
        return IllegalStateException(hints.joinToString(" "), error)
    }

    private fun isLoopbackComfyUrl(baseUrl: String): Boolean {
        val host =
            try {
                URI(baseUrl).host?.trim().orEmpty()
            } catch (_: Exception) {
                ""
            }
        return isLoopbackHost(host)
    }

    private fun isLikelyNetworkError(error: Throwable?): Boolean {
        var cursor = error
        while (cursor != null) {
            if (cursor is IOException) return true
            cursor = cursor.cause
        }
        return false
    }

    private fun parseJsonObject(raw: String?): JSONObject {
        if (raw.isNullOrBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun safeRequestBodyLength(body: okhttp3.RequestBody?): Long {
        if (body == null) return 0L
        return try {
            body.contentLength().coerceAtLeast(0L)
        } catch (_: Exception) {
            -1L
        }
    }

    private fun emitDebug(
        debugEmitter: ((String, JSONObject) -> Unit)?,
        stage: String,
        details: JSONObject? = null,
    ) {
        val safeDetails =
            if (details == null) {
                JSONObject()
            } else {
                try {
                    JSONObject(details.toString())
                } catch (_: Exception) {
                    JSONObject().put("raw", details.toString())
                }
            }
        val logLine = "[$stage] ${safeDetails.toString().take(3000)}"
        val isErrorStage =
            stage.contains("exception", ignoreCase = true) ||
                stage.contains("failed", ignoreCase = true) ||
                stage.contains("error", ignoreCase = true)
        if (isErrorStage) {
            Log.w(COMFY_DEBUG_TAG, logLine)
        } else {
            Log.d(COMFY_DEBUG_TAG, logLine)
        }
        if (debugEmitter != null) {
            try {
                debugEmitter(stage, safeDetails)
            } catch (callbackError: Exception) {
                Log.w(
                    COMFY_DEBUG_TAG,
                    "[debug_emit_failed] ${callbackError.message ?: "callback_error"}",
                )
            }
        }
    }

    private fun requestBinary(
        url: String,
        method: String,
        payload: String?,
        auth: JSONObject?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
        cacheNoStore: Boolean = false,
        connectionClose: Boolean = false,
        traceLabel: String? = null,
        debugEmitter: ((String, JSONObject) -> Unit)? = null,
    ): BinaryHttpResult {
        val requestBody = buildJsonRequestBody(method, payload)
        val requestBuilder = Request.Builder().url(url).method(method, requestBody).header("Accept", "*/*")
        if (cacheNoStore) {
            requestBuilder.header("Cache-Control", "no-store")
            requestBuilder.header("Pragma", "no-cache")
        }
        if (connectionClose) {
            requestBuilder.header("Connection", "close")
        }
        val authHeaders = buildAuthHeaders(auth)
        for ((name, value) in authHeaders) {
            requestBuilder.header(name, value)
        }
        val response =
            executeRequest(
                request = requestBuilder.build(),
                connectTimeoutMs = connectTimeoutMs,
                readTimeoutMs = readTimeoutMs,
                traceLabel = traceLabel,
                debugEmitter = debugEmitter,
            )
        return if (response.code in 200..299) {
            BinaryHttpResult(
                code = response.code,
                bytes = response.bodyBytes,
                bodyText = "",
                contentType = response.contentType,
            )
        } else {
            BinaryHttpResult(
                code = response.code,
                bytes = ByteArray(0),
                bodyText = response.bodyText,
                contentType = response.contentType,
            )
        }
    }

    private fun requestJson(
        url: String,
        method: String,
        payload: String?,
        auth: JSONObject?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
        cacheNoStore: Boolean = false,
        connectionClose: Boolean = false,
        traceLabel: String? = null,
        debugEmitter: ((String, JSONObject) -> Unit)? = null,
    ): HttpResult {
        val requestBody = buildJsonRequestBody(method, payload)
        val requestBuilder =
            Request.Builder()
                .url(url)
                .method(method, requestBody)
                .header("Accept", "application/json")
        if (cacheNoStore) {
            requestBuilder.header("Cache-Control", "no-store")
            requestBuilder.header("Pragma", "no-cache")
        }
        if (connectionClose) {
            requestBuilder.header("Connection", "close")
        }
        val authHeaders = buildAuthHeaders(auth)
        for ((name, value) in authHeaders) {
            requestBuilder.header(name, value)
        }
        val response =
            executeRequest(
                request = requestBuilder.build(),
                connectTimeoutMs = connectTimeoutMs,
                readTimeoutMs = readTimeoutMs,
                traceLabel = traceLabel,
                debugEmitter = debugEmitter,
            )
        return HttpResult(code = response.code, body = response.bodyText)
    }

    private fun buildJsonRequestBody(method: String, payload: String?): okhttp3.RequestBody? {
        val normalizedMethod = method.trim().uppercase(Locale.ROOT)
        val payloadBytes = payload?.toByteArray(StandardCharsets.UTF_8)
        return when {
            payloadBytes != null && payloadBytes.isNotEmpty() ->
                payloadBytes.toRequestBody("application/json; charset=utf-8".toMediaType())
            normalizedMethod == "POST" || normalizedMethod == "PUT" || normalizedMethod == "PATCH" ->
                ByteArray(0).toRequestBody("application/json; charset=utf-8".toMediaType())
            else -> null
        }
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

    private fun urlEncode(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.toString())
    }

}
