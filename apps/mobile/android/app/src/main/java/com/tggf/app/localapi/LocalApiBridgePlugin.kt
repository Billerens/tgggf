package com.tggf.app.localapi

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONArray
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "LocalApi")
class LocalApiBridgePlugin : Plugin() {
    companion object {
        @Volatile
        private var activePluginRef: WeakReference<LocalApiBridgePlugin>? = null

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

    private val repository by lazy { LocalRepository(context) }
    private val backgroundJobs by lazy { BackgroundJobRepository(context) }

    override fun load() {
        super.load()
        activePluginRef = WeakReference(this)
        ForegroundSyncService.ensureStartedIfEnabled(context)
    }

    override fun handleOnDestroy() {
        if (activePluginRef?.get() === this) {
            activePluginRef = null
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
            val key = URLDecoder.decode(keyRaw, StandardCharsets.UTF_8)
            if (key == name) {
                return URLDecoder.decode(valueRaw, StandardCharsets.UTF_8).trim()
            }
        }
        return null
    }

    private fun readIntQueryParam(query: String?, name: String, fallback: Int): Int {
        val raw = readQueryParam(query, name) ?: return fallback
        return raw.toIntOrNull() ?: fallback
    }

    private fun readLongQueryParam(query: String?, name: String, fallback: Long): Long {
        val raw = readQueryParam(query, name) ?: return fallback
        return raw.toLongOrNull() ?: fallback
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

    private fun respond(call: PluginCall, status: Int, body: Any?) {
        val payload = JSObject()
        payload.put("status", status)
        payload.put("body", body)
        call.resolve(payload)
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

    private fun exportRawStores(): JSONObject {
        val stores = JSONObject()
        val storeNames = repository.knownStoreNames().toList().sorted()
        for (storeName in storeNames) {
            stores.put(storeName, readStoreArray(storeName))
        }
        return stores
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
            val workerStatuses = JSONArray().apply {
                for (snapshot in ForegroundSyncService.getWorkerStatusSnapshots()) {
                    val stale = ForegroundSyncService.isWorkerSnapshotStale(
                        snapshot = snapshot,
                        nowMs = System.currentTimeMillis(),
                    )
                    put(
                        JSObject().apply {
                            put("worker", snapshot.worker)
                            put("state", snapshot.state)
                            put("scopeId", snapshot.scopeId)
                            put("detail", snapshot.detail)
                            put("heartbeatAtMs", snapshot.heartbeatAtMs)
                            put("progressAtMs", snapshot.progressAtMs)
                            put("claimAtMs", snapshot.claimAtMs)
                            put("lastError", snapshot.lastError)
                            put("stale", stale)
                        },
                    )
                }
            }
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("enabled", ForegroundSyncService.isEnabled(context))
                    put("running", ForegroundSyncService.isRunning())
                    put("heartbeatIntervalMs", ForegroundSyncService.HEARTBEAT_INTERVAL_MS)
                    put("workers", workerStatuses)
                },
            )
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
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("enabled", enabled)
                    put("running", ForegroundSyncService.isRunning())
                    put("heartbeatIntervalMs", ForegroundSyncService.HEARTBEAT_INTERVAL_MS)
                },
            )
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

            val workerStatuses = JSONArray().apply {
                for (snapshot in ForegroundSyncService.getWorkerStatusSnapshots()) {
                    val stale = ForegroundSyncService.isWorkerSnapshotStale(
                        snapshot = snapshot,
                        nowMs = System.currentTimeMillis(),
                    )
                    put(
                        JSObject().apply {
                            put("worker", snapshot.worker)
                            put("state", snapshot.state)
                            put("scopeId", snapshot.scopeId)
                            put("detail", snapshot.detail)
                            put("heartbeatAtMs", snapshot.heartbeatAtMs)
                            put("progressAtMs", snapshot.progressAtMs)
                            put("claimAtMs", snapshot.claimAtMs)
                            put("lastError", snapshot.lastError)
                            put("stale", stale)
                        },
                    )
                }
            }

            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("enabled", ForegroundSyncService.isEnabled(context))
                    put("running", ForegroundSyncService.isRunning())
                    put("heartbeatIntervalMs", ForegroundSyncService.HEARTBEAT_INTERVAL_MS)
                    put("workers", workerStatuses)
                },
            )
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
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
                    put("stores", exportRawStores())
                },
            )
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
            respond(
                call,
                200,
                JSObject().apply {
                    put("ok", true)
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
