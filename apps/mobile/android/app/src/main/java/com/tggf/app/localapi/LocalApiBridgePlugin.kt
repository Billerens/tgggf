package com.tggf.app.localapi

import android.content.ContentValues
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONArray
import java.net.URLDecoder
import java.lang.ref.WeakReference
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.UUID

@CapacitorPlugin(name = "LocalApi")
class LocalApiBridgePlugin : Plugin() {
    companion object {
        @Volatile
        private var activePluginRef: WeakReference<LocalApiBridgePlugin>? = null
        private const val IMAGE_REF_MIGRATION_MARKER_KEY = "image_ref_migration_v1_done"

        @JvmStatic
        fun emitBackgroundTick(
            source: String,
            sequence: Long,
            intervalMs: Long,
            enabled: Boolean,
            running: Boolean,
        ) {
            val plugin = activePluginRef?.get() ?: return
            val payload = JSObject().apply {
                put("ok", true)
                put("source", source)
                put("sequence", sequence)
                put("intervalMs", intervalMs)
                put("enabled", enabled)
                put("running", running)
                put("timestamp", System.currentTimeMillis())
            }
            plugin.notifyListeners("backgroundTick", payload)
        }

    }

    private val repositoryDelegate = lazy { LocalRepository(context) }
    private val backgroundJobsDelegate = lazy { BackgroundJobRepository(context) }
    private val backgroundRuntimeDelegate = lazy { BackgroundRuntimeRepository(context) }

    private val repository by repositoryDelegate
    private val backgroundJobs by backgroundJobsDelegate
    private val backgroundRuntime by backgroundRuntimeDelegate

    override fun load() {
        super.load()
        activePluginRef = WeakReference(this)
        runOneTimeStoreMaintenance()
        ForegroundSyncService.ensureStartedIfEnabled(context)
    }

    override fun handleOnDestroy() {
        if (activePluginRef?.get() === this) {
            activePluginRef = null
        }
        if (backgroundJobsDelegate.isInitialized()) {
            backgroundJobs.closeQuietly()
        }
        if (backgroundRuntimeDelegate.isInitialized()) {
            backgroundRuntime.closeQuietly()
        }
        if (repositoryDelegate.isInitialized()) {
            repository.close()
        }
        super.handleOnDestroy()
    }

    private fun normalizePath(path: String): String {
        val trimmed = path.trim()
        if (trimmed.isEmpty()) return "/"
        return if (trimmed.startsWith("/")) trimmed else "/$trimmed"
    }

    private fun splitPathAndQuery(rawPath: String): Pair<String, String?> {
        val queryIndex = rawPath.indexOf("?")
        if (queryIndex < 0) return Pair(rawPath, null)
        val path = rawPath.substring(0, queryIndex)
        val query = rawPath.substring(queryIndex + 1)
        return Pair(path, query)
    }

    private fun readQueryParam(query: String?, name: String): String? {
        if (query.isNullOrBlank()) return null
        val pairs = query.split("&")
        for (pair in pairs) {
            if (pair.isBlank()) continue
            val index = pair.indexOf("=")
            val keyRaw = if (index >= 0) pair.substring(0, index) else pair
            val valueRaw = if (index >= 0) pair.substring(index + 1) else ""
            val key = decodeUriComponentSafe(keyRaw)
            if (key == name) {
                return decodeUriComponentSafe(valueRaw).trim()
            }
        }
        return null
    }

    private fun decodeUriComponentSafe(raw: String): String {
        return try {
            URLDecoder.decode(raw, "UTF-8")
        } catch (_: Throwable) {
            raw
        }
    }

    private fun readIntQueryParam(query: String?, name: String, fallback: Int): Int {
        val raw = readQueryParam(query, name) ?: return fallback
        return raw.toIntOrNull() ?: fallback
    }

    private fun readLongQueryParam(query: String?, name: String, fallback: Long): Long {
        val raw = readQueryParam(query, name) ?: return fallback
        return raw.toLongOrNull() ?: fallback
    }

    private fun readBooleanQueryParam(query: String?, name: String, fallback: Boolean): Boolean {
        val raw = readQueryParam(query, name)?.trim()?.lowercase() ?: return fallback
        return when (raw) {
            "1", "true", "yes", "on" -> true
            "0", "false", "no", "off" -> false
            else -> fallback
        }
    }

    private fun readScopeIdsQueryParam(query: String?, name: String): List<String> {
        val raw = readQueryParam(query, name) ?: return emptyList()
        if (raw.isBlank()) return emptyList()
        return raw
            .split(",")
            .map { token -> token.trim() }
            .filter { token -> token.isNotEmpty() }
            .distinct()
    }

    private fun parsePayloadJson(raw: Any?): String {
        return when (raw) {
            is JSONObject -> raw.toString()
            is JSONArray -> raw.toString()
            is String -> {
                val text = raw.trim()
                if (text.isEmpty()) "{}" else text
            }
            null -> "{}"
            else -> JSONObject.wrap(raw)?.toString() ?: "{}"
        }
    }

    private fun parsePayloadToAny(raw: String): Any {
        val normalized = raw.trim()
        if (normalized.startsWith("{")) {
            return try {
                JSObject(normalized)
            } catch (_: Exception) {
                normalized
            }
        }
        if (normalized.startsWith("[")) {
            return try {
                JSONArray(normalized)
            } catch (_: Exception) {
                normalized
            }
        }
        return normalized
    }

    private fun sanitizeExportFileName(rawFileName: String): String {
        val fallback = "tg-gf-export-${System.currentTimeMillis()}.json"
        val trimmed = rawFileName.trim()
        if (trimmed.isEmpty()) return fallback
        val sanitized = trimmed.replace(Regex("""[\\/:*?"<>|]"""), "_")
        return if (sanitized.isEmpty()) fallback else sanitized
    }

