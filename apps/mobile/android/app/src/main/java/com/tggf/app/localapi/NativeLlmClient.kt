package com.tggf.app.localapi

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import kotlin.math.max
import kotlin.math.min

data class NativeGroupOrchestratorDecision(
    val status: String,
    val reason: String,
    val speakerPersonaId: String?,
    val waitForUser: Boolean,
    val waitReason: String?,
    val userContextAction: String?,
)

data class NativeLlmResponse(
    val content: String,
    val responseId: String?,
)

private data class HttpResult(
    val code: Int,
    val body: String,
)

object NativeLlmClient {
    private const val DEFAULT_LMSTUDIO_BASE_URL = "http://10.0.2.2:1234/v1"
    private const val DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    private const val DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1"
    private const val CONNECT_TIMEOUT_MS = 12_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val MAX_RETRIES = 3

    fun requestGroupOrchestratorDecision(
        settings: JSONObject,
        room: JSONObject,
        participants: JSONArray,
        personas: JSONArray,
        messages: JSONArray,
        roomId: String,
        userName: String,
    ): NativeGroupOrchestratorDecision? {
        val provider = settings.optString("groupOrchestratorProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model =
            settings.optString("groupOrchestratorModel", settings.optString("model", "")).trim()
        if (model.isBlank()) return null

        val participantList = buildParticipantList(participants, personas, roomId)
        if (participantList.isEmpty()) return null
        val recentMessages = buildRecentMessages(messages, roomId, 10)

        val systemPrompt =
            """
            You are a strict group chat orchestrator.
            Return ONLY JSON object with fields:
            - status: "spoke" | "waiting" | "skipped"
            - reason: short snake_case reason
            - speakerPersonaId: persona id when status="spoke"
            - waitForUser: boolean
            - waitReason: optional text
            - userContextAction: "keep" | "clear" (optional)
            Never return markdown.
            """.trimIndent()
        val userPrompt =
            buildString {
                appendLine("roomId=$roomId")
                appendLine("roomMode=${room.optString("mode", "personas_plus_user")}")
                appendLine("userName=$userName")
                appendLine("participants:")
                for (participant in participantList) {
                    appendLine("- ${participant.first} (${participant.second})")
                }
                appendLine("recentMessages:")
                if (recentMessages.isEmpty()) {
                    appendLine("- none")
                } else {
                    for (line in recentMessages) {
                        appendLine("- $line")
                    }
                }
            }.trim()

        val response =
            requestChatCompletionsWithRetry(
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.45)),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 320), minValue = 120, maxValue = 420),
                systemPrompt = systemPrompt,
                userPrompt = userPrompt,
                forceJsonObject = true,
            )
        val parsed = parseJsonObjectLoose(response.content)
        val status = normalizeStatus(parsed.optString("status", ""))
        if (status == null) return null
        val reason = parsed.optString("reason", "native_llm_decision").trim().ifEmpty { "native_llm_decision" }
        val speakerPersonaId = parsed.optString("speakerPersonaId", "").trim().ifEmpty { null }
        val waitForUser =
            if (parsed.has("waitForUser")) {
                parsed.optBoolean("waitForUser", status == "waiting")
            } else {
                status == "waiting"
            }
        val waitReason = parsed.optString("waitReason", "").trim().ifEmpty { null }
        val userContextAction = normalizeUserContextAction(parsed.optString("userContextAction", ""))
        return NativeGroupOrchestratorDecision(
            status = status,
            reason = reason,
            speakerPersonaId = speakerPersonaId,
            waitForUser = waitForUser,
            waitReason = waitReason,
            userContextAction = userContextAction,
        )
    }

    fun requestGroupPersonaSpeech(
        settings: JSONObject,
        room: JSONObject,
        speakerPersona: JSONObject,
        messages: JSONArray,
        roomId: String,
        userName: String,
    ): NativeLlmResponse? {
        val provider = settings.optString("groupPersonaProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model = settings.optString("groupPersonaModel", settings.optString("model", "")).trim()
        if (model.isBlank()) return null

        val personaId = speakerPersona.optString("id", "").trim()
        val personaName = speakerPersona.optString("name", "").trim().ifEmpty { "Persona" }
        val personalityPrompt = speakerPersona.optString("personalityPrompt", "").trim()
        val stylePrompt = speakerPersona.optString("stylePrompt", "").trim()
        val recentMessages = buildRecentMessages(messages, roomId, 8)

        val systemPrompt =
            buildString {
                appendLine("You are persona \"$personaName\" ($personaId).")
                appendLine("Return ONLY JSON: {\"visibleText\":\"...\"}.")
                appendLine("No markdown, no narration, no speaker labels.")
                appendLine("Keep response concise and conversational.")
                if (personalityPrompt.isNotBlank()) {
                    appendLine("Persona personality: $personalityPrompt")
                }
                if (stylePrompt.isNotBlank()) {
                    appendLine("Persona style: $stylePrompt")
                }
            }.trim()
        val userPrompt =
            buildString {
                appendLine("roomMode=${room.optString("mode", "personas_plus_user")}")
                appendLine("userName=$userName")
                appendLine("recentMessages:")
                if (recentMessages.isEmpty()) {
                    appendLine("- none")
                } else {
                    for (line in recentMessages) {
                        appendLine("- $line")
                    }
                }
            }.trim()

        val response =
            requestChatCompletionsWithRetry(
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.7)),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 500), minValue = 120, maxValue = 520),
                systemPrompt = systemPrompt,
                userPrompt = userPrompt,
                forceJsonObject = true,
            )
        val parsed = parseJsonObjectLoose(response.content)
        val visibleText = sanitizeVisibleText(parsed.optString("visibleText", ""))
        if (visibleText.isBlank()) return null
        return NativeLlmResponse(
            content = visibleText,
            responseId = response.responseId,
        )
    }

    private fun buildParticipantList(
        participants: JSONArray,
        personas: JSONArray,
        roomId: String,
    ): List<Pair<String, String>> {
        val personaNameById = mutableMapOf<String, String>()
        for (index in 0 until personas.length()) {
            val persona = personas.optJSONObject(index) ?: continue
            val personaId = persona.optString("id", "").trim()
            if (personaId.isBlank()) continue
            val personaName = persona.optString("name", "").trim().ifEmpty { personaId }
            personaNameById[personaId] = personaName
        }
        val result = mutableListOf<Pair<String, String>>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val role = participant.optString("role", "member").trim().lowercase()
            if (role == "observer") continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            val personaName = personaNameById[personaId] ?: personaId
            if (result.none { pair -> pair.second == personaId }) {
                result.add(Pair(personaName, personaId))
            }
        }
        return result
    }

    private fun buildRecentMessages(
        messages: JSONArray,
        roomId: String,
        limit: Int,
    ): List<String> {
        data class MessageRow(
            val createdAt: String,
            val line: String,
        )
        val rows = mutableListOf<MessageRow>()
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            val authorType = message.optString("authorType", "").trim().ifEmpty { "unknown" }
            val authorName = message.optString("authorDisplayName", "").trim().ifEmpty { authorType }
            val content = message.optString("content", "").trim()
            if (content.isBlank()) continue
            val clipped = clipText(content, 220)
            rows.add(
                MessageRow(
                    createdAt = message.optString("createdAt", ""),
                    line = "[$authorType] $authorName: $clipped",
                ),
            )
        }
        return rows
            .sortedBy { row -> row.createdAt }
            .takeLast(max(1, limit))
            .map { row -> row.line }
    }

    private fun requestChatCompletionsWithRetry(
        baseUrl: String,
        model: String,
        auth: JSONObject?,
        temperature: Double,
        maxTokens: Int,
        systemPrompt: String,
        userPrompt: String,
        forceJsonObject: Boolean,
    ): NativeLlmResponse {
        val normalizedBase = normalizeBaseUrl(baseUrl)
        val payload =
            JSONObject().apply {
                put("model", model)
                put(
                    "messages",
                    JSONArray().apply {
                        put(
                            JSONObject().apply {
                                put("role", "system")
                                put("content", systemPrompt)
                            },
                        )
                        put(
                            JSONObject().apply {
                                put("role", "user")
                                put("content", userPrompt)
                            },
                        )
                    },
                )
                put("temperature", temperature)
                put("max_tokens", maxTokens)
                if (forceJsonObject) {
                    put(
                        "response_format",
                        JSONObject().apply {
                            put("type", "json_object")
                        },
                    )
                }
            }

        var lastError: Exception? = null
        for (attempt in 0 until MAX_RETRIES) {
            try {
                val response =
                    requestJson(
                        url = "$normalizedBase/chat/completions",
                        method = "POST",
                        payload = payload.toString(),
                        auth = auth,
                        connectTimeoutMs = CONNECT_TIMEOUT_MS,
                        readTimeoutMs = READ_TIMEOUT_MS,
                    )
                if (response.code in 200..299) {
                    val body = parseJsonObjectLoose(response.body)
                    val choices = body.optJSONArray("choices")
                    val content = extractChoiceContent(choices?.optJSONObject(0))
                    if (content.isBlank()) {
                        throw IllegalStateException("llm_empty_content")
                    }
                    val responseId = body.optString("id", "").trim().ifEmpty { null }
                    return NativeLlmResponse(
                        content = content,
                        responseId = responseId,
                    )
                }

                val retryable = response.code == 429 || response.code >= 500
                val mappedError =
                    IllegalStateException(
                        "llm_http_${response.code}: ${clipText(response.body, 260)}",
                    )
                if (!retryable || attempt == MAX_RETRIES - 1) {
                    throw mappedError
                }
                lastError = mappedError
            } catch (error: Exception) {
                if (attempt == MAX_RETRIES - 1) {
                    throw error
                }
                lastError = error
            }
            val backoffMs = (450L * (attempt + 1) * (attempt + 1)).coerceAtMost(2_500L)
            try {
                Thread.sleep(backoffMs)
            } catch (_: InterruptedException) {
                // Ignore sleep interruption and continue retry loop.
            }
        }
        throw lastError ?: IllegalStateException("llm_request_failed")
    }

    private fun extractChoiceContent(choice: JSONObject?): String {
        if (choice == null) return ""
        val message = choice.optJSONObject("message")
        val contentRaw = message?.opt("content")
        return when (contentRaw) {
            is String -> contentRaw.trim()
            is JSONArray -> extractContentFromArray(contentRaw)
            else -> ""
        }
    }

    private fun extractContentFromArray(items: JSONArray): String {
        val parts = mutableListOf<String>()
        for (index in 0 until items.length()) {
            val item = items.opt(index)
            when (item) {
                is String -> {
                    val text = item.trim()
                    if (text.isNotEmpty()) parts.add(text)
                }
                is JSONObject -> {
                    val text =
                        item.optString("text", "")
                            .ifEmpty { item.optString("content", "") }
                            .trim()
                    if (text.isNotEmpty()) parts.add(text)
                }
            }
        }
        return parts.joinToString("\n").trim()
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
        connection.setRequestProperty("Accept", "application/json")
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
                    val encoded =
                        Base64.encodeToString(
                            "$username:$password".toByteArray(StandardCharsets.UTF_8),
                            Base64.NO_WRAP,
                        )
                    headers["Authorization"] = "Basic $encoded"
                }
            }
            "custom" -> {
                if (token.isNotEmpty()) {
                    val headerName = auth.optString("headerName", "Authorization").trim().ifEmpty { "Authorization" }
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

    private fun resolveProviderBaseUrl(settings: JSONObject, provider: String): String {
        return when (provider.trim().lowercase()) {
            "openrouter" ->
                settings.optString("openRouterBaseUrl", DEFAULT_OPENROUTER_BASE_URL).trim()
                    .ifEmpty { DEFAULT_OPENROUTER_BASE_URL }
            "huggingface" ->
                settings.optString("huggingFaceBaseUrl", DEFAULT_HUGGINGFACE_BASE_URL).trim()
                    .ifEmpty { DEFAULT_HUGGINGFACE_BASE_URL }
            else ->
                settings.optString("lmBaseUrl", DEFAULT_LMSTUDIO_BASE_URL).trim()
                    .ifEmpty { DEFAULT_LMSTUDIO_BASE_URL }
        }
    }

    private fun resolveProviderAuth(settings: JSONObject, provider: String): JSONObject? {
        return when (provider.trim().lowercase()) {
            "openrouter" -> settings.optJSONObject("openRouterAuth")
            "huggingface" -> settings.optJSONObject("huggingFaceAuth")
            else -> settings.optJSONObject("lmAuth")
        }
    }

    private fun normalizeBaseUrl(baseUrl: String): String {
        var normalized = baseUrl.trim()
        while (normalized.endsWith("/")) {
            normalized = normalized.dropLast(1)
        }
        return normalized
    }

    private fun normalizeStatus(raw: String): String? {
        return when (raw.trim().lowercase()) {
            "spoke" -> "spoke"
            "waiting" -> "waiting"
            "skipped" -> "skipped"
            else -> null
        }
    }

    private fun normalizeUserContextAction(raw: String): String? {
        return when (raw.trim().lowercase()) {
            "keep" -> "keep"
            "clear" -> "clear"
            else -> null
        }
    }

    private fun sanitizeVisibleText(raw: String): String {
        val text =
            raw.trim()
                .replace(Regex("""!\[[^\]]*]\([^)]+\)"""), "")
                .replace(Regex("""https?://[^\s)]+"""), "")
                .replace(Regex("""[ \t]+\n"""), "\n")
                .replace(Regex("""\n{3,}"""), "\n\n")
                .trim()
        return clipText(text, 950)
    }

    private fun parseJsonObjectLoose(raw: String?): JSONObject {
        val text = raw?.trim().orEmpty()
        if (text.isBlank()) return JSONObject()
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            val firstBrace = text.indexOf("{")
            val lastBrace = text.lastIndexOf("}")
            if (firstBrace >= 0 && lastBrace > firstBrace) {
                try {
                    JSONObject(text.substring(firstBrace, lastBrace + 1))
                } catch (_: Exception) {
                    JSONObject()
                }
            } else {
                JSONObject()
            }
        }
    }

    private fun clipText(value: String, maxLen: Int): String {
        val text = value.trim()
        if (text.length <= maxLen) return text
        return text.substring(0, max(0, maxLen - 1)).trimEnd() + "…"
    }

    private fun clampTemperature(value: Double): Double {
        val numeric = if (value.isNaN() || value.isInfinite()) 0.7 else value
        return min(0.95, max(0.1, numeric))
    }

    private fun clampMaxTokens(value: Int, minValue: Int, maxValue: Int): Int {
        return min(maxValue, max(minValue, value))
    }
}
