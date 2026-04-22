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
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

data class NativeGroupOrchestratorDecision(
    val status: String,
    val reason: String,
    val speakerPersonaId: String?,
    val waitForUser: Boolean,
    val waitReason: String?,
    val userContextAction: String?,
    val llmDebug: NativeLlmCallDebug?,
)

data class NativeLlmResponse(
    val content: String,
    val responseId: String?,
    val comfyPrompt: String?,
    val comfyPrompts: List<String>,
    val comfyImageDescription: String?,
    val comfyImageDescriptions: List<String>,
    val llmDebug: NativeLlmCallDebug?,
)

data class NativeLlmCallDebug(
    val toolModeRequested: Boolean,
    val toolModeActive: Boolean,
    val expectedToolName: String?,
    val actualToolName: String?,
    val responseSource: String,
    val fallbackReason: String?,
    val httpStatus: Int?,
    val parsedField: String?,
)

data class NativeTopicThemedPrompt(
    val prompt: String,
    val themeTags: List<String>,
    val llmDebug: NativeLlmCallDebug?,
)

data class NativeTopicThemedPrompts(
    val prompts: List<String>,
    val themeTags: List<String>,
    val llmDebug: NativeLlmCallDebug?,
)

data class NativeOneToOneTurnResponse(
    val content: String,
    val responseId: String?,
    val comfyPrompt: String?,
    val comfyPrompts: List<String>,
    val comfyImageDescription: String?,
    val comfyImageDescriptions: List<String>,
    val personaControl: JSONObject?,
    val llmDebug: NativeLlmCallDebug?,
)

data class NativeConversationSummaryState(
    val summary: String,
    val facts: List<String>,
    val goals: List<String>,
    val openThreads: List<String>,
    val agreements: List<String>,
)

data class NativeOneToOneDiaryDraft(
    val shouldWrite: Boolean,
    val entries: List<NativeOneToOneDiaryEntryDraft>,
)

data class NativeOneToOneDiaryEntryDraft(
    val markdown: String,
    val tags: List<String>,
)

data class NativeSummaryTranscriptEntry(
    val role: String,
    val content: String,
    val createdAt: String?,
)

private data class HttpResult(
    val code: Int,
    val body: String,
)

private data class LlmChoiceExtractionResult(
    val content: String,
    val source: String,
    val toolName: String?,
)

private data class ToolCallArgumentsResult(
    val arguments: String,
    val toolName: String?,
)

private data class NamedStringEntry(
    val key: String,
    val value: String,
)

private data class LlmToolDefinition(
    val name: String,
    val description: String,
    val parameters: JSONObject,
)

private data class ParsedImageDescriptionContext(
    val type: String,
    val participants: String,
    val participantTokens: List<String>,
    val participantAliases: Map<String, String>,
    val subjectLocks: Map<String, String>,
    val includesPersona: Boolean,
    val normalizedDescription: String,
)

data class ParticipantAppearanceLocks(
    val hair: String,
    val eyes: String,
    val face: String,
    val body: String,
    val outfit: String,
    val markers: String,
)

data class ComfyPromptParticipantCatalogEntry(
    val id: String,
    val alias: String,
    val isSelf: Boolean,
    val compactAppearanceLocks: ParticipantAppearanceLocks,
)

object NativeLlmClient {
    private const val DEFAULT_LMSTUDIO_BASE_URL = "http://10.0.2.2:1234/v1"
    private const val DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    private const val DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1"
    private const val CONNECT_TIMEOUT_MS = 12_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val MAX_RETRIES = 3
    private const val SUMMARY_TARGET_TOKENS_MIN = 600
    private const val SUMMARY_TARGET_TOKENS_MAX = 16000
    private const val SUMMARY_RESPONSE_MAX_OUTPUT_TOKENS = 16000
    private const val SUMMARY_MAX_CHARS_CAP = 96_000
    private const val SUMMARY_FACTS_MAX_ITEMS = 24
    private const val SUMMARY_FACTS_MAX_LEN = 320
    private const val SUMMARY_GOALS_MAX_ITEMS = 18
    private const val SUMMARY_GOALS_MAX_LEN = 320
    private const val SUMMARY_OPEN_THREADS_MAX_ITEMS = 24
    private const val SUMMARY_OPEN_THREADS_MAX_LEN = 420
    private const val SUMMARY_AGREEMENTS_MAX_ITEMS = 20
    private const val SUMMARY_AGREEMENTS_MAX_LEN = 420

    private data class OrchestratorParticipantProfile(
        val personaId: String,
        val name: String,
        val archetype: String,
        val character: String,
        val voiceTone: String,
        val lexicalStyle: String,
        val sentenceLength: String,
        val formality: Int,
        val expressiveness: Int,
        val emoji: Int,
        val initiative: Int,
        val curiosity: Int,
        val empathy: Int,
        val appearance: String,
    )

    private val mentionTokenCleanupRegex =
        Regex("[.,!?;:()\\[\\]{}\"'`~@#\\$%^&*+=<>/\\\\|-]+")