    private fun resolveExportMimeType(fileName: String, rawMimeType: String): String {
        val normalized = rawMimeType.trim()
        if (normalized.isNotEmpty()) return normalized
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".zip") -> "application/zip"
            lower.endsWith(".json") -> "application/json"
            else -> "application/octet-stream"
        }
    }

    private fun decodeExportBase64Payload(rawPayload: String): ByteArray? {
        val normalized = rawPayload.trim()
        if (normalized.isEmpty()) return null
        val payload =
            if (normalized.startsWith("data:", ignoreCase = true)) {
                val commaIndex = normalized.indexOf(',')
                if (commaIndex >= 0 && commaIndex + 1 < normalized.length) {
                    normalized.substring(commaIndex + 1)
                } else {
                    ""
                }
            } else {
                normalized
            }
        if (payload.isEmpty()) return null
        return try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun writeExportBytesToDevice(
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
    ): String? {
        if (bytes.isEmpty()) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            return try {
                resolver.openOutputStream(uri)?.use { stream ->
                    stream.write(bytes)
                    stream.flush()
                } ?: throw IllegalStateException("download_output_stream_unavailable")
                val publishValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(uri, publishValues, null, null)
                uri.toString()
            } catch (_: Exception) {
                resolver.delete(uri, null, null)
                null
            }
        }

        @Suppress("DEPRECATION")
        val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!downloadsDir.exists() && !downloadsDir.mkdirs()) return null
        val targetFile = File(downloadsDir, fileName)
        return try {
            FileOutputStream(targetFile).use { stream ->
                stream.write(bytes)
                stream.flush()
            }
            MediaScannerConnection.scanFile(
                context,
                arrayOf(targetFile.absolutePath),
                arrayOf(mimeType),
                null,
            )
            targetFile.absolutePath
        } catch (_: Exception) {
            null
        }
    }

    private fun backgroundJobToJsObject(job: BackgroundJobRecord): JSObject {
        return JSObject().apply {
            put("id", job.id)
            put("type", job.type)
            put("payload", parsePayloadToAny(job.payloadJson))
            put("status", job.status)
            put("runAtMs", job.runAtMs)
            put("leaseUntilMs", job.leaseUntilMs)
            put("attempts", job.attempts)
            put("maxAttempts", job.maxAttempts)
            put("lastError", job.lastError)
            put("createdAtMs", job.createdAtMs)
            put("updatedAtMs", job.updatedAtMs)
        }
    }

    private fun backgroundDesiredStateToJsObject(record: BackgroundDesiredStateRecord): JSObject {
        return JSObject().apply {
            put("taskType", record.taskType)
            put("scopeId", record.scopeId)
            put("enabled", record.enabled)
            put("payload", parsePayloadToAny(record.payloadJson))
            put("updatedAtMs", record.updatedAtMs)
        }
    }

    private fun backgroundRuntimeEventToJsObject(record: BackgroundRuntimeEventRecord): JSObject {
        return JSObject().apply {
            put("id", record.id)
            put("taskType", record.taskType)
            put("scopeId", record.scopeId)
            put("jobId", record.jobId)
            put("stage", record.stage)
            put("level", record.level)
            put("message", record.message)
            if (record.detailsJson.isNullOrBlank()) {
                put("details", null)
            } else {
                put("details", parsePayloadToAny(record.detailsJson))
            }
            put("createdAtMs", record.createdAtMs)
        }
    }

    private fun backgroundDeltaToJsObject(record: BackgroundDeltaRecord): JSObject {
        return JSObject().apply {
            put("id", record.id)
            put("taskType", record.taskType)
            put("scopeId", record.scopeId)
            put("kind", record.kind)
            put("entityType", record.entityType)
            put("entityId", record.entityId)
            put("payload", parsePayloadToAny(record.payloadJson))
            put("createdAtMs", record.createdAtMs)
        }
    }

    private fun respond(call: PluginCall, status: Int, body: Any?) {
        val payload = JSObject()
        payload.put("status", status)
        payload.put("body", body)
        call.resolve(payload)
    }

    private fun foregroundWorkerSnapshotToJsObject(
        snapshot: ForegroundSyncService.Companion.WorkerStatusSnapshot,
        nowMs: Long,
    ): JSObject {
        val stale = ForegroundSyncService.isWorkerSnapshotStale(
            snapshot = snapshot,
            nowMs = nowMs,
        )
        return JSObject().apply {
            put("worker", snapshot.worker)
            put("state", snapshot.state)
            put("scopeId", snapshot.scopeId)
            put("detail", snapshot.detail)
            put("heartbeatAtMs", snapshot.heartbeatAtMs)
            put("progressAtMs", snapshot.progressAtMs)
            put("claimAtMs", snapshot.claimAtMs)
            put("lastError", snapshot.lastError)
            put("stale", stale)
        }
    }

    private fun buildForegroundWorkerStatuses(nowMs: Long): JSONArray {
        return JSONArray().apply {
            for (snapshot in ForegroundSyncService.getWorkerStatusSnapshots()) {
                put(foregroundWorkerSnapshotToJsObject(snapshot, nowMs))
            }
        }
    }

    private fun resolveForegroundHealth(
        enabled: Boolean,
        running: Boolean,
        diagnostics: ForegroundSyncService.Companion.RuntimeDiagnostics,
    ): String {
        if (!enabled) return "fallback"
        if (!running) return "degraded"
        if (diagnostics.staleWorkerCount > 0) return "degraded"
        if (diagnostics.queueStaleLeasedCount > 0) return "degraded"
        if (diagnostics.hasWorkerErrors) return "degraded"
        return "active"
    }

    private fun buildForegroundServiceStatusPayload(enabledOverride: Boolean? = null): JSObject {
        val nowMs = System.currentTimeMillis()
        val enabled = enabledOverride ?: ForegroundSyncService.isEnabled(context)
        val running = ForegroundSyncService.isRunning()
        val workerStatuses = buildForegroundWorkerStatuses(nowMs)
        val diagnostics = ForegroundSyncService.collectRuntimeDiagnostics(context, nowMs)
        return JSObject().apply {
            put("ok", true)
            put("enabled", enabled)
            put("running", running)
            put(
                "health",
                resolveForegroundHealth(
                    enabled = enabled,
                    running = running,
                    diagnostics = diagnostics,
                ),
            )
            put("heartbeatIntervalMs", ForegroundSyncService.HEARTBEAT_INTERVAL_MS)
            put("workers", workerStatuses)
            put("staleWorkers", diagnostics.staleWorkerCount)
            put("hasWorkerErrors", diagnostics.hasWorkerErrors)
            put("lastError", diagnostics.lastError.ifBlank { null })
            put("staleJobs", diagnostics.queueStaleLeasedCount)
            put("collectedAtMs", diagnostics.collectedAtMs)
            put(
                "queue",
                JSObject().apply {
                    put("pending", diagnostics.queuePendingCount)
                    put("leased", diagnostics.queueLeasedCount)
                    put("staleLeased", diagnostics.queueStaleLeasedCount)
                    put("totalDepth", diagnostics.queueDepth)
                },
            )
            put(
                "activeScopes",
                JSObject().apply {
                    put("topicGeneration", diagnostics.topicActiveScopes)
                    put("groupIteration", diagnostics.groupActiveScopes)
                    put("total", diagnostics.topicActiveScopes + diagnostics.groupActiveScopes)
                },
            )
        }
    }

    private fun readStoreArray(storeName: String): JSONArray {
        if (storeName == "settings") {
            val settingsJson = repository.readSettingsJson()
            if (settingsJson.isNullOrBlank()) {
                return JSONArray()
            }
            return try {
                JSONArray().put(JSONObject(settingsJson))
            } catch (_: JSONException) {
                JSONArray()
            }
        }
        val raw = repository.readStoreJson(storeName)
        if (raw.isNullOrBlank()) {
            return JSONArray()
        }
        return try {
            JSONArray(raw)
        } catch (_: JSONException) {
            try {
                JSONArray().put(JSONObject(raw))
            } catch (_: JSONException) {
                JSONArray()
            }
        }
    }

    private fun writeStoreArray(storeName: String, value: JSONArray) {
        if (storeName == "settings") {
            val settings = value.optJSONObject(0)
            if (settings == null) {
                repository.clearStoreJson("settings")
            } else {
                repository.writeSettingsJson(settings.toString())
            }
            return
        }
        repository.writeStoreJson(storeName, value.toString())
    }

    private fun parseRequestedStoreNames(query: String?): Set<String>? {
        val raw = readQueryParam(query, "stores") ?: return null
        if (raw.isBlank()) return null
        val knownStoreNames = repository.knownStoreNames()
        val requested = mutableSetOf<String>()
        for (token in raw.split(",")) {
            val storeName = token.trim()
            if (storeName.isEmpty()) continue
            if (knownStoreNames.contains(storeName)) {
                requested.add(storeName)
            }
        }
        return requested
    }

    private fun exportRawStores(requestedStoreNames: Set<String>? = null): JSONObject {
        val stores = JSONObject()
        val storeNames =
            if (requestedStoreNames == null) {
                repository.knownStoreNames().toList().sorted()
            } else {
                requestedStoreNames.toList().sorted()
            }
        for (storeName in storeNames) {
            stores.put(storeName, readStoreArray(storeName))
        }
        return stores
    }

    private fun applyStoresPayload(storesJson: JSONObject, mode: String) {
        val storeNames = repository.knownStoreNames().toList().sorted()
        if (mode == "replace") {
            for (storeName in storeNames) {
                repository.clearStoreJson(storeName)
            }
        }
        for (storeName in storeNames) {
            if (!storesJson.has(storeName)) {
                if (mode == "replace") {
                    repository.clearStoreJson(storeName)
                }
                continue
            }
            val rawValue = storesJson.opt(storeName)
            val arrayValue = when (rawValue) {
                is JSONArray -> rawValue
                is JSONObject -> JSONArray().put(rawValue)
                else -> JSONArray()
            }
            writeStoreArray(storeName, arrayValue)
        }
    }

    private fun runOneTimeStoreMaintenance() {
        runCatching { runOneTimeImageRefMigration() }
        runCatching { TopicGenerationNativeExecutor.maybeRunImageAssetGc(repository) }
    }

    private fun runOneTimeImageRefMigration() {
        if (repository.readBooleanMarker(IMAGE_REF_MIGRATION_MARKER_KEY, false)) return
        val imageAssets = readStoreArray("imageAssets")
        val assetIdByDataUrl = mutableMapOf<String, String>()
        for (index in 0 until imageAssets.length()) {
            val item = imageAssets.optJSONObject(index) ?: continue
            val assetId = item.optString("id", "").trim()
            val dataUrl = item.optString("dataUrl", "").trim()
            if (assetId.isNotEmpty() && dataUrl.isNotEmpty()) {
                assetIdByDataUrl[dataUrl] = assetId
            }
        }

        val sessionsChanged =
            migrateGeneratorSessionsImageRefs(
                imageAssets = imageAssets,
                assetIdByDataUrl = assetIdByDataUrl,
            )
        val groupMessagesChanged =
            migrateGroupMessagesImageRefs(
                imageAssets = imageAssets,
                assetIdByDataUrl = assetIdByDataUrl,
            )
        if (sessionsChanged || groupMessagesChanged) {
            repository.writeStoreJson("imageAssets", imageAssets.toString())
        }
        repository.writeBooleanMarker(IMAGE_REF_MIGRATION_MARKER_KEY, true)
    }

    private fun migrateGeneratorSessionsImageRefs(
        imageAssets: JSONArray,
        assetIdByDataUrl: MutableMap<String, String>,
    ): Boolean {
        val sessions = readStoreArray("generatorSessions")
        var changed = false
        for (sessionIndex in 0 until sessions.length()) {
            val session = sessions.optJSONObject(sessionIndex) ?: continue
            val entries = session.optJSONArray("entries") ?: continue
            var sessionChanged = false
            for (entryIndex in 0 until entries.length()) {
                val entry = entries.optJSONObject(entryIndex) ?: continue
                val createdAt = entry.optString("createdAt", "").trim().ifBlank { Instant.now().toString() }
                val imageUrls = entry.optJSONArray("imageUrls") ?: JSONArray()
                val migratedUrls = JSONArray()
                var entryChanged = false
                for (urlIndex in 0 until imageUrls.length()) {
                    val rawUrl = imageUrls.optString(urlIndex, "").trim()
                    if (rawUrl.isEmpty()) continue
                    if (!TopicGenerationNativeExecutor.isInlineDataUrl(rawUrl)) {
                        migratedUrls.put(rawUrl)
                        continue
                    }
                    val ref =
                        ensureImageAssetRefFromDataUrl(
                            imageAssets = imageAssets,
                            assetIdByDataUrl = assetIdByDataUrl,
                            dataUrl = rawUrl,
                            meta = null,
                            createdAt = createdAt,
                        )
                    if (ref.isNotEmpty()) {
                        migratedUrls.put(ref)
                        if (ref != rawUrl) {
                            entryChanged = true
                        }
                    }
                }
                if (entryChanged) {
                    entry.put("imageUrls", migratedUrls)
                }

                val imageMetaByUrl = entry.optJSONObject("imageMetaByUrl")
                if (imageMetaByUrl != null && imageMetaByUrl.length() > 0) {
                    val migratedMetaByUrl = JSONObject()
                    var metaChanged = false
                    val keys = imageMetaByUrl.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        val value = imageMetaByUrl.opt(key)
                        val normalizedKey = key.trim()
                        var targetKey = normalizedKey
                        if (TopicGenerationNativeExecutor.isInlineDataUrl(normalizedKey)) {
                            targetKey =
                                ensureImageAssetRefFromDataUrl(
                                    imageAssets = imageAssets,
                                    assetIdByDataUrl = assetIdByDataUrl,
                                    dataUrl = normalizedKey,
                                    meta = value as? JSONObject,
                                    createdAt = createdAt,
                                )
                            if (targetKey.isNotEmpty() && targetKey != normalizedKey) {
                                metaChanged = true
                            }
                        }
                        val finalKey = targetKey.ifBlank { normalizedKey }
                        if (!migratedMetaByUrl.has(finalKey)) {
                            migratedMetaByUrl.put(finalKey, value)
                        }
                    }
                    if (metaChanged) {
                        entry.put("imageMetaByUrl", migratedMetaByUrl)
                        entryChanged = true
                    }
                }
                if (entryChanged) {
                    entries.put(entryIndex, entry)
                    sessionChanged = true
                }
            }
            if (sessionChanged) {
                session.put("entries", entries)
                sessions.put(sessionIndex, session)
                changed = true
            }
        }
        if (changed) {
            repository.writeStoreJson("generatorSessions", sessions.toString())
        }
        return changed
    }

    private fun migrateGroupMessagesImageRefs(
        imageAssets: JSONArray,
        assetIdByDataUrl: MutableMap<String, String>,
    ): Boolean {
        val messages = readStoreArray("groupMessages")
        var changed = false
        for (messageIndex in 0 until messages.length()) {
            val message = messages.optJSONObject(messageIndex) ?: continue
            val createdAt = message.optString("createdAt", "").trim().ifBlank { Instant.now().toString() }
            var messageChanged = false

            val attachments = message.optJSONArray("imageAttachments")
            if (attachments != null) {
                for (attachmentIndex in 0 until attachments.length()) {
                    val attachment = attachments.optJSONObject(attachmentIndex) ?: continue
                    val rawUrl = attachment.optString("url", "").trim()
                    if (rawUrl.isEmpty()) continue
                    if (TopicGenerationNativeExecutor.isInlineDataUrl(rawUrl)) {
                        val ref =
                            ensureImageAssetRefFromDataUrl(
                                imageAssets = imageAssets,
                                assetIdByDataUrl = assetIdByDataUrl,
                                dataUrl = rawUrl,
                                meta = attachment.optJSONObject("meta"),
                                createdAt = createdAt,
                            )
                        val imageId = TopicGenerationNativeExecutor.parseImageRefAssetId(ref)
                        if (ref.isNotEmpty()) {
                            attachment.put("url", ref)
                            if (imageId.isNotEmpty()) {
                                attachment.put("imageId", imageId)
                            }
                            attachments.put(attachmentIndex, attachment)
                            messageChanged = true
                        }
                    } else if (TopicGenerationNativeExecutor.isImageRef(rawUrl)) {
                        val imageId = TopicGenerationNativeExecutor.parseImageRefAssetId(rawUrl)
                        if (
                            imageId.isNotEmpty() &&
                                attachment.optString("imageId", "").trim().isEmpty()
                        ) {
                            attachment.put("imageId", imageId)
                            attachments.put(attachmentIndex, attachment)
                            messageChanged = true
                        }
                    }
                }
                if (messageChanged) {
                    message.put("imageAttachments", attachments)
                }
            }

            val imageMetaByUrl = message.optJSONObject("imageMetaByUrl")
            if (imageMetaByUrl != null && imageMetaByUrl.length() > 0) {
                val migratedMetaByUrl = JSONObject()
                var metaChanged = false
                val keys = imageMetaByUrl.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = imageMetaByUrl.opt(key)
                    val normalizedKey = key.trim()
                    var targetKey = normalizedKey
                    if (TopicGenerationNativeExecutor.isInlineDataUrl(normalizedKey)) {
                        targetKey =
                            ensureImageAssetRefFromDataUrl(
                                imageAssets = imageAssets,
                                assetIdByDataUrl = assetIdByDataUrl,
                                dataUrl = normalizedKey,
                                meta = value as? JSONObject,
                                createdAt = createdAt,
                            )
                        if (targetKey.isNotEmpty() && targetKey != normalizedKey) {
                            metaChanged = true
                        }
                    }
                    val finalKey = targetKey.ifBlank { normalizedKey }
                    if (!migratedMetaByUrl.has(finalKey)) {
                        migratedMetaByUrl.put(finalKey, value)
                    }
                }
                if (metaChanged) {
                    message.put("imageMetaByUrl", migratedMetaByUrl)
                    messageChanged = true
                }
            }

            if (messageChanged) {
                messages.put(messageIndex, message)
                changed = true
            }
        }
        if (changed) {
            repository.writeStoreJson("groupMessages", messages.toString())
        }
        return changed
    }

    private fun ensureImageAssetRefFromDataUrl(
        imageAssets: JSONArray,
        assetIdByDataUrl: MutableMap<String, String>,
        dataUrl: String,
        meta: JSONObject?,
        createdAt: String,
    ): String {
        val normalizedDataUrl = dataUrl.trim()
        if (normalizedDataUrl.isEmpty()) return ""
        val existingId = assetIdByDataUrl[normalizedDataUrl]
        if (!existingId.isNullOrBlank()) {
            return TopicGenerationNativeExecutor.toImageRef(existingId)
        }
        val assetId = UUID.randomUUID().toString()
        imageAssets.put(
            JSONObject().apply {
                put("id", assetId)
                put("dataUrl", normalizedDataUrl)
                put("meta", JSONObject((meta ?: JSONObject()).toString()))
                put("createdAt", createdAt.ifBlank { Instant.now().toString() })
            },
        )
        assetIdByDataUrl[normalizedDataUrl] = assetId
        return TopicGenerationNativeExecutor.toImageRef(assetId)
    }

    private fun readPersonasArray(): JSONArray {
        return readStoreArray("personas")
    }

    private fun upsertPersona(personaId: String, personaBody: JSObject): JSONArray {
        val personasArray = readPersonasArray()
        val nextPersona = JSONObject(personaBody.toString())
        nextPersona.put("id", personaId)
        val result = JSONArray()
        var replaced = false

        for (index in 0 until personasArray.length()) {
            val item = personasArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") == personaId) {
                result.put(nextPersona)
                replaced = true
            } else {
                result.put(item)
            }
        }
        if (!replaced) {
            result.put(nextPersona)
        }
        return result
    }

    private fun deletePersona(personaId: String): JSONArray {
        val personasArray = readPersonasArray()
        val result = JSONArray()
        for (index in 0 until personasArray.length()) {
            val item = personasArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") != personaId) {
                result.put(item)
            }
        }
        return result
    }

    private fun readChatsArray(): JSONArray {
        return readStoreArray("chats")
    }

    private fun upsertChat(chatId: String, chatBody: JSObject): JSONArray {
        val chatsArray = readChatsArray()
        val nextChat = JSONObject(chatBody.toString())
        nextChat.put("id", chatId)
        val result = JSONArray()
        var replaced = false

        for (index in 0 until chatsArray.length()) {
            val item = chatsArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") == chatId) {
                result.put(nextChat)
                replaced = true
            } else {
                result.put(item)
            }
        }
        if (!replaced) {
            result.put(nextChat)
        }
        return result
    }

    private fun deleteChat(chatId: String): JSONArray {
        val chatsArray = readChatsArray()
        val result = JSONArray()
        for (index in 0 until chatsArray.length()) {
            val item = chatsArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") != chatId) {
                result.put(item)
            }
        }
        return result
    }

    private fun readMessagesArray(): JSONArray {
        return readStoreArray("messages")
    }

    private fun upsertMessage(messageId: String, messageBody: JSObject): JSONArray {
        val messagesArray = readMessagesArray()
        val nextMessage = JSONObject(messageBody.toString())
        nextMessage.put("id", messageId)
        val result = JSONArray()
        var replaced = false

        for (index in 0 until messagesArray.length()) {
            val item = messagesArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") == messageId) {
                result.put(nextMessage)
                replaced = true
            } else {
                result.put(item)
            }
        }
        if (!replaced) {
            result.put(nextMessage)
        }
        return result
    }

    private fun deleteMessage(messageId: String): JSONArray {
        val messagesArray = readMessagesArray()
        val result = JSONArray()
        for (index in 0 until messagesArray.length()) {
            val item = messagesArray.optJSONObject(index)
            if (item == null) continue
            if (item.optString("id", "") != messageId) {
                result.put(item)
            }
        }
        return result
    }

    private fun deleteMessagesByChatIds(chatIds: Set<String>): JSONArray {
        val messagesArray = readMessagesArray()
        if (chatIds.isEmpty()) return messagesArray
        val result = JSONArray()
        for (index in 0 until messagesArray.length()) {
            val item = messagesArray.optJSONObject(index)
            if (item == null) continue
            val messageChatId = item.optString("chatId", "").trim()
            if (!chatIds.contains(messageChatId)) {
                result.put(item)
            }
        }
        return result
    }

    @PluginMethod
    fun health(call: PluginCall) {
        val health = repository.health()
        val payload = JSObject()
        payload.put("ok", health["ok"])
        payload.put("service", health["service"])
        payload.put("storage", health["storage"])
        call.resolve(payload)
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val method = (call.getString("method", "GET") ?: "GET").trim().uppercase()
        val normalizedPath = normalizePath(call.getString("path", "/") ?: "/")
        val (path, query) = splitPathAndQuery(normalizedPath)

        if (method == "GET" && path == "/api/foreground-service") {
            respond(call, 200, buildForegroundServiceStatusPayload())
            return
        }

        if (method == "PUT" && path == "/api/foreground-service") {
            val body = call.getObject("body")
            if (body == null || !body.has("enabled")) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Foreground service payload must include enabled:boolean")
                    },
                )
                return
            }
            val enabled = body.optBoolean("enabled", true)
            ForegroundSyncService.setEnabled(context, enabled)
            respond(call, 200, buildForegroundServiceStatusPayload(enabled))
            return
        }

        if (method == "PUT" && path == "/api/foreground-service/worker-status") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Worker status payload must be an object")
                    },
                )
                return
            }

            val worker = body.optString("worker", "").trim()
            val state = body.optString("state", "").trim()
            if (worker.isEmpty() || state.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Worker status payload requires worker and state")
                    },
                )
                return
            }

            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = worker,
                state = state,
                scopeId = body.optString("scopeId", "").trim(),
                detail = body.optString("detail", "").trim(),
                progress = body.optBoolean("progress", false),
                claimed = body.optBoolean("claimed", false),
                lastError = body.optString("lastError", "").trim(),
            )
            respond(call, 200, buildForegroundServiceStatusPayload())
            return
        }

        if (method == "GET" && path == "/api/background-jobs/claim") {
            val limit = readIntQueryParam(query, "limit", 4)
            val leaseMs = readLongQueryParam(query, "leaseMs", 12_000L)
            val type = readQueryParam(query, "type")
            val claimed = backgroundJobs.claimDueJobs(limit, leaseMs, type)
            val jobs = JSONArray().apply {
                for (job in claimed) {
                    put(backgroundJobToJsObject(job))
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("jobs", jobs)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/background-jobs") {
            val status = readQueryParam(query, "status")
            val limit = readIntQueryParam(query, "limit", 50)
            val rows = backgroundJobs.listJobs(status, limit)
            val jobs = JSONArray().apply {
                for (job in rows) {
                    put(backgroundJobToJsObject(job))
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("jobs", jobs)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-jobs/ensure-recurring") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job payload must be an object")
                    },
                )
                return
            }

            val id = body.optString("id", "").trim()
            val type = body.optString("type", "").trim()
            val runAtMs = body.optLong("runAtMs", System.currentTimeMillis())
            val maxAttempts = body.optInt("maxAttempts", 0)
            val payloadJson = parsePayloadJson(body.opt("payload"))

            if (id.isEmpty() || type.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job requires id and type")
                    },
                )
                return
            }

            val ensured = backgroundJobs.ensureRecurringJob(
                id = id,
                type = type,
                payloadJson = payloadJson,
                runAtMs = runAtMs,
                maxAttempts = maxAttempts,
            )
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("job", backgroundJobToJsObject(ensured))
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-jobs/reschedule") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job reschedule payload must be an object")
                    },
                )
                return
            }

            val id = body.optString("id", "").trim()
            if (id.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job id is required")
                    },
                )
                return
            }
            val runAtMs = body.optLong("runAtMs", System.currentTimeMillis())
            val incrementAttempts = body.optBoolean("incrementAttempts", false)
            val lastError = body.optString("lastError", "").trim().ifEmpty { null }
            val updated = backgroundJobs.rescheduleJob(id, runAtMs, incrementAttempts, lastError)
            respond(
                call,
                if (updated) 200 else 404,
                JSObject().apply {
                    put("ok", updated)
                    if (!updated) {
                        put("error", "Background job not found")
                    }
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-jobs/complete") {
            val body = call.getObject("body")
            val id = body?.optString("id", "")?.trim() ?: ""
            if (id.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job id is required")
                    },
                )
                return
            }
            val updated = backgroundJobs.completeJob(id)
            respond(
                call,
                if (updated) 200 else 404,
                JSObject().apply {
                    put("ok", updated)
                    if (!updated) {
                        put("error", "Background job not found")
                    }
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-jobs/cancel") {
            val body = call.getObject("body")
            val id = body?.optString("id", "")?.trim() ?: ""
            if (id.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Background job id is required")
                    },
                )
                return
            }
            val updated = backgroundJobs.cancelJob(id)
            respond(
                call,
                if (updated) 200 else 404,
                JSObject().apply {
                    put("ok", updated)
                    if (!updated) {
                        put("error", "Background job not found")
                    }
                },
            )
            return
        }

        if (method == "GET" && path == "/api/background-runtime/desired-state") {
            val taskType = readQueryParam(query, "taskType")
            val scopeId = readQueryParam(query, "scopeId")
            val states = JSONArray()
            if (!taskType.isNullOrBlank() && !scopeId.isNullOrBlank()) {
                val single = backgroundRuntime.getDesiredState(taskType.trim(), scopeId.trim())
                if (single != null) {
                    states.put(backgroundDesiredStateToJsObject(single))
                }
            } else {
                val rows = backgroundRuntime.listDesiredStates(taskType)
                for (row in rows) {
                    if (!scopeId.isNullOrBlank() && row.scopeId != scopeId.trim()) {
                        continue
                    }
                    states.put(backgroundDesiredStateToJsObject(row))
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("states", states)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/desired-state") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Desired-state payload must be an object")
                    },
                )
                return
            }
            val taskType = body.optString("taskType", "").trim()
            val scopeId = body.optString("scopeId", "").trim()
            if (taskType.isEmpty() || scopeId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Desired-state payload requires taskType and scopeId")
                    },
                )
                return
            }
            val enabled = body.optBoolean("enabled", false)
            val payloadJson = parsePayloadJson(body.opt("payload"))
            val existingState = backgroundRuntime.getDesiredState(taskType, scopeId)
            if (
                existingState != null &&
                    existingState.enabled == enabled &&
                    existingState.payloadJson.trim() == payloadJson.trim()
            ) {
                respond(
                    call,
                    200,
                    JSObject().apply {
                        put("ok", true)
                        put("state", backgroundDesiredStateToJsObject(existingState))
                    },
                )
                return
            }
            val updated = backgroundRuntime.upsertDesiredState(
                taskType = taskType,
                scopeId = scopeId,
                enabled = enabled,
                payloadJson = payloadJson,
            )
            if (!enabled) {
                when (taskType) {
                    ForegroundSyncService.WORKER_TOPIC_GENERATION ->
                        TopicGenerationNativeExecutor.requestCancellation(scopeId)
                    ForegroundSyncService.WORKER_GROUP_ITERATION ->
                        GroupIterationNativeExecutor.requestCancellation(scopeId)
                }
                backgroundJobs.cancelJob("$taskType:$scopeId")
            } else {
                when (taskType) {
                    ForegroundSyncService.WORKER_TOPIC_GENERATION ->
                        TopicGenerationNativeExecutor.clearCancellation(scopeId)
                    ForegroundSyncService.WORKER_GROUP_ITERATION ->
                        GroupIterationNativeExecutor.clearCancellation(scopeId)
                }
            }
            backgroundRuntime.appendEvent(
                taskType = taskType,
                scopeId = scopeId,
                jobId = null,
                stage = "desired_state_updated",
                level = "info",
                message = "Desired state updated",
                detailsJson =
                    JSONObject().apply {
                        put("enabled", enabled)
                        put("payload", parsePayloadToAny(payloadJson))
                    }.toString(),
            )
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("state", backgroundDesiredStateToJsObject(updated))
                },
            )
            ForegroundSyncService.triggerNow(context, "desired_state")
            return
        }

        if (method == "GET" && path == "/api/background-runtime/delta") {
            val sinceId = readLongQueryParam(query, "sinceId", 0L)
            val limit = readIntQueryParam(query, "limit", 200)
            val taskType = readQueryParam(query, "taskType")
            val scopeIds = readScopeIdsQueryParam(query, "scopeIds")
            val includeGlobal = readBooleanQueryParam(query, "includeGlobal", true)
            val rows =
                backgroundRuntime.listDelta(
                    sinceId = sinceId,
                    limit = limit,
                    taskType = taskType,
                    scopeIds = scopeIds,
                    includeGlobalScope = includeGlobal,
                )
            var nextSinceId = maxOf(0L, sinceId)
            val items = JSONArray().apply {
                for (row in rows) {
                    put(backgroundDeltaToJsObject(row))
                    if (row.id > nextSinceId) {
                        nextSinceId = row.id
                    }
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("items", items)
                    put("nextSinceId", nextSinceId)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/background-runtime/image-assets") {
            val requestedIds =
                readScopeIdsQueryParam(query, "ids")
                    .map { value -> value.trim() }
                    .filter { value -> value.isNotEmpty() }
                    .distinct()
            val limit = readIntQueryParam(query, "limit", 80).coerceIn(1, 300)
            val targetIds =
                if (requestedIds.size > limit) {
                    requestedIds.take(limit)
                } else {
                    requestedIds
                }
            val imageAssets = readStoreArray("imageAssets")
            val assetById = mutableMapOf<String, JSONObject>()
            for (index in 0 until imageAssets.length()) {
                val item = imageAssets.optJSONObject(index) ?: continue
                val assetId = item.optString("id", "").trim()
                if (assetId.isNotEmpty() && !assetById.containsKey(assetId)) {
                    assetById[assetId] = item
                }
            }
            val items = JSONArray()
            val missingIds = JSONArray()
            for (assetId in targetIds) {
                val asset = assetById[assetId]
                if (asset == null) {
                    missingIds.put(assetId)
                } else {
                    items.put(JSONObject(asset.toString()))
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("items", items)
                    put("missingIds", missingIds)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/delta/ack") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Delta ack payload must be an object")
                    },
                )
                return
            }
            val ackedUpToId = body.optLong("ackedUpToId", 0L)
            val taskType = body.optString("taskType", "").trim().ifEmpty { null }
            val deletedCount = backgroundRuntime.ackDeltaUpTo(ackedUpToId, taskType)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("ackedUpToId", maxOf(0L, ackedUpToId))
                    put("taskType", taskType)
                    put("deletedCount", deletedCount)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/trigger") {
            val body = call.getObject("body")
            val reason = body?.optString("reason", "")?.trim().orEmpty().ifEmpty { "manual" }
            ForegroundSyncService.triggerNow(context, reason)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/background-runtime/events") {
            val limit = readIntQueryParam(query, "limit", 120)
            val taskType = readQueryParam(query, "taskType")
            val scopeId = readQueryParam(query, "scopeId")
            val rows = backgroundRuntime.listEvents(
                limit = limit,
                taskType = taskType,
                scopeId = scopeId,
            )
            val events = JSONArray().apply {
                for (row in rows) {
                    put(backgroundRuntimeEventToJsObject(row))
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("events", events)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/events") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Runtime event payload must be an object")
                    },
                )
                return
            }
            val taskType = body.optString("taskType", "").trim()
            val scopeId = body.optString("scopeId", "").trim()
            val stage = body.optString("stage", "").trim()
            val message = body.optString("message", "").trim()
            val level = body.optString("level", "info").trim().ifEmpty { "info" }
            val jobId = body.optString("jobId", "").trim().ifEmpty { null }
            if (taskType.isEmpty() || scopeId.isEmpty() || stage.isEmpty() || message.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put(
                            "error",
                            "Runtime event payload requires taskType, scopeId, stage and message",
                        )
                    },
                )
                return
            }
            val detailsJson = parsePayloadJson(body.opt("details"))
            val created = backgroundRuntime.appendEvent(
                taskType = taskType,
                scopeId = scopeId,
                jobId = jobId,
                stage = stage,
                level = level,
                message = message,
                detailsJson = detailsJson,
            )
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("event", backgroundRuntimeEventToJsObject(created))
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/events/clear") {
            val body = call.getObject("body")
            val taskType = body?.optString("taskType", "")?.trim().orEmpty().ifEmpty { null }
            val scopeId = body?.optString("scopeId", "")?.trim().orEmpty().ifEmpty { null }
            val deleted = backgroundRuntime.clearEvents(taskType = taskType, scopeId = scopeId)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("deleted", deleted)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/settings") {
            val settingsEnvelope = JSObject()
            settingsEnvelope.put("ok", true)
            val settingsJson = repository.readSettingsJson()
            if (!settingsJson.isNullOrBlank()) {
                try {
                    settingsEnvelope.put("settings", JSObject(settingsJson))
                } catch (_: JSONException) {
                    settingsEnvelope.put("settings", null)
                }
            } else {
                settingsEnvelope.put("settings", null)
            }
            respond(call, 200, settingsEnvelope)
            return
        }

        if (method == "PUT" && path == "/api/settings") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Settings payload must be an object")
                    },
                )
                return
            }
            repository.writeSettingsJson(body.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/personas") {
            val personasEnvelope = JSObject()
            personasEnvelope.put("ok", true)
            personasEnvelope.put("personas", readPersonasArray())
            respond(call, 200, personasEnvelope)
            return
        }

        if (method == "PUT" && path.startsWith("/api/personas/")) {
            val personaId = path.removePrefix("/api/personas/").trim()
            if (personaId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "personaId is required")
                    },
                )
                return
            }
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Persona payload must be an object")
                    },
                )
                return
            }
            val nextPersonas = upsertPersona(personaId, body)
            repository.writePersonasJson(nextPersonas.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "DELETE" && path.startsWith("/api/personas/")) {
            val personaId = path.removePrefix("/api/personas/").trim()
            if (personaId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "personaId is required")
                    },
                )
                return
            }
            val nextPersonas = deletePersona(personaId)
            repository.writePersonasJson(nextPersonas.toString())
            val currentChats = readChatsArray()
            val nextChats = JSONArray()
            val removedChatIds = mutableSetOf<String>()
            for (index in 0 until currentChats.length()) {
                val item = currentChats.optJSONObject(index)
                if (item == null) continue
                val chatPersonaId = item.optString("personaId", "").trim()
                val chatId = item.optString("id", "").trim()
                if (chatPersonaId != personaId) {
                    nextChats.put(item)
                } else if (chatId.isNotEmpty()) {
                    removedChatIds.add(chatId)
                }
            }
            repository.writeChatsJson(nextChats.toString())
            val nextMessages = deleteMessagesByChatIds(removedChatIds)
            repository.writeMessagesJson(nextMessages.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/chats") {
            val personaIdFilter = readQueryParam(query, "personaId")
            val source = readChatsArray()
            val filtered = JSONArray()
            for (index in 0 until source.length()) {
                val item = source.optJSONObject(index)
                if (item == null) continue
                val personaId = item.optString("personaId", "").trim()
                if (personaIdFilter.isNullOrBlank() || personaId == personaIdFilter) {
                    filtered.put(item)
                }
            }
            val chatsEnvelope = JSObject()
            chatsEnvelope.put("ok", true)
            chatsEnvelope.put("chats", filtered)
            respond(call, 200, chatsEnvelope)
            return
        }

        if (method == "PUT" && path.startsWith("/api/chats/")) {
            val chatId = path.removePrefix("/api/chats/").trim()
            if (chatId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "chatId is required")
                    },
                )
                return
            }
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Chat payload must be an object")
                    },
                )
                return
            }
            val personaId = body.optString("personaId", "").trim()
            if (personaId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Chat payload must include personaId")
                    },
                )
                return
            }
            val nextChats = upsertChat(chatId, body)
            repository.writeChatsJson(nextChats.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "DELETE" && path.startsWith("/api/chats/")) {
            val chatId = path.removePrefix("/api/chats/").trim()
            if (chatId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "chatId is required")
                    },
                )
                return
            }
            val nextChats = deleteChat(chatId)
            repository.writeChatsJson(nextChats.toString())
            val nextMessages = deleteMessagesByChatIds(setOf(chatId))
            repository.writeMessagesJson(nextMessages.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/messages") {
            val chatIdFilter = readQueryParam(query, "chatId")
            val source = readMessagesArray()
            val filtered = JSONArray()
            for (index in 0 until source.length()) {
                val item = source.optJSONObject(index)
                if (item == null) continue
                val chatId = item.optString("chatId", "").trim()
                if (chatIdFilter.isNullOrBlank() || chatId == chatIdFilter) {
                    filtered.put(item)
                }
            }
            val messagesEnvelope = JSObject()
            messagesEnvelope.put("ok", true)
            messagesEnvelope.put("messages", filtered)
            respond(call, 200, messagesEnvelope)
            return
        }

        if (method == "PUT" && path.startsWith("/api/messages/")) {
            val messageId = path.removePrefix("/api/messages/").trim()
            if (messageId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "messageId is required")
                    },
                )
                return
            }
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Message payload must be an object")
                    },
                )
                return
            }
            val chatId = body.optString("chatId", "").trim()
            if (chatId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Message payload must include chatId")
                    },
                )
                return
            }
            val nextMessages = upsertMessage(messageId, body)
            repository.writeMessagesJson(nextMessages.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "DELETE" && path.startsWith("/api/messages/")) {
            val messageId = path.removePrefix("/api/messages/").trim()
            if (messageId.isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "messageId is required")
                    },
                )
                return
            }
            val nextMessages = deleteMessage(messageId)
            repository.writeMessagesJson(nextMessages.toString())
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "GET" && path == "/api/raw-snapshot") {
            val requestedStoreNames = parseRequestedStoreNames(query)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("stores", exportRawStores(requestedStoreNames))
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/background-runtime/context") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Runtime context payload must be an object")
                    },
                )
                return
            }
            val bodyJson = try {
                JSONObject(body.toString())
            } catch (_: JSONException) {
                null
            }
            val storesJson = bodyJson?.optJSONObject("stores")
            if (storesJson == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Runtime context payload must include object stores")
                    },
                )
                return
            }
            val modeRaw = bodyJson.optString("mode", "merge").trim().lowercase()
            val mode = if (modeRaw == "replace") "replace" else "merge"
            applyStoresPayload(storesJson, mode)
            TopicGenerationNativeExecutor.maybeRunImageAssetGc(repository)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            ForegroundSyncService.triggerNow(context, "runtime_context")
            return
        }

        if (method == "PUT" && path == "/api/raw-snapshot") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Raw snapshot payload must be an object")
                    },
                )
                return
            }
            val bodyJson = try {
                JSONObject(body.toString())
            } catch (_: JSONException) {
                null
            }
            val storesJson = bodyJson?.optJSONObject("stores")
            if (storesJson == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Raw snapshot payload must include object stores")
                    },
                )
                return
            }
            val modeRaw = bodyJson.optString("mode", "merge").trim().lowercase()
            val mode = if (modeRaw == "replace") "replace" else "merge"
            applyStoresPayload(storesJson, mode)
            TopicGenerationNativeExecutor.maybeRunImageAssetGc(repository)
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                },
            )
            return
        }

        if (method == "PUT" && path == "/api/export-file") {
            val body = call.getObject("body")
            if (body == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Export payload must be an object")
                    },
                )
                return
            }
            val rawFileName = body.optString("fileName", "")
            val rawMimeType = body.optString("mimeType", "")
            val rawDataBase64 = body.optString("dataBase64", "")
            if (rawDataBase64.trim().isEmpty()) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Export payload must include dataBase64")
                    },
                )
                return
            }

            val fileName = sanitizeExportFileName(rawFileName)
            val mimeType = resolveExportMimeType(fileName, rawMimeType)
            val bytes = decodeExportBase64Payload(rawDataBase64)
            if (bytes == null) {
                respond(
                    call,
                    400,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Export dataBase64 is invalid")
                    },
                )
                return
            }

            val savedAs = writeExportBytesToDevice(fileName, mimeType, bytes)
            if (savedAs.isNullOrBlank()) {
                respond(
                    call,
                    500,
                    JSObject().apply {
                        put("ok", false)
                        put("error", "Failed to persist export file on device")
                    },
                )
                return
            }

            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("fileName", fileName)
                    put("mimeType", mimeType)
                    put("savedAs", savedAs)
                },
            )
            return
        }

        respond(
            call,
            404,
            JSObject().apply {
                put("ok", false)
                put("error", "Not implemented: $method $path")
            },
        )
    }
}