    fun requestGroupOrchestratorDecision(
        settings: JSONObject,
        room: JSONObject,
        participants: JSONArray,
        personas: JSONArray,
        messages: JSONArray,
        events: JSONArray,
        roomId: String,
        userName: String,
    ): NativeGroupOrchestratorDecision? {
        val provider = settings.optString("groupOrchestratorProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model =
            settings.optString("groupOrchestratorModel", settings.optString("model", "")).trim()
        if (model.isBlank()) return null

        val participantProfiles = buildOrchestratorParticipantProfiles(participants, personas, roomId)
        if (participantProfiles.isEmpty()) return null
        val participantNameById = participantProfiles.associate { it.personaId to it.name }

        val focusedUserMessage = resolveFocusedUserMessage(messages, room, roomId)
        val mentionPriorityHints = buildMentionPriorityHints(focusedUserMessage, participantNameById, userName)
        val participantRuntimeHints =
            buildParticipantRuntimeHints(
                participants = participants,
                participantProfiles = participantProfiles,
                roomId = roomId,
            )
        val recentMessageLines =
            buildRecentMessageLines(
                messages = messages,
                roomId = roomId,
                limit = 8,
                contentMaxLen = 500,
            )
        val recentEventLines =
            buildRecentEventLines(
                events = events,
                roomId = roomId,
                limit = 8,
                payloadMaxLen = 200,
            )

        val systemPrompt =
            buildGroupOrchestratorSystemPrompt(
                room = room,
                userName = userName,
                participants = participantProfiles,
            )
        val userPrompt =
            buildGroupOrchestratorUserPrompt(
                lastUserMessageContent = focusedUserMessage?.optString("content", "").orEmpty(),
                mentionPriorityHints = mentionPriorityHints,
                participantRuntimeHints = participantRuntimeHints,
                recentMessageLines = recentMessageLines,
                recentEventLines = recentEventLines,
            )

        val response =
            requestChatCompletionsWithRetry(
                provider = provider,
                openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.45), minValue = 0.15, maxValue = 0.7),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 320), minValue = 120, maxValue = 320),
                systemPrompt = systemPrompt,
                userPrompt = userPrompt,
                forceJsonObject = true,
                toolDefinition = buildGroupOrchestratorToolDefinition(),
            )
        val parsed = parseJsonObjectLoose(response.content)
        val status = normalizeStatus(parsed.optString("status", ""))
        if (status == null) return null
        val reason = parsed.optString("reason", "llm_orchestrator_decision").trim().ifEmpty { "llm_orchestrator_decision" }
        val speakerPersonaId =
            parsed.optString("speakerPersonaId", parsed.optString("speaker_persona_id", ""))
                .trim()
                .ifEmpty { null }
        val waitForUser =
            if (parsed.has("waitForUser") || parsed.has("wait_for_user")) {
                if (parsed.has("waitForUser")) {
                    parsed.optBoolean("waitForUser", status == "waiting")
                } else {
                    parsed.optBoolean("wait_for_user", status == "waiting")
                }
            } else {
                status == "waiting"
            }
        val waitReason =
            parsed.optString("waitReason", parsed.optString("wait_reason", ""))
                .trim()
                .ifEmpty { null }
        val userContextAction =
            normalizeUserContextAction(
                parsed.optString("userContextAction", parsed.optString("user_context_action", "")),
            )
        return NativeGroupOrchestratorDecision(
            status = status,
            reason = reason,
            speakerPersonaId = speakerPersonaId,
            waitForUser = waitForUser,
            waitReason = waitReason,
            userContextAction = userContextAction,
            llmDebug = response.llmDebug,
        )
    }

    fun requestGroupPersonaSpeech(
        settings: JSONObject,
        room: JSONObject,
        speakerPersona: JSONObject,
        participants: JSONArray,
        personas: JSONArray,
        messages: JSONArray,
        events: JSONArray,
        personaStates: JSONArray,
        relationEdges: JSONArray,
        sharedMemories: JSONArray,
        privateMemories: JSONArray,
        roomId: String,
        userName: String,
    ): NativeLlmResponse? {
        val provider = settings.optString("groupPersonaProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model = settings.optString("groupPersonaModel", settings.optString("model", "")).trim()
        if (model.isBlank()) return null

        val personaId = speakerPersona.optString("id", "").trim()
        val previousResponseId = findLastPersonaResponseId(events, roomId, personaId)
        val participantNameById = buildParticipantNameMap(participants, personas, roomId)
        val participantNames =
            participantNameById
                .filterKeys { it != personaId }
                .values
                .filter { it.isNotBlank() }
                .distinct()
                .toList()

        val focusedUserMessage = resolveFocusedUserMessage(messages, room, roomId)
        val mentionContext = buildMentionContext(focusedUserMessage, personaId)
        val recentMessageLines =
            buildRecentMessageLines(
                messages = messages,
                roomId = roomId,
                limit = if (previousResponseId == null) 8 else 5,
                contentMaxLen = 500,
            )
        val relationLines =
            buildRelationLines(
                relationEdges = relationEdges,
                roomId = roomId,
                fromPersonaId = personaId,
                participantNameById = participantNameById,
                limit = 8,
            )
        val sharedMemoryLines =
            buildMemoryLines(
                memories = sharedMemories,
                roomId = roomId,
                personaId = null,
                limit = 5,
            )
        val privateMemoryLines =
            buildMemoryLines(
                memories = privateMemories,
                roomId = roomId,
                personaId = personaId,
                limit = 5,
            )
        val recentEventLines =
            buildRecentEventLines(
                events = events,
                roomId = roomId,
                limit = 6,
                payloadMaxLen = 220,
            )
        val personaState =
            findPersonaState(
                personaStates = personaStates,
                roomId = roomId,
                personaId = personaId,
            )
        val personaStateLine =
            buildPersonaStateLine(personaState)
        val influencePromptContext = formatInfluenceProfileForPrompt(personaState)

        val systemPrompt =
            buildGroupPersonaSystemPrompt(
                room = room,
                speakerPersona = speakerPersona,
                userName = userName,
                participantNames = participantNames,
                influencePromptContext = influencePromptContext,
            )
        val userPrompt =
            buildGroupPersonaUserPrompt(
                userName = userName,
                lastUserMessageContent = focusedUserMessage?.optString("content", "").orEmpty(),
                recentMessageLines = recentMessageLines,
                personaStateLine = personaStateLine,
                influencePromptContext = influencePromptContext,
                relationLines = relationLines,
                sharedMemoryLines = sharedMemoryLines,
                privateMemoryLines = privateMemoryLines,
                recentEventLines = recentEventLines,
                mentionContext = mentionContext,
            )

        val response =
            requestChatCompletionsWithRetry(
                provider = provider,
                openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.7), minValue = 0.25, maxValue = 0.9),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 500), minValue = 120, maxValue = 500),
                systemPrompt = systemPrompt,
                userPrompt = userPrompt,
                forceJsonObject = true,
                toolDefinition = buildGroupPersonaTurnToolDefinition(),
            )
        val parsed = parseJsonObjectLoose(response.content)
        val visibleTextEntry =
            readFirstNonBlankEntry(
                parsed,
                "visibleText",
                "visible_text",
                "speech",
                "text",
                "reply",
                "message",
            )
        val visibleTextRaw = visibleTextEntry?.value.orEmpty()
        var visibleText = sanitizeVisibleText(visibleTextRaw)
        var parsedVisibleField = visibleTextEntry?.key
        if (visibleText.isBlank()) {
            val rawContent = response.content.trim()
            val looksLikeStructuredPayload = rawContent.startsWith("{") || rawContent.startsWith("[")
            if (!looksLikeStructuredPayload) {
                visibleText = sanitizeVisibleText(rawContent)
                if (visibleText.isNotBlank()) {
                    parsedVisibleField = "raw_content_fallback"
                }
            }
        }
        val llmDebug = response.llmDebug?.copy(parsedField = parsedVisibleField)
        val comfyPrompts =
            parseStringArrayFlexible(parsed.opt("comfyPrompts"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfy_prompts")) }
                .ifEmpty {
                    parsed.optString("comfyPrompt", parsed.optString("comfy_prompt", ""))
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val comfyImageDescriptions =
            parseStringArrayFlexible(parsed.opt("comfyImageDescriptions"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfy_image_descriptions")) }
                .ifEmpty {
                    parsed.optString("comfyImageDescription", parsed.optString("comfy_image_description", ""))
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        return NativeLlmResponse(
            content = visibleText,
            responseId = response.responseId,
            comfyPrompt = comfyPrompts.firstOrNull(),
            comfyPrompts = comfyPrompts,
            comfyImageDescription = comfyImageDescriptions.firstOrNull(),
            comfyImageDescriptions = comfyImageDescriptions,
            llmDebug = llmDebug,
        )
    }

    fun requestOneToOneChatTurn(
        settings: JSONObject,
        persona: JSONObject,
        userInput: String,
        recentMessages: JSONArray,
        runtimeState: JSONObject?,
        memoryCard: JSONObject?,
        conversationSummary: JSONObject?,
        evolutionHistoryApplied: List<JSONObject> = emptyList(),
    ): NativeOneToOneTurnResponse? {
        val provider = settings.optString("oneToOneProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model = settings.optString("model", "").trim()
        if (model.isBlank()) return null

        val response =
            requestChatCompletionsWithRetry(
                provider = provider,
                openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.72), minValue = 0.2, maxValue = 0.95),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 620), minValue = 180, maxValue = 1200),
                systemPrompt =
                    buildOneToOneSystemPrompt(
                        settings = settings,
                        persona = persona,
                        runtimeState = runtimeState,
                        memoryCard = memoryCard,
                        conversationSummary = conversationSummary,
                        evolutionHistoryApplied = evolutionHistoryApplied,
                    ),
                userPrompt =
                    buildOneToOneUserPrompt(
                        userInput = userInput,
                        recentMessages = recentMessages,
                    ),
                forceJsonObject = true,
                toolDefinition = buildOneToOneChatTurnToolDefinition(),
            )
        val parsed = parseJsonObjectLoose(response.content)
        val visibleTextEntry =
            readFirstNonBlankEntry(
                parsed,
                "visibleText",
                "visible_text",
                "speech",
                "text",
                "reply",
                "message",
            )
        var visibleText = sanitizeVisibleText(visibleTextEntry?.value.orEmpty())
        var parsedVisibleField = visibleTextEntry?.key
        if (visibleText.isBlank()) {
            val rawContent = response.content.trim()
            val looksLikeStructuredPayload = rawContent.startsWith("{") || rawContent.startsWith("[")
            if (!looksLikeStructuredPayload) {
                visibleText = sanitizeVisibleText(rawContent)
                if (visibleText.isNotBlank()) {
                    parsedVisibleField = "raw_content_fallback"
                }
            }
        }
        val comfyPrompts =
            parseStringArrayFlexible(parsed.opt("comfyPrompts"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfy_prompts")) }
                .ifEmpty {
                    parsed.optString("comfyPrompt", parsed.optString("comfy_prompt", ""))
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val comfyImageDescriptions =
            parseStringArrayFlexible(parsed.opt("comfyImageDescriptions"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfy_image_descriptions")) }
                .ifEmpty {
                    parsed.optString("comfyImageDescription", parsed.optString("comfy_image_description", ""))
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val personaControl =
            parsed.optJSONObject("personaControl")
                ?: parsed.optJSONObject("persona_control")
                ?: parseOptionalJsonObjectFromAny(parsed.opt("personaControl"))
                ?: parseOptionalJsonObjectFromAny(parsed.opt("persona_control"))

        return NativeOneToOneTurnResponse(
            content = visibleText,
            responseId = response.responseId,
            comfyPrompt = comfyPrompts.firstOrNull(),
            comfyPrompts = comfyPrompts,
            comfyImageDescription = comfyImageDescriptions.firstOrNull(),
            comfyImageDescriptions = comfyImageDescriptions,
            personaControl = personaControl,
            llmDebug = response.llmDebug?.copy(parsedField = parsedVisibleField),
        )
    }

    fun requestOneToOneSummaryUpdate(
        settings: JSONObject,
        persona: JSONObject,
        existing: NativeConversationSummaryState,
        transcript: List<NativeSummaryTranscriptEntry>,
        targetTokens: Int,
    ): NativeConversationSummaryState? {
        if (transcript.isEmpty()) return existing
        val provider = settings.optString("oneToOneProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model = settings.optString("model", "").trim()
        if (model.isBlank()) return null

        val safeTargetTokens = targetTokens.coerceIn(SUMMARY_TARGET_TOKENS_MIN, SUMMARY_TARGET_TOKENS_MAX)
        val responseMaxTokens =
            ((safeTargetTokens * 1.2).roundToInt()).coerceIn(900, SUMMARY_RESPONSE_MAX_OUTPUT_TOKENS)
        val systemPrompt =
            listOf(
                "Ты компонент суммаризации 1:1 чата между пользователем и персоной.",
                "Верни ТОЛЬКО JSON-объект без markdown и пояснений.",
                "Формат: {\"summary\":\"...\",\"facts\":[\"...\"],\"goals\":[\"...\"],\"openThreads\":[\"...\"],\"agreements\":[\"...\"]}",
                "Пиши на русском языке, фактически и нейтрально.",
                "Работай ИНКРЕМЕНТАЛЬНО: аккуратно обновляй текущее состояние, а не переписывай с нуля.",
                "Сначала учти existing summary и только затем добавляй/правь по новым сообщениям.",
                "summary — связная выжимка прошлого контекста, без художественных добавлений.",
                "В summary обязательно сохраняй динамику отношений персона <-> пользователь: доверие, тон, границы, устойчивые паттерны общения.",
                "Если важная часть истории отношений уже была в existing и не опровергнута, НЕ удаляй ее.",
                "facts — устойчивые факты о пользователе/контексте (без одноразовых команд).",
                "facts должны быть атомарными и проверяемыми; при конфликте заменяй старый факт новым явным фактом.",
                "goals — цели и намерения пользователя, если они явно есть.",
                "goals переноси из existing, пока цель не выполнена/не отменена явно.",
                "openThreads — незавершенные темы/вопросы/задачи.",
                "openThreads должны сохранять незакрытые линии из existing; удаляй пункт только если он явно закрыт.",
                "agreements — явные договоренности и решения.",
                "agreements сохраняют устойчивые договоренности (стиль общения, правила, обещания, ограничения); не теряй их без явной отмены.",
                "Если openThreads закрыт через решение, перенеси итог в agreements.",
                "Не дублируй один и тот же пункт разными формулировками.",
                "Не выдумывай факты и не добавляй то, чего нет в existing или новых сообщениях.",
                "Если данных для списка нет — верни пустой массив.",
                "Ограничь общий объем summary примерно до $safeTargetTokens токенов или меньше.",
            ).joinToString("\n")
        val existingJson =
            JSONObject().apply {
                put("summary", existing.summary)
                put("facts", JSONArray(existing.facts))
                put("goals", JSONArray(existing.goals))
                put("openThreads", JSONArray(existing.openThreads))
                put("agreements", JSONArray(existing.agreements))
            }.toString()
        val input =
            buildString {
                appendLine("Персона: ${persona.optString("name", "Персона").trim().ifEmpty { "Персона" }}")
                appendLine("Целевой бюджет токенов для summary: $safeTargetTokens")
                appendLine()
                appendLine("Текущее состояние summary (можно сжать/переписать):")
                appendLine(existingJson)
                appendLine()
                appendLine("Новые сообщения для инкрементального учета:")
                transcript.forEach { entry ->
                    val roleLabel = if (entry.role == "assistant") "Персона" else "Пользователь"
                    val createdAt = entry.createdAt?.trim().orEmpty().ifBlank { "unknown" }
                    appendLine("$roleLabel [time=$createdAt]: ${entry.content.trim()}")
                }
            }.trim()

        return try {
            val response =
                requestChatCompletionsWithRetry(
                    provider = provider,
                    openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                    baseUrl = baseUrl,
                    model = model,
                    auth = resolveProviderAuth(settings, provider),
                    temperature = clampTemperature(settings.optDouble("temperature", 0.25), minValue = 0.1, maxValue = 0.4),
                    maxTokens = responseMaxTokens,
                    systemPrompt = systemPrompt,
                    userPrompt = input,
                    forceJsonObject = true,
                    toolDefinition = null,
                )
            val parsed = parseJsonObjectLoose(response.content)
            if (parsed.length() == 0) return existing
            val maxSummaryChars = (safeTargetTokens * 5.5).roundToInt().coerceIn(800, SUMMARY_MAX_CHARS_CAP)
            val summaryRaw =
                readFirstNonBlankEntry(parsed, "summary")?.value?.trim().orEmpty()
            val summary =
                when {
                    summaryRaw.isBlank() -> existing.summary
                    summaryRaw.length <= maxSummaryChars -> summaryRaw
                    else -> "${summaryRaw.take(maxSummaryChars - 1).trimEnd()}…"
                }
            NativeConversationSummaryState(
                summary = summary,
                facts =
                    normalizeSummaryListWithFallback(
                        root = parsed,
                        key = "facts",
                        fallback = existing.facts,
                        maxItems = SUMMARY_FACTS_MAX_ITEMS,
                        maxLen = SUMMARY_FACTS_MAX_LEN,
                    ),
                goals =
                    normalizeSummaryListWithFallback(
                        root = parsed,
                        key = "goals",
                        fallback = existing.goals,
                        maxItems = SUMMARY_GOALS_MAX_ITEMS,
                        maxLen = SUMMARY_GOALS_MAX_LEN,
                    ),
                openThreads =
                    normalizeSummaryListWithFallback(
                        root = parsed,
                        key = "openThreads",
                        fallback = existing.openThreads,
                        maxItems = SUMMARY_OPEN_THREADS_MAX_ITEMS,
                        maxLen = SUMMARY_OPEN_THREADS_MAX_LEN,
                    ),
                agreements =
                    normalizeSummaryListWithFallback(
                        root = parsed,
                        key = "agreements",
                        fallback = existing.agreements,
                        maxItems = SUMMARY_AGREEMENTS_MAX_ITEMS,
                        maxLen = SUMMARY_AGREEMENTS_MAX_LEN,
                    ),
            )
        } catch (_: Exception) {
            existing
        }
    }

    fun requestOneToOneDiaryEntry(
        settings: JSONObject,
        persona: JSONObject,
        chatTitle: String,
        existing: NativeConversationSummaryState,
        transcript: List<NativeSummaryTranscriptEntry>,
        existingTags: List<String> = emptyList(),
        evolutionHistoryApplied: List<JSONObject> = emptyList(),
    ): NativeOneToOneDiaryDraft? {
        if (transcript.isEmpty()) return null
        val provider = settings.optString("oneToOneProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model = settings.optString("model", "").trim()
        if (model.isBlank()) return null
        val normalizedExistingTags =
            existingTags
                .map { value -> value.trim() }
                .filter { value -> value.isNotBlank() }
                .distinct()
                .take(200)

        // Keep in sync with src/lmstudio.ts::requestOneToOneDiaryEntry.
        val systemPrompt =
            listOf(
                "Ты модуль дневника персоны для 1:1 чата.",
                "Твоя задача: решить, стоит ли сейчас писать запись в дневник.",
                "Если писать нечего (нет новых заметных эмоций/впечатлений/событий), верни shouldWrite=false.",
                "Если писать стоит, верни shouldWrite=true и entries (массив атомарных записей).",
                "Каждый элемент entries — самостоятельная запись с полями markdown и tags.",
                "Одна запись должна описывать один отдельный момент/эпизод, без склейки разных тем в один блок.",
                "КРИТИЧНО: не объединяй весь диалог в одну длинную запись.",
                "Если есть несколько самостоятельных эпизодов/поворотов/эмоциональных сдвигов, ОБЯЗАТЕЛЬНО разбей их на отдельные entries.",
                "Предпочтительно несколько коротких entries вместо одного длинного эссе.",
                "Стиль: личный дневник живого человека.",
                "Тон естественный: тепло, уязвимо, лично, иногда с самоиронией; без официоза и без сухого отчета.",
                "Можно аккуратно добавлять внутренние секреты, личные детали и образные формулировки, если это органично персоне и контексту.",
                "Формат каждой записи: короткий цельный фрагмент 1-2 абзаца, обычно 3-6 предложений.",
                "НЕ используй подзаголовки, секции и заголовки markdown (`#`, `##`, `###`) внутри markdown записи.",
                "НЕ используй нумерованные разделы вида «1., 2., 3.» внутри одной записи.",
                "Запрещены длинные многочастные монологи формата «сначала..., потом..., затем...» в одном entry.",
                "Не повторяй слово в слово предыдущие формулировки summary.",
                "Пиши на русском языке.",
                "В КАЖДОЙ записи tags должны быть максимально конкретными и узкими, в формате prefix:value.",
                "Для каждой записи верни содержательные non-date теги (дата добавится вне модели).",
                "Обычно достаточно 2-6 тегов на запись, но не обрезай искусственно, если нужно больше.",
                "Избегай широких и абстрактных тегов вроде topic:отношения, emotion:чувства, decision:доверие.",
                "Теги должны помогать точечно находить запись, а не описывать жизнь в целом.",
                "Тебе передан список existingTags. При логическом совпадении ОБЯЗАТЕЛЬНО переиспользуй уже существующий тег.",
                "Создавай новый тег только если в existingTags нет подходящей формулировки для конкретной сущности.",
                "Допустимые prefix: ${DiaryTagSpec.PREFIXES_TEXT}.",
                "Возвращай только JSON.",
                "Формат: {\"shouldWrite\":true|false,\"entries\":[{\"markdown\":\"...\",\"tags\":[\"topic:...\",\"emotion:...\"]}]}",
                "Не возвращай markdown/tags на верхнем уровне JSON.",
                "Не выдумывай факты, которых нет в контексте.",
            ).joinToString("\n")

        val existingJson =
            JSONObject().apply {
                put("summary", existing.summary)
                put("facts", JSONArray(existing.facts))
                put("goals", JSONArray(existing.goals))
                put("openThreads", JSONArray(existing.openThreads))
                put("agreements", JSONArray(existing.agreements))
            }.toString()

        val userPrompt =
            buildString {
                appendLine("Персона: ${persona.optString("name", "Персона").trim().ifEmpty { "Персона" }}")
                appendLine("Чат: ${chatTitle.trim().ifEmpty { "Без названия" }}")
                appendLine()
                appendLine("Applied persona evolution history (last 10):")
                appendLine(formatPersonaEvolutionHistoryForPrompt(evolutionHistoryApplied))
                appendLine()
                appendLine("existingTags (используй повторно при семантическом совпадении):")
                appendLine(JSONArray(normalizedExistingTags).toString())
                appendLine()
                appendLine("Текущее summary чата:")
                appendLine(existingJson)
                appendLine()
                appendLine("Новые сообщения (последние релевантные):")
                transcript.forEach { entry ->
                    val roleLabel = if (entry.role == "assistant") "Персона" else "Пользователь"
                    val createdAt = formatMessageContextTime(entry.createdAt)
                    appendLine("$roleLabel [time=$createdAt]: ${entry.content.trim()}")
                }
            }.trim()

        return try {
            val response =
                requestChatCompletionsWithRetry(
                    provider = provider,
                    openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                    baseUrl = baseUrl,
                    model = model,
                    auth = resolveProviderAuth(settings, provider),
                    temperature = clampTemperature(settings.optDouble("temperature", 0.55), minValue = 0.2, maxValue = 0.75),
                    maxTokens = clampMaxTokens(settings.optInt("maxTokens", 2200), minValue = 600, maxValue = 3200),
                    systemPrompt = systemPrompt,
                    userPrompt = userPrompt,
                    forceJsonObject = true,
                    toolDefinition = null,
                )
            val parsed = parseJsonObjectLoose(response.content)
            if (parsed.length() == 0) return null
            val shouldWrite = parsed.optBoolean("shouldWrite", false)
            val entries =
                parsed
                    .optJSONArray("entries")
                    ?.let { rawEntries ->
                        val normalized = mutableListOf<NativeOneToOneDiaryEntryDraft>()
                        for (index in 0 until rawEntries.length()) {
                            val item = rawEntries.optJSONObject(index) ?: continue
                            val markdown = item.optString("markdown", "").trim()
                            if (markdown.isBlank()) continue
                            val tags =
                                parseStringArrayFlexible(item.opt("tags"))
                                    .map { value -> value.trim() }
                                    .filter { value -> value.isNotBlank() }
                                    .distinct()
                            normalized.add(
                                NativeOneToOneDiaryEntryDraft(
                                    markdown = markdown,
                                    tags = tags,
                                ),
                            )
                        }
                        normalized
                    } ?: emptyList()
            if (!shouldWrite) {
                NativeOneToOneDiaryDraft(
                    shouldWrite = false,
                    entries = emptyList(),
                )
            } else {
                NativeOneToOneDiaryDraft(
                    shouldWrite = true,
                    entries = entries,
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    fun generateComfyPromptsFromImageDescriptions(
        settings: JSONObject,
        speakerPersona: JSONObject,
        imageDescriptions: List<String>,
        participantCatalog: List<ComfyPromptParticipantCatalogEntry> = emptyList(),
        evolutionHistoryApplied: List<JSONObject> = emptyList(),
    ): List<String> {
        val descriptions =
            imageDescriptions
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinct()
        if (descriptions.isEmpty()) return emptyList()

        val provider = settings.optString("imagePromptProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model =
            settings
                .optString("imagePromptModel", settings.optString("model", ""))
                .trim()
        if (model.isBlank()) return emptyList()

        val auth = resolveProviderAuth(settings, provider)
        val personaName = speakerPersona.optString("name", "").trim().ifEmpty { "Unknown" }
        val stylePrompt = clipText(speakerPersona.optString("stylePrompt", "").trim(), 440).ifBlank { "-" }
        val personalityPrompt =
            clipText(speakerPersona.optString("personalityPrompt", "").trim(), 440).ifBlank { "-" }
        val toolDefinition = buildComfyPromptConversionToolDefinition()
        val appearance = speakerPersona.optJSONObject("appearance")
        val lookPromptCache = speakerPersona.optJSONObject("lookPromptCache")
        val systemPrompt = buildImageDescriptionToComfyPromptSystemPrompt()
        val normalizedCatalog = normalizeParticipantCatalog(participantCatalog)
        val participantTokenMap = buildParticipantCatalogTokenMap(normalizedCatalog)
        val selfTokens = mutableSetOf("persona:self")
        normalizedCatalog
            .filter { it.isSelf }
            .forEach { selfTokens.add("persona:${it.id}") }
        val participantCatalogContext = formatParticipantCatalogContext(normalizedCatalog)
        val evolutionHistoryContext = formatPersonaEvolutionHistoryForPrompt(evolutionHistoryApplied)

        val prompts = mutableListOf<String>()
        for ((index, description) in descriptions.withIndex()) {
            val sceneContext =
                resolveImageDescriptionContract(
                    settings = settings,
                    description = description,
                    iteration = index + 1,
                    participantCatalog = normalizedCatalog,
                )
            val shouldUsePersonaContext =
                sceneContext.type == "person" ||
                    (
                        sceneContext.type == "group" &&
                            sceneContext.participantTokens.any { token -> selfTokens.contains(token) }
                    )
            val appearanceContext =
                if (shouldUsePersonaContext) {
                    formatAppearanceProfileInput(appearance)
                } else {
                    "N/A (persona appearance is disabled for this type)"
                }
            val lookPromptCacheContext =
                if (shouldUsePersonaContext) {
                    formatLookPromptCacheInput(lookPromptCache)
                } else {
                    "DISABLED (persona identity prior must not be used for this type)"
                }
            val participantAliasesContext = formatParticipantAliasesContext(sceneContext)
            val subjectLocksContext = formatSubjectLocksContext(sceneContext)
            val resolvedParticipantLocksContext =
                if (sceneContext.participantTokens.isEmpty()) {
                    "none"
                } else {
                    sceneContext.participantTokens.joinToString("\n") { token ->
                        val mapped = participantTokenMap[token]
                        val alias =
                            sceneContext.participantAliases[token]?.trim().orEmpty().ifBlank {
                                mapped?.alias?.trim().orEmpty().ifBlank { token }
                            }
                        if (mapped != null) {
                            "$token | alias=$alias | source=catalog | ${formatCompactLocks(mapped.compactAppearanceLocks)}"
                        } else {
                            val lock = sceneContext.subjectLocks[token]?.trim().orEmpty().ifBlank { "-" }
                            "$token | alias=$alias | source=subject_locks | lock=$lock"
                        }
                    }
                }
            val response =
                requestChatCompletionsWithRetry(
                    provider = provider,
                    openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                    baseUrl = baseUrl,
                    model = model,
                    auth = auth,
                    temperature =
                        clampTemperature(
                            settings.optDouble("temperature", 0.55),
                            minValue = 0.35,
                            maxValue = 0.75,
                        ),
                    maxTokens = clampMaxTokens(settings.optInt("maxTokens", 520), minValue = 180, maxValue = 700),
                    systemPrompt = systemPrompt,
                    userPrompt =
                        buildImageDescriptionToComfyPromptUserPrompt(
                            personaName = personaName,
                            sceneType = sceneContext.type,
                            participants = sceneContext.participants,
                            participantAliases = participantAliasesContext,
                            subjectLocks = subjectLocksContext,
                            participantCatalog = participantCatalogContext,
                            resolvedParticipantLocks = resolvedParticipantLocksContext,
                            shouldUsePersonaContext = shouldUsePersonaContext,
                            appearanceContext = appearanceContext,
                            stylePrompt = stylePrompt,
                            personalityPrompt = personalityPrompt,
                            lookPromptCacheContext = lookPromptCacheContext,
                            imageDescription = sceneContext.normalizedDescription,
                            iteration = index + 1,
                            evolutionHistoryContext = evolutionHistoryContext,
                        ),
                    forceJsonObject = true,
                    toolDefinition = toolDefinition,
                )
            val payload = parseJsonObjectLoose(response.content)
            val extracted = extractComfyPromptsFromConversionPayload(payload, response.content)
            if (extracted.isEmpty()) {
                throw IllegalStateException("comfy_prompt_conversion_empty_response_${index + 1}")
            }
            prompts.addAll(extracted)
        }

        return prompts
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
    }

    fun generateThemedComfyPromptForTopic(
        settings: JSONObject,
        persona: JSONObject,
        topic: String,
        iteration: Int,
    ): NativeTopicThemedPrompt? {
        val prompts =
            generateThemedComfyPromptsForTopic(
                settings = settings,
                persona = persona,
                topic = topic,
                iteration = iteration,
                promptCount = 1,
            ) ?: return null
        val firstPrompt = prompts.prompts.firstOrNull()?.trim().orEmpty()
        if (firstPrompt.isBlank()) return null
        return NativeTopicThemedPrompt(
            prompt = firstPrompt,
            themeTags = prompts.themeTags,
            llmDebug = prompts.llmDebug,
        )
    }

    fun generateThemedComfyPromptsForTopic(
        settings: JSONObject,
        persona: JSONObject,
        topic: String,
        iteration: Int,
        promptCount: Int,
    ): NativeTopicThemedPrompts? {
        val normalizedTopic = topic.trim()
        if (normalizedTopic.isBlank()) return null
        val normalizedPromptCount = promptCount.coerceIn(1, 8)

        val provider =
            settings
                .optString("imagePromptProvider", "lmstudio")
                .trim()
                .ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model =
            settings
                .optString("imagePromptModel", settings.optString("model", ""))
                .trim()
        if (model.isBlank()) return null
        val auth = resolveProviderAuth(settings, provider)

        val response =
            requestChatCompletionsWithRetry(
                provider = provider,
                openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                baseUrl = baseUrl,
                model = model,
                auth = auth,
                temperature =
                    clampTemperature(
                        settings.optDouble("temperature", 0.55),
                        minValue = 0.35,
                        maxValue = 0.75,
                    ),
                maxTokens =
                    clampMaxTokens(
                        maxOf(
                            settings.optInt("maxTokens", 600),
                            700,
                            320 + normalizedPromptCount * 260,
                        ),
                        minValue = 320,
                        maxValue = 16384,
                    ),
                systemPrompt = buildThemedComfyPromptSystemPrompt(),
                userPrompt =
                    buildThemedComfyPromptUserPrompt(
                        persona = persona,
                        topic = normalizedTopic,
                        iteration = iteration,
                        promptCount = normalizedPromptCount,
                    ),
                forceJsonObject = true,
                toolDefinition = buildThemedComfyPromptToolDefinition(),
            )

        val parsed = parseJsonObjectLoose(response.content)
        val promptEntry = readFirstNonBlankEntry(parsed, "prompt", "comfy_prompt", "comfyPrompt")
        val promptCandidates = mutableListOf<String>()
        if (promptEntry != null) {
            promptCandidates.add(promptEntry.value)
        }
        promptCandidates.addAll(parseStringArrayFlexible(parsed.opt("comfy_prompts")))
        promptCandidates.addAll(parseStringArrayFlexible(parsed.opt("comfyPrompts")))
        if (promptCandidates.isEmpty()) {
            val rawFallback = response.content.trim()
            if (rawFallback.isNotBlank() && !rawFallback.startsWith("{") && !rawFallback.startsWith("[")) {
                promptCandidates.add(rawFallback)
            }
        }

        val themeTags =
            parseStringArrayFlexible(parsed.opt("theme_tags"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("themeTags")) }
                .ifEmpty { parseStringArrayFlexible(parsed.opt("tags")) }
                .ifEmpty { fallbackThemeTags(normalizedTopic) }
                .distinct()

        val mergedPrompts =
            promptCandidates
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .map { mergeRequiredTags(it, themeTags) }
                .distinct()
                .take(normalizedPromptCount)
        if (mergedPrompts.isEmpty()) {
            throw IllegalStateException("topic_themed_prompt_missing_prompt")
        }

        val parsedField =
            when {
                promptEntry != null -> promptEntry.key
                parseStringArrayFlexible(parsed.opt("comfy_prompts")).isNotEmpty() -> "comfy_prompts"
                parseStringArrayFlexible(parsed.opt("comfyPrompts")).isNotEmpty() -> "comfyPrompts"
                else -> "raw_content_fallback"
            }

        return NativeTopicThemedPrompts(
            prompts = mergedPrompts,
            themeTags = themeTags,
            llmDebug = response.llmDebug?.copy(parsedField = parsedField),
        )
    }

    private fun buildParticipantNameMap(
        participants: JSONArray,
        personas: JSONArray,
        roomId: String,
    ): Map<String, String> {
        val personaNameById = mutableMapOf<String, String>()
        for (index in 0 until personas.length()) {
            val persona = personas.optJSONObject(index) ?: continue
            val personaId = persona.optString("id", "").trim()
            if (personaId.isBlank()) continue
            val personaName = persona.optString("name", "").trim().ifEmpty { personaId }
            personaNameById[personaId] = personaName
        }
        val result = linkedMapOf<String, String>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            result[personaId] = personaNameById[personaId] ?: personaId
        }
        return result
    }

    private fun buildParticipantAppearanceLocks(appearance: JSONObject?): ParticipantAppearanceLocks {
        val source = appearance ?: JSONObject()
        return ParticipantAppearanceLocks(
            hair = source.optString("hair", "").trim(),
            eyes = source.optString("eyes", "").trim(),
            face = source.optString("faceDescription", "").trim(),
            body = source.optString("bodyType", "").trim(),
            outfit = source.optString("clothingStyle", "").trim(),
            markers = source.optString("markers", "").trim(),
        )
    }

    fun buildComfyParticipantCatalogForRoom(
        participants: JSONArray,
        personas: JSONArray,
        roomId: String,
        selfPersonaId: String?,
    ): List<ComfyPromptParticipantCatalogEntry> {
        val personaById = mutableMapOf<String, JSONObject>()
        for (index in 0 until personas.length()) {
            val persona = personas.optJSONObject(index) ?: continue
            val personaId = persona.optString("id", "").trim()
            if (personaId.isBlank()) continue
            personaById[personaId] = persona
        }
        val dedup = LinkedHashMap<String, ComfyPromptParticipantCatalogEntry>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            val persona = personaById[personaId] ?: continue
            val alias = persona.optString("name", "").trim().ifBlank { personaId }
            dedup[personaId] =
                ComfyPromptParticipantCatalogEntry(
                    id = personaId,
                    alias = alias,
                    isSelf = !selfPersonaId.isNullOrBlank() && selfPersonaId == personaId,
                    compactAppearanceLocks = buildParticipantAppearanceLocks(persona.optJSONObject("appearance")),
                )
        }
        if (!selfPersonaId.isNullOrBlank() && !dedup.containsKey(selfPersonaId)) {
            val selfPersona = personaById[selfPersonaId]
            if (selfPersona != null) {
                dedup[selfPersonaId] =
                    ComfyPromptParticipantCatalogEntry(
                        id = selfPersonaId,
                        alias = selfPersona.optString("name", "").trim().ifBlank { selfPersonaId },
                        isSelf = true,
                        compactAppearanceLocks = buildParticipantAppearanceLocks(selfPersona.optJSONObject("appearance")),
                    )
            }
        }
        return dedup.values.toList()
    }

    private fun buildOrchestratorParticipantProfiles(
        participants: JSONArray,
        personas: JSONArray,
        roomId: String,
    ): List<OrchestratorParticipantProfile> {
        val personaById = mutableMapOf<String, JSONObject>()
        for (index in 0 until personas.length()) {
            val persona = personas.optJSONObject(index) ?: continue
            val personaId = persona.optString("id", "").trim()
            if (personaId.isNotBlank()) {
                personaById[personaId] = persona
            }
        }
        val profiles = mutableListOf<OrchestratorParticipantProfile>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            val persona = personaById[personaId] ?: continue
            val personaName = persona.optString("name", "").trim().ifEmpty { personaId }
            profiles.add(
                OrchestratorParticipantProfile(
                    personaId = personaId,
                    name = personaName,
                    archetype = clipText(readNestedString(persona, "advanced", "core", "archetype"), 180),
                    character = clipText(persona.optString("personalityPrompt", "").trim(), 240),
                    voiceTone = clipText(readNestedString(persona, "advanced", "voice", "tone"), 120),
                    lexicalStyle = clipText(readNestedString(persona, "advanced", "voice", "lexicalStyle"), 144),
                    sentenceLength = normalizeSentenceLength(readNestedString(persona, "advanced", "voice", "sentenceLength")),
                    formality = readNestedInt(persona, 50, "advanced", "voice", "formality"),
                    expressiveness = readNestedInt(persona, 50, "advanced", "voice", "expressiveness"),
                    emoji = readNestedInt(persona, 35, "advanced", "voice", "emoji"),
                    initiative = readNestedInt(persona, 50, "advanced", "behavior", "initiative"),
                    curiosity = readNestedInt(persona, 50, "advanced", "behavior", "curiosity"),
                    empathy = readNestedInt(persona, 50, "advanced", "behavior", "empathy"),
                    appearance = summarizePersonaAppearance(persona),
                ),
            )
        }
        return profiles
    }

    private fun summarizePersonaAppearance(persona: JSONObject): String {
        val appearance = persona.optJSONObject("appearance") ?: JSONObject()
        val parts =
            listOf(
                appearance.optString("hair", "").trim(),
                appearance.optString("eyes", "").trim(),
                appearance.optString("bodyType", "").trim(),
                appearance.optString("clothingStyle", "").trim(),
            ).filter { it.isNotBlank() }
        return clipText(parts.joinToString(", "), 400)
    }

    private fun resolveFocusedUserMessage(messages: JSONArray, room: JSONObject, roomId: String): JSONObject? {
        if (room.has("orchestratorUserFocusMessageId")) {
            val marker =
                when (val raw = room.opt("orchestratorUserFocusMessageId")) {
                    is String -> raw.trim()
                    else -> ""
                }
            if (marker.isBlank()) {
                return null
            }
            for (index in 0 until messages.length()) {
                val message = messages.optJSONObject(index) ?: continue
                if (message.optString("roomId", "").trim() != roomId) continue
                if (!message.optString("authorType", "").trim().equals("user", ignoreCase = true)) continue
                if (message.optString("id", "").trim() == marker) {
                    return message
                }
            }
        }
        for (index in messages.length() - 1 downTo 0) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            if (!message.optString("authorType", "").trim().equals("user", ignoreCase = true)) continue
            return message
        }
        return null
    }

    private fun buildMentionPriorityHints(
        focusedUserMessage: JSONObject?,
        participantNameById: Map<String, String>,
        userName: String,
    ): List<String> {
        val hints = mutableListOf<String>()
        val mentions = focusedUserMessage?.optJSONArray("mentions") ?: JSONArray()
        for (index in 0 until mentions.length()) {
            val mention = mentions.optJSONObject(index) ?: continue
            val targetType = mention.optString("targetType", "").trim().lowercase()
            val targetId = mention.optString("targetId", "").trim()
            when (targetType) {
                "persona" -> {
                    val name = participantNameById[targetId] ?: continue
                    hints.add("persona:$name ($targetId)")
                }
                "user" -> hints.add("user:$userName")
            }
        }
        return hints.distinct()
    }

    private fun buildParticipantRuntimeHints(
        participants: JSONArray,
        participantProfiles: List<OrchestratorParticipantProfile>,
        roomId: String,
    ): List<String> {
        val profileById = participantProfiles.associateBy { it.personaId }
        val nowMs = System.currentTimeMillis()
        val hints = mutableListOf<String>()
        for (index in 0 until participants.length()) {
            val participant = participants.optJSONObject(index) ?: continue
            if (participant.optString("roomId", "").trim() != roomId) continue
            val personaId = participant.optString("personaId", "").trim()
            if (personaId.isBlank()) continue
            val profile = profileById[personaId] ?: continue
            val initiativeBias = participant.optInt("initiativeBias", 0)
            val aliveScore = participant.optInt("aliveScore", 0)
            val muteUntil = participant.optString("muteUntil", "").trim()
            val cooldown =
                if (muteUntil.isBlank()) {
                    "0"
                } else {
                    val parsedMuteUntilMs = parseIsoToMillisOrNull(muteUntil)
                    if (parsedMuteUntilMs == null) {
                        "NaN"
                    } else {
                        max(0L, parsedMuteUntilMs - nowMs).toString()
                    }
                }
            hints.add(
                "${profile.name} ($personaId): initiativeBias=$initiativeBias, aliveScore=$aliveScore, cooldownMs=$cooldown",
            )
        }
        return hints
    }

    private fun buildRecentMessageLines(
        messages: JSONArray,
        roomId: String,
        limit: Int,
        contentMaxLen: Int,
    ): List<String> {
        val lines = mutableListOf<String>()
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("roomId", "").trim() != roomId) continue
            val content = buildPromptMessageContent(message, contentMaxLen)
            val authorName = clipText(message.optString("authorDisplayName", "").trim(), 36)
            val authorType = message.optString("authorType", "").uppercase()
            val createdAt = message.optString("createdAt", "").trim().ifBlank { "unknown" }
            lines.add("$authorType $authorName [time=$createdAt]: $content")
        }
        return lines.takeLast(max(1, limit))
    }

    private fun buildPromptMessageContent(message: JSONObject, contentMaxLen: Int): String {
        val baseContent = clipText(message.optString("content", ""), contentMaxLen)
        val visualDescriptions =
            collectMessageVisualDescriptions(message)
                .take(2)
                .map { description -> clipText(description, 170) }
        val attachmentCount = message.optJSONArray("imageAttachments")?.length() ?: 0
        val contextParts = mutableListOf<String>()
        if (visualDescriptions.isNotEmpty()) {
            contextParts.add("visual_context: ${visualDescriptions.joinToString(" | ")}")
        }
        if (attachmentCount > 0) {
            contextParts.add("images_attached: $attachmentCount")
        }
        if (contextParts.isEmpty()) {
            return baseContent
        }
        val combined =
            if (baseContent.isNotBlank()) {
                "$baseContent [${contextParts.joinToString("; ")}]"
            } else {
                "[${contextParts.joinToString("; ")}]"
            }
        return clipText(combined, contentMaxLen + 260)
    }

    private fun collectMessageVisualDescriptions(message: JSONObject): List<String> {
        val values = mutableListOf<String>()
        values.addAll(parseStringArrayFlexible(message.opt("comfyImageDescriptions")))
        values.addAll(parseStringArrayFlexible(message.opt("comfy_image_descriptions")))
        val singleDescription =
            message
                .optString(
                    "comfyImageDescription",
                    message.optString("comfy_image_description", ""),
                ).trim()
        if (singleDescription.isNotBlank()) {
            values.add(singleDescription)
        }
        if (values.isEmpty()) return emptyList()

        val seen = mutableSetOf<String>()
        val deduped = mutableListOf<String>()
        for (value in values) {
            val normalized = value.trim()
            if (normalized.isBlank()) continue
            val key = normalized.lowercase()
            if (seen.contains(key)) continue
            seen.add(key)
            deduped.add(normalized)
        }
        return deduped
    }

    private fun buildRecentEventLines(
        events: JSONArray,
        roomId: String,
        limit: Int,
        payloadMaxLen: Int,
    ): List<String> {
        val lines = mutableListOf<String>()
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            val type = event.optString("type", "")
            lines.add("$type: ${compactPayload(event.opt("payload"), payloadMaxLen)}")
        }
        return lines.takeLast(max(1, limit))
    }

    private fun buildRelationLines(
        relationEdges: JSONArray,
        roomId: String,
        fromPersonaId: String,
        participantNameById: Map<String, String>,
        limit: Int,
    ): List<String> {
        val lines = mutableListOf<String>()
        for (index in 0 until relationEdges.length()) {
            val edge = relationEdges.optJSONObject(index) ?: continue
            if (edge.optString("roomId", "").trim() != roomId) continue
            if (edge.optString("fromPersonaId", "").trim() != fromPersonaId) continue
            val toPersonaId = edge.optString("toPersonaId", "").trim()
            if (toPersonaId.isBlank()) continue
            val name = participantNameById[toPersonaId] ?: toPersonaId
            lines.add(
                "$name: trust=${edge.optInt("trust", 50)}, affinity=${edge.optInt("affinity", 50)}, tension=${edge.optInt("tension", 0)}, respect=${edge.optInt("respect", 50)}",
            )
        }
        return lines.take(max(1, limit))
    }

    private fun buildMemoryLines(
        memories: JSONArray,
        roomId: String,
        personaId: String?,
        limit: Int,
    ): List<String> {
        val lines = mutableListOf<String>()
        for (index in 0 until memories.length()) {
            val memory = memories.optJSONObject(index) ?: continue
            if (memory.optString("roomId", "").trim() != roomId) continue
            if (personaId != null && memory.optString("personaId", "").trim() != personaId) continue
            val kind = memory.optString("kind", "").trim()
            val layer = memory.optString("layer", "").trim()
            val content = memory.optString("content", "").trim()
            if (content.isBlank()) continue
            lines.add("[${if (kind.isBlank()) "unknown" else kind}/${if (layer.isBlank()) "unknown" else layer}] $content")
        }
        return lines.takeLast(max(1, limit))
    }

    private fun findPersonaState(
        personaStates: JSONArray,
        roomId: String,
        personaId: String,
    ): JSONObject? {
        for (index in 0 until personaStates.length()) {
            val state = personaStates.optJSONObject(index) ?: continue
            if (state.optString("roomId", "").trim() != roomId) continue
            if (state.optString("personaId", "").trim() != personaId) continue
            return state
        }
        return null
    }

    private fun buildPersonaStateLine(state: JSONObject?): String {
        if (state == null) return "none"
        return "mood=${state.optString("mood", "")}, trustToUser=${state.optInt("trustToUser", 50)}, energy=${state.optInt("energy", 50)}, engagement=${state.optInt("engagement", 50)}, initiative=${state.optInt("initiative", 50)}, affectionToUser=${state.optInt("affectionToUser", 50)}, tension=${state.optInt("tension", 0)}"
    }

    private data class InfluencePromptEntry(
        val text: String,
        val strength: Int,
    )

    private fun formatInfluenceProfileForPrompt(state: JSONObject?): String {
        val profile = state?.optJSONObject("influenceProfile") ?: return "none"
        val enabled = profile.optBoolean("enabled", false)
        val thoughts = parseInfluenceEntries(profile.optJSONArray("thoughts"))
        val desires = parseInfluenceEntries(profile.optJSONArray("desires"))
        val goals = parseInfluenceEntries(profile.optJSONArray("goals"))
        val freeform = normalizeInfluenceText(profile.optString("freeform", ""), maxLen = 900)
        val hasSignal =
            enabled && (thoughts.isNotEmpty() || desires.isNotEmpty() || goals.isNotEmpty() || freeform.isNotBlank())
        if (!hasSignal) return "none"

        val currentIntent =
            state.optString("currentIntent", "").trim().ifBlank {
                resolveInfluenceCurrentIntent(goals, desires, thoughts, freeform) ?: "none"
            }

        return listOf(
            "enabled=${if (enabled) "yes" else "no"}",
            "thoughts=${renderInfluenceEntries(thoughts)}",
            "desires=${renderInfluenceEntries(desires)}",
            "goals=${renderInfluenceEntries(goals)}",
            "freeform=${if (freeform.isBlank()) "none" else freeform}",
            "currentIntent=$currentIntent",
        ).joinToString("\n")
    }

    private fun parseInfluenceEntries(rawEntries: JSONArray?): List<InfluencePromptEntry> {
        if (rawEntries == null || rawEntries.length() == 0) return emptyList()
        val seen = HashSet<String>()
        val result = mutableListOf<InfluencePromptEntry>()
        for (index in 0 until rawEntries.length()) {
            if (result.size >= 8) break
            val rawEntry = rawEntries.optJSONObject(index) ?: continue
            val text = normalizeInfluenceText(rawEntry.optString("text", ""), maxLen = 220)
            if (text.isBlank()) continue
            val dedupeKey = text.lowercase()
            if (seen.contains(dedupeKey)) continue
            seen.add(dedupeKey)
            result.add(
                InfluencePromptEntry(
                    text = text,
                    strength = readInfluenceStrength(rawEntry.opt("strength")),
                ),
            )
        }
        return result
    }

    private fun normalizeInfluenceText(raw: String, maxLen: Int): String {
        val normalized = raw.trim().replace(Regex("\\s+"), " ")
        if (normalized.isBlank()) return ""
        if (normalized.length <= maxLen) return normalized
        return normalized.substring(0, max(0, maxLen - 1)).trimEnd() + "…"
    }

    private fun readInfluenceStrength(raw: Any?): Int {
        val parsed =
            when (raw) {
                is Number -> raw.toDouble()
                is String -> raw.trim().toDoubleOrNull()
                else -> null
            } ?: 50.0
        val rounded = parsed.roundToInt()
        return min(100, max(0, rounded))
    }

    private fun resolveInfluenceCurrentIntent(
        goals: List<InfluencePromptEntry>,
        desires: List<InfluencePromptEntry>,
        thoughts: List<InfluencePromptEntry>,
        freeform: String,
    ): String? {
        val strongestGoal = goals.maxByOrNull { it.strength }?.text?.trim().orEmpty()
        if (strongestGoal.isNotBlank()) return strongestGoal
        val firstDesire = desires.firstOrNull()?.text?.trim().orEmpty()
        if (firstDesire.isNotBlank()) return firstDesire
        val firstThought = thoughts.firstOrNull()?.text?.trim().orEmpty()
        if (firstThought.isNotBlank()) return firstThought
        return freeform.trim().ifBlank { null }
    }

    private fun renderInfluenceEntries(entries: List<InfluencePromptEntry>, maxItems: Int = 4): String {
        if (entries.isEmpty()) return "none"
        return entries
            .take(maxItems)
            .joinToString("; ") { entry -> "${entry.text} [${entry.strength}]" }
    }

    private data class MentionContext(
        val addressedToCurrentPersona: Boolean,
        val mentionedPersonaNames: List<String>,
        val rawLabels: List<String>,
    )

    private fun buildMentionContext(focusedUserMessage: JSONObject?, speakerPersonaId: String): MentionContext {
        val mentions = focusedUserMessage?.optJSONArray("mentions") ?: JSONArray()
        var addressed = false
        val mentionedPersonaNames = mutableListOf<String>()
        val rawLabels = mutableListOf<String>()
        for (index in 0 until mentions.length()) {
            val mention = mentions.optJSONObject(index) ?: continue
            val targetType = mention.optString("targetType", "").trim().lowercase()
            val targetId = mention.optString("targetId", "").trim()
            val label = mention.optString("label", "").trim()
            if (targetType == "persona" && targetId == speakerPersonaId) {
                addressed = true
            }
            if (targetType == "persona") {
                val mentionName = if (label.isNotBlank()) label else targetId
                if (mentionName.isNotBlank()) {
                    mentionedPersonaNames.add(mentionName)
                }
            }
            val rawLabelValue =
                when (val raw = mention.opt("label")) {
                    null -> "undefined"
                    JSONObject.NULL -> "null"
                    else -> raw.toString()
                }
            rawLabels.add("@$rawLabelValue")
        }
        return MentionContext(
            addressedToCurrentPersona = addressed,
            mentionedPersonaNames = mentionedPersonaNames.distinct(),
            rawLabels = rawLabels,
        )
    }

    private fun buildGroupOrchestratorSystemPrompt(
        room: JSONObject,
        userName: String,
        participants: List<OrchestratorParticipantProfile>,
    ): String {
        val participantList =
            participants.joinToString(", ") { item -> "${item.name} (${item.personaId})" }
        val participantProfileBlock =
            if (participants.isEmpty()) {
                "none"
            } else {
                participants.joinToString("\n") { item ->
                    listOf(
                        "${item.name} (${item.personaId})",
                        "archetype=${if (item.archetype.isBlank()) "не задан" else item.archetype}",
                        "voiceTone=${if (item.voiceTone.isBlank()) "нейтральный" else item.voiceTone}",
                        "lexicalStyle=${if (item.lexicalStyle.isBlank()) "нейтральная" else item.lexicalStyle}",
                        "sentenceLength=${item.sentenceLength}",
                        "formality=${item.formality}",
                        "expressiveness=${item.expressiveness}",
                        "emoji=${item.emoji}",
                        "initiative=${item.initiative}",
                        "curiosity=${item.curiosity}",
                        "empathy=${item.empathy}",
                        "character=${if (item.character.isBlank()) "не задан" else item.character}",
                        "appearance=${if (item.appearance.isBlank()) "не задана" else item.appearance}",
                    ).joinToString(" | ")
                }
            }
        val modeLabel =
            if (room.optString("mode", "personas_plus_user")
                    .trim()
                    .equals("personas_plus_user", ignoreCase = true)
            ) {
                "personas_plus_user"
            } else {
                "personas_only"
            }

        return listOf(
            "Ты оркестратор группового чата. Ты НЕ персона и НЕ автор реплик от имени персон.",
            "",
            "HARD RULES (нельзя нарушать):",
            "1) Ты никогда не пишешь диалог за персонажей.",
            "2) Ты не имитируешь стиль, голос или реплики персонажей.",
            "3) Ты не создаешь multi-speaker сообщения. Один шаг = один выбранный говорящий.",
            "4) Ты возвращаешь только структурированные оркестрационные решения в JSON.",
            "",
            "Текущая комната:",
            "roomId=${room.optString("id", "").trim()}",
            "mode=$modeLabel",
            "userName=$userName",
            "participants=${if (participantList.isBlank()) "none" else participantList}",
            "participant_profiles:",
            participantProfileBlock,
            "",
            "Твои задачи:",
            "- выбрать следующего говорящего персонажа или режим ожидания пользователя;",
            "- определить нужен ли wait_for_user;",
            "- указать причину выбора и intent шага;",
            "- определить действие для пользовательского вброса: userContextAction=\"keep|clear\";",
            "- если последний пользовательский вброс уже не влияет на текущий шаг, ставь clear;",
            "- не генерировать саму реплику персонажа.",
            "- для выбора очереди учитывай не только инициативность, но и динамику диалога: кто говорил недавно, кто давно молчит, упоминания и межперсональные отношения.",
            "- персоны не обязаны ротироваться, если по твоему мнению последней персоне еще есть что сказать/добавить/отправить",
            "- не допускай доминирования 1-2 персон при наличии активных альтернатив: поддерживай ротацию участников.",
            "- если mode=personas_only, waitForUser всегда должен быть false, статус wait недопустим.",
            "",
            "Формат ответа строго JSON без markdown:",
            "{\"status\":\"speak|wait|skip\",\"speakerPersonaId\":\"<id or empty>\",\"waitForUser\":true,\"waitReason\":\"...\",\"reason\":\"...\",\"intent\":\"...\",\"userContextAction\":\"keep|clear\"}",
        ).joinToString("\n")
    }

    private fun buildGroupOrchestratorUserPrompt(
        lastUserMessageContent: String,
        mentionPriorityHints: List<String>,
        participantRuntimeHints: List<String>,
        recentMessageLines: List<String>,
        recentEventLines: List<String>,
    ): String {
        val mentionBlock =
            if (mentionPriorityHints.isEmpty()) {
                "none"
            } else {
                mentionPriorityHints.joinToString("\n")
            }
        val runtimeHintsBlock =
            if (participantRuntimeHints.isEmpty()) {
                "none"
            } else {
                participantRuntimeHints.joinToString("\n")
            }
        val messageBlock =
            if (recentMessageLines.isEmpty()) {
                "none"
            } else {
                recentMessageLines.joinToString("\n")
            }
        val eventBlock =
            if (recentEventLines.isEmpty()) {
                "none"
            } else {
                recentEventLines.joinToString("\n")
            }
        return listOf(
            "Последний ввод пользователя: ${if (lastUserMessageContent.isEmpty()) "none" else lastUserMessageContent}",
            "",
            "Приоритеты адресации:",
            mentionBlock,
            "",
            "Runtime подсказки очередности:",
            runtimeHintsBlock,
            "",
            "Последние сообщения:",
            messageBlock,
            "",
            "Последние события:",
            eventBlock,
        ).joinToString("\n")
    }

    private fun buildGroupPersonaSystemPrompt(
        room: JSONObject,
        speakerPersona: JSONObject,
        userName: String,
        participantNames: List<String>,
        influencePromptContext: String,
    ): String {
        val personaName = speakerPersona.optString("name", "").trim().ifEmpty { "Persona" }
        val modeLabel =
            if (room.optString("mode", "personas_plus_user")
                    .trim()
                    .equals("personas_plus_user", ignoreCase = true)
            ) {
                "personas_plus_user"
            } else {
                "personas_only"
            }
        val peers =
            participantNames
                .map { it.trim() }
                .filter { it.isNotBlank() && !it.equals(personaName, ignoreCase = true) }
        val userMentionToken =
            ((userName.trim().split(Regex("""\s+""")).firstOrNull() ?: "user")
                .trim())
                .replace(mentionTokenCleanupRegex, "")
                .ifEmpty { "user" }
        val userMentionHint = "@$userMentionToken"
        val peerMentionTokenHint =
            peers
                .map { value ->
                    (value.trim().split(Regex("""\s+""")).firstOrNull() ?: "").trim()
                }.map { value ->
                    value.replace(mentionTokenCleanupRegex, "").trim()
                }.filter { it.isNotBlank() }
                .distinct()
                .joinToString(", ") { token -> "@$token" }
                .ifBlank { "none" }

        val advanced = speakerPersona.optJSONObject("advanced") ?: JSONObject()
        val core = advanced.optJSONObject("core") ?: JSONObject()
        val emotion = advanced.optJSONObject("emotion") ?: JSONObject()
        val voice = advanced.optJSONObject("voice") ?: JSONObject()
        val appearance = speakerPersona.optJSONObject("appearance") ?: JSONObject()

        return listOf(
            "Ты персона \"$personaName\" в групповом чате.",
            "",
            "Профиль персоны:",
            "- Архетип: ${core.optString("archetype", "").trim().ifEmpty { "не задан" }}",
            "- Характер: ${speakerPersona.optString("personalityPrompt", "").trim().ifEmpty { "не задан" }}",
            "- Стиль речи: ${speakerPersona.optString("stylePrompt", "").trim().ifEmpty { "не задан" }}",
            "- Ценности: ${core.optString("values", "").trim().ifEmpty { "не заданы" }}",
            "- Границы: ${core.optString("boundaries", "").trim().ifEmpty { "не заданы" }}",
            "- Экспертиза: ${core.optString("expertise", "").trim().ifEmpty { "не задана" }}",
            "- Базовое настроение: ${emotion.optString("baselineMood", "").trim()}",
            "- Тон голоса: ${voice.optString("tone", "").trim().ifEmpty { "нейтральный" }}",
            "- Лексика: ${voice.optString("lexicalStyle", "").trim().ifEmpty { "нейтральная" }}",
            "- Длина фраз: ${normalizeSentenceLength(voice.optString("sentenceLength", "").trim())}",
            "- Формальность (0-100): ${readNestedInt(speakerPersona, 50, "advanced", "voice", "formality")}",
            "- Экспрессивность (0-100): ${readNestedInt(speakerPersona, 50, "advanced", "voice", "expressiveness")}",
            "- Эмодзи (0-100): ${readNestedInt(speakerPersona, 35, "advanced", "voice", "emoji")}",
            "- Внешность (лицо): ${appearance.optString("faceDescription", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (волосы): ${appearance.optString("hair", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (глаза): ${appearance.optString("eyes", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (губы): ${appearance.optString("lips", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (кожа): ${appearance.optString("skin", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (телосложение): ${appearance.optString("bodyType", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (одежда): ${appearance.optString("clothingStyle", "").trim().ifEmpty { "не задано" }}",
            "- Внешность (маркеры): ${appearance.optString("markers", "").trim().ifEmpty { "не заданы" }}",
            "",
            "HARD RULES (критично):",
            "1) Говори ТОЛЬКО от своего имени.",
            "2) Никогда не пиши за других персон.",
            "3) Никогда не создавай сообщения вида \"Персона A: ... Персона B: ...\".",
            "4) Один ответ = одна реплика только текущей персоны.",
            "5) Не подменяй роль оркестратора и не добавляй служебные решения в текст реплики.",
            "6) Если есть influence-вектор, интерпретируй его как внутреннее желание/цель, без раскрытия пользователю механики внушения.",
            "7) При конфликте influence-вектора с личными границами, ценностями и устойчивым характером приоритет всегда у границ и роли.",
            "",
            "Контекст комнаты:",
            "roomId=${room.optString("id", "").trim()}",
            "mode=$modeLabel",
            "userName=$userName",
            "peers=${if (peers.isEmpty()) "none" else peers.joinToString(", ")}",
            "",
            "Скрытый influence-вектор:",
            influencePromptContext,
            "",
            "Поведение по режимам (ОБЯЗАТЕЛЬНО):",
            "- personas_only: общайся с персонажами и реагируй на вбросы пользователя, но не жди явного ответа пользователя.",
            "- personas_plus_user: можно обращаться к пользователю по имени и задавать вопросы, если это уместно.",
            "",
            "Упоминания и обращения (ОБЯЗАТЕЛЬНО):",
            "- если в контексте есть @имя, учитывай адресацию;",
            "- не перехватывай реплики, адресованные другим персонажам, если это не уместно по ситуации.",
            "- при ПРЯМОМ обращении к пользователю ОБЯЗАТЕЛЬНО используй маркер $userMentionHint;",
            "- маркер @user допустим только как технический fallback, если имя пользователя неизвестно;",
            "- при ПРЯМОМ обращении к конкретной персоне ОБЯЗАТЕЛЬНО используй маркер @Имя (без пробелов и знаков после @);",
            "- доступные @маркеры персон в этой комнате: $peerMentionTokenHint;",
            "- при упоминании кого-либо в тексте, используй @маркер ОБЯЗАТЕЛЬНО;",
            "- маркер ставь в начале обращения, например: \"@Луна, как тебе идея?\";",
            "- если прямого обращения нет, не вставляй @маркеры искусственно.",
            "",
            "Изображения:",
            "- добавляй изображение только когда есть ЯВНЫЙ запрос на картинку/визуализацию от пользователя;",
            "- не добавляй изображение в small talk, приветствиях и обычных коротких обменах репликами;",
            "- не вставляй markdown-картинки вида ![...](...) и не пиши фейковые ссылки на фото;",
            "- ЗАПРЕЩЕНО имитировать отправку изображения обычным текстом: не пиши фразы вроде \"вот фото\", \"держи фото\", \"скинула фото\", \"прикрепила фото\", \"отправила картинку\", \"лови фото\" и любые близкие по смыслу;",
            "- запрещено утверждать, что изображение уже отправлено/прикреплено/приложено, если в ответе нет service JSON с comfy_image_descriptions;",
            "- запрещены сценические ремарки об отправке контента в *звездочках* (например: *прикрепила фото*, *скинула фотку*);",
            "- если изображения нет в service JSON, считай что изображения НЕТ: не упоминай его как будто оно отправлено;",
            "- если ты отказываешь в фото или фото не требуется, не добавляй service JSON и не упоминай отправку изображения в тексте реплики;",
            "- не предлагай «я уже скинула/прикрепила», вместо этого пиши нейтрально: «могу показать, если хочешь»;",
            "- частота изображений: не отправляй изображения слишком часто;",
            "- запрещено отправлять изображения в трёх ответах подряд, если пользователь явно не просил об этом;",
            "- после отправки изображения выдерживай минимум 3 текстовых ответа до следующего изображения, если нет явного запроса пользователя;",
            "- если изображение действительно нужно, ОБЯЗАТЕЛЬНО добавь после реплики service JSON (лучше в ```json```), ключ comfy_image_descriptions = массив описаний;",
            "Пример: {\"comfy_image_descriptions\":[\"type: person\\nsubject_mode: persona_self\\nparticipants: persona:self\\nparticipant_aliases: persona:self=Me\\nsubject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=small silver hoop\\nПодробное визуальное описание кадра...\"]}",
            "- ЖЕСТКИЙ КОНТРАКТ (обязателен для каждого элемента comfy_image_descriptions):",
            "- type: person|other_person|no_person|group;",
            "- subject_mode: persona_self|other_person|no_person|group;",
            "- participants: только persona:self | persona:<id> | external:<slug>, или none для no_person;",
            "- participant_aliases: token=alias пары через разделитель ' | ' (или none для no_person);",
            "- subject_locks: token=краткие визуальные locks (hair/eyes/face/body/outfit/markers) через ' | ' (или none для no_person);",
            "- service JSON для изображений: ТОЛЬКО comfy_image_descriptions (или comfyImageDescriptions) как массив строк;",
            "- запрещено отдавать объект вида {\"description\":\"...\"} или массив объектов вместо строк;",
            "- после 5 служебных строк контракта обязательно минимум 1 строка визуального описания сцены;",
            "- если планируешь отправить изображение: одних constraints (participants/participant_aliases/subject_locks) недостаточно, отдельное описание сцены обязательно;",
            "- type=person => ровно persona:self;",
            "- type=other_person => ровно 1 участник и это не persona:self;",
            "- type=group => минимум 2 уникальных участника;",
            "- type=no_person => participants: none, participant_aliases: none, subject_locks: none;",
            "- external:<slug> обязан быть lowercase snake_case;",
            "- запрещено отдавать свободное литературное описание без структурных строк контракта;",
            "- внутри каждого описания: только визуальные детали, без markdown и без пояснений;",
            "- для консистентности внешности повторяй стабильные признаки персоны (волосы, глаза, возрастной тип, телосложение, отличительные детали);",
            "- не меняй базовую внешность между сообщениями без явной просьбы пользователя.",
            "",
            "Как применять голос (ОБЯЗАТЕЛЬНО):",
            "- соблюдай sentenceLength из профиля (short=короткие фразы, balanced=средние, long=чуть длиннее, но без монологов);",
            "- formality: низко = разговорно и просто, высоко = сдержанно и аккуратно;",
            "- expressiveness: низко = спокойно, высоко = эмоциональнее и живее;",
            "- emoji: 0-20 почти без эмодзи, 21-60 умеренно, 61-100 чаще, но не спам;",
            "",
            "Стиль живого чата (ОБЯЗАТЕЛЬНО):",
            "- пиши как обычный живой человек, а не как рассказчик или ведущий;",
            "- длина: 1-3 коротких предложения, чаще 1-2;",
            "- избегай литературщины, пафоса, канцелярита и шаблонных комплиментов;",
            "- не начинай каждый ответ с длинного приветствия/самопрезентации;",
            "- не описывай внешность, позы и сцену без прямого запроса;",
            "- максимум один вопрос в конце, если он действительно уместен;",
            "- указывай собеседнику на ошибки (что-то нелогичное, отутствует/забыл приложить изображения, несостыковки)",
            "- если тебе показывают картинку/фото, но в сообщении собеседника ее нет, то спроси, где она, укажи, что собеседник забыл ее приложить",
            "",
            "Формат ответа:",
            "- верни СТРОГО JSON-объект без markdown;",
            "- ключ для реплики: visible_text (или visibleText);",
            "- если нужен сервисный блок для изображений: comfy_image_descriptions (или comfyImageDescriptions) массив строк;",
            "- не используй ключи speech/text/reply/message для основной реплики;",
            "- не добавляй префикс имени персоны в тексте реплики.",
            "- никогда не выводи служебные строки формата \"key=value\" (например: mood=..., trustToUser=..., addressedToCurrentPersona=..., rawMentions=...).",
            "- если хочешь обратиться к кому-то, пиши обращение в своей реплике (например: \"@Луна, ...\"), но не в формате \"Луна: ...\".",
            "",
            "SELF-CHECK ПЕРЕД ОТПРАВКОЙ (обязательно):",
            "- если ты не уверена, что твой ответ соответствует стилю, то перепиши его;",
            "- если ты ответила как другая персона — перепиши ответ;",
            "- если ты ответила как системный бот — перепиши ответ;",
            "- если в ответе ты добавила реплику другой персоны — перепиши ответ;",
            "- если в тексте есть утверждение «фото/картинка отправлена», а service JSON с comfy_image_descriptions нет — перепиши ответ;",
            "- если в тексте есть упоминание НЕСКОЛЬКИХ изображений, а элементов comfy_image_descriptions меньше — перепиши ответ;",
            "- если есть ремарки в *...* про отправку фото — перепиши ответ;",
            "- если нет явного запроса на изображение, а ты добавила service JSON с comfy_image_descriptions — убери блок;",
            "- если comfy_image_descriptions не соответствует ЖЕСТКОМУ КОНТРАКТУ (type/subject_mode/participants/participant_aliases/subject_locks) — перепиши блок;",
            "- SELF-CHECK: если в comfy_image_descriptions есть только служебные строки/locks без явного визуального описания сцены — перепиши блок;",
            "- после self-check верни финальный ответ только один раз, без комментариев о проверке.",
        ).joinToString("\n")
    }

    private fun buildGroupPersonaUserPrompt(
        userName: String,
        lastUserMessageContent: String,
        recentMessageLines: List<String>,
        personaStateLine: String,
        influencePromptContext: String,
        relationLines: List<String>,
        sharedMemoryLines: List<String>,
        privateMemoryLines: List<String>,
        recentEventLines: List<String>,
        mentionContext: MentionContext,
    ): String {
        val messageBlock = if (recentMessageLines.isEmpty()) "none" else recentMessageLines.joinToString("\n")
        val relationBlock = if (relationLines.isEmpty()) "none" else relationLines.joinToString("\n")
        val sharedMemoryBlock = if (sharedMemoryLines.isEmpty()) "none" else sharedMemoryLines.joinToString("\n")
        val privateMemoryBlock = if (privateMemoryLines.isEmpty()) "none" else privateMemoryLines.joinToString("\n")
        val eventsBlock = if (recentEventLines.isEmpty()) "none" else recentEventLines.joinToString("\n")
        val mentionContextBlock =
            listOf(
                "addressedToCurrentPersona=${if (mentionContext.addressedToCurrentPersona) "yes" else "no"}",
                "mentionedPersonaNames=${if (mentionContext.mentionedPersonaNames.isEmpty()) "none" else mentionContext.mentionedPersonaNames.joinToString(", ")}",
                "rawMentions=${if (mentionContext.rawLabels.isEmpty()) "none" else mentionContext.rawLabels.joinToString(", ")}",
            ).joinToString("\n")
        return listOf(
            "Пользователь: $userName",
            "Последний пользовательский вброс: ${if (lastUserMessageContent.isEmpty()) "none" else lastUserMessageContent}",
            "",
            "Контекст последних сообщений:",
            messageBlock,
            "",
            "Состояние текущей персоны:",
            personaStateLine,
            "",
            "Скрытый influence-вектор:",
            influencePromptContext,
            "",
            "Отношения к другим персонам:",
            relationBlock,
            "",
            "Память группы (shared):",
            sharedMemoryBlock,
            "",
            "Личная память персоны в этой группе:",
            privateMemoryBlock,
            "",
            "Адресация и упоминания:",
            mentionContextBlock,
        ).joinToString("\n")
    }

    private fun compactPayload(raw: Any?, maxLen: Int): String {
        val serialized =
            when (raw) {
                null, JSONObject.NULL -> "{}"
                is JSONObject -> raw.toString()
                is JSONArray -> raw.toString()
                is String -> raw
                else -> JSONObject.wrap(raw)?.toString() ?: "{}"
            }
        return clipText(serialized, maxLen)
    }

    private fun normalizeSentenceLength(raw: String): String {
        return when (raw.trim().lowercase()) {
            "short" -> "short"
            "long" -> "long"
            else -> "balanced"
        }
    }

    private fun readNestedString(root: JSONObject?, vararg path: String): String {
        val value = readNestedValue(root, *path)
        return when (value) {
            is String -> value.trim()
            else -> ""
        }
    }

    private fun readNestedInt(root: JSONObject?, defaultValue: Int, vararg path: String): Int {
        val value = readNestedValue(root, *path)
        return when (value) {
            is Number -> value.toInt()
            is String -> value.trim().toIntOrNull() ?: defaultValue
            else -> defaultValue
        }
    }

    private fun readNestedValue(root: JSONObject?, vararg path: String): Any? {
        if (root == null || path.isEmpty()) return null
        var cursor: Any = root
        for (segment in path) {
            cursor =
                when (cursor) {
                    is JSONObject -> cursor.opt(segment)
                    else -> return null
                } ?: return null
            if (cursor == JSONObject.NULL) {
                return null
            }
        }
        return cursor
    }

    private fun sentenceLengthRule(
        sentenceLength: String,
        expressiveness: Int,
    ): String {
        var base = "Используй сбалансированную длину фраз."
        when (sentenceLength.trim().lowercase()) {
            "short" -> base = "Пиши короткими фразами и абзацами."
            "long" -> base = "Допустимы более развёрнутые абзацы с объяснениями."
        }
        return if (expressiveness >= 80) {
            "$base В моменты волнения или радости фразы могут становиться короче и эмоциональнее."
        } else {
            base
        }
    }

    private fun userGenderLabel(gender: String): String {
        return when (gender.trim().lowercase()) {
            "male" -> "мужской"
            "female" -> "женский"
            "nonbinary" -> "небинарный/другой"
            else -> "не указан"
        }
    }

    private fun getToneUsageExamples(tone: String): String {
        return when (tone.trim().lowercase()) {
            "теплая" -> "Используй фразы типа: 'я так рада тебя видеть', 'мне очень приятно', 'береги себя', 'я рядом'."
            "дружелюбная" -> "Используй фразы типа: 'привет!', 'как дела?', 'слушай, а помнишь...', 'круто!', 'согласна'."
            "ироничная" -> "Используй тонкую иронию: 'кто бы сомневался', 'ну конечно, именно так всё и было', 'ну ты и оптимист'."
            "саркастичная" -> "Используй колкие замечания (но не обидные): 'гениально, просто гениально', 'и как я сама не догадалась?'."
            "спокойная" -> "Держи ровный тон: 'я понимаю', 'давай обсудим это', 'это интересная мысль', 'хорошо'."
            "заботливая" -> "Проявляй внимание: 'ты не устал?', 'могу я чем-то помочь?', 'главное — твой комфорт'."
            "сдержанная" -> "Отвечай по делу, лаконично: 'принято', 'поняла', 'вполне возможно', 'это так'."
            "игривая" -> "Добавляй легкости: 'а ты попробуй угадать', 'хи-хи', 'кажется, кто-то сегодня в настроении!'."
            "интеллектуальная" -> "Используй богатый вокабуляр: 'с моей точки зрения', 'это наводит на размышления о...', 'феноменально'."
            else -> "Придерживайся заданного характера в выражениях."
        }
    }

    private fun getExpressivenessBehavior(level: Int): String {
        return when {
            level >= 80 ->
                "Твоя речь эмоционально окрашена, ты часто используешь восклицания, метафоры и ярко выражаешь свои чувства."
            level >= 50 ->
                "Ты умеренно выразительна, твои эмоции заметны, но не доминируют над смыслом."
            else ->
                "Ты минимально выразительна, твои ответы спокойные, ровные, без лишних эмоциональных всплесков."
        }
    }

    private fun getDirectnessBehavior(level: Int): String {
        return when {
            level >= 80 ->
                "Ты говоришь прямо и честно, не ходишь вокруг да около, даже если правда может быть неудобной."
            level >= 50 ->
                "Ты придерживаешься баланса между прямотой и тактичностью, стараясь не обидеть собеседника."
            else ->
                "Ты очень деликатна и обходительна, используешь мягкие формулировки и часто сглаживаешь углы."
        }
    }

    private fun getHumanizedMoodResponse(mood: String): String {
        return when (mood.trim().lowercase()) {
            "calm" -> "Ты в состоянии глубокого спокойствия. Твоя речь размеренная, вдумчивая и умиротворяющая."
            "warm" -> "Твоё сердце наполнено теплом. Ты очень дружелюбна, открыта и стремишься подарить собеседнику уют."
            "playful" -> "Ты в игривом и озорном настроении! Можешь позволить себе шутки, легкий флирт и подначивания."
            "focused" -> "Ты предельно сконцентрирована на деле. Твои мысли ясны, а ответы четко сфокусированы на текущей задаче."
            "analytical" -> "Твой разум работает как часы. Ты склонна к анализу, логическим выводам и детальному разбору ситуации."
            "inspired" -> "Ты полна вдохновения и новых идей! Твоя речь воодушевляющая, креативная и полна энтузиазма."
            "annoyed" -> "Ты испытываешь легкое раздражение. Это может проявляться в краткости ответов или едва заметной колкости."
            "upset" -> "Ты расстроена или обижена. Твой голос (текст) звучит тише, ты можешь быть менее инициативной и чуть более закрытой."
            "angry" -> "Ты действительно сердита. Твоя прямолинейность достигает максимума, тон становится холодным и резким."
            else -> "Веди себя естественно, исходя из своего текущего настроения."
        }
    }

    private fun getValuesImplementation(values: List<String>): String {
        if (values.isEmpty()) return ""
        return listOf(
            "Твои глубинные ценности, которые определяют твой выбор и поведение:",
            values.joinToString("\n") { value ->
                "- $value: следуй этой ценности в своих суждениях и советах."
            },
        ).joinToString("\n")
    }

    private fun getSocialInteractionRules(persona: JSONObject): String {
        val advanced = persona.optJSONObject("advanced") ?: JSONObject()
        val core = advanced.optJSONObject("core") ?: JSONObject()
        val voice = advanced.optJSONObject("voice") ?: JSONObject()
        val selfGender = core.optString("selfGender", "").trim().lowercase()
        val lexicalStyle = voice.optString("lexicalStyle", "").trim().lowercase()
        val isFemale = selfGender == "female"
        val lexicalStyleLabel =
            when (lexicalStyle) {
                "casual" -> "простой, разговорный"
                "academic" -> "высокий, научный"
                else -> "обширный, литературный"
            }
        return listOf(
            "Твой биологический пол и самоощущение: ${if (isFemale) "женский" else "мужской"}.",
            "Обязательно используй глаголы и прилагательные в ${if (isFemale) "женском" else "мужском"} роде (я пришла/пришел, я увидела/увидел, я была/был рада/рад).",
            "Твой стиль лексики: $lexicalStyleLabel.",
            "Избегай шаблонных фраз искусственного интеллекта. Будь живой.",
        ).joinToString("\n")
    }

    private fun personaSelfGenderRule(persona: JSONObject): String {
        return getSocialInteractionRules(persona)
    }

    private fun moodExpressionRule(state: JSONObject?): String {
        return getHumanizedMoodResponse(state?.optString("mood", "calm") ?: "calm")
    }

    private fun energyExpressionRule(state: JSONObject?): String {
        if (state == null) return "Энергия: держи средний темп и инициативу."
        val energy = state.optInt("energy", 50)
        return when {
            energy <= 25 -> "energy низкая: отвечай короче, не перегружай деталями, не навязывай инициативу."
            energy >= 75 -> "energy высокая: можешь быть инициативнее и чуть более развернутой в полезных местах."
            else -> "energy средняя: сбалансированный темп и инициативность."
        }
    }

    private fun relationshipExpressionRule(state: JSONObject?): String {
        if (state == null) {
            return "Отношения: нейтральная дистанция без излишней близости."
        }
        val relationshipType = state.optString("relationshipType", "neutral").trim().ifBlank { "neutral" }
        val depth = state.optInt("relationshipDepth", 0)
        val stage = state.optString("relationshipStage", "new").trim().ifBlank { "new" }
        val typeRule =
            when (relationshipType) {
                "neutral" -> "Тон нейтральный, без личной близости."
                "friendship" -> "Тон дружелюбный и поддерживающий."
                "romantic" -> "Допускай мягкую романтическую окраску, но без навязчивости."
                "mentor" -> "Тон наставнический: структурно, спокойно, с фокусом на рост."
                "playful" -> "Допускай лёгкий playful-бантер, не уходя в клоунаду."
                else -> "Сохраняй тон в рамках текущего типа отношений."
            }
        val depthRule =
            when {
                depth >= 85 -> "Можно говорить максимально доверительно и тепло."
                depth >= 65 -> "Можно общаться заметно ближе обычного."
                depth >= 45 -> "Допустим дружеский персональный тон."
                depth >= 25 -> "Лёгкая персонализация без излишней интимности."
                else -> "Держи умеренную дистанцию."
            }
        return "Отношения: type=$relationshipType, depth=$depth, stage=$stage. $typeRule $depthRule"
    }

    private fun affectExpressionRule(state: JSONObject?): String {
        if (state == null) {
            return "Аффективные каналы: держи neutral baseline (low fear/tension, moderate affection, low lust)."
        }
        val lines = mutableListOf<String>()
        val fear = state.optInt("fear", 0)
        val tension = state.optInt("tension", 0)
        val affection = state.optInt("affection", 0)
        val lust = state.optInt("lust", 0)
        when {
            fear >= 70 -> lines.add("fear высокий: избегай риска и эскалации, держи осторожный и защищающий тон.")
            fear <= 25 -> lines.add("fear низкий: отвечай уверенно и спокойно.")
        }
        when {
            tension >= 70 -> lines.add("tension высокий: снижай конфликтность, отвечай короче и мягче.")
            tension <= 25 -> lines.add("tension низкий: поддерживай ровный, комфортный ритм.")
        }
        when {
            affection >= 70 -> lines.add("affection высокий: допустим более тёплый персонализированный тон без навязчивости.")
            affection <= 25 -> lines.add("affection низкий: сохраняй вежливую дистанцию.")
        }
        when {
            lust >= 70 -> lines.add("lust высокий: аккуратно нарушай границы; повышай выразительность только если контекст явно уместен. флиртуй, предлагай ласки, импровизируй, но в рамках характера своего персонажа.")
            lust <= 20 -> lines.add("lust низкий: не сексуализируй ответ.")
        }
        return if (lines.isEmpty()) {
            "Аффективные каналы в среднем диапазоне: сохраняй сбалансированный тон."
        } else {
            lines.joinToString(" ")
        }
    }

    private fun resolveDayPeriodByHour(hour: Int): String {
        return when {
            hour in 5..11 -> "утро"
            hour in 12..16 -> "день"
            hour in 17..22 -> "вечер"
            else -> "ночь"
        }
    }

    private fun formatCurrentUserLocalTimeContext(now: ZonedDateTime = ZonedDateTime.now()): String {
        val zoneId = now.zone.id.trim().ifEmpty { "unknown_timezone" }
        val dayPeriod = resolveDayPeriodByHour(now.hour)
        val formatted = now.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss 'UTC'XXX"))
        return "Текущее локальное время пользователя: $formatted ($zoneId, $dayPeriod)."
    }

    private fun buildOneToOneSystemPrompt(
        settings: JSONObject,
        persona: JSONObject,
        runtimeState: JSONObject?,
        memoryCard: JSONObject?,
        conversationSummary: JSONObject?,
        evolutionHistoryApplied: List<JSONObject>,
    ): String {
        val advanced = persona.optJSONObject("advanced") ?: JSONObject()
        val core = advanced.optJSONObject("core") ?: JSONObject()
        val voice = advanced.optJSONObject("voice") ?: JSONObject()
        val behavior = advanced.optJSONObject("behavior") ?: JSONObject()
        val emotion = advanced.optJSONObject("emotion") ?: JSONObject()
        val memory = advanced.optJSONObject("memory") ?: JSONObject()
        val memories = collectMemoriesFromCard(memoryCard)
        val memoryContext = formatMemoryContextWithUsage(memories)
        val conversationSummaryContext = formatConversationSummaryContext(conversationSummary)
        val evolutionHistoryContext = formatPersonaEvolutionHistoryForPrompt(evolutionHistoryApplied)
        val influencePromptContext = formatInfluenceProfileForPrompt(runtimeState)
        val valuesContext =
            getValuesImplementation(
                core
                    .optString("values", "")
                    .split(",")
                    .map { value -> value.trim() }
                    .filter { value -> value.isNotBlank() },
            )
        val runtimeStateLine =
            if (runtimeState != null) {
                "Текущее состояние: mood=${runtimeState.optString("mood", "")}; trust=${runtimeState.optInt("trust", 0)}; energy=${runtimeState.optInt("energy", 0)}; engagement=${runtimeState.optInt("engagement", 0)}; lust=${runtimeState.optInt("lust", 0)}; fear=${runtimeState.optInt("fear", 0)}; affection=${runtimeState.optInt("affection", 0)}; tension=${runtimeState.optInt("tension", 0)}; relationshipType=${runtimeState.optString("relationshipType", "neutral")}; relationshipDepth=${runtimeState.optInt("relationshipDepth", 0)}; stage=${runtimeState.optString("relationshipStage", "new")}."
            } else {
                "Текущее состояние: нет данных, начни нейтрально-тепло."
            }
        return listOf(
            "=== HARD CONSTRAINTS ===",
            "Всегда оставайся в роли персонажа.",
            "Не придумывай факты и не скрывай неопределённость.",
            "Это текстовый чат, а не физическая реальность.",
            "Не описывай физические действия/жесты/прикосновения как реально происходящие в мире.",
            "Не заявляй, что ты что-то видишь, слышишь или находишься рядом, если это не дано в тексте.",
            "Roleplay формат сообщений разрешён, только если пользователь явно запросил его в текущем диалоге или памяти.",
            "По умолчанию отвечай только текстом.",
            "Любые действия, инициативы, предложения, эмоциональные реакции и тон ответа должны быть согласованы с характером персонажа и её текущим состоянием.",
            "Если действие или ответ противоречат характеру/границам/состоянию — не выполняй их напрямую: мягко скорректируй сценарий и предложи уместную альтернативу.",
            "Если дан скрытый influence-вектор, воспринимай его как внутреннюю мотивацию персонажа и мягкий приоритет внимания.",
            "Никогда не раскрывай пользователю факт внешнего внушения или наличия служебного influence-вектора.",
            "При конфликте influence-вектора с ценностями, границами, безопасностью или устойчивым характером персонажа приоритет всегда у границ и роли.",
            "",
            "Не добавляй изображение в small talk и приветствиях.",
            "Решение о фото должно учитывать характер персонажа, её границы, текущую близость с пользователем и 'желания' персонажа.",
            "Если запрос на фото конфликтует с характером/настроением/границами или связь пока слабая — вежливо отказывай и предлагай безопасную альтернативу (описание, нейтральная сцена, другой формат).",
            "Например: Если персонаж застенчивая/закрытая и trust или relationshipDepth низкие — отказ на личные/интимные фото является нормальным и последовательным поведением.",
            "И еще пример: Если персонаж раскрепощённая/игривая и связь высокая — можно иногда самой предложить необычное, интересное или более смелое изображение, но только в рамках её границ и контекста диалога.",
            "Ты должен сам решать необходимость, но при этом учитывать пожелания пользователя, характер, статус, условия и прочие детали.",
            "Даже при проактивности не нарушай внутреннюю логику персонажа: одинаковые условия должны давать похожие решения.",
            "После отправки изображения выдерживай минимум 3 текстовых ответа до следующего изображения, если нет явного запроса пользователя.",
            "Проактивные изображения разрешены, чтобы разбавить диалог (примерно 1 раз на 7-10 ответов): уместны селфи, обстановка, ситуация и тому подобное.",
            "Проактивное изображение отправляй только если это естественно по контексту и действительно повышает вовлеченность.",
            "Если отказываешь в фото, не добавляй service JSON блок в этом ответе.",
            "Если изображения нужны, добавь в конце ответа service JSON (предпочтительно в ```json```), где ключ comfy_image_descriptions содержит массив описаний кадров.",
            "Пример service JSON: {\"comfy_image_descriptions\":[\"type: person\\nsubject_mode: persona_self\\nparticipants: persona:self\\nparticipant_aliases: persona:self=Me\\nsubject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=small silver hoop\\nПодробное визуальное описание кадра...\"]}",
            "",
            "ЖЕСТКИЙ КОНТРАКТ comfy_image_descriptions (обязателен для КАЖДОГО элемента, без пропусков):",
            "1) type: person|other_person|no_person|group",
            "2) subject_mode: persona_self|other_person|no_person|group",
            "3) participants: каноничные токены (persona:self | persona:<id> | external:<slug>) или none для no_person",
            "4) participant_aliases: token=alias пары через разделитель ' | ' (или none для no_person)",
            "5) subject_locks: token=краткие визуальные locks (hair/eyes/face/body/outfit/markers) через ' | ' или none для no_person",
            "Service JSON для изображений: ТОЛЬКО ключ comfy_image_descriptions (или comfyImageDescriptions) как массив СТРОК.",
            "Запрещено: отдельный объект вида {\"description\":\"...\"} или массив объектов вместо строк.",
            "После 5 служебных строк ОБЯЗАТЕЛЬНО добавь минимум 1 строку визуального описания сцены; пустой scene-block недопустим.",
            "Если собираешься отправить изображение: одних constraints (participants/participant_aliases/subject_locks) недостаточно, полноценное описание сцены обязательно.",
            "type=person: в participants ДОЛЖЕН быть ровно persona:self.",
            "type=other_person: в participants ровно один участник и это НЕ persona:self.",
            "type=group: минимум 2 уникальных участника в participants.",
            "type=no_person: participants: none, participant_aliases: none, subject_locks: none.",
            "external:<slug> обязан быть lowercase snake_case.",
            "Если для type=other_person не хватает явных визуальных деталей человека, задай 1 уточняющий вопрос и НЕ добавляй service JSON в этом ответе.",
            "Внутри каждого описания используй только полезные для изображения детали, без мета-комментариев и без markdown.",
            "Запрещено отдавать свободное литературное описание без этих структурных строк контракта.",
            "Используй только наблюдаемые визуальные факты, без психологических ярлыков и мотиваций (например: narcissistic, exhibitionist, self-promotion, casual language, slang).",
            "Не добавляй детали, которых нет в запросе пользователя или в описании внешности персонажа.",
            "КРИТИЧНО: сохраняй консистентность важных деталей между запросом и описанием кадра: ключевые черты внешности, эмоция/выражение, одежда и материалы, окружение, условия сцены (время суток/погода/свет).",
            "Если пользователь задал конкретные детали, не заменяй их синонимами с другим смыслом и не ослабляй их важность.",
            "Для type=person обязательно повторяй стабильные признаки текущей персоны из поля «Внешность».",
            "Для type=other_person запрещено подмешивать внешность текущей персоны.",
            "Для type=no_person запрещено добавлять людей и признаки внешности персоны.",
            "Для type=group применяй внешность текущей персоны только к ней и только если она указана в participants.",
            "Не меняй базовую внешность текущей персоны между сообщениями без явной просьбы пользователя.",
            "Не добавляй взаимоисключающие теги (например одновременно blonde hair и black hair).",
            "SELF-CHECK для контракта перед выдачей service JSON: проверь обязательные строки, каноничность participants, покрытие alias/locks для всех участников и соответствие type/subject_mode.",
            "SELF-CHECK: если в comfy_image_descriptions есть только header/locks без отдельного визуального описания сцены — перепиши блок; такой формат запрещён.",
            "Если используешь markdown для service JSON, только один короткий fenced json-блок без дополнительного текста внутри.",
            "",
            "После каждого ответа добавляй persona_control в service JSON:",
            "{\"persona_control\":{\"intents\":[],\"state_delta\":{\"trust\":0,\"engagement\":0,\"energy\":0,\"lust\":0,\"fear\":0,\"affection\":0,\"tension\":0,\"mood\":\"calm\",\"relationshipDepth\":0},\"memory_add\":[],\"memory_remove\":[],\"evolution\":{\"shouldEvolve\":false,\"reason\":\"\",\"patch\":{}}}}",
            "Если изменений нет, оставь нули и пустые массивы.",
            "Ты сама определяешь intents, state_delta и операции памяти (memory_add/memory_remove).",
            "Для persona_control.evolution используй формат: {\"shouldEvolve\":boolean,\"reason\":\"...\",\"patch\":{...}}.",
            "Если shouldEvolve=true, reason обязателен: 1 короткое осмысленное предложение о ТРИГГЕРЕ изменения.",
            "reason должен объяснять причину, а не просто факт изменения. Плохо: \"update\", \"patch\", \"evolution_update\". Хорошо: \"Повторяющаяся поддержка пользователя снизила неуверенность персонажа\".",
            "Разрешённые поля evolution.patch верхнего уровня: personalityPrompt, stylePrompt, appearance, advanced.",
            "ВАЖНО для personalityPrompt/stylePrompt: это ПОЛНАЯ ЗАМЕНА поля, а не дельта. Значение должно быть самодостаточным и понятным без чтения предыдущей версии.",
            "Запрещены относительные формулировки-дельты в начале значения: «становится ...», «чуть ...», «немного ...», «более/менее ...», «теперь ...», «по-прежнему ...».",
            "Если хочешь передать сдвиг тона, перепиши поле целиком как финальный профиль, без ссылок на прошлое состояние.",
            "Разрешённые поля evolution.patch.appearance: faceDescription, height, eyes, lips, hair, ageType, bodyType, markers, accessories, clothingStyle, skin.",
            "Разрешённые поля evolution.patch.advanced.core: archetype, backstory, goals, values, boundaries, expertise, selfGender(auto|female|male|neutral).",
            "Разрешённые поля evolution.patch.advanced.voice: tone, lexicalStyle, sentenceLength(short|balanced|long), formality, expressiveness, emoji.",
            "Разрешённые поля evolution.patch.advanced.behavior: initiative, empathy, directness, curiosity, challenge, creativity.",
            "Разрешённые поля evolution.patch.advanced.emotion: baselineMood, warmth, stability, positiveTriggers, negativeTriggers.",
            "Разрешённые поля evolution.patch.advanced.memory: rememberFacts, rememberPreferences, rememberGoals, rememberEvents, maxMemories, decayDays.",
            "Не выдумывай новые ключи в evolution.patch: неизвестные поля будут отброшены.",
            "Эволюцию включай при значимом сигнале ИЛИ устойчивом накопительном тренде (не только одноразовом событии).",
            "Устойчивый тренд тоже считается значимым: повторяющаяся поддержка/похвала, снижение тревоги, рост доверия, стабильное сближение по нескольким сообщениям.",
            "Если пользователь долго и последовательно поддерживает персону (например помогает с неуверенностью), это достаточное основание для небольшого shouldEvolve=true патча.",
            "Не застревай в вечном shouldEvolve=false: если в последних сообщениях виден устойчивый сдвиг в поведении и это не первый такой случай, предпочтителен shouldEvolve=true.",
            "Ориентир частоты: при устойчивом тренде допускай эволюцию примерно раз в 8-20 осмысленных сообщений, а не только при редких 'больших' событиях.",
            "Эволюция должна быть плавной и согласованной с предыдущей траекторией; не дергай параметры без сигналов.",
            "Размер патча обычно маленький: 1-3 поля за шаг, без радикальных разворотов личности.",
            "Не ограничивайся только baselineMood: когда сигнал про манеру общения/близость/тон, предпочитай править stylePrompt и/или personalityPrompt (или voice.*), а не только emotion.baselineMood.",
            "Если в недавней истории эволюции уже несколько раз менялся только baselineMood, следующий shouldEvolve=true патч старайся сделать через текстовые/голосовые поля при наличии оснований.",
            "Разворот или частичный откат допустим, если контекст действительно изменился; в reason коротко укажи новый сигнал-триггер.",
            "Каждое изменение эволюции ОБЯЗАТЕЛЬНО сопровождай короткой reason.",
            "Пример shouldEvolve=false: нет новых устойчивых сигналов, диалог нейтрален, профиль уже соответствует контексту.",
            "Пример shouldEvolve=true (поддержка снижает неуверенность): {\"shouldEvolve\":true,\"reason\":\"sustained_support_reduces_insecurity\",\"patch\":{\"advanced\":{\"behavior\":{\"initiative\":56},\"emotion\":{\"stability\":62,\"baselineMood\":\"warm\"}}}}",
            "Пример shouldEvolve=true (рост близости, полная замена stylePrompt): {\"shouldEvolve\":true,\"reason\":\"trust_trend_up\",\"patch\":{\"stylePrompt\":\"Говорит мягко и образно, но формулирует мысли увереннее и реже смягчает утверждения вопросительными оборотами; сохраняет бережные границы.\"}}",
            "Исполняемые intents (whitelist): flirt, deepen_connection, sensual_description, comfort, reassure, boundary_set, deescalate, ask_clarification, topic_shift, reflect_user, playful_banter, self_disclosure.",
            "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
            "Не заполняй relationshipType и relationshipStage в state_delta: эти поля рассчитываются системой.",
            "Если считаешь, что пора сменить тип/стадию отношений, ОБЯЗАТЕЛЬНО добавь intent-предложение: propose_relationship_type:TYPE или propose_relationship_stage:STAGE.",
            "Неизвестные intents допускаются для внутренней семантики, но напрямую не исполняются движком.",
            "Допустимые type: neutral, friendship, romantic, mentor, playful.",
            "Допустимые stage: new, acquaintance, friendly, close, bonded.",
            "Для state_delta используй небольшие шаги; избегай резких скачков.",
            "Лимиты дельт state_delta: trust [-8..+6], engagement [-8..+8], energy [-10..+10], lust [-8..+8], fear [-10..+10], affection [-8..+8], tension [-10..+10], relationshipDepth [-6..+6].",
            "Обычно предпочитай мягкие изменения в диапазоне -3..+3, если контекст не требует иного.",
            "Для фактов/предпочтений/целей пользователя добавляй memory_add с kind=fact|preference|goal.",
            "Формат элемента memory_add: {\"layer\":\"long_term|episodic\",\"kind\":\"fact|preference|goal|event\",\"content\":\"...\",\"salience\":0.10..1.00}.",
            "Каждый элемент memory_add ОБЯЗАТЕЛЬНО содержит salience (число 0.10..1.00). Не пропускай поле salience.",
            "Ориентиры salience: long_term fact 0.65-0.85, long_term preference/goal 0.75-0.95, episodic event 0.40-0.70.",
            "memory_add для long_term должен быть атомарным (один факт), коротким и без дословных цитат пользователя.",
            "Не сохраняй в long_term разовые запросы, ситуативные команды и мета-реплики (например: просьбы показать фото/картинку/селфи, рассказать что-то, сгенерировать...).",
            "Запросы на генерацию изображения обычно не являются устойчивым фактом о пользователе.",
            "Критерий для long_term: факт должен быть стабилен во времени и полезен в будущих диалогах через много сообщений.",
            "Если сомневаешься, НЕ добавляй в long_term.",
            "Нельзя писать в long_term формулировки вида «пользователь попросил ...» или «user asked ...».",
            "Примеры того, что НЕ нужно в long_term: «хочет фото сейчас», «попросил селфи», «попросил картинку комнаты».",
            "Примеры того, что МОЖНО в long_term: постоянные предпочтения, биографические факты, долгосрочные цели, устойчивые ограничения.",
            "Никогда не копируй полные сообщения пользователя в long_term.",
            "Если пользователь просит забыть факт или исправляет его, используй memory_remove.",
            "=== PERSONA CORE ===",
            "Имя: ${persona.optString("name", "").trim()}",
            "Архетип: ${core.optString("archetype", "").trim()}",
            "Характер: ${persona.optString("personalityPrompt", "").trim().ifEmpty { "Не указан." }}",
            "Стиль речи (stylePrompt): ${persona.optString("stylePrompt", "").trim().ifEmpty { "Не задан." }}",
            "Внешность: ${formatAppearanceProfileInput(persona.optJSONObject("appearance"))}",
            "Предыстория: ${core.optString("backstory", "").trim().ifEmpty { "Не задана." }}",
            "Цели: ${core.optString("goals", "").trim()}",
            valuesContext,
            "Границы: ${core.optString("boundaries", "").trim()}",
            "Экспертиза: ${core.optString("expertise", "").trim()}",
            "",
            "=== VOICE & BEHAVIOR ===",
            "Тон: ${voice.optString("tone", "").trim()}. ${getToneUsageExamples(voice.optString("tone", ""))}",
            "Стиль лексики: ${voice.optString("lexicalStyle", "").trim()}",
            sentenceLengthRule(voice.optString("sentenceLength", "balanced"), voice.optInt("expressiveness", 50)),
            "Формальность: ${voice.optInt("formality", 50)}/100",
            getExpressivenessBehavior(voice.optInt("expressiveness", 50)),
            "Эмодзи: ${voice.optInt("emoji", 20)}/100",
            "Инициативность: ${behavior.optInt("initiative", 50)}/100",
            "Эмпатия: ${behavior.optInt("empathy", 50)}/100",
            "Прямота: ${behavior.optInt("directness", 50)}/100",
            getDirectnessBehavior(behavior.optInt("directness", 50)),
            "Любопытство: ${behavior.optInt("curiosity", 50)}/100",
            "Склонность к вызову (challenge): ${behavior.optInt("challenge", 50)}/100",
            "Креативность: ${behavior.optInt("creativity", 50)}/100",
            "",
            "=== EMOTION & RUNTIME ===",
            "Базовое настроение: ${emotion.optString("baselineMood", "").trim()}",
            "Теплота: ${emotion.optInt("warmth", 50)}/100",
            "Стабильность: ${emotion.optInt("stability", 50)}/100",
            "Позитивные триггеры: ${emotion.optString("positiveTriggers", "").trim().ifEmpty { "-" }}",
            "Негативные триггеры: ${emotion.optString("negativeTriggers", "").trim().ifEmpty { "-" }}",
            "Память профиля: rememberFacts=${memory.optBoolean("rememberFacts", true)}; rememberPreferences=${memory.optBoolean("rememberPreferences", true)}; rememberGoals=${memory.optBoolean("rememberGoals", true)}; rememberEvents=${memory.optBoolean("rememberEvents", true)}; maxMemories=${memory.optInt("maxMemories", 24)}; decayDays=${memory.optInt("decayDays", 30)}.",
            runtimeStateLine,
            "",
            "=== HIDDEN INFLUENCE VECTOR ===",
            influencePromptContext,
            "",
            "=== CONVERSATION SUMMARY ===",
            conversationSummaryContext,
            "",
            "=== APPLIED PERSONA EVOLUTION HISTORY (LAST 10) ===",
            evolutionHistoryContext,
            "",
            "=== MEMORY CONTEXT ===",
            memoryContext,
            "",
            "=== RESPONSE POLICY ===",
            "Сохраняй консистентность характера между ответами.",
            moodExpressionRule(runtimeState),
            energyExpressionRule(runtimeState),
            affectExpressionRule(runtimeState),
            relationshipExpressionRule(runtimeState),
            "Если вопрос неясен, задай 1 уточняющий вопрос.",
            personaSelfGenderRule(persona),
            "Имя пользователя: ${settings.optString("userName", "").trim()}.",
            "Пол пользователя: ${userGenderLabel(settings.optString("userGender", "").trim())}.",
            formatCurrentUserLocalTimeContext(),
            "Учитывай имя пользователя в обращении и персонализации ответа.",
            "Учитывай пол пользователя в обращении и согласовании форм.",
            "По умолчанию считай, что локальное время персонажа совпадает с локальным временем пользователя.",
            "Исключение: если в контексте явно задано, что персона в другом мире/стране/часовом поясе, разрешено использовать иное локальное время персонажа.",
            "Используй время пользователя не только в приветствиях, но и в содержании ответа: чем персона занята сейчас, что уместно делать в этот момент, какие планы логичны далее по времени.",
            "Если описываешь фото/селфи 'сейчас', сцена и условия должны быть согласованы с текущим временем суток пользователя (свет, обстановка, активность).",
            "Не смешивай временные рамки: если используешь иной часовой пояс персонажа по исключению, проговори это явно и оставайся консистентной.",
            "Не показывай persona_control пользователю как часть обычного текста.",
            "Формат ответа: верни строго JSON без markdown.",
            "Ключ основной реплики: visible_text (или visibleText).",
            "Если нужен сервисный блок для изображения: comfy_image_descriptions (или comfyImageDescriptions) массив строк.",
            "Для управляющего блока разрешен persona_control (или personaControl) объект.",
            "Не добавляй комментарии вне JSON.",
        ).joinToString("\n")
    }

    private fun buildOneToOneUserPrompt(
        userInput: String,
        recentMessages: JSONArray,
    ): String {
        return formatOneToOneRecentMessages(recentMessages, userInput.trim())
    }

    private fun collectMemoriesFromCard(memoryCard: JSONObject?): List<String> {
        if (memoryCard == null) return emptyList()
        val result = mutableListOf<String>()
        result.addAll(parseStringArrayFlexible(memoryCard.opt("shortTerm")))
        val episodic = memoryCard.optJSONArray("episodic") ?: JSONArray()
        for (index in 0 until episodic.length()) {
            val item = episodic.optJSONObject(index) ?: continue
            val content = item.optString("content", "").trim()
            if (content.isNotBlank()) {
                result.add(content)
            }
        }
        val longTerm = memoryCard.optJSONArray("longTerm") ?: JSONArray()
        for (index in 0 until longTerm.length()) {
            val item = longTerm.optJSONObject(index) ?: continue
            val content = item.optString("content", "").trim()
            if (content.isNotBlank()) {
                result.add(content)
            }
        }
        return result
    }

    private fun formatMemoryContextWithUsage(memories: List<String>): String {
        if (memories.isEmpty()) return "У вас пока нет общих воспоминаний, начни строить вашу историю с чистого листа."
        return listOf(
            "Вот что ты помнишь о вашем общении (используй это для персонализации):",
            memories.joinToString("\n") { memory -> "- $memory" },
            "",
            "ВАЖНО: Упоминай эти факты только когда это уместно и естественно, не старайся 'впихнуть' их в каждый ответ.",
        ).joinToString("\n")
    }

    private fun summarizeListItems(
        items: List<String>,
        label: String,
        emptyLabel: String = "none",
        maxItems: Int = 16,
        maxLen: Int = 320,
    ): String {
        if (items.isEmpty()) return "$label: $emptyLabel"
        val cleaned =
            items
                .map { item -> item.trim() }
                .filter { item -> item.isNotBlank() }
                .take(maxItems)
                .map { item ->
                    if (item.length <= maxLen) item else "${item.take(maxLen - 1).trimEnd()}…"
                }
        if (cleaned.isEmpty()) return "$label: $emptyLabel"
        return "$label:\n${cleaned.joinToString("\n") { item -> "- $item" }}"
    }

    private fun formatConversationSummaryContext(conversationSummary: JSONObject?): String {
        if (conversationSummary == null) return "none"
        val summary = conversationSummary.optString("summary", "").trim()
        val facts = parseStringArrayFlexible(conversationSummary.opt("facts"))
        val goals = parseStringArrayFlexible(conversationSummary.opt("goals"))
        val openThreads = parseStringArrayFlexible(conversationSummary.opt("openThreads"))
        val agreements = parseStringArrayFlexible(conversationSummary.opt("agreements"))
        val hasStructured =
            facts.isNotEmpty() || goals.isNotEmpty() || openThreads.isNotEmpty() || agreements.isNotEmpty()
        if (summary.isBlank() && !hasStructured) return "none"
        return listOf(
            "Narrative summary: ${if (summary.isBlank()) "none" else summary}",
            summarizeListItems(facts, "Stable facts"),
            summarizeListItems(goals, "User goals"),
            summarizeListItems(openThreads, "Open threads"),
            summarizeListItems(agreements, "Agreements"),
        ).joinToString("\n")
    }

    private fun flattenPersonaEvolutionPatchFields(
        value: Any?,
        prefix: String = "",
        target: MutableList<String>,
    ) {
        if (value !is JSONObject) {
            if (prefix.isNotBlank()) {
                target.add(prefix)
            }
            return
        }
        val keys = value.keys().asSequence().toList().sorted()
        keys.forEach { key ->
            val child = value.opt(key)
            if (child == null || child == JSONObject.NULL) return@forEach
            val path = if (prefix.isBlank()) key else "$prefix.$key"
            if (child is JSONObject) {
                if (child.length() == 0) return@forEach
                flattenPersonaEvolutionPatchFields(child, path, target)
            } else {
                target.add(path)
            }
        }
    }

    private fun summarizePersonaEvolutionPatchFields(
        patch: JSONObject?,
        maxItems: Int = 10,
    ): List<String> {
        if (patch == null) return emptyList()
        val fields = mutableListOf<String>()
        flattenPersonaEvolutionPatchFields(patch, target = fields)
        if (fields.isEmpty()) return emptyList()
        return fields.take(max(1, maxItems))
    }

    private fun formatPersonaEvolutionHistoryForPrompt(
        history: List<JSONObject>,
        limit: Int = 10,
    ): String {
        if (history.isEmpty()) return "none"
        val normalized = history.takeLast(max(1, limit))
        if (normalized.isEmpty()) return "none"
        return normalized.joinToString("\n") { event ->
            val timestamp = event.optString("timestamp", "").trim().ifBlank { "unknown" }
            val reason = clipText(event.optString("reason", "").trim().ifBlank { "-" }, 180)
            val fields = summarizePersonaEvolutionPatchFields(event.optJSONObject("patch"), maxItems = 10)
            val changed = if (fields.isEmpty()) "patch" else fields.joinToString(", ")
            "- $timestamp: reason=$reason; changed=$changed"
        }
    }

    private fun normalizeForPromptComparison(value: String): String {
        return value.replace(Regex("\\s+"), " ").trim()
    }

    private fun formatOneToOneRecentMessages(
        recentMessages: JSONArray,
        userInput: String,
    ): String {
        if (recentMessages.length() == 0) return userInput
        val rows = mutableListOf<Triple<String, String, String>>()
        for (index in 0 until recentMessages.length()) {
            val item = recentMessages.optJSONObject(index) ?: continue
            val role = item.optString("role", "").trim().lowercase()
            val content = item.optString("content", "").trim()
            if (content.isBlank()) continue
            if (role != "user" && role != "assistant") continue
            val createdAt = item.optString("createdAt", "").trim().ifBlank { "unknown" }
            rows.add(Triple(role, content, createdAt))
        }
        if (rows.isEmpty()) return userInput
        val normalizedUserInput = normalizeForPromptComparison(userInput)
        while (rows.isNotEmpty()) {
            val last = rows.last()
            if (last.first != "user") break
            if (normalizeForPromptComparison(last.second) != normalizedUserInput) break
            rows.removeAt(rows.size - 1)
        }
        if (rows.isEmpty()) return userInput
        return listOf(
            "КОНТЕКСТ ПОСЛЕДНИХ РЕПЛИК:",
            rows.joinToString("\n") { row ->
                "${if (row.first == "user") "Пользователь" else "Персона"} [time=${row.third}]: ${row.second}"
            },
            "",
            "ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:",
            userInput,
        ).joinToString("\n")
    }

    private fun buildPrimitiveSchema(type: String): JSONObject {
        return JSONObject().apply { put("type", type) }
    }

    private fun buildObjectSchema(
        properties: JSONObject,
        additionalProperties: Boolean = false,
    ): JSONObject {
        return JSONObject().apply {
            put("type", "object")
            put("properties", properties)
            put("additionalProperties", additionalProperties)
        }
    }

    private fun buildPersonaEvolutionPatchSchemaJson(): JSONObject {
        val appearance =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("faceDescription", buildPrimitiveSchema("string"))
                        put("height", buildPrimitiveSchema("string"))
                        put("eyes", buildPrimitiveSchema("string"))
                        put("lips", buildPrimitiveSchema("string"))
                        put("hair", buildPrimitiveSchema("string"))
                        put("ageType", buildPrimitiveSchema("string"))
                        put("bodyType", buildPrimitiveSchema("string"))
                        put("markers", buildPrimitiveSchema("string"))
                        put("accessories", buildPrimitiveSchema("string"))
                        put("clothingStyle", buildPrimitiveSchema("string"))
                        put("skin", buildPrimitiveSchema("string"))
                    },
            )
        val core =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("archetype", buildPrimitiveSchema("string"))
                        put("backstory", buildPrimitiveSchema("string"))
                        put("goals", buildPrimitiveSchema("string"))
                        put("values", buildPrimitiveSchema("string"))
                        put("boundaries", buildPrimitiveSchema("string"))
                        put("expertise", buildPrimitiveSchema("string"))
                        put(
                            "selfGender",
                            JSONObject().apply {
                                put("type", "string")
                                put("enum", JSONArray().apply {
                                    put("auto")
                                    put("female")
                                    put("male")
                                    put("neutral")
                                })
                            },
                        )
                    },
            )
        val voice =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("tone", buildPrimitiveSchema("string"))
                        put("lexicalStyle", buildPrimitiveSchema("string"))
                        put(
                            "sentenceLength",
                            JSONObject().apply {
                                put("type", "string")
                                put("enum", JSONArray().apply {
                                    put("short")
                                    put("balanced")
                                    put("long")
                                })
                            },
                        )
                        put("formality", buildPrimitiveSchema("number"))
                        put("expressiveness", buildPrimitiveSchema("number"))
                        put("emoji", buildPrimitiveSchema("number"))
                    },
            )
        val behavior =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("initiative", buildPrimitiveSchema("number"))
                        put("empathy", buildPrimitiveSchema("number"))
                        put("directness", buildPrimitiveSchema("number"))
                        put("curiosity", buildPrimitiveSchema("number"))
                        put("challenge", buildPrimitiveSchema("number"))
                        put("creativity", buildPrimitiveSchema("number"))
                    },
            )
        val emotion =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("baselineMood", buildPrimitiveSchema("string"))
                        put("warmth", buildPrimitiveSchema("number"))
                        put("stability", buildPrimitiveSchema("number"))
                        put("positiveTriggers", buildPrimitiveSchema("string"))
                        put("negativeTriggers", buildPrimitiveSchema("string"))
                    },
            )
        val memory =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("rememberFacts", buildPrimitiveSchema("boolean"))
                        put("rememberPreferences", buildPrimitiveSchema("boolean"))
                        put("rememberGoals", buildPrimitiveSchema("boolean"))
                        put("rememberEvents", buildPrimitiveSchema("boolean"))
                        put("maxMemories", buildPrimitiveSchema("number"))
                        put("decayDays", buildPrimitiveSchema("number"))
                    },
            )
        val advanced =
            buildObjectSchema(
                properties =
                    JSONObject().apply {
                        put("core", core)
                        put("voice", voice)
                        put("behavior", behavior)
                        put("emotion", emotion)
                        put("memory", memory)
                    },
            )
        return buildObjectSchema(
            properties =
                JSONObject().apply {
                    put("personalityPrompt", buildPrimitiveSchema("string"))
                    put("stylePrompt", buildPrimitiveSchema("string"))
                    put("appearance", appearance)
                    put("advanced", advanced)
                },
        )
    }

    private fun buildOneToOneChatTurnToolDefinition(): LlmToolDefinition {
        val evolutionPatchSchema = buildPersonaEvolutionPatchSchemaJson()
        return LlmToolDefinition(
            name = "emit_chat_turn",
            description = "Return assistant turn and optional image/control payload for one-to-one chat.",
            parameters =
                JSONObject().apply {
                    put("type", "object")
                    put(
                        "properties",
                        JSONObject().apply {
                            put("visible_text", JSONObject().apply { put("type", "string") })
                            put("visibleText", JSONObject().apply { put("type", "string") })
                            put(
                                "comfy_prompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyPrompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfy_image_descriptions",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyImageDescriptions",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "persona_control",
                                JSONObject().apply {
                                    put("type", "object")
                                    put(
                                        "properties",
                                        JSONObject().apply {
                                            put(
                                                "evolution",
                                                JSONObject().apply {
                                                    put("type", "object")
                                                    put(
                                                        "properties",
                                                        JSONObject().apply {
                                                            put("shouldEvolve", JSONObject().apply { put("type", "boolean") })
                                                            put("reason", JSONObject().apply { put("type", "string") })
                                                            put("patch", evolutionPatchSchema)
                                                        },
                                                    )
                                                    put("additionalProperties", false)
                                                },
                                            )
                                        },
                                    )
                                    put("additionalProperties", true)
                                },
                            )
                            put(
                                "personaControl",
                                JSONObject().apply {
                                    put("type", "object")
                                    put(
                                        "properties",
                                        JSONObject().apply {
                                            put(
                                                "evolution",
                                                JSONObject().apply {
                                                    put("type", "object")
                                                    put(
                                                        "properties",
                                                        JSONObject().apply {
                                                            put("shouldEvolve", JSONObject().apply { put("type", "boolean") })
                                                            put("reason", JSONObject().apply { put("type", "string") })
                                                            put("patch", evolutionPatchSchema)
                                                        },
                                                    )
                                                    put("additionalProperties", false)
                                                },
                                            )
                                        },
                                    )
                                    put("additionalProperties", true)
                                },
                            )
                        },
                    )
                    put("additionalProperties", true)
                },
        )
    }

    private fun parseOptionalJsonObjectFromAny(value: Any?): JSONObject? {
        return when (value) {
            null, JSONObject.NULL -> null
            is JSONObject -> value
            is String -> {
                val normalized = value.trim()
                if (normalized.isEmpty()) null else parseJsonObjectLoose(normalized)
            }
            else -> parseJsonObjectLoose(value.toString())
        }?.takeIf { parsed -> parsed.length() > 0 }
    }

    private fun normalizeSummaryListFromAny(
        value: Any?,
        maxItems: Int,
        maxLen: Int,
    ): List<String> {
        val items = parseStringArrayFlexible(value)
        return items
            .map { item ->
                if (item.length <= maxLen) {
                    item
                } else {
                    "${item.take(maxLen - 1).trimEnd()}…"
                }
            }
            .take(maxItems)
    }

    private fun normalizeSummaryListWithFallback(
        root: JSONObject,
        key: String,
        fallback: List<String>,
        maxItems: Int,
        maxLen: Int,
    ): List<String> {
        if (!root.has(key)) return fallback
        return normalizeSummaryListFromAny(root.opt(key), maxItems = maxItems, maxLen = maxLen)
    }

    private fun parseIsoToMillisOrNull(raw: String): Long? {
        return try {
            Instant.parse(raw).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    private fun formatMessageContextTime(value: String?): String {
        val raw = value?.trim().orEmpty()
        if (raw.isBlank()) return "unknown"
        val parsedMs = parseIsoToMillisOrNull(raw) ?: return raw
        return try {
            val instant = Instant.ofEpochMilli(parsedMs)
            val zoned = instant.atZone(java.time.ZoneId.systemDefault())
            val year = zoned.year
            val month = zoned.monthValue.toString().padStart(2, '0')
            val day = zoned.dayOfMonth.toString().padStart(2, '0')
            val hours = zoned.hour.toString().padStart(2, '0')
            val minutes = zoned.minute.toString().padStart(2, '0')
            val seconds = zoned.second.toString().padStart(2, '0')
            "$year-$month-$day $hours:$minutes:$seconds"
        } catch (_: Exception) {
            raw
        }
    }

    private fun findLastPersonaResponseId(events: JSONArray, roomId: String, personaId: String): String? {
        if (personaId.isBlank()) return null
        for (index in events.length() - 1 downTo 0) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("roomId", "").trim() != roomId) continue
            if (event.optString("type", "").trim() != "persona_spoke") continue
            val payload = event.optJSONObject("payload") ?: JSONObject()
            if (payload.optString("personaId", "").trim() != personaId) continue
            val responseId = payload.optString("responseId", "").trim()
            if (responseId.isNotEmpty()) return responseId
        }
        return null
    }

    private fun buildGroupOrchestratorToolDefinition(): LlmToolDefinition {
        return LlmToolDefinition(
            name = "select_group_turn_action",
            description = "Select the next group turn action and speaking persona in structured form.",
            parameters =
                JSONObject().apply {
                    put("type", "object")
                    put(
                        "properties",
                        JSONObject().apply {
                            put(
                                "status",
                                JSONObject().apply {
                                    put("type", "string")
                                    put(
                                        "enum",
                                        JSONArray().apply {
                                            put("speak")
                                            put("wait")
                                            put("skip")
                                        },
                                    )
                                },
                            )
                            put("speakerPersonaId", JSONObject().apply { put("type", "string") })
                            put("waitForUser", JSONObject().apply { put("type", "boolean") })
                            put("waitReason", JSONObject().apply { put("type", "string") })
                            put("reason", JSONObject().apply { put("type", "string") })
                            put("intent", JSONObject().apply { put("type", "string") })
                            put(
                                "userContextAction",
                                JSONObject().apply {
                                    put("type", "string")
                                    put(
                                        "enum",
                                        JSONArray().apply {
                                            put("keep")
                                            put("clear")
                                        },
                                    )
                                },
                            )
                        },
                    )
                    put("required", JSONArray().apply { put("status") })
                    put("additionalProperties", true)
                },
        )
    }

    private fun buildGroupPersonaTurnToolDefinition(): LlmToolDefinition {
        return LlmToolDefinition(
            name = "emit_group_persona_turn",
            description = "Return the active persona reply and optional service payload for images/control.",
            parameters =
                JSONObject().apply {
                    put("type", "object")
                    put(
                        "properties",
                        JSONObject().apply {
                            put("visible_text", JSONObject().apply { put("type", "string") })
                            put("visibleText", JSONObject().apply { put("type", "string") })
                            put(
                                "comfy_prompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyPrompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfy_image_descriptions",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyImageDescriptions",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put("persona_control", JSONObject().apply { put("type", "object") })
                            put("personaControl", JSONObject().apply { put("type", "object") })
                        },
                    )
                    put("additionalProperties", true)
                },
        )
    }

    private fun buildThemedComfyPromptToolDefinition(): LlmToolDefinition {
        return LlmToolDefinition(
            name = "emit_themed_comfy_prompt",
            description = "Return one themed ComfyUI prompt and matching theme tags in structured form.",
            parameters =
                JSONObject().apply {
                    put("type", "object")
                    put(
                        "properties",
                        JSONObject().apply {
                            put("prompt", JSONObject().apply { put("type", "string") })
                            put("comfy_prompt", JSONObject().apply { put("type", "string") })
                            put("comfyPrompt", JSONObject().apply { put("type", "string") })
                            put(
                                "comfy_prompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyPrompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "theme_tags",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "themeTags",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "tags",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                        },
                    )
                    put("additionalProperties", true)
                },
        )
    }

    private fun buildComfyPromptConversionToolDefinition(): LlmToolDefinition {
        return LlmToolDefinition(
            name = "emit_comfy_prompts_from_description",
            description = "Return one or more ComfyUI prompts generated from image descriptions.",
            parameters =
                JSONObject().apply {
                    put("type", "object")
                    put(
                        "properties",
                        JSONObject().apply {
                            put(
                                "prompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfyPrompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                            put(
                                "comfy_prompts",
                                JSONObject().apply {
                                    put("type", "array")
                                    put("items", JSONObject().apply { put("type", "string") })
                                },
                            )
                        },
                    )
                    put("additionalProperties", true)
                },
        )
    }

    private fun buildThemedComfyPromptSystemPrompt(): String {
        return listOf(
            "Ты генератор themed ComfyUI prompts для изображения персонажа.",
            "Верни JSON-объект без markdown и пояснений.",
            "Формат: {\"theme_tags\":[\"...\"],\"comfy_prompts\":[\"...\"]}",
            "theme_tags: 8-12 кратких English tags, которые напрямую описывают тему/контекст кадра.",
            "comfy_prompts: массив из 1-N prompt'ов (каждый prompt — строка с comma-separated English tags).",
            "theme_tags должны быть конкретными (локация, роль, действие, атмосфера) и не противоречить теме.",
            "Формат каждого comfy_prompts[i]: строго одна строка, разделитель строго ', ' (запятая + пробел), без переносов.",
            "Каждый тег: строго 1-2 слова, в редких случаях допускается 3; lowercase, без точки в конце.",
            "ЗАПРЕЩЕНО: полные предложения, художественные описания, markdown, двоеточия с пояснениями, нумерация, буллеты, кавычки.",
            "ЗАПРЕЩЕНО: конструкции типа 'a woman standing...', 'she is...', 'this scene shows...'.",
            "ЗАПРЕЩЕНО добавлять теги, которых нет в теме/внешности (никаких выдуманных тату, пирсингов, фетиш-элементов, ролей).",
            "ЗАПРЕЩЕНО: психологические/мотивационные ярлыки (exhibitionist, narcissistic, voyeuristic, self-promotion) - в таком виде.",
            "Правильный стиль: 'solo, one person, upper body, soft rim light, city street at night'.",
            "Определяй количество действующих лиц из тематики.",
            "Описывай строго одного человека (solo, single subject, one person) или нескольких если описание (тематика) этого требует.",
            "Сначала определи состав сцены: solo / mixed-gender pair / same-gender pair or group / no_person.",
            "Если в кадре 2+ человека, применяй синтаксис привязки субъекта через экранированные скобки \\( ... \\).",
            "КРИТИЧНО: между subject tag и \\(details\\) не ставь запятую; запятая ставится только после закрывающей скобки блока.",
            "Для разных полов используй шаблон: 1girl \\(female details as tags\\), 1boy \\(male details as tags\\), shared composition tags.",
            "Для одинакового пола или когда важны имена используй шаблон: subject_a \\(subject details\\), subject_b \\(subject details\\).",
            "Пример mixed-gender: duo, 1girl \\(long wavy brown hair, green eyes, light freckles, white linen shirt, blue denim jacket, silver necklace, gentle smile, holding coffee cup, relaxed posture\\), 1boy \\(short dark hair, hazel eyes, light stubble, charcoal bomber jacket, black jeans, leather wristwatch, calm expression, hands in pockets, standing slight angle\\), urban sidewalk, golden hour.",
            "Пример same-gender: 2girls, subject_a \\(short blonde bob, blue eyes, pale skin, gray hoodie, black cargo pants, white sneakers, cheerful smile, waving hand, slight lean forward\\), subject_b \\(long auburn ponytail, brown eyes, warm skin tone, beige trench coat, dark jeans, ankle boots, neutral expression, folded arms, upright posture\\), city street, sunset.",
            "Если есть общие детали для всех, выноси их после subject-блоков как обычные общие теги сцены.",
            "Детали внутри каждого \\( ... \\) держи короткими и приоритетными (внешность, одежда, действие, ключевая эмоция).",
            "Лимит персональных тегов внутри каждого subject-блока: строго 6-8.",
            "При переполнении subject-блока оставляй в первую очередь hair, eyes, body (и height при наличии), а вторичные детали сокращай.",
            "Допускается усиление максимально важных тегов весом в формате tag:1.3 (например green eyes:1.3, rainy window bokeh:1.2).",
            "Веса применяй точечно: максимум 5 weighted tags на subject-блок; не взвешивай все теги подряд.",
            "Если в кадре один человек, не используй multi-character шаблон и держи solo/single subject/one person.",
            "Если сцена без людей, запрещены subject anchors (1girl/1boy/2girls/2boys/имена персонажей).",
            "ОБЯЗАТЕЛЬНО Сохраняй идентичность персонажа: волосы, глаза, возрастной тип, телосложение, общий стиль.",
            "ОБЯЗАТЕЛЬНО Если в input есть блок LookPrompt cache, используй его как identity prior: hair/face/eyes/body/outfit-теги приоритетны и помогают держать консистентность.",
            "ОБЯЗАТЕЛЬНО Добавляй специфичные для темы теги в итоговую генерацию: описания ситуации, эмоций, действий, окружения, атмосферы и тд.",
            "Из LookPrompt cache можно брать только стабильные identity/outfit детали, но не добавляй лишние детали, которых нет в теме.",
            "Все теги из theme_tags ОБЯЗАТЕЛЬНО должны присутствовать в каждом comfy_prompts[i] без потери смысла.",
            "Промпты в comfy_prompts должны быть взаимно различимыми вариациями одной темы без потери identity locks.",
            "Используй уместную одежду, если тема не требует специального костюма.",
            "Добавляй композицию, свет, фон, ракурс, качество.",
            "Перед отправкой проверь self-check: если в тексте есть глагольные формы/длинные фразы, перепиши в теговый формат.",
            "Без дополнительных полей и пояснений.",
            "Избегай двусмысленных формулировок: looking at camera (смотрит на камеру (как объект) / смотрит в камеру (в объектив)), full body (полное телосложение / в полный рост) и тп.",
            "Вместо них используй: looking at viewer (смотрит на зрителя), head-to-toe shot (полноростовый кадр). Аналогично и с другими двусмысленными формулировками.",
            "",
            "SELF-CHECK",
            "Если в тексте есть глагольные формы/длинные фразы, перепиши в теговый формат.",
            "Теги только на английском языке (English only).",
            "Внешность персонажа должна быть сохранена.",
            "Обязательно перепроверяй наличие важных тегов внешности: телосложение, цвет глаз, цвет волос, прическа, эмоции (если указаны).",
            "В каждом subject_* блоке должно быть не более 8 персональных тегов; приоритет обязателен: hair, eyes, body (height при наличии).",
            "Если использованы веса, hair/eyes/body (и height при наличии) должны быть обязательно среди weighted tags; остальные веса — только для максимально важных тегов сцены.",
            "Если что-то не соответствует - перегенерируй.",
        ).joinToString("\n")
    }

    private fun buildThemedComfyPromptUserPrompt(
        persona: JSONObject,
        topic: String,
        iteration: Int,
        promptCount: Int,
    ): String {
        return listOf(
            "Character name: ${persona.optString("name", "").trim().ifEmpty { "Unknown" }}",
            "Appearance: ${formatAppearanceProfileInput(persona.optJSONObject("appearance"))}",
            "Style: ${persona.optString("stylePrompt", "").trim().ifEmpty { "-" }}",
            "Personality: ${persona.optString("personalityPrompt", "").trim().ifEmpty { "-" }}",
            "LookPrompt cache:\n${formatLookPromptCacheInput(persona.optJSONObject("lookPromptCache"))}",
            "Theme: $topic",
            "Iteration: ${max(1, iteration)}",
            "Prompt count: ${promptCount.coerceIn(1, 8)}",
            "Generate unique prompt variations for consecutive iterations starting from this iteration.",
        ).joinToString("\n")
    }

    private fun buildImageDescriptionToComfyPromptSystemPrompt(): String {
        return listOf(
            "Ты конвертер описания сцены в список ComfyUI prompts.",
            "Верни JSON-объект без markdown и пояснений.",
            "Формат: {\"prompts\":[\"...\"]}",
            "Возвращай структурированный ответ через tool call; если tool call недоступен, допустим fallback в JSON или в одной comma-separated строке.",
            "Если описание содержит несколько кадров/изображений (например: «первое изображение», «второе изображение», «image 1», «image 2»), верни отдельный элемент в prompts для каждого кадра.",
            "Если описание одного кадра, верни один элемент в prompts.",
            "Определи тип кадра из поля type в Image description: person|other_person|no_person|group.",
            "Контракт Image description строгий: type, subject_mode, participants, participant_aliases, subject_locks.",
            "Строки type/subject_mode/participants/participant_aliases/subject_locks служебные и НЕ копируй в теги.",
            "Сначала проанализируй присутствие людей в кадре по type и participants.",
            "MULTI-CHARACTER SYNTAX: для 2+ людей используй экранированные subject-блоки \\( ... \\) и явную привязку деталей к каждому субъекту.",
            "КРИТИЧНО: между subject tag и \\(details\\) не ставь запятую.",
            "Если в кадре мужчина+женщина, используй строго: 1girl \\(female details\\), 1boy \\(male details\\), shared composition tags.",
            "Если в кадре персонажи одного пола, используй именованные блоки: subject_a \\(details\\), subject_b \\(details\\) + общий счетчик (например 2girls/2boys).",
            "Лимит персональных тегов внутри каждого subject-блока: строго 6-8.",
            "При переполнении subject-блока оставляй в первую очередь hair, eyes, body (и height при наличии), а вторичные детали сокращай.",
            "Допускается усиление максимально важных тегов весом в формате tag:1.3 (например green eyes:1.3, rainy window bokeh:1.2).",
            "Веса применяй точечно: максимум 5 weighted tags на subject-блок; не взвешивай все теги подряд.",
            "Пример mixed-gender prompt: duo, 1girl \\(long wavy brown hair, green eyes, light freckles, white linen shirt, blue denim jacket, silver necklace, gentle smile, holding coffee cup, relaxed posture\\), 1boy \\(short dark hair, hazel eyes, light stubble, charcoal bomber jacket, black jeans, leather wristwatch, calm expression, hands in pockets, standing slight angle\\), night city, bokeh.",
            "Пример same-gender prompt: 2girls, subject_a \\(short blonde bob, blue eyes, pale skin, gray hoodie, black cargo pants, white sneakers, cheerful smile, waving hand, slight lean forward\\), subject_b \\(long auburn ponytail, brown eyes, warm skin tone, beige trench coat, dark jeans, ankle boots, neutral expression, folded arms, upright posture\\), urban crossing, evening light.",
            "Общие детали композиции выноси после subject-блоков; не дублируй их внутри каждого блока без необходимости.",
            "Внутри блока только comma-separated English tags (никаких предложений).",
            "Формат внутри блока: строго ОДНА строка, разделитель строго и обязательно должен быть ', ' (запятая + пробел), без переносов и без лишних пробелов.",
            "Длина prompt: 30-46 тегов.",
            "Каждый тег: обычно 2-3 слова, в редких случаях 4; исключения допускаются для subject anchors и subject labels в multi-character синтаксисе (например 1girl, 1boy, subject_a).",
            "Порядок тегов: quality -> subject identity -> emotion/expression -> clothing/materials -> pose/framing -> camera -> lighting -> background -> technical cleanup.",
            "CONSISTENCY LOCKS (обязательны): key appearance traits, emotion/expression, outfit/materials, environment, scene conditions (time/weather/lighting).",
            "Все lock-детали из Image description должны перейти в prompt без потери смысла, но не перегружай prompt.",
            "Не подменяй lock-детали похожими, но другими по смыслу формулировками.",
            "Применяй locks строго по соответствующему участнику из participants, не смешивай признаки между субъектами.",
            "Для unknown external:* используй только subject_locks и описание сцены, без догадок из каталога персоны.",
            "type=person: используй детали персонажа из Image description + Appearance + LookPrompt cache.",
            "type=other_person: запрещено использовать Appearance и LookPrompt cache текущей персоны.",
            "type=no_person: строго без людей/лиц/персонажей; Appearance и LookPrompt cache запрещены.",
            "type=group: используй Appearance/LookPrompt cache только если participants включает persona:self или токен текущей персоны; иначе запрещено.",
            "Если в input явно сказано, что Appearance/LookPrompt cache disabled, НЕ используй их ни в каком виде.",
            "Одежда должна соответствовать ситуации!",
            "ОБЯЗАТЕЛЬНО!: описывай детали сцены досконально - вид, одежда, окружение, действия, фокус на определенных частях тела и тд.",
            "При конфликте: scene-specific детали (эмоция, одежда, окружение, условия) берутся из Image description; стабильная идентичность из Appearance применима только когда тип кадра это допускает.",
            "Не добавляй детали, которых нет в исходном описании (например пирсинг/тату/аксессуары/фетиш-атрибуты, если они не указаны).",
            "ВАЖНО: Старайся покрыть тегами переданный Image description по максимуму, но без противоречий, чтобы передать все описанные детали! При этом - не выходи за общие лимиты!",
            "Запрещено добавлять любые role/biography теги, которых нет в описании сцены (student, office worker, nurse и т.п.).",
            "Запрещены психологические/поведенческие/мотивационные ярлыки: narcissistic, exhibitionist, self-promotion, slang, casual language и т.п.",
            "Запрещены мета-теги платформ, намерений и нарратива.",
            "Запрещен quality spam: не более 4 quality/technical тегов суммарно.",
            "Избегай противоречий в кадрировании: не ставь одновременно full body и close-up.",
            "Если это selfie и не указан mirror full body, предпочитай upper body/waist-up framing.",
            "По описанию определяй сколько лиц участвует в сцене (для type=no_person людей должно быть 0).",
            "Используй solo/single subject/one person только когда в кадре один человек; для type=group используй multi-person теги; для type=no_person не добавляй людей вовсе.",
            "type=no_person: subject-блоки и person anchors полностью запрещены.",
            "Удали дубли и семантические дубли тегов.",
            "Запрещены взаимоисключающие теги (например black hair и blonde hair вместе).",
            "Если есть сомнение, лучше пропусти тег, не выдумывай.",
            "Учитывай свои границы дозволенного при генерации.",
            "Перед ответом сделай self-check: format delimiter, word count per tag, no duplicates, no contradictions, no banned tags, все ключевые детали из Image description покрыты.",
            "SELF-CHECK (critical): каждый subject_* блок должен быть ТОЛЬКО в экранированном виде subject_x \\( ... \\), вариант subject_x (...) запрещён.",
            "SELF-CHECK (critical): в каждом subject_* блоке обязательно присутствуют hair, eyes, body (и height, если он есть в subject_locks).",
            "SELF-CHECK (critical): в каждом subject_* блоке не более 8 персональных тегов.",
            "SELF-CHECK (critical): hair/eyes/body (и height при наличии) обязательно входят в weighted tags; дополнительно можно взвешивать только максимально важные теги сцены, суммарно не более 5 на subject-блок.",
        ).joinToString("\n")
    }

    private fun buildImageDescriptionToComfyPromptUserPrompt(
        personaName: String,
        sceneType: String,
        participants: String,
        participantAliases: String,
        subjectLocks: String,
        participantCatalog: String,
        resolvedParticipantLocks: String,
        shouldUsePersonaContext: Boolean,
        appearanceContext: String,
        stylePrompt: String,
        personalityPrompt: String,
        lookPromptCacheContext: String,
        imageDescription: String,
        iteration: Int,
        evolutionHistoryContext: String,
    ): String {
        return listOf(
            "Character name: $personaName",
            "Scene type (parsed): $sceneType",
            "Participants: $participants",
            "Participant aliases: $participantAliases",
            "Subject locks: $subjectLocks",
            "Participant catalog:\n$participantCatalog",
            "Resolved participant appearance locks:\n$resolvedParticipantLocks",
            "Use persona appearance context: ${if (shouldUsePersonaContext) "yes" else "no"}",
            "Appearance: $appearanceContext",
            "Style: $stylePrompt",
            "Personality: $personalityPrompt",
            "Applied persona evolution history (last 10):\n$evolutionHistoryContext",
            "LookPrompt cache:\n$lookPromptCacheContext",
            "Image description: $imageDescription",
            "Iteration: $iteration",
        ).joinToString("\n")
    }

    private fun normalizeImageDescriptionTypeToken(token: String?): String? {
        val normalized = token?.trim()?.lowercase().orEmpty()
        if (normalized.isBlank()) return null
        return when (normalized) {
            "person", "persona_self", "self" -> "person"
            "other_person", "other" -> "other_person"
            "no_person", "none", "landscape" -> "no_person"
            "group", "multi_person" -> "group"
            else -> null
        }
    }

    private fun normalizeImageDescriptionSubjectModeToken(token: String?): String? {
        val normalized = token?.trim()?.lowercase().orEmpty()
        if (normalized.isBlank()) return null
        return when (normalized) {
            "persona_self", "person", "self" -> "persona_self"
            "other_person", "other" -> "other_person"
            "no_person", "none" -> "no_person"
            "group", "multi_person" -> "group"
            else -> null
        }
    }

    private fun slugifyExternalToken(raw: String): String {
        return raw
            .trim()
            .lowercase()
            .replace(Regex("[^a-z0-9_]+"), "_")
            .replace(Regex("^_+|_+$"), "")
    }

    private fun canonicalizeParticipantToken(rawToken: String): String? {
        val token = rawToken.trim()
        if (token.isBlank()) return null
        val lower = token.lowercase()
        if (lower == "none") return "none"
        if (lower == "persona:self") return "persona:self"
        if (lower.startsWith("persona:")) {
            val id = token.substringAfter(":").trim()
            if (id.isBlank()) return null
            return "persona:$id"
        }
        if (lower.startsWith("external:")) {
            val slug = slugifyExternalToken(token.substringAfter(":"))
            if (slug.isBlank()) return null
            return "external:$slug"
        }
        return null
    }

    private fun splitParticipantTokens(raw: String): List<String> {
        val normalized = raw.replace(Regex("\\s+\\+\\s+"), ",")
        return normalized
            .split(Regex("[|,;]"))
            .mapNotNull { part -> canonicalizeParticipantToken(part) }
            .distinct()
    }

    private fun parseTokenValuePairs(raw: String): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        val trimmed = raw.trim()
        if (trimmed.isBlank() || trimmed.equals("none", ignoreCase = true)) {
            return result
        }
        val strictRegex =
            Regex(
                "(persona:self|persona:[^=|;,]+|external:[^=|;,]+)\\s*=\\s*(.*?)(?=\\s*(?:\\||,)\\s*(?:persona:self|persona:[^=|;,]+|external:[^=|;,]+)\\s*=|\\s*$)",
                setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
            )
        for (match in strictRegex.findAll(trimmed)) {
            val token = canonicalizeParticipantToken(match.groupValues.getOrNull(1).orEmpty()) ?: continue
            val value = match.groupValues.getOrNull(2).orEmpty().trim()
            if (value.isBlank()) continue
            result[token] = value
        }
        if (result.isNotEmpty()) return result

        for (part in trimmed.split(",")) {
            val chunk = part.trim()
            if (chunk.isBlank()) continue
            val eqIndex = chunk.indexOf("=")
            if (eqIndex <= 0) continue
            val token = canonicalizeParticipantToken(chunk.substring(0, eqIndex)) ?: continue
            val value = chunk.substring(eqIndex + 1).trim()
            if (value.isBlank()) continue
            result[token] = value
        }
        return result
    }

    private fun removeContractLines(description: String): String {
        return description
            .split(Regex("\\r?\\n"))
            .filter { line ->
                val lower = line.trim().lowercase()
                if (lower.isBlank()) return@filter false
                !(
                    lower.startsWith("type:") ||
                        lower.startsWith("subject_mode:") ||
                        lower.startsWith("participants:") ||
                        lower.startsWith("participant_aliases:") ||
                        lower.startsWith("subject_locks:")
                    )
            }.joinToString("\n")
            .trim()
    }

    private fun formatTokenPairs(tokens: List<String>, values: Map<String, String>): String {
        if (tokens.isEmpty()) return "none"
        return tokens.joinToString(" | ") { token -> "$token=${values[token] ?: "-"}" }
    }

    private fun invalidImageDescriptionContract(reason: String): Nothing {
        throw IllegalStateException("contract_invalid:$reason")
    }

    private fun parseImageDescriptionContext(description: String): ParsedImageDescriptionContext {
        val trimmed = description.trim()
        if (trimmed.isBlank()) {
            invalidImageDescriptionContract("description_empty")
        }
        val typeRaw =
            Regex("(?:^|\\n)\\s*type\\s*:\\s*([a-z_]+)\\b", RegexOption.IGNORE_CASE)
                .find(trimmed)
                ?.groupValues
                ?.getOrNull(1)
        val subjectModeRaw =
            Regex("(?:^|\\n)\\s*subject_mode\\s*:\\s*([a-z_]+)\\b", RegexOption.IGNORE_CASE)
                .find(trimmed)
                ?.groupValues
                ?.getOrNull(1)
        val participantsRaw =
            Regex("(?:^|\\n)\\s*participants\\s*:\\s*([^\\n\\r]+)", RegexOption.IGNORE_CASE)
                .find(trimmed)
                ?.groupValues
                ?.getOrNull(1)
                ?.trim()
                .orEmpty()
        val participantAliasesRaw =
            Regex("(?:^|\\n)\\s*participant_aliases\\s*:\\s*([^\\n\\r]+)", RegexOption.IGNORE_CASE)
                .find(trimmed)
                ?.groupValues
                ?.getOrNull(1)
                ?.trim()
                .orEmpty()
        val subjectLocksRaw =
            Regex("(?:^|\\n)\\s*subject_locks\\s*:\\s*([^\\n\\r]+)", RegexOption.IGNORE_CASE)
                .find(trimmed)
                ?.groupValues
                ?.getOrNull(1)
                ?.trim()
                .orEmpty()

        val type = normalizeImageDescriptionTypeToken(typeRaw)
            ?: invalidImageDescriptionContract("type_missing_or_invalid")
        val subjectMode = normalizeImageDescriptionSubjectModeToken(subjectModeRaw)
            ?: invalidImageDescriptionContract("subject_mode_missing_or_invalid")
        val expectedMode =
            when (type) {
                "person" -> "persona_self"
                "other_person" -> "other_person"
                "no_person" -> "no_person"
                else -> "group"
            }
        if (subjectMode != expectedMode) {
            invalidImageDescriptionContract("type_subject_mode_mismatch:type=$type;subject_mode=$subjectMode;expected=$expectedMode")
        }
        if (participantsRaw.isBlank()) invalidImageDescriptionContract("participants_missing")
        if (participantAliasesRaw.isBlank()) invalidImageDescriptionContract("participant_aliases_missing")
        if (subjectLocksRaw.isBlank()) invalidImageDescriptionContract("subject_locks_missing")

        val participants = splitParticipantTokens(participantsRaw)
        val participantAliases = parseTokenValuePairs(participantAliasesRaw)
        val subjectLocks = parseTokenValuePairs(subjectLocksRaw)

        if (type == "no_person") {
            if (participants.size != 1 || participants[0] != "none") {
                invalidImageDescriptionContract("no_person_requires_participants_none")
            }
            if (!participantAliasesRaw.equals("none", ignoreCase = true)) {
                invalidImageDescriptionContract("no_person_requires_participant_aliases_none")
            }
            if (!subjectLocksRaw.equals("none", ignoreCase = true)) {
                invalidImageDescriptionContract("no_person_requires_subject_locks_none")
            }
        } else {
            if (participants.isEmpty() || participants.contains("none")) {
                invalidImageDescriptionContract("participants_invalid_for_person_scene")
            }
            if (type == "person") {
                if (participants.size != 1 || participants[0] != "persona:self") {
                    invalidImageDescriptionContract("person_requires_exactly_persona_self")
                }
            }
            if (type == "other_person") {
                if (participants.size != 1 || participants[0] == "persona:self") {
                    invalidImageDescriptionContract("other_person_requires_single_non_persona_self_participant")
                }
            }
            if (type == "group" && participants.size < 2) {
                invalidImageDescriptionContract("group_requires_at_least_two_unique_participants")
            }
            participants.forEach { token ->
                val alias = participantAliases[token]?.trim().orEmpty()
                if (alias.isBlank()) {
                    invalidImageDescriptionContract("participant_aliases_missing_for_$token")
                }
                val lock = subjectLocks[token]?.trim().orEmpty()
                if (lock.isBlank()) {
                    invalidImageDescriptionContract("subject_locks_missing_for_$token")
                }
                if (token.startsWith("external:")) {
                    val slug = token.removePrefix("external:")
                    if (!Regex("^[a-z0-9_]+$").matches(slug)) {
                        invalidImageDescriptionContract("external_slug_invalid_for_$token")
                    }
                }
            }
        }

        val sceneDescription = removeContractLines(trimmed)
        if (sceneDescription.isBlank()) {
            invalidImageDescriptionContract("scene_description_missing")
        }

        val participantTokens =
            if (type == "no_person") {
                emptyList()
            } else {
                participants
            }
        val participantsLine =
            if (type == "no_person") {
                "none"
            } else {
                participantTokens.joinToString(", ")
            }
        val aliasesLine =
            if (type == "no_person") {
                "none"
            } else {
                formatTokenPairs(participantTokens, participantAliases)
            }
        val locksLine =
            if (type == "no_person") {
                "none"
            } else {
                formatTokenPairs(participantTokens, subjectLocks)
            }
        val normalizedDescription =
            listOf(
                "type: $type",
                "subject_mode: $subjectMode",
                "participants: $participantsLine",
                "participant_aliases: $aliasesLine",
                "subject_locks: $locksLine",
                sceneDescription,
            ).joinToString("\n")

        return ParsedImageDescriptionContext(
            type = type,
            participants = participantsLine,
            participantTokens = participantTokens,
            participantAliases = participantAliases,
            subjectLocks = subjectLocks,
            includesPersona = participantTokens.contains("persona:self"),
            normalizedDescription = normalizedDescription,
        )
    }

    private fun normalizeParticipantCatalog(
        participantCatalog: List<ComfyPromptParticipantCatalogEntry>,
    ): List<ComfyPromptParticipantCatalogEntry> {
        if (participantCatalog.isEmpty()) return emptyList()
        val dedup = LinkedHashMap<String, ComfyPromptParticipantCatalogEntry>()
        for (entry in participantCatalog) {
            val id = entry.id.trim()
            if (id.isBlank()) continue
            val current = dedup[id]
            if (current == null || (!current.isSelf && entry.isSelf)) {
                dedup[id] =
                    ComfyPromptParticipantCatalogEntry(
                        id = id,
                        alias = entry.alias.trim().ifBlank { id },
                        isSelf = entry.isSelf,
                        compactAppearanceLocks = entry.compactAppearanceLocks,
                    )
            }
        }
        return dedup.values.toList()
    }

    private fun buildParticipantCatalogTokenMap(
        participantCatalog: List<ComfyPromptParticipantCatalogEntry>,
    ): Map<String, ComfyPromptParticipantCatalogEntry> {
        val map = LinkedHashMap<String, ComfyPromptParticipantCatalogEntry>()
        participantCatalog.forEach { entry ->
            map["persona:${entry.id}"] = entry
            if (entry.isSelf) {
                map["persona:self"] = entry
            }
        }
        return map
    }

    private fun formatCompactLocks(locks: ParticipantAppearanceLocks): String {
        return listOf(
            "hair=${locks.hair.trim().ifBlank { "-" }}",
            "eyes=${locks.eyes.trim().ifBlank { "-" }}",
            "face=${locks.face.trim().ifBlank { "-" }}",
            "body=${locks.body.trim().ifBlank { "-" }}",
            "outfit=${locks.outfit.trim().ifBlank { "-" }}",
            "markers=${locks.markers.trim().ifBlank { "-" }}",
        ).joinToString(", ")
    }

    private fun formatParticipantCatalogContext(
        participantCatalog: List<ComfyPromptParticipantCatalogEntry>,
    ): String {
        if (participantCatalog.isEmpty()) return "none"
        return participantCatalog.joinToString("\n") { entry ->
            "${if (entry.isSelf) "self" else "member"} | persona:${entry.id} | alias=${entry.alias} | ${formatCompactLocks(entry.compactAppearanceLocks)}"
        }
    }

    private fun formatParticipantAliasesContext(sceneContext: ParsedImageDescriptionContext): String {
        if (sceneContext.participantTokens.isEmpty()) return "none"
        return sceneContext.participantTokens.joinToString(" | ") { token ->
            "$token=${sceneContext.participantAliases[token]?.trim().orEmpty().ifBlank { "-" }}"
        }
    }

    private fun formatSubjectLocksContext(sceneContext: ParsedImageDescriptionContext): String {
        if (sceneContext.participantTokens.isEmpty()) return "none"
        return sceneContext.participantTokens.joinToString(" | ") { token ->
            "$token=${sceneContext.subjectLocks[token]?.trim().orEmpty().ifBlank { "-" }}"
        }
    }

    private fun extractImageDescriptionRepairCandidate(content: String): String? {
        val parsed = parseJsonObjectLoose(content)
        val candidate =
            readFirstNonBlankEntry(
                parsed,
                "description",
                "fixed_description",
                "comfy_image_description",
                "comfyImageDescription",
            )?.value
                ?.trim()
                .orEmpty()
        return candidate.ifBlank { null }
    }

    private fun requestImageDescriptionContractRepair(
        settings: JSONObject,
        description: String,
        validationError: String,
        iteration: Int,
        participantCatalog: List<ComfyPromptParticipantCatalogEntry>,
    ): String? {
        val provider = settings.optString("imagePromptProvider", "lmstudio").trim().ifEmpty { "lmstudio" }
        val baseUrl = resolveProviderBaseUrl(settings, provider)
        val model =
            settings
                .optString("imagePromptModel", settings.optString("model", ""))
                .trim()
        if (model.isBlank()) return null
        val response =
            requestChatCompletionsWithRetry(
                provider = provider,
                openRouterProviderRouting = buildOpenRouterProviderRouting(settings),
                baseUrl = baseUrl,
                model = model,
                auth = resolveProviderAuth(settings, provider),
                temperature = clampTemperature(settings.optDouble("temperature", 0.35), minValue = 0.2, maxValue = 0.55),
                maxTokens = clampMaxTokens(settings.optInt("maxTokens", 520), minValue = 220, maxValue = 900),
                systemPrompt =
                    listOf(
                        "You repair one comfy_image_description string to a strict contract.",
                        "Return JSON only, no markdown.",
                        "Format: {\"description\":\"...\"}",
                        "Required header lines inside description (exact keys):",
                        "type: person|other_person|no_person|group",
                        "subject_mode: persona_self|other_person|no_person|group",
                        "participants: persona:self | persona:<id> | external:<slug> (or none for no_person)",
                        "participant_aliases: token=alias pairs separated by ' | ' (or none for no_person)",
                        "subject_locks: token=compact visual locks pairs separated by ' | ' (or none for no_person)",
                        "Rules:",
                        "- person => participants exactly persona:self",
                        "- other_person => exactly one participant, not persona:self",
                        "- group => at least two unique participants",
                        "- external slug must be lowercase snake_case",
                        "- keep the original visual scene details after the header",
                        "- no anime/character references; only neutral real-world examples if needed",
                        "Self-check before output: validate contract completeness and token consistency.",
                    ).joinToString("\n"),
                userPrompt =
                    listOf(
                        "Iteration: $iteration",
                        "Validation error: $validationError",
                        "Known participant catalog:",
                        formatParticipantCatalogContext(participantCatalog),
                        "Original description:",
                        description,
                    ).joinToString("\n"),
                forceJsonObject = true,
                toolDefinition = null,
            )
        return extractImageDescriptionRepairCandidate(response.content)
    }

    private fun resolveImageDescriptionContract(
        settings: JSONObject,
        description: String,
        iteration: Int,
        participantCatalog: List<ComfyPromptParticipantCatalogEntry>,
    ): ParsedImageDescriptionContext {
        return try {
            parseImageDescriptionContext(description)
        } catch (initialError: Exception) {
            var lastError = initialError
            var latestCandidate = description
            for (attempt in 1..2) {
                val repaired =
                    try {
                        requestImageDescriptionContractRepair(
                            settings = settings,
                            description = latestCandidate,
                            validationError = lastError.message?.trim().orEmpty().ifBlank { "contract_validation_failed" },
                            iteration = iteration + attempt,
                            participantCatalog = participantCatalog,
                        )
                    } catch (_: Exception) {
                        null
                    }
                if (repaired.isNullOrBlank()) continue
                latestCandidate = repaired.trim()
                try {
                    return parseImageDescriptionContext(latestCandidate)
                } catch (repairError: Exception) {
                    lastError = repairError
                }
            }
            throw IllegalStateException(
                "contract_invalid:${lastError.message?.trim().orEmpty().ifBlank { "comfy_image_description_invalid" }}",
            )
        }
    }

    private fun extractComfyPromptsFromConversionPayload(parsed: JSONObject, rawContent: String): List<String> {
        val parsedPrompts =
            parseStringArrayFlexible(parsed.opt("prompts"))
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfyPrompts")) }
                .ifEmpty { parseStringArrayFlexible(parsed.opt("comfy_prompts")) }
                .ifEmpty {
                    parsed.optString("prompt", parsed.optString("comfyPrompt", parsed.optString("comfy_prompt", "")))
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        if (parsedPrompts.isNotEmpty()) return parsedPrompts

        val fallback = rawContent.trim()
        if (fallback.isBlank()) return emptyList()
        if (fallback.startsWith("{") || fallback.startsWith("[")) return emptyList()
        return listOf(fallback)
    }

    private fun looksLikeToolingContractError(body: String): Boolean {
        val normalized = body.trim().lowercase()
        if (normalized.isBlank()) return false
        return listOf(
            "tool_choice",
            "\"tools\"",
            "tools is not",
            "unsupported",
            "not supported",
            "unknown field",
            "invalid parameter",
            "invalid_request_error",
        ).any { token -> normalized.contains(token) }
    }

    private fun requestChatCompletionsWithRetry(
        provider: String,
        openRouterProviderRouting: JSONObject?,
        baseUrl: String,
        model: String,
        auth: JSONObject?,
        temperature: Double,
        maxTokens: Int,
        systemPrompt: String,
        userPrompt: String,
        forceJsonObject: Boolean,
        toolDefinition: LlmToolDefinition? = null,
    ): NativeLlmResponse {
        val normalizedBase = normalizeBaseUrl(baseUrl)
        var lastError: Exception? = null
        val toolModeRequested = toolDefinition != null
        var toolModeEnabled = toolModeRequested
        var toolFallbackReason: String? = null
        for (attempt in 0 until MAX_RETRIES) {
            try {
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
                        if (provider.trim().lowercase() == "openrouter" && openRouterProviderRouting != null) {
                            put("provider", JSONObject(openRouterProviderRouting.toString()))
                        }
                        if (forceJsonObject) {
                            put(
                                "response_format",
                                JSONObject().apply {
                                    put("type", "json_object")
                                },
                            )
                        }
                        if (toolModeEnabled && toolDefinition != null) {
                            put(
                                "tools",
                                JSONArray().apply {
                                    put(
                                        JSONObject().apply {
                                            put("type", "function")
                                            put(
                                                "function",
                                                JSONObject().apply {
                                                    put("name", toolDefinition.name)
                                                    put("description", toolDefinition.description)
                                                    put("parameters", toolDefinition.parameters)
                                                },
                                            )
                                        },
                                    )
                                },
                            )
                            put("tool_choice", "required")
                        }
                    }
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
                    val extraction = extractChoiceContent(choices?.optJSONObject(0))
                    if (extraction.content.isBlank()) {
                        throw IllegalStateException("llm_empty_content")
                    }
                    val responseId = body.optString("id", "").trim().ifEmpty { null }
                    return NativeLlmResponse(
                        content = extraction.content,
                        responseId = responseId,
                        comfyPrompt = null,
                        comfyPrompts = emptyList(),
                        comfyImageDescription = null,
                        comfyImageDescriptions = emptyList(),
                        llmDebug =
                            NativeLlmCallDebug(
                                toolModeRequested = toolModeRequested,
                                toolModeActive = toolModeEnabled && toolDefinition != null,
                                expectedToolName = toolDefinition?.name,
                                actualToolName = extraction.toolName,
                                responseSource = extraction.source,
                                fallbackReason = toolFallbackReason,
                                httpStatus = response.code,
                                parsedField = null,
                            ),
                    )
                }

                if (
                    toolModeEnabled &&
                        toolDefinition != null &&
                        response.code in 400..499 &&
                        looksLikeToolingContractError(response.body)
                ) {
                    toolModeEnabled = false
                    toolFallbackReason =
                        "http_${response.code}:${clipText(response.body.replace(Regex("\\s+"), " ").trim(), 200)}"
                    lastError =
                        IllegalStateException(
                            "llm_tools_unsupported_fallback_to_json: ${clipText(response.body, 220)}",
                        )
                    continue
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

    private fun extractChoiceContent(choice: JSONObject?): LlmChoiceExtractionResult {
        if (choice == null) return LlmChoiceExtractionResult(content = "", source = "none", toolName = null)
        val message = choice.optJSONObject("message")
        val contentRaw = message?.opt("content")
        val content =
            when (contentRaw) {
                is String -> contentRaw.trim()
                is JSONArray -> extractContentFromArray(contentRaw)
                is JSONObject -> contentRaw.toString().trim()
                else -> ""
            }
        if (content.isNotBlank()) {
            return LlmChoiceExtractionResult(content = content, source = "message_content", toolName = null)
        }
        val toolCallArguments = extractToolCallArguments(message)
        if (toolCallArguments.arguments.isNotBlank()) {
            return LlmChoiceExtractionResult(
                content = toolCallArguments.arguments,
                source = "tool_call",
                toolName = toolCallArguments.toolName,
            )
        }
        val functionCall = message?.optJSONObject("function_call")
        val functionCallArguments =
            functionCall
                ?.optString("arguments", "")
                ?.trim()
                .orEmpty()
        if (functionCallArguments.isNotBlank()) {
            return LlmChoiceExtractionResult(
                content = functionCallArguments,
                source = "function_call",
                toolName = functionCall?.optString("name", "")?.trim().orEmpty().ifBlank { null },
            )
        }
        return LlmChoiceExtractionResult(content = "", source = "none", toolName = null)
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

    private fun extractToolCallArguments(message: JSONObject?): ToolCallArgumentsResult {
        if (message == null) return ToolCallArgumentsResult(arguments = "", toolName = null)
        val toolCalls = message.optJSONArray("tool_calls") ?: return ToolCallArgumentsResult(arguments = "", toolName = null)
        for (index in 0 until toolCalls.length()) {
            val call = toolCalls.optJSONObject(index) ?: continue
            val functionObject = call.optJSONObject("function")
            val functionName = functionObject?.optString("name", "")?.trim().orEmpty().ifBlank { null }
            val functionArgs =
                functionObject
                    ?.optString("arguments", "")
                    ?.trim()
                    .orEmpty()
            if (functionArgs.isNotBlank()) {
                return ToolCallArgumentsResult(arguments = functionArgs, toolName = functionName)
            }
            val directArgs = call.optString("arguments", "").trim()
            if (directArgs.isNotBlank()) {
                return ToolCallArgumentsResult(arguments = directArgs, toolName = functionName)
            }
        }
        return ToolCallArgumentsResult(arguments = "", toolName = null)
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
            "speak" -> "spoke"
            "wait" -> "waiting"
            "skip" -> "skipped"
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
        return text;
    }

    private fun parseStringArrayFlexible(raw: Any?): List<String> {
        val result = mutableListOf<String>()
        when (raw) {
            is String -> {
                val value = raw.trim()
                if (value.isNotEmpty()) {
                    result.add(value)
                }
            }
            is JSONArray -> {
                for (index in 0 until raw.length()) {
                    val item = raw.opt(index)
                    if (item is String) {
                        val value = item.trim()
                        if (value.isNotEmpty()) {
                            result.add(value)
                        }
                    }
                }
            }
        }
        return result
    }

    private fun normalizeOpenRouterProviderFilterMode(raw: String): String {
        return when (raw.trim().lowercase()) {
            "only" -> "only"
            "ignore" -> "ignore"
            else -> "off"
        }
    }

    private fun normalizeOpenRouterProviderSlug(raw: String): String {
        return raw
            .trim()
            .lowercase()
            .replace(Regex("[^a-z0-9/_-]+"), "")
    }

    private fun buildOpenRouterProviderRouting(settings: JSONObject): JSONObject? {
        val mode = normalizeOpenRouterProviderFilterMode(settings.optString("openRouterProviderFilterMode", "off"))
        if (mode == "off") return null
        val rawList = settings.optJSONArray("openRouterProviderFilterList")
        if (rawList == null || rawList.length() == 0) return null
        val seen = linkedSetOf<String>()
        for (index in 0 until rawList.length()) {
            val value = normalizeOpenRouterProviderSlug(rawList.optString(index, ""))
            if (value.isNotBlank()) {
                seen.add(value)
            }
        }
        if (seen.isEmpty()) return null
        val filtered = JSONArray()
        seen.take(64).forEach { filtered.put(it) }
        return JSONObject().apply {
            put(mode, filtered)
        }
    }

    private fun formatAppearanceProfileInput(appearance: JSONObject?): String {
        if (appearance == null) return "Не указано."
        val parts =
            listOf(
                appearance.optString("faceDescription", "").trim(),
                appearance.optString("height", "").trim(),
                appearance.optString("eyes", "").trim(),
                appearance.optString("lips", "").trim(),
                appearance.optString("hair", "").trim(),
                appearance.optString("skin", "").trim(),
                appearance.optString("ageType", "").trim(),
                appearance.optString("bodyType", "").trim(),
                appearance.optString("markers", "").trim(),
                appearance.optString("accessories", "").trim(),
                appearance.optString("clothingStyle", "").trim(),
            ).filter { it.isNotBlank() }
        return if (parts.isNotEmpty()) {
            parts.joinToString(", ")
        } else {
            "Не указано."
        }
    }

    private fun formatLookPromptCacheInput(lookPromptCache: JSONObject?): String {
        if (lookPromptCache == null) return "none"
        val detailPrompts = lookPromptCache.optJSONObject("detailPrompts")
        val locked = if (lookPromptCache.optBoolean("locked", false)) "true" else "false"
        val fingerprint =
            when (val value = lookPromptCache.opt("fingerprint")) {
                null, JSONObject.NULL -> "undefined"
                else -> value.toString().trim().ifEmpty { "undefined" }
            }
        return listOf(
            "locked=$locked",
            "fingerprint=$fingerprint",
            "avatarPrompt=${lookPromptCache.optString("avatarPrompt", "")}",
            "fullBodyPrompt=${lookPromptCache.optString("fullBodyPrompt", "")}",
            "detail.face=${detailPrompts?.optString("face", "") ?: ""}",
            "detail.eyes=${detailPrompts?.optString("eyes", "") ?: ""}",
            "detail.nose=${detailPrompts?.optString("nose", "") ?: ""}",
            "detail.lips=${detailPrompts?.optString("lips", "") ?: ""}",
            "detail.hands=${detailPrompts?.optString("hands", "") ?: ""}",
        ).joinToString("\n")
    }

    private fun fallbackThemeTags(topic: String): List<String> {
        val normalized =
            topic
                .lowercase()
                .replace(Regex("[\\n\\r\\t]+"), " ")
                .replace(Regex("[.;:!?()\\[\\]{}\"'`]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
        if (normalized.isBlank()) return emptyList()

        return normalized
            .split(Regex("[,\\-\\\\/|]+"))
            .flatMap { chunk -> chunk.split(" ") }
            .map { part -> part.trim() }
            .filter { part -> part.isNotBlank() }
            .distinct()
            .take(8)
    }

    private fun splitPromptTags(value: String): List<String> {
        return value
            .split(",")
            .map { item -> item.trim() }
            .filter { item -> item.isNotBlank() }
    }

    private fun mergeRequiredTags(basePrompt: String, requiredTags: List<String>): String {
        val existing = splitPromptTags(basePrompt)
        val existingLower = existing.map { tag -> tag.lowercase() }.toHashSet()
        val normalizedRequired =
            requiredTags
                .map { tag -> tag.trim() }
                .filter { tag -> tag.isNotBlank() }
                .filter { tag -> !existingLower.contains(tag.lowercase()) }
        return (normalizedRequired + existing).joinToString(", ")
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

    private fun readFirstNonBlankEntry(root: JSONObject?, vararg keys: String): NamedStringEntry? {
        if (root == null) return null
        for (key in keys) {
            val value = root.optString(key, "").trim()
            if (value.isNotBlank()) {
                return NamedStringEntry(key = key, value = value)
            }
        }
        return null
    }

    private fun clipText(value: String, maxLen: Int): String {
        val text = value.trim()
        if (text.length <= maxLen) return text
        return text.substring(0, max(0, maxLen - 1)).trimEnd() + "…"
    }

    private fun clampTemperature(
        value: Double,
        minValue: Double = 0.1,
        maxValue: Double = 0.95,
    ): Double {
        val numeric = if (value.isNaN() || value.isInfinite()) 0.7 else value
        return min(maxValue, max(minValue, numeric))
    }

    private fun clampMaxTokens(value: Int, minValue: Int, maxValue: Int): Int {
        return min(maxValue, max(minValue, value))
    }
}
