package com.tggf.app.localapi

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt

object OneToOneChatNativeExecutor {
    private const val ONE_TO_ONE_CHAT_JOB_TYPE = "one_to_one_chat"
    private const val ONE_TO_ONE_CHAT_JOB_PREFIX = "one_to_one_chat:"
    private const val ONE_TO_ONE_CHAT_LEASE_MS = 120_000L
    private const val ONE_TO_ONE_CHAT_DEFAULT_RETRY_DELAY_MS = 6_500L
    private const val ONE_TO_ONE_CHAT_DEFAULT_MAX_ATTEMPTS = 3
    private const val CONTEXT_SYNC_RETRY_DELAY_MS = 1_500L
    private const val RECENT_CONTEXT_MESSAGE_LIMIT = 6
    private const val SUMMARY_DEFAULT_TOKEN_BUDGET = 16000
    private const val SUMMARY_MIN_TOKEN_BUDGET = 600
    private const val SUMMARY_MAX_TOKEN_BUDGET = 16000
    private const val SUMMARY_MIN_NEW_MESSAGES = 4
    private const val SUMMARY_MIN_NEW_CHARS = 1200
    private const val SUMMARY_TRANSCRIPT_MAX_CHARS_PER_MESSAGE = 4000
    private const val DIARY_IDLE_MS = 10 * 60 * 1000L
    private const val DIARY_CHECK_INTERVAL_MS = 15 * 60 * 1000L
    private const val DIARY_RECENT_MESSAGE_LIMIT = 30
    private const val DIARY_MIN_NEW_MESSAGES = 4
    private const val DIARY_MIN_NEW_CHARS = 240
    private const val DIARY_MAX_TAGS = 256
    private const val DIARY_GENERATION_MAX_ENTRIES = 64
    private const val DIARY_EXISTING_TAGS_LIMIT = 200

    private val inFlight = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "tg-gf-one-to-one-native").apply {
            isDaemon = true
        }
    }

    private class ContextMissingException(message: String) : IllegalStateException(message)

    private data class ParsedJobScope(
        val chatId: String,
        val userMessageId: String,
        val personaId: String,
        val retryDelayMs: Long,
        val payloadMaxAttempts: Int,
    )

    private data class ControlMemoryCandidate(
        val layer: String,
        val kind: String,
        val content: String,
        val salience: Double,
    )

    private data class MemoryTextCandidate(
        val content: String,
        val salience: Double,
    )

    private data class ControlMemoryRemoval(
        val id: String?,
        val layer: String?,
        val kind: String?,
        val content: String?,
    )

    private data class AppliedControlResult(
        val state: JSONObject,
        val memoryCandidates: List<ControlMemoryCandidate>,
        val memoryRemovals: List<ControlMemoryRemoval>,
    )

    private data class ChatEvolutionConfig(
        val enabled: Boolean,
        val applyMode: String,
    )

    private data class EvolutionProcessingResult(
        val state: JSONObject,
        val appliedNow: Boolean,
    )

    private data class ImageAssetAppendResult(
        val id: String,
        val ref: String,
        val dataUrl: String,
        val meta: JSONObject,
        val createdAt: String,
    )

    private data class ImageGenerationResult(
        val message: JSONObject,
        val generatedAssets: List<JSONObject>,
    )

    private data class ParsedImageDescriptionType(
        val type: String,
        val participants: String,
        val includesPersona: Boolean,
        val hasExplicitType: Boolean,
    )

    private data class RelationshipProposalIntent(
        val type: String?,
        val stage: String?,
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
                    worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
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
        val runtime = BackgroundRuntimeRepository(context)
        val repository = LocalRepository(context)
        try {
            val claimed =
                jobs.claimDueJobs(
                    limit = 1,
                    leaseMs = ONE_TO_ONE_CHAT_LEASE_MS,
                    type = ONE_TO_ONE_CHAT_JOB_TYPE,
                )

            if (claimed.isEmpty()) {
                maybeGenerateDiaryEntries(context, repository, runtime)
                emitAwaitingState(context, jobs)
                return
            }

            for (job in claimed) {
                processClaimedJob(
                    context = context,
                    repository = repository,
                    runtime = runtime,
                    jobs = jobs,
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
        jobs: BackgroundJobRepository,
    ) {
        val pendingCount =
            jobs.countJobs(
                status = BackgroundJobRepository.STATUS_PENDING,
                type = ONE_TO_ONE_CHAT_JOB_TYPE,
            )
        val leasedCount =
            jobs.countJobs(
                status = BackgroundJobRepository.STATUS_LEASED,
                type = ONE_TO_ONE_CHAT_JOB_TYPE,
            )
        if (pendingCount > 0 || leasedCount > 0) {
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                state = "running",
                scopeId = "",
                detail = "awaiting_due_job",
                progress = false,
                claimed = false,
                lastError = "",
            )
            return
        }
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
            state = "idle",
            scopeId = "",
            detail = "no_pending_jobs",
            progress = false,
            claimed = false,
            lastError = "",
        )
    }

    private fun processClaimedJob(
        context: Context,
        repository: LocalRepository,
        runtime: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        job: BackgroundJobRecord,
    ) {
        val payload = parseJsonObject(job.payloadJson)
        val scope = parseJobScope(job.id, payload)
        if (scope.chatId.isBlank() || scope.userMessageId.isBlank()) {
            jobs.cancelJob(job.id)
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId.ifBlank { "unknown" },
                jobId = job.id,
                stage = "job_failed_terminal",
                level = "error",
                message = "Failed to resolve chat scope for one-to-one job",
                details =
                    JSONObject().apply {
                        put("jobId", job.id)
                        put("payload", payload)
                    },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                state = "idle",
                scopeId = scope.chatId,
                detail = "invalid_scope",
                progress = false,
                claimed = false,
                lastError = "invalid_scope",
            )
            return
        }

        val maxAttempts = if (job.maxAttempts > 0) job.maxAttempts else scope.payloadMaxAttempts
        val retryDelayMs = max(1_000L, scope.retryDelayMs)
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stage = "job_claimed",
            level = "info",
            message = "One-to-one chat job claimed",
            details =
                JSONObject().apply {
                    put("chatId", scope.chatId)
                    put("userMessageId", scope.userMessageId)
                    put("attempt", job.attempts + 1)
                    put("maxAttempts", maxAttempts)
                },
        )
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
            state = "running",
            scopeId = scope.chatId,
            detail = "llm_started",
            progress = false,
            claimed = true,
            lastError = "",
        )

        try {
            executeClaimedJob(
                context = context,
                repository = repository,
                runtime = runtime,
                jobs = jobs,
                job = job,
                scope = scope,
            )
        } catch (error: Exception) {
            val errorMessage = error.message?.trim().orEmpty().ifBlank { "one_to_one_failed" }
            val runAtMs =
                System.currentTimeMillis() +
                    if (error is ContextMissingException) {
                        CONTEXT_SYNC_RETRY_DELAY_MS
                    } else {
                        retryDelayMs
                    }
            val nextAttempt = job.attempts + 1
            val terminal = maxAttempts > 0 && nextAttempt >= maxAttempts
            jobs.rescheduleJob(
                id = job.id,
                runAtMs = runAtMs,
                incrementAttempts = true,
                lastError = errorMessage,
            )
            if (terminal) {
                val stores = markUserMessageFailed(repository, scope, errorMessage)
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = scope.chatId,
                    jobId = job.id,
                    stage = "job_failed_terminal",
                    level = "error",
                    message = "One-to-one job reached terminal failure",
                    details =
                        JSONObject().apply {
                            put("error", errorMessage)
                            put("attempt", nextAttempt)
                            put("maxAttempts", maxAttempts)
                        },
                )
                if (stores != null) {
                    appendStatePatch(
                        runtime = runtime,
                        scopeId = scope.chatId,
                        jobId = job.id,
                        stores = stores,
                    )
                }
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                    state = "idle",
                    scopeId = scope.chatId,
                    detail = "job_failed_terminal",
                    progress = false,
                    claimed = false,
                    lastError = errorMessage,
                )
            } else {
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = scope.chatId,
                    jobId = job.id,
                    stage = "job_failed_retry",
                    level = "warn",
                    message = "One-to-one job failed and scheduled for retry",
                    details =
                        JSONObject().apply {
                            put("error", errorMessage)
                            put("attempt", nextAttempt)
                            put("maxAttempts", maxAttempts)
                            put("retryDelayMs", runAtMs - System.currentTimeMillis())
                        },
                )
                ForegroundSyncService.updateWorkerStatus(
                    context = context,
                    worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                    state = "error",
                    scopeId = scope.chatId,
                    detail = "job_failed_retry",
                    progress = false,
                    claimed = true,
                    lastError = errorMessage,
                )
            }
        }
    }

    private fun parseJobScope(jobId: String, payload: JSONObject): ParsedJobScope {
        val payloadChatId = payload.optString("chatId", "").trim()
        val payloadUserMessageId = payload.optString("userMessageId", "").trim()
        val payloadPersonaId = payload.optString("personaId", "").trim()
        var chatId = payloadChatId
        var userMessageId = payloadUserMessageId
        if ((chatId.isBlank() || userMessageId.isBlank()) && jobId.startsWith(ONE_TO_ONE_CHAT_JOB_PREFIX)) {
            val scopeRaw = jobId.removePrefix(ONE_TO_ONE_CHAT_JOB_PREFIX).trim()
            val separatorIndex = scopeRaw.indexOf(":")
            if (separatorIndex > 0 && separatorIndex < scopeRaw.length - 1) {
                if (chatId.isBlank()) {
                    chatId = scopeRaw.substring(0, separatorIndex).trim()
                }
                if (userMessageId.isBlank()) {
                    userMessageId = scopeRaw.substring(separatorIndex + 1).trim()
                }
            }
        }
        return ParsedJobScope(
            chatId = chatId,
            userMessageId = userMessageId,
            personaId = payloadPersonaId,
            retryDelayMs = payload.optLong("retryDelayMs", ONE_TO_ONE_CHAT_DEFAULT_RETRY_DELAY_MS),
            payloadMaxAttempts = payload.optInt("maxAttempts", ONE_TO_ONE_CHAT_DEFAULT_MAX_ATTEMPTS),
        )
    }

    private fun executeClaimedJob(
        context: Context,
        repository: LocalRepository,
        runtime: BackgroundRuntimeRepository,
        jobs: BackgroundJobRepository,
        job: BackgroundJobRecord,
        scope: ParsedJobScope,
    ) {
        val settings = parseJsonObject(repository.readSettingsJson())
        val personas = readStoreArray(repository, "personas")
        val chats = readStoreArray(repository, "chats")
        val messages = readStoreArray(repository, "messages")
        val personaEvolutionStates = readStoreArray(repository, "personaEvolutionStates")
        val personaStates = readStoreArray(repository, "personaStates")
        val memories = readStoreArray(repository, "memories")

        val chatIndex = findObjectIndexById(chats, scope.chatId)
        if (chatIndex < 0) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stage = "context_missing",
                level = "warn",
                message = "Chat context is missing in native store",
                details = JSONObject().put("chatId", scope.chatId),
            )
            throw ContextMissingException("chat_missing")
        }
        val chat = chats.optJSONObject(chatIndex) ?: JSONObject()
        val userMessageIndex = findMessageIndex(messages, scope.chatId, scope.userMessageId)
        if (userMessageIndex < 0) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stage = "context_missing",
                level = "warn",
                message = "User message is missing in native store",
                details = JSONObject().put("userMessageId", scope.userMessageId),
            )
            throw ContextMissingException("user_message_missing")
        }
        val userMessage = messages.optJSONObject(userMessageIndex) ?: JSONObject()
        val userContent = userMessage.optString("content", "").trim()
        if (userContent.isBlank()) {
            throw IllegalStateException("user_message_empty")
        }

        val personaId =
            scope.personaId.ifBlank {
                chat.optString("personaId", "").trim()
            }
        val persona = findObjectById(personas, personaId)
        if (persona == null) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stage = "context_missing",
                level = "warn",
                message = "Persona is missing in native store",
                details = JSONObject().put("personaId", personaId),
            )
            throw ContextMissingException("persona_missing")
        }

        val evolutionConfig = normalizeChatEvolutionConfig(chat.optJSONObject("evolutionConfig"))
        val existingEvolutionState =
            normalizePersonaEvolutionState(
                state = findPersonaEvolutionStateForChat(personaEvolutionStates, scope.chatId),
                chatId = scope.chatId,
                persona = persona,
            )
        upsertByChatId(personaEvolutionStates, existingEvolutionState, "chatId")
        val effectivePersona =
            if (evolutionConfig.enabled) {
                applyPersonaEvolutionProfile(persona, existingEvolutionState.optJSONObject("currentProfile"))
            } else {
                JSONObject(persona.toString())
            }
        val evolutionHistoryForPrompt = selectAppliedPersonaEvolutionHistory(existingEvolutionState).takeLast(10)

        val recentMessages = buildRecentMessagesForPrompt(messages, scope.chatId)
        val existingState =
            findPersonaStateForChat(personaStates, scope.chatId)
                ?: createInitialPersonaState(effectivePersona, scope.chatId)
        upsertByChatId(personaStates, existingState, "chatId")
        val memoryPool = readChatMemories(memories, scope.chatId)
        val decayDays = resolvePersonaMemoryDecayDays(effectivePersona)
        val memoryCard = buildMemoryCard(memoryPool, recentMessages, decayDays)
        val conversationSummary = buildConversationSummaryContext(chat)

        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stage = "llm_started",
            level = "info",
            message = "One-to-one LLM turn started",
            details = JSONObject().put("personaId", persona.optString("id", "")),
        )
        val llmResult =
            NativeLlmClient.requestOneToOneChatTurn(
                settings = settings,
                persona = effectivePersona,
                userInput = userContent,
                recentMessages = recentMessages,
                runtimeState = existingState,
                memoryCard = memoryCard,
                conversationSummary = conversationSummary,
                evolutionHistoryApplied = evolutionHistoryForPrompt,
            ) ?: throw IllegalStateException("llm_empty_response")

        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stage = "llm_completed",
            level = "info",
            message = "One-to-one LLM turn completed",
            details =
                JSONObject().apply {
                    put("hasText", llmResult.content.trim().isNotEmpty())
                    put(
                        "comfyPromptCount",
                        max(
                            llmResult.comfyPrompts.size,
                            if (llmResult.comfyPrompt.isNullOrBlank()) 0 else 1,
                        ),
                    )
                    put(
                        "comfyDescriptionCount",
                        max(
                            llmResult.comfyImageDescriptions.size,
                            if (llmResult.comfyImageDescription.isNullOrBlank()) 0 else 1,
                        ),
                    )
                    put("hasPersonaControl", llmResult.personaControl != null)
                    putLlmCallDebugDetails(this, llmResult.llmDebug)
                },
        )

        setMessageNativeStatus(userMessage, "completed", null)
        messages.put(userMessageIndex, userMessage)

        val assistantMessage = buildAssistantMessage(scope, llmResult)
        val promptBlocks =
            parseStringList(assistantMessage.optJSONArray("comfyPrompts"))
                .ifEmpty {
                    assistantMessage
                        .optString("comfyPrompt", "")
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val imageDescriptionBlocks =
            parseStringList(assistantMessage.optJSONArray("comfyImageDescriptions"))
                .ifEmpty {
                    assistantMessage
                        .optString("comfyImageDescription", "")
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val requestedImageCount =
            if (imageDescriptionBlocks.isNotEmpty()) {
                imageDescriptionBlocks.size
            } else {
                promptBlocks.size
            }
        if (requestedImageCount > 0) {
            assistantMessage.put("imageGenerationPending", true)
            assistantMessage.put("imageGenerationExpected", requestedImageCount)
            assistantMessage.put("imageGenerationCompleted", 0)
        }
        messages.put(assistantMessage)

        chat.put(
            "title",
            resolveChatTitle(
                currentTitle = chat.optString("title", "Новый чат"),
                userText = userContent,
            ),
        )
        chat.put("updatedAt", nowIsoUtc())
        if (!llmResult.responseId.isNullOrBlank()) {
            chat.put("lastResponseId", llmResult.responseId)
        }
        chats.put(chatIndex, chat)

        // Publish assistant message immediately after LLM response.
        repository.writeStoreJson("chats", chats.toString())
        repository.writeStoreJson("messages", messages.toString())
        appendStatePatch(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stores =
                JSONObject().apply {
                    put("chats", JSONArray().put(JSONObject(chat.toString())))
                    put(
                        "messages",
                        JSONArray().apply {
                            put(JSONObject(userMessage.toString()))
                            put(JSONObject(assistantMessage.toString()))
                        },
                    )
                },
        )
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stage = "assistant_published",
            level = "info",
            message = "Assistant message published before side actions",
            details =
                JSONObject().apply {
                    put("requestedImageCount", requestedImageCount)
                },
        )
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
            state = "running",
            scopeId = scope.chatId,
            detail = "assistant_published",
            progress = true,
            claimed = true,
            lastError = "",
        )

        try {
            var finalAssistantMessage = JSONObject(assistantMessage.toString())
            val assistantMessageWithImages =
                maybeGenerateMessageImages(
                    context = context,
                    repository = repository,
                    runtime = runtime,
                    jobId = job.id,
                    scope = scope,
                    settings = settings,
                    chat = chat,
                    persona = effectivePersona,
                    evolutionHistoryApplied = evolutionHistoryForPrompt,
                    baseAssistantMessage = finalAssistantMessage,
                )
            finalAssistantMessage = assistantMessageWithImages.message
            val generatedAssetIds =
                assistantMessageWithImages.generatedAssets
                    .mapNotNull { asset -> asset.optString("id", "").trim().ifBlank { null } }

            if (!replaceMessageById(messages, finalAssistantMessage)) {
                messages.put(finalAssistantMessage)
            }
            if (generatedAssetIds.isNotEmpty() || requestedImageCount > 0) {
                persistMessageUpdatesMerged(
                    repository = repository,
                    updates = listOf(finalAssistantMessage),
                )
                appendStatePatch(
                    runtime = runtime,
                    scopeId = scope.chatId,
                    jobId = job.id,
                    stores =
                        JSONObject().apply {
                            put(
                                "messages",
                                JSONArray().put(JSONObject(finalAssistantMessage.toString())),
                            )
                        },
                    assetIds = generatedAssetIds,
                )
            }

            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                state = "running",
                scopeId = scope.chatId,
                detail = "state_persisting",
                progress = true,
                claimed = true,
                lastError = "",
            )

            val fallbackState =
                evolveStateFallback(
                    baseState = existingState,
                    persona = effectivePersona,
                    userMessage = userContent,
                    assistantMessage = finalAssistantMessage.optString("content", ""),
                )
            val controlApplied =
                applyPersonaControl(
                    control = llmResult.personaControl,
                    baseState = fallbackState,
                    userMessage = userContent,
                )
            val resolvedState = controlApplied.state
            upsertByChatId(personaStates, resolvedState, "chatId")
            val evolutionResult =
                processPersonaControlEvolution(
                    control = llmResult.personaControl,
                    config = evolutionConfig,
                    state = existingEvolutionState,
                    timestamp = nowIsoUtc(),
                )
            val resolvedEvolutionState = evolutionResult.state
            upsertByChatId(personaEvolutionStates, resolvedEvolutionState, "chatId")

            val memoriesAfterRemoval = applyMemoryRemovals(memoryPool, controlApplied.memoryRemovals)
            val derivedMemoryCandidates =
                if (llmResult.personaControl == null) {
                    derivePersistentMemoriesFromUserMessage(
                        persona = effectivePersona,
                        text = userContent,
                    )
                } else {
                    emptyList()
                }
            val candidates = derivedMemoryCandidates + controlApplied.memoryCandidates
            val maxMemories = resolvePersonaMaxMemories(effectivePersona)
            val reconciledMemories =
                reconcileMemories(
                    existing = memoriesAfterRemoval.first,
                    candidates = candidates,
                    maxMemories = maxMemories,
                    decayDays = decayDays,
                    chatId = scope.chatId,
                    personaId = persona.optString("id", "").trim(),
                )
            writeChatMemories(
                store = memories,
                chatId = scope.chatId,
                memoriesForChat = reconciledMemories.first,
            )
            val deletedMemoryIds =
                (memoriesAfterRemoval.second + reconciledMemories.second)
                    .map { id -> id.trim() }
                    .filter { id -> id.isNotEmpty() }
                    .distinct()

            val timelineAfterAssistant = buildChatMessageTimeline(messages, scope.chatId)
            maybeRefreshConversationSummary(
                settings = settings,
                persona = effectivePersona,
                chat = chat,
                timeline = timelineAfterAssistant,
            )
            chats.put(chatIndex, chat)

            val latestChats = readStoreArray(repository, "chats")
            val latestMessages = readStoreArray(repository, "messages")
            val latestPersonaStates = readStoreArray(repository, "personaStates")
            val latestPersonaEvolutionStates = readStoreArray(repository, "personaEvolutionStates")
            val latestMemories = readStoreArray(repository, "memories")

            upsertByChatId(latestChats, JSONObject(chat.toString()), "id")
            upsertByChatId(latestMessages, JSONObject(userMessage.toString()), "id")
            upsertByChatId(latestMessages, JSONObject(finalAssistantMessage.toString()), "id")
            upsertByChatId(latestPersonaStates, JSONObject(resolvedState.toString()), "chatId")
            val latestEvolutionState =
                normalizePersonaEvolutionState(
                    state = findPersonaEvolutionStateForChat(latestPersonaEvolutionStates, scope.chatId),
                    chatId = scope.chatId,
                    persona = persona,
                )
            val mergedEvolutionState =
                mergePersonaEvolutionStateDelta(
                    latestState = latestEvolutionState,
                    stateAtJobStart = existingEvolutionState,
                    stateAfterJob = resolvedEvolutionState,
                )
            upsertByChatId(latestPersonaEvolutionStates, mergedEvolutionState, "chatId")
            writeChatMemories(
                store = latestMemories,
                chatId = scope.chatId,
                memoriesForChat = reconciledMemories.first.map { memory -> JSONObject(memory.toString()) },
            )

            repository.writeStoreJson("chats", latestChats.toString())
            repository.writeStoreJson("messages", latestMessages.toString())
            repository.writeStoreJson("personaStates", latestPersonaStates.toString())
            repository.writeStoreJson("personaEvolutionStates", latestPersonaEvolutionStates.toString())
            repository.writeStoreJson("memories", latestMemories.toString())

            appendStatePatch(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stores =
                    JSONObject().apply {
                        put("chats", JSONArray().put(JSONObject(chat.toString())))
                        put("messages", JSONArray().put(JSONObject(finalAssistantMessage.toString())))
                        put("personaStates", JSONArray().put(JSONObject(resolvedState.toString())))
                        put(
                            "personaEvolutionStates",
                            JSONArray().put(JSONObject(mergedEvolutionState.toString())),
                        )
                        put(
                            "memories",
                            JSONArray().apply {
                                reconciledMemories.first.forEach { memory ->
                                    put(JSONObject(memory.toString()))
                                }
                            },
                        )
                        if (deletedMemoryIds.isNotEmpty()) {
                            put("deletedMemoryIds", JSONArray(deletedMemoryIds))
                        }
                    },
            )
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stage = "state_persisted",
                level = "info",
                message = "One-to-one state persisted",
                details =
                    JSONObject().apply {
                        put("memoryCount", reconciledMemories.first.size)
                        put("deletedMemoryCount", deletedMemoryIds.size)
                        put("evolutionAppliedNow", evolutionResult.appliedNow)
                    },
            )
        } catch (error: Exception) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = job.id,
                stage = "post_llm_side_effects_failed",
                level = "warn",
                message = "Post-LLM side effects failed after assistant publish (soft-fail)",
                details =
                    JSONObject().apply {
                        put("error", error.message ?: "post_llm_side_effects_failed")
                    },
            )
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                state = "running",
                scopeId = scope.chatId,
                detail = "post_llm_side_effects_failed",
                progress = true,
                claimed = true,
                lastError = error.message ?: "post_llm_side_effects_failed",
            )
        }

        jobs.completeJob(job.id)
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = job.id,
            stage = "job_completed",
            level = "info",
            message = "One-to-one job completed",
            details = null,
        )
        ForegroundSyncService.updateWorkerStatus(
            context = context,
            worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
            state = "idle",
            scopeId = scope.chatId,
            detail = "job_completed",
            progress = true,
            claimed = false,
            lastError = "",
        )
    }

    private fun buildAssistantMessage(
        scope: ParsedJobScope,
        llmResult: NativeOneToOneTurnResponse,
    ): JSONObject {
        val relationshipProposal = extractRelationshipProposal(llmResult.personaControl)
        val visibleText =
            llmResult.content.trim().ifBlank {
                if (
                    llmResult.comfyPrompts.isNotEmpty() ||
                        llmResult.comfyImageDescriptions.isNotEmpty() ||
                        llmResult.personaControl != null
                ) {
                    ""
                } else {
                    "Не получилось получить содержательный ответ от модели. Сформулируй запрос чуть конкретнее, и я попробую снова."
                }
            }
        return JSONObject().apply {
            put("id", UUID.randomUUID().toString())
            put("chatId", scope.chatId)
            put("role", "assistant")
            put("replyToUserMessageId", scope.userMessageId)
            put("content", visibleText)
            if (!llmResult.comfyPrompt.isNullOrBlank()) {
                put("comfyPrompt", llmResult.comfyPrompt)
            }
            if (llmResult.comfyPrompts.isNotEmpty()) {
                put("comfyPrompts", JSONArray(llmResult.comfyPrompts))
            }
            if (!llmResult.comfyImageDescription.isNullOrBlank()) {
                put("comfyImageDescription", llmResult.comfyImageDescription)
            }
            if (llmResult.comfyImageDescriptions.isNotEmpty()) {
                put("comfyImageDescriptions", JSONArray(llmResult.comfyImageDescriptions))
            }
            if (llmResult.personaControl != null) {
                put("personaControlRaw", llmResult.personaControl.toString())
            }
            relationshipProposal?.type?.let { type ->
                put("relationshipProposalType", type)
            }
            relationshipProposal?.stage?.let { stage ->
                put("relationshipProposalStage", stage)
            }
            if (relationshipProposal != null) {
                put("relationshipProposalStatus", "pending")
            }
            put("imageGenerationPending", false)
            put("createdAt", nowIsoUtc())
        }
    }

    private fun maybeGenerateMessageImages(
        context: Context,
        repository: LocalRepository,
        runtime: BackgroundRuntimeRepository,
        jobId: String,
        scope: ParsedJobScope,
        settings: JSONObject,
        chat: JSONObject,
        persona: JSONObject,
        evolutionHistoryApplied: List<JSONObject>,
        baseAssistantMessage: JSONObject,
    ): ImageGenerationResult {
        val comfyPrompts =
            parseStringList(baseAssistantMessage.optJSONArray("comfyPrompts"))
                .ifEmpty {
                    baseAssistantMessage
                        .optString("comfyPrompt", "")
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }
        val comfyImageDescriptions =
            parseStringList(baseAssistantMessage.optJSONArray("comfyImageDescriptions"))
                .ifEmpty {
                    baseAssistantMessage
                        .optString("comfyImageDescription", "")
                        .trim()
                        .ifEmpty { null }
                        ?.let { listOf(it) } ?: emptyList()
                }

        if (comfyPrompts.isEmpty() && comfyImageDescriptions.isEmpty()) {
            return ImageGenerationResult(baseAssistantMessage, emptyList())
        }

        val personaName = persona.optString("name", "").trim()
        val requestedImageCount = if (comfyImageDescriptions.isNotEmpty()) comfyImageDescriptions.size else comfyPrompts.size
        val checkpointName = persona.optString("imageCheckpoint", "").trim().ifEmpty { null }
        val personaStyleReferenceCandidates =
            listOf(
                persona.optString("fullBodyImageId", "").trim().ifBlank { null }?.let { imageId -> "idb://$imageId" },
                persona.optString("avatarImageId", "").trim().ifBlank { null }?.let { imageId -> "idb://$imageId" },
                persona.optString("fullBodyUrl", "").trim().ifBlank { null },
                persona.optString("avatarUrl", "").trim().ifBlank { null },
            ).filterNotNull().distinct()
        val chatStyleStrength = resolveChatStyleStrength(chat, settings)
        val effectiveSettings =
            if (chatStyleStrength != null) {
                JSONObject(settings.toString()).apply { put("chatStyleStrength", chatStyleStrength) }
            } else {
                settings
            }
        val participantCatalog =
            listOf(
                ComfyPromptParticipantCatalogEntry(
                    id = persona.optString("id", "").trim(),
                    alias = personaName.ifBlank { "Self" },
                    isSelf = true,
                    compactAppearanceLocks = buildPersonaAppearanceLocks(persona),
                ),
            )

        var promptsForGeneration = comfyPrompts
        var parsedTypesForGeneration =
            promptsForGeneration.map { prompt ->
                parseImageDescriptionType(prompt, personaName)
            }

        try {
            if (comfyImageDescriptions.isNotEmpty()) {
                val parsedTypesByDescription =
                    comfyImageDescriptions.map { description ->
                        parseImageDescriptionType(description, personaName)
                    }
                val promptsWithType = mutableListOf<Pair<String, ParsedImageDescriptionType>>()
                comfyImageDescriptions.forEachIndexed { index, description ->
                    val generatedBatch =
                        NativeLlmClient.generateComfyPromptsFromImageDescriptions(
                            settings = effectiveSettings,
                            speakerPersona = persona,
                            imageDescriptions = listOf(description),
                            participantCatalog = participantCatalog,
                            evolutionHistoryApplied = evolutionHistoryApplied,
                        )
                    generatedBatch
                        .map { value -> value.trim() }
                        .filter { value -> value.isNotBlank() }
                        .forEach { prompt ->
                            promptsWithType.add(
                                Pair(
                                    prompt,
                                    parsedTypesByDescription.getOrNull(index) ?: parseImageDescriptionType(description, personaName),
                                ),
                            )
                        }
                }
                promptsForGeneration = promptsWithType.map { item -> item.first }
                parsedTypesForGeneration = promptsWithType.map { item -> item.second }
            }
        } catch (error: Exception) {
            appendRuntimeEvent(
                runtime = runtime,
                scopeId = scope.chatId,
                jobId = jobId,
                stage = "image_completed",
                level = "warn",
                message =
                    if (isComfyImageDescriptionContractInvalidError(error)) {
                        "Native image generation contract invalid (soft-fail)"
                    } else {
                        "Native image prompt preparation failed (soft-fail)"
                    },
                details =
                    JSONObject().apply {
                        put("requestedCount", requestedImageCount)
                        put("error", error.message ?: "image_prompt_prepare_failed")
                    },
            )
            return ImageGenerationResult(
                baseAssistantMessage.apply {
                    put("imageGenerationPending", false)
                    put("imageGenerationExpected", requestedImageCount)
                    put("imageGenerationCompleted", 0)
                },
                emptyList(),
            )
        }

        if (promptsForGeneration.isEmpty()) {
            return ImageGenerationResult(
                baseAssistantMessage.apply {
                    put("imageGenerationPending", false)
                    put("imageGenerationExpected", requestedImageCount)
                    put("imageGenerationCompleted", 0)
                },
                emptyList(),
            )
        }

        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = jobId,
            stage = "image_started",
            level = "info",
            message = "Native image generation started for one-to-one turn",
            details = JSONObject().put("promptCount", promptsForGeneration.size),
        )

        val assistantMessage = JSONObject(baseAssistantMessage.toString())
        if (promptsForGeneration.isNotEmpty()) {
            assistantMessage.put("comfyPrompt", promptsForGeneration.first())
            assistantMessage.put("comfyPrompts", JSONArray(promptsForGeneration))
        }
        val imageRefs = mutableListOf<String>()
        val metaByRef = JSONObject()
        val generatedAssetObjects = mutableListOf<JSONObject>()
        var completedCount = 0
        val expectedCount = promptsForGeneration.size
        assistantMessage.put("imageGenerationPending", true)
        assistantMessage.put("imageGenerationExpected", expectedCount)
        assistantMessage.put("imageGenerationCompleted", 0)

        promptsForGeneration.forEachIndexed { index, prompt ->
            try {
                val seed =
                    ComfyNativeClient.stableSeedFromText("${scope.chatId}:${scope.userMessageId}:$index:$prompt")
                val parsedType =
                    parsedTypesForGeneration.getOrNull(index) ?: parseImageDescriptionType(prompt, personaName)
                val needsPersonaReference = shouldAttachPersonaReference(parsedType)
                val styleReferenceCandidates =
                    if (needsPersonaReference) {
                        personaStyleReferenceCandidates
                    } else {
                        emptyList()
                    }
                if (needsPersonaReference && styleReferenceCandidates.isEmpty()) {
                    appendRuntimeEvent(
                        runtime = runtime,
                        scopeId = scope.chatId,
                        jobId = jobId,
                        stage = "image_progress",
                        level = "warn",
                        message = "Style reference is required but persona has no reference image",
                        details =
                            JSONObject().apply {
                                put("promptIndex", index)
                                put("parsedType", parsedType.type)
                            },
                    )
                }
                val runGeneration =
                    { styleReferenceImage: String?, strictStyleReference: Boolean ->
                        val styleDebugEmitter: (String, JSONObject) -> Unit =
                            styleEmitter@{ label, payload ->
                                if (!label.startsWith("style_")) return@styleEmitter
                                appendRuntimeEvent(
                                    runtime = runtime,
                                    scopeId = scope.chatId,
                                    jobId = jobId,
                                    stage = "image_progress",
                                    level = if (label == "style_reference_ignored") "warn" else "info",
                                    message = "Native style debug: $label",
                                    details =
                                        JSONObject().apply {
                                            put("promptIndex", index)
                                            put("strictStyleReference", strictStyleReference)
                                            put(
                                                "styleReferenceSourcePreview",
                                                styleReferenceImage?.take(140) ?: "",
                                            )
                                            put("payload", JSONObject(payload.toString()))
                                        },
                                )
                            }
                        ComfyNativeClient.runBaseGeneration(
                            ComfyNativeClient.BaseGenerationRequest(
                                context = context,
                                settings = effectiveSettings,
                                prompt = prompt,
                                seed = seed,
                                checkpointName = checkpointName,
                                styleReferenceImage = styleReferenceImage,
                                strictStyleReference = strictStyleReference,
                                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                                workerScopeId = scope.chatId,
                                workerQueueDetail = "image_queue",
                                workerWaitDetail = "image_wait",
                                debugEmitter = styleDebugEmitter,
                            ),
                        )
                    }
                val comfyResult =
                    if (styleReferenceCandidates.isEmpty()) {
                        runGeneration(null, false)
                    } else {
                        var recoveredWithFallback = false
                        var result: ComfyNativeClient.ComfyRunResult? = null
                        for (candidateIndex in styleReferenceCandidates.indices) {
                            if (result != null) break
                            val candidate = styleReferenceCandidates[candidateIndex]
                            try {
                                result = runGeneration(candidate, true)
                                if (candidateIndex > 0) {
                                    recoveredWithFallback = true
                                }
                            } catch (error: Exception) {
                                val hasNextCandidate = candidateIndex < styleReferenceCandidates.lastIndex
                                if (
                                    hasNextCandidate &&
                                    ComfyNativeClient.isRecoverableStyleReferenceError(error)
                                ) {
                                    appendRuntimeEvent(
                                        runtime = runtime,
                                        scopeId = scope.chatId,
                                        jobId = jobId,
                                        stage = "image_progress",
                                        level = "warn",
                                        message = "Style reference upload failed, retrying with fallback reference",
                                        details =
                                            JSONObject().apply {
                                                put("promptIndex", index)
                                                put("candidateIndex", candidateIndex)
                                                put("candidateCount", styleReferenceCandidates.size)
                                                put("error", error.message ?: "style_reference_failed")
                                            },
                                    )
                                    continue
                                }
                                throw error
                            }
                        }
                        if (recoveredWithFallback) {
                            appendRuntimeEvent(
                                runtime = runtime,
                                scopeId = scope.chatId,
                                jobId = jobId,
                                stage = "image_progress",
                                level = "info",
                                message = "Image generation recovered using fallback style reference",
                                details =
                                    JSONObject().apply {
                                        put("promptIndex", index)
                                        put("candidateCount", styleReferenceCandidates.size)
                                    },
                            )
                        }
                        result ?: throw IllegalStateException("Failed to apply any style reference candidate.")
                    }
                val localizedUrls =
                    ComfyNativeClient.localizeOutputImageUrls(
                        context = context,
                        settings = settings,
                        imageUrls = comfyResult.imageUrls,
                    )
                val createdAt = nowIsoUtc()
                val meta =
                    JSONObject().apply {
                        put("seed", comfyResult.seed)
                        put("prompt", prompt)
                        put("flow", "base")
                        comfyResult.model?.takeIf { it.isNotBlank() }?.let { model ->
                            put("model", model)
                        }
                    }
                val appended =
                    appendImageAssets(
                        repository = repository,
                        imageUrls = localizedUrls,
                        meta = meta,
                        createdAt = createdAt,
                    )
                appended.forEach { item ->
                    imageRefs.add(item.ref)
                    if (!metaByRef.has(item.ref)) {
                        metaByRef.put(item.ref, JSONObject(item.meta.toString()))
                    }
                    generatedAssetObjects.add(
                        JSONObject().apply {
                            put("id", item.id)
                            put("dataUrl", item.dataUrl)
                            put("meta", JSONObject(item.meta.toString()))
                            put("createdAt", item.createdAt)
                        },
                    )
                }
                completedCount += 1
            } catch (error: Exception) {
                appendRuntimeEvent(
                    runtime = runtime,
                    scopeId = scope.chatId,
                    jobId = jobId,
                    stage = "image_completed",
                    level = "warn",
                    message = "Native image generation iteration failed",
                    details =
                        JSONObject().apply {
                            put("index", index)
                            put("error", error.message ?: "image_generation_failed")
                        },
                )
            }
        }

        assistantMessage.put("imageGenerationPending", false)
        assistantMessage.put("imageGenerationExpected", expectedCount)
        assistantMessage.put("imageGenerationCompleted", completedCount)
        if (imageRefs.isNotEmpty()) {
            assistantMessage.put("imageUrls", JSONArray(imageRefs))
            assistantMessage.put("imageMetaByUrl", metaByRef)
        }
        appendRuntimeEvent(
            runtime = runtime,
            scopeId = scope.chatId,
            jobId = jobId,
            stage = "image_completed",
            level = "info",
            message = "Native image generation completed for one-to-one turn",
            details =
                JSONObject().apply {
                    put("expectedCount", expectedCount)
                    put("completedCount", completedCount)
                    put("assetCount", generatedAssetObjects.size)
                },
        )

        return ImageGenerationResult(
            message = assistantMessage,
            generatedAssets = generatedAssetObjects,
        )
    }

    private fun buildPersonaAppearanceLocks(persona: JSONObject): ParticipantAppearanceLocks {
        val appearance = persona.optJSONObject("appearance") ?: JSONObject()
        val hair = readNestedString(appearance, "face", "hair").ifBlank { "-" }
        val eyes = readNestedString(appearance, "face", "eyes").ifBlank { "-" }
        val face = readNestedString(appearance, "face", "details").ifBlank { "-" }
        val body = readNestedString(appearance, "body", "build").ifBlank { "-" }
        val outfit = readNestedString(appearance, "style", "outfit").ifBlank { "-" }
        val markers = readNestedString(appearance, "style", "markers").ifBlank { "-" }
        return ParticipantAppearanceLocks(
            hair = hair,
            eyes = eyes,
            face = face,
            body = body,
            outfit = outfit,
            markers = markers,
        )
    }

    private fun resolvePersonaMaxMemories(persona: JSONObject): Int {
        val advanced = persona.optJSONObject("advanced") ?: return 60
        val memory = advanced.optJSONObject("memory") ?: return 60
        return memory.optInt("maxMemories", 60).coerceAtLeast(6)
    }

    private fun resolvePersonaMemoryDecayDays(persona: JSONObject): Int {
        val advanced = persona.optJSONObject("advanced") ?: return 30
        val memory = advanced.optJSONObject("memory") ?: return 30
        return memory.optInt("decayDays", 30).coerceAtLeast(1)
    }

    @JvmStatic
    fun generateDiaryPreviewEntries(
        repository: LocalRepository,
        chatId: String,
    ): JSONArray {
        val trimmedChatId = chatId.trim()
        if (trimmedChatId.isBlank()) return JSONArray()

        val settings = parseJsonObject(repository.readSettingsJson())
        val personas = readStoreArray(repository, "personas")
        val chats = readStoreArray(repository, "chats")
        val messages = readStoreArray(repository, "messages")
        val diaryEntries = readStoreArray(repository, "diaryEntries")
        val personaEvolutionStates = readStoreArray(repository, "personaEvolutionStates")

        val chat = findObjectById(chats, trimmedChatId) ?: return JSONArray()
        val personaId = chat.optString("personaId", "").trim()
        if (personaId.isBlank()) return JSONArray()
        val persona = findObjectById(personas, personaId) ?: return JSONArray()
        val evolutionConfig = normalizeChatEvolutionConfig(chat.optJSONObject("evolutionConfig"))
        val evolutionState =
            normalizePersonaEvolutionState(
                state = findPersonaEvolutionStateForChat(personaEvolutionStates, trimmedChatId),
                chatId = trimmedChatId,
                persona = persona,
            )
        val effectivePersona =
            if (evolutionConfig.enabled) {
                applyPersonaEvolutionProfile(persona, evolutionState.optJSONObject("currentProfile"))
            } else {
                JSONObject(persona.toString())
            }
        val evolutionHistoryForPrompt = selectAppliedPersonaEvolutionHistory(evolutionState).takeLast(10)

        val timeline = buildChatMessageTimeline(messages, trimmedChatId)
        if (timeline.isEmpty()) return JSONArray()

        val diaryConfig = ensureDiaryConfig(chat)
        val lastSourceMessageAtMs = diaryConfig.optLong("lastSourceMessageAtMs", 0L)
        val newMessages =
            timeline.filter { message ->
                val createdAtMs = parseIsoMs(message.optString("createdAt", "").trim()) ?: return@filter false
                createdAtMs > lastSourceMessageAtMs
            }
        val sourceMessagesRaw = if (newMessages.isNotEmpty()) newMessages else timeline
        val sourceMessages =
            if (sourceMessagesRaw.size <= DIARY_RECENT_MESSAGE_LIMIT) {
                sourceMessagesRaw
            } else {
                sourceMessagesRaw.takeLast(DIARY_RECENT_MESSAGE_LIMIT)
            }
        if (sourceMessages.isEmpty()) return JSONArray()

        val newChars = sourceMessages.sumOf { message -> message.optString("content", "").trim().length }
        if (sourceMessages.size < DIARY_MIN_NEW_MESSAGES && newChars < DIARY_MIN_NEW_CHARS) {
            return JSONArray()
        }
        val nowMs = System.currentTimeMillis()
        val existingTags = buildDiaryExistingTagsCatalog(diaryEntries, trimmedChatId, nowMs)

        val existingSummary =
            NativeConversationSummaryState(
                summary = chat.optString("conversationSummary", "").trim(),
                facts = parseStringList(chat.optJSONArray("summaryFacts")),
                goals = parseStringList(chat.optJSONArray("summaryGoals")),
                openThreads = parseStringList(chat.optJSONArray("summaryOpenThreads")),
                agreements = parseStringList(chat.optJSONArray("summaryAgreements")),
            )
        val transcript =
            sourceMessages.map { message ->
                val role = message.optString("role", "user").trim().lowercase()
                NativeSummaryTranscriptEntry(
                    role = if (role == "assistant") "assistant" else "user",
                    content = message.optString("content", "").trim(),
                    createdAt = message.optString("createdAt", "").trim().ifBlank { null },
                )
            }

        val draft =
            NativeLlmClient.requestOneToOneDiaryEntry(
                settings = settings,
                persona = effectivePersona,
                chatTitle = chat.optString("title", "").trim(),
                existing = existingSummary,
                transcript = transcript,
                existingTags = existingTags,
                evolutionHistoryApplied = evolutionHistoryForPrompt,
            )
        if (draft == null || !draft.shouldWrite || draft.entries.isEmpty()) return JSONArray()
        return materializeDiaryEntriesFromDraft(
            chatId = trimmedChatId,
            personaId = personaId,
            sourceMessages = sourceMessages,
            draft = draft,
            nowMs = nowMs,
        )
    }

    private fun maybeGenerateDiaryEntries(
        context: Context,
        repository: LocalRepository,
        runtime: BackgroundRuntimeRepository,
    ) {
        val settings = parseJsonObject(repository.readSettingsJson())
        val personas = readStoreArray(repository, "personas")
        val chats = readStoreArray(repository, "chats")
        val messages = readStoreArray(repository, "messages")
        val diaryEntries = readStoreArray(repository, "diaryEntries")
        val personaEvolutionStates = readStoreArray(repository, "personaEvolutionStates")
        if (chats.length() == 0) return

        val nowMs = System.currentTimeMillis()
        var chatsChanged = false
        var diariesChanged = false

        for (chatIndex in 0 until chats.length()) {
            val chat = chats.optJSONObject(chatIndex) ?: continue
            val chatId = chat.optString("id", "").trim()
            if (chatId.isBlank()) continue
            val diaryConfig = ensureDiaryConfig(chat)
            if (!diaryConfig.optBoolean("enabled", false)) continue

            val timeline = buildChatMessageTimeline(messages, chatId)
            val lastMessage = timeline.lastOrNull()
            val lastActivityMs = lastMessage?.let { message -> parseIsoMs(message.optString("createdAt", "").trim()) }
            if (lastActivityMs == null) continue
            if (nowMs - lastActivityMs < DIARY_IDLE_MS) continue

            val lastGeneratedAtMs = diaryConfig.optLong("lastGeneratedAtMs", 0L)
            val lastCheckedAtMs = diaryConfig.optLong("lastCheckedAtMs", 0L)
            val lastEvaluationMs = max(lastGeneratedAtMs, lastCheckedAtMs)
            if (lastEvaluationMs > 0 && nowMs - lastEvaluationMs < DIARY_CHECK_INTERVAL_MS) {
                continue
            }

            val lastSourceMessageAtMs = diaryConfig.optLong("lastSourceMessageAtMs", 0L)
            val newMessages =
                timeline.filter { message ->
                    val createdAtMs = parseIsoMs(message.optString("createdAt", "").trim()) ?: return@filter false
                    createdAtMs > lastSourceMessageAtMs
                }
            val sourceMessages = if (newMessages.size <= DIARY_RECENT_MESSAGE_LIMIT) newMessages else newMessages.takeLast(DIARY_RECENT_MESSAGE_LIMIT)
            val newChars = sourceMessages.sumOf { message -> message.optString("content", "").trim().length }
            if (sourceMessages.isEmpty()) {
                diaryConfig.put("lastCheckedAtMs", nowMs)
                chatsChanged = true
                continue
            }
            if (sourceMessages.size < DIARY_MIN_NEW_MESSAGES && newChars < DIARY_MIN_NEW_CHARS) {
                diaryConfig.put("lastCheckedAtMs", nowMs)
                chatsChanged = true
                continue
            }

            val personaId = chat.optString("personaId", "").trim()
            val persona = findObjectById(personas, personaId) ?: continue
            val evolutionConfig = normalizeChatEvolutionConfig(chat.optJSONObject("evolutionConfig"))
            val evolutionState =
                normalizePersonaEvolutionState(
                    state = findPersonaEvolutionStateForChat(personaEvolutionStates, chatId),
                    chatId = chatId,
                    persona = persona,
                )
            val effectivePersona =
                if (evolutionConfig.enabled) {
                    applyPersonaEvolutionProfile(persona, evolutionState.optJSONObject("currentProfile"))
                } else {
                    JSONObject(persona.toString())
                }
            val evolutionHistoryForPrompt =
                selectAppliedPersonaEvolutionHistory(evolutionState).takeLast(10)
            val existingTags = buildDiaryExistingTagsCatalog(diaryEntries, chatId, nowMs)
            val existingSummary =
                NativeConversationSummaryState(
                    summary = chat.optString("conversationSummary", "").trim(),
                    facts = parseStringList(chat.optJSONArray("summaryFacts")),
                    goals = parseStringList(chat.optJSONArray("summaryGoals")),
                    openThreads = parseStringList(chat.optJSONArray("summaryOpenThreads")),
                    agreements = parseStringList(chat.optJSONArray("summaryAgreements")),
                )
            val transcript =
                sourceMessages.map { message ->
                    val role = message.optString("role", "user").trim().lowercase()
                    NativeSummaryTranscriptEntry(
                        role = if (role == "assistant") "assistant" else "user",
                        content = message.optString("content", "").trim(),
                        createdAt = message.optString("createdAt", "").trim().ifBlank { null },
                    )
                }

            val draft =
                NativeLlmClient.requestOneToOneDiaryEntry(
                    settings = settings,
                    persona = effectivePersona,
                    chatTitle = chat.optString("title", "").trim(),
                    existing = existingSummary,
                    transcript = transcript,
                    existingTags = existingTags,
                    evolutionHistoryApplied = evolutionHistoryForPrompt,
                )
            if (draft == null || !draft.shouldWrite || draft.entries.isEmpty()) {
                diaryConfig.put("lastCheckedAtMs", nowMs)
                chatsChanged = true
                continue
            }

            val sourceLast = sourceMessages.lastOrNull()
            val sourceLastAtMs = sourceLast?.let { message -> parseIsoMs(message.optString("createdAt", "").trim()) } ?: lastSourceMessageAtMs
            val generatedEntries =
                materializeDiaryEntriesFromDraft(
                    chatId = chatId,
                    personaId = personaId,
                    sourceMessages = sourceMessages,
                    draft = draft,
                    nowMs = nowMs,
                )
            if (generatedEntries.length() == 0) {
                diaryConfig.put("lastCheckedAtMs", nowMs)
                chatsChanged = true
                continue
            }
            val createdAt = nowIsoUtc()
            for (index in 0 until generatedEntries.length()) {
                generatedEntries.optJSONObject(index)?.let { diaryEntries.put(it) }
            }

            diaryConfig.put("enabled", true)
            diaryConfig.put("lastCheckedAtMs", nowMs)
            diaryConfig.put("lastGeneratedAtMs", nowMs)
            diaryConfig.put("lastSourceMessageAtMs", sourceLastAtMs)
            chat.put("diaryConfig", diaryConfig)
            chat.put("updatedAt", createdAt)
            chats.put(chatIndex, chat)
            chatsChanged = true
            diariesChanged = true

            appendRuntimeEvent(
                runtime = runtime,
                scopeId = chatId,
                jobId = null,
                stage = "diary_written",
                level = "info",
                message = "Diary entries generated",
                details =
                    JSONObject().apply {
                        put("entryCount", generatedEntries.length())
                        put("messageCount", sourceMessages.size)
                    },
            )

            appendStatePatch(
                runtime = runtime,
                scopeId = chatId,
                jobId = null,
                stores =
                    JSONObject().apply {
                        put("chats", JSONArray().put(JSONObject(chat.toString())))
                        put("diaryEntries", generatedEntries)
                    },
            )
        }

        if (chatsChanged) {
            repository.writeStoreJson("chats", chats.toString())
        }
        if (diariesChanged) {
            repository.writeStoreJson("diaryEntries", diaryEntries.toString())
            ForegroundSyncService.updateWorkerStatus(
                context = context,
                worker = ForegroundSyncService.WORKER_ONE_TO_ONE_CHAT,
                state = "running",
                scopeId = "",
                detail = "diary_generated",
                progress = true,
                claimed = false,
                lastError = "",
            )
        }
    }

    private fun isDiaryDateTag(tag: String): Boolean {
        return tag.trim().lowercase().startsWith("date:")
    }

    private fun buildDiaryExistingTagsCatalog(
        diaryEntries: JSONArray,
        chatId: String,
        nowMs: Long,
    ): List<String> {
        val stats = mutableMapOf<String, Pair<Int, Long>>()
        for (index in 0 until diaryEntries.length()) {
            val entry = diaryEntries.optJSONObject(index) ?: continue
            if (entry.optString("chatId", "").trim() != chatId) continue
            val createdAtMs = parseIsoMs(entry.optString("createdAt", "").trim()) ?: 0L
            val tags = parseStringList(entry.optJSONArray("tags"))
            val normalized = normalizeDiaryTags(tags)
            for (tag in normalized) {
                if (isDiaryDateTag(tag)) continue
                val current = stats[tag]
                if (current == null) {
                    stats[tag] = 1 to createdAtMs
                } else {
                    stats[tag] = (current.first + 1) to max(current.second, createdAtMs)
                }
            }
        }
        return stats
            .entries
            .map { (tag, pair) ->
                val count = pair.first
                val lastCreatedAtMs = pair.second
                val ageHours = max(0.0, (nowMs - lastCreatedAtMs).toDouble() / 3_600_000.0)
                val recencyBoost = 1.0 / (1.0 + ageHours / 12.0)
                val score = count * 10.0 + recencyBoost
                Triple(tag, score, lastCreatedAtMs)
            }
            .sortedWith(
                compareByDescending<Triple<String, Double, Long>> { it.second }
                    .thenByDescending { it.third }
                    .thenBy { it.first },
            )
            .take(DIARY_EXISTING_TAGS_LIMIT)
            .map { it.first }
    }

    private fun materializeDiaryEntriesFromDraft(
        chatId: String,
        personaId: String,
        sourceMessages: List<JSONObject>,
        draft: NativeOneToOneDiaryDraft,
        nowMs: Long,
    ): JSONArray {
        if (draft.entries.isEmpty()) return JSONArray()
        val sourceFirst = sourceMessages.firstOrNull()
        val sourceLast = sourceMessages.lastOrNull()
        val timestamp = nowIsoUtc()
        val dateTag = "date:${Instant.ofEpochMilli(nowMs).toString().take(10)}"
        val generated = JSONArray()
        for (entryDraft in draft.entries.take(DIARY_GENERATION_MAX_ENTRIES)) {
            val markdown = entryDraft.markdown.trim()
            if (markdown.isBlank()) continue
            val nonDateTags =
                normalizeDiaryTags(entryDraft.tags)
                    .filter { tag -> !isDiaryDateTag(tag) }
            if (nonDateTags.isEmpty()) continue
            val tags = normalizeDiaryTags(listOf(dateTag) + nonDateTags)
            val diaryEntry =
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("chatId", chatId)
                    put("personaId", personaId)
                    put("markdown", markdown)
                    put("tags", JSONArray(tags))
                    put("sourceRange", JSONObject().apply {
                        sourceFirst?.optString("id", "")?.trim()?.takeIf { it.isNotBlank() }?.let { put("fromMessageId", it) }
                        sourceLast?.optString("id", "")?.trim()?.takeIf { it.isNotBlank() }?.let { put("toMessageId", it) }
                        sourceFirst?.optString("createdAt", "")?.trim()?.takeIf { it.isNotBlank() }?.let { put("fromCreatedAt", it) }
                        sourceLast?.optString("createdAt", "")?.trim()?.takeIf { it.isNotBlank() }?.let { put("toCreatedAt", it) }
                        put("messageCount", sourceMessages.size)
                    })
                    put("autoGenerated", true)
                    put("createdAt", timestamp)
                    put("updatedAt", timestamp)
                }
            generated.put(diaryEntry)
        }
        return generated
    }

    private fun normalizeDiaryTags(rawTags: List<String>): List<String> {
        val normalized = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (raw in rawTags) {
            val candidate = raw.trim()
            if (candidate.isBlank()) continue
            val compact = candidate.replace(Regex("\\s+"), " ")
            val tag = if (compact.length > 120) "${compact.take(119).trimEnd()}…" else compact
            if (seen.contains(tag)) continue
            seen.add(tag)
            normalized.add(tag)
            if (normalized.size >= DIARY_MAX_TAGS) break
        }
        return normalized
    }

    private fun ensureDiaryConfig(chat: JSONObject): JSONObject {
        val existing = chat.optJSONObject("diaryConfig") ?: JSONObject()
        val next = JSONObject(existing.toString())
        if (!next.has("enabled")) {
            next.put("enabled", false)
        } else {
            next.put("enabled", next.optBoolean("enabled", false))
        }
        return next
    }

    private fun parseIsoMs(value: String): Long? {
        return try {
            Instant.parse(value.trim()).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    private fun maybeRefreshConversationSummary(
        settings: JSONObject,
        persona: JSONObject,
        chat: JSONObject,
        timeline: List<JSONObject>,
    ) {
        if (timeline.size <= RECENT_CONTEXT_MESSAGE_LIMIT) return
        val boundaryExclusive = timeline.size - RECENT_CONTEXT_MESSAGE_LIMIT
        if (boundaryExclusive <= 0) return
        val cursorId = chat.optString("summaryCursorMessageId", "").trim()
        val cursorIndex =
            if (cursorId.isBlank()) {
                -1
            } else {
                timeline.indexOfFirst { message -> message.optString("id", "").trim() == cursorId }
            }
        val startIndex = if (cursorIndex >= 0) cursorIndex + 1 else 0
        if (startIndex >= boundaryExclusive) return
        val pending = timeline.subList(startIndex, boundaryExclusive)
        val pendingChars = pending.sumOf { message -> message.optString("content", "").trim().length }
        if (pending.size < SUMMARY_MIN_NEW_MESSAGES && pendingChars < SUMMARY_MIN_NEW_CHARS) return

        val existingSummary =
            NativeConversationSummaryState(
                summary = chat.optString("conversationSummary", "").trim(),
                facts = parseStringList(chat.optJSONArray("summaryFacts")),
                goals = parseStringList(chat.optJSONArray("summaryGoals")),
                openThreads = parseStringList(chat.optJSONArray("summaryOpenThreads")),
                agreements = parseStringList(chat.optJSONArray("summaryAgreements")),
            )
        val transcript =
            pending.map { message ->
                val role = message.optString("role", "user").trim().lowercase()
                val content = message.optString("content", "").trim()
                NativeSummaryTranscriptEntry(
                    role = if (role == "assistant") "assistant" else "user",
                    content = content.take(SUMMARY_TRANSCRIPT_MAX_CHARS_PER_MESSAGE),
                    createdAt = message.optString("createdAt", "").trim().ifBlank { null },
                )
            }.filter { entry -> entry.content.isNotBlank() }
        if (transcript.isEmpty()) return
        val targetTokens =
            chat.optInt("summaryTokenBudget", SUMMARY_DEFAULT_TOKEN_BUDGET)
                .coerceIn(SUMMARY_MIN_TOKEN_BUDGET, SUMMARY_MAX_TOKEN_BUDGET)
        val next =
            NativeLlmClient.requestOneToOneSummaryUpdate(
                settings = settings,
                persona = persona,
                existing = existingSummary,
                transcript = transcript,
                targetTokens = targetTokens,
            ) ?: return

        val cursorMessageId = timeline[boundaryExclusive - 1].optString("id", "").trim()
        if (cursorMessageId.isBlank()) return
        chat.put("conversationSummary", next.summary)
        chat.put("summaryFacts", JSONArray(next.facts))
        chat.put("summaryGoals", JSONArray(next.goals))
        chat.put("summaryOpenThreads", JSONArray(next.openThreads))
        chat.put("summaryAgreements", JSONArray(next.agreements))
        chat.put("summaryCursorMessageId", cursorMessageId)
        chat.put("summaryUpdatedAt", nowIsoUtc())
        chat.put("summaryTokenBudget", targetTokens)
    }

    private fun readNestedString(root: JSONObject?, vararg path: String): String {
        if (root == null || path.isEmpty()) return ""
        var cursor: Any = root
        for (segment in path) {
            cursor =
                when (cursor) {
                    is JSONObject -> cursor.opt(segment)
                    else -> return ""
                } ?: return ""
            if (cursor == JSONObject.NULL) return ""
        }
        return if (cursor is String) cursor.trim() else cursor.toString().trim()
    }

    private fun findMessageIndex(messages: JSONArray, chatId: String, messageId: String): Int {
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("id", "").trim() != messageId) continue
            if (message.optString("chatId", "").trim() != chatId) continue
            if (!message.optString("role", "").trim().equals("user", ignoreCase = true)) continue
            return index
        }
        return -1
    }

    private fun replaceMessageById(messages: JSONArray, nextMessage: JSONObject): Boolean {
        val targetId = nextMessage.optString("id", "").trim()
        if (targetId.isEmpty()) return false
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("id", "").trim() != targetId) continue
            messages.put(index, nextMessage)
            return true
        }
        return false
    }

    private fun findObjectById(items: JSONArray, id: String): JSONObject? {
        val normalizedId = id.trim()
        if (normalizedId.isEmpty()) return null
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.optString("id", "").trim() == normalizedId) {
                return item
            }
        }
        return null
    }

    private fun findObjectIndexById(items: JSONArray, id: String): Int {
        val normalizedId = id.trim()
        if (normalizedId.isEmpty()) return -1
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.optString("id", "").trim() == normalizedId) {
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

    private fun persistMessageUpdatesMerged(
        repository: LocalRepository,
        updates: List<JSONObject>,
    ) {
        if (updates.isEmpty()) return
        val latestMessages = readStoreArray(repository, "messages")
        updates.forEach { message ->
            upsertByChatId(
                items = latestMessages,
                next = JSONObject(message.toString()),
                key = "id",
            )
        }
        repository.writeStoreJson("messages", latestMessages.toString())
    }

    private fun mergePersonaEvolutionStateDelta(
        latestState: JSONObject,
        stateAtJobStart: JSONObject,
        stateAfterJob: JSONObject,
    ): JSONObject {
        val merged = JSONObject(latestState.toString())
        val latestHistory = merged.optJSONArray("history")?.let { JSONArray(it.toString()) } ?: JSONArray()
        val latestPending = merged.optJSONArray("pendingProposals")?.let { JSONArray(it.toString()) } ?: JSONArray()
        val baseHistoryIds = collectJsonObjectIds(stateAtJobStart.optJSONArray("history"))
        val basePendingIds = collectJsonObjectIds(stateAtJobStart.optJSONArray("pendingProposals"))
        val historyAdded =
            appendJsonObjectDeltaById(
                source = stateAfterJob.optJSONArray("history"),
                baseIds = baseHistoryIds,
                target = latestHistory,
            )
        val pendingAdded =
            appendJsonObjectDeltaById(
                source = stateAfterJob.optJSONArray("pendingProposals"),
                baseIds = basePendingIds,
                target = latestPending,
            )
        merged.put("history", latestHistory)
        merged.put("pendingProposals", latestPending)
        if (historyAdded) {
            merged.put("currentProfile", rebuildPersonaEvolutionCurrentProfile(merged))
        }
        if (historyAdded || pendingAdded) {
            val mergedUpdatedAt =
                maxIsoTimestamp(
                    merged.optString("updatedAt", ""),
                    stateAfterJob.optString("updatedAt", ""),
                    nowIsoUtc(),
                )
            merged.put("updatedAt", mergedUpdatedAt)
        }
        return merged
    }

    private fun collectJsonObjectIds(items: JSONArray?): Set<String> {
        if (items == null) return emptySet()
        val ids = mutableSetOf<String>()
        for (index in 0 until items.length()) {
            val row = items.optJSONObject(index) ?: continue
            val id = row.optString("id", "").trim()
            if (id.isNotEmpty()) {
                ids.add(id)
            }
        }
        return ids
    }

    private fun appendJsonObjectDeltaById(
        source: JSONArray?,
        baseIds: Set<String>,
        target: JSONArray,
    ): Boolean {
        if (source == null || source.length() == 0) return false
        val targetIds = collectJsonObjectIds(target).toMutableSet()
        var changed = false
        for (index in 0 until source.length()) {
            val row = source.optJSONObject(index) ?: continue
            val rowId = row.optString("id", "").trim()
            if (rowId.isNotEmpty()) {
                if (baseIds.contains(rowId)) continue
                if (targetIds.contains(rowId)) continue
                target.put(JSONObject(row.toString()))
                targetIds.add(rowId)
                changed = true
                continue
            }
            val serialized = row.toString()
            var alreadyExists = false
            for (targetIndex in 0 until target.length()) {
                val existing = target.optJSONObject(targetIndex) ?: continue
                if (existing.toString() == serialized) {
                    alreadyExists = true
                    break
                }
            }
            if (!alreadyExists) {
                target.put(JSONObject(row.toString()))
                changed = true
            }
        }
        return changed
    }

    private fun rebuildPersonaEvolutionCurrentProfile(state: JSONObject): JSONObject {
        val baselineProfile = state.optJSONObject("baselineProfile")?.let { JSONObject(it.toString()) } ?: JSONObject()
        val historyOnlyState =
            JSONObject().apply {
                put("history", state.optJSONArray("history")?.let { JSONArray(it.toString()) } ?: JSONArray())
            }
        var currentProfile = JSONObject(baselineProfile.toString())
        selectAppliedPersonaEvolutionHistory(historyOnlyState).forEach { event ->
            val patch = normalizePersonaEvolutionPatch(parseOptionalJsonObject(event.opt("patch"))) ?: return@forEach
            currentProfile = applyPersonaEvolutionPatch(currentProfile, patch)
        }
        return currentProfile
    }

    private fun maxIsoTimestamp(vararg values: String): String {
        var latest = ""
        values.forEach { raw ->
            val value = raw.trim()
            if (value.isBlank()) return@forEach
            if (latest.isBlank() || value > latest) {
                latest = value
            }
        }
        return if (latest.isNotBlank()) latest else nowIsoUtc()
    }

    private fun parseJsonObject(raw: String?): JSONObject {
        if (raw.isNullOrBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
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

    private fun nowIsoUtc(): String = Instant.now().toString()

    private fun setMessageNativeStatus(message: JSONObject, status: String, error: String?) {
        message.put("nativeStatus", status)
        if (error.isNullOrBlank()) {
            message.remove("nativeError")
        } else {
            message.put("nativeError", error.trim())
        }
    }

    private fun markUserMessageFailed(
        repository: LocalRepository,
        scope: ParsedJobScope,
        errorMessage: String,
    ): JSONObject? {
        val messages = readStoreArray(repository, "messages")
        val userMessageIndex = findMessageIndex(messages, scope.chatId, scope.userMessageId)
        if (userMessageIndex < 0) return null
        val userMessage = messages.optJSONObject(userMessageIndex) ?: return null
        setMessageNativeStatus(userMessage, "failed", errorMessage)
        messages.put(userMessageIndex, userMessage)
        repository.writeStoreJson("messages", messages.toString())
        return JSONObject().apply {
            put(
                "messages",
                JSONArray().put(
                    JSONObject(userMessage.toString()),
                ),
            )
        }
    }

    private fun buildRecentMessagesForPrompt(messages: JSONArray, chatId: String): JSONArray {
        val rows = mutableListOf<JSONObject>()
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("chatId", "").trim() != chatId) continue
            val role = message.optString("role", "").trim().lowercase()
            if (role != "user" && role != "assistant") continue
            val content = message.optString("content", "").trim()
            if (content.isBlank()) continue
            rows.add(message)
        }
        val selected =
            if (rows.size <= RECENT_CONTEXT_MESSAGE_LIMIT) {
                rows
            } else {
                rows.takeLast(RECENT_CONTEXT_MESSAGE_LIMIT)
            }
        return JSONArray().apply {
            selected.forEach { row ->
                put(
                    JSONObject().apply {
                        put("role", row.optString("role", "user").trim().lowercase())
                        put("content", row.optString("content", "").trim())
                        put("createdAt", row.optString("createdAt", "").trim())
                    },
                )
            }
        }
    }

    private fun buildChatMessageTimeline(messages: JSONArray, chatId: String): List<JSONObject> {
        val rows = mutableListOf<JSONObject>()
        for (index in 0 until messages.length()) {
            val message = messages.optJSONObject(index) ?: continue
            if (message.optString("chatId", "").trim() != chatId) continue
            val role = message.optString("role", "").trim().lowercase()
            if (role != "user" && role != "assistant") continue
            val content = message.optString("content", "").trim()
            if (content.isBlank()) continue
            rows.add(message)
        }
        return rows
    }

    private fun findPersonaStateForChat(personaStates: JSONArray, chatId: String): JSONObject? {
        for (index in 0 until personaStates.length()) {
            val state = personaStates.optJSONObject(index) ?: continue
            if (state.optString("chatId", "").trim() == chatId) {
                return state
            }
        }
        return null
    }

    private fun findPersonaEvolutionStateForChat(personaEvolutionStates: JSONArray, chatId: String): JSONObject? {
        for (index in 0 until personaEvolutionStates.length()) {
            val state = personaEvolutionStates.optJSONObject(index) ?: continue
            if (state.optString("chatId", "").trim() == chatId) {
                return state
            }
        }
        return null
    }

    private fun normalizeChatEvolutionConfig(raw: JSONObject?): ChatEvolutionConfig {
        val applyModeRaw = raw?.optString("applyMode", "")?.trim()?.lowercase().orEmpty()
        val applyMode = if (applyModeRaw == "auto") "auto" else "manual"
        return ChatEvolutionConfig(
            enabled = raw?.optBoolean("enabled", false) == true,
            applyMode = applyMode,
        )
    }

    private fun extractPersonaEvolutionBaselineProfile(persona: JSONObject): JSONObject {
        val advanced = persona.optJSONObject("advanced") ?: JSONObject()
        return JSONObject().apply {
            put("personalityPrompt", persona.optString("personalityPrompt", "").trim())
            put("stylePrompt", persona.optString("stylePrompt", "").trim())
            put("appearance", JSONObject((persona.optJSONObject("appearance") ?: JSONObject()).toString()))
            put(
                "advanced",
                JSONObject().apply {
                    put("core", JSONObject((advanced.optJSONObject("core") ?: JSONObject()).toString()))
                    put("voice", JSONObject((advanced.optJSONObject("voice") ?: JSONObject()).toString()))
                    put("behavior", JSONObject((advanced.optJSONObject("behavior") ?: JSONObject()).toString()))
                    put("emotion", JSONObject((advanced.optJSONObject("emotion") ?: JSONObject()).toString()))
                    put("memory", JSONObject((advanced.optJSONObject("memory") ?: JSONObject()).toString()))
                },
            )
        }
    }

    private fun createInitialPersonaEvolutionState(
        chatId: String,
        persona: JSONObject,
        timestamp: String,
    ): JSONObject {
        val baselineProfile = extractPersonaEvolutionBaselineProfile(persona)
        return JSONObject().apply {
            put("chatId", chatId)
            put("personaId", persona.optString("id", "").trim())
            put("baselineProfile", JSONObject(baselineProfile.toString()))
            put("currentProfile", JSONObject(baselineProfile.toString()))
            put("pendingProposals", JSONArray())
            put("history", JSONArray())
            put("updatedAt", timestamp)
        }
    }

    private fun normalizePersonaEvolutionState(
        state: JSONObject?,
        chatId: String,
        persona: JSONObject,
    ): JSONObject {
        if (state == null) {
            return createInitialPersonaEvolutionState(chatId, persona, nowIsoUtc())
        }
        val baselineFallback = extractPersonaEvolutionBaselineProfile(persona)
        val baselineProfile =
            state.optJSONObject("baselineProfile")
                ?.takeIf { it.length() > 0 }
                ?.let { JSONObject(it.toString()) }
                ?: JSONObject(baselineFallback.toString())
        val currentProfile =
            state.optJSONObject("currentProfile")
                ?.takeIf { it.length() > 0 }
                ?.let { JSONObject(it.toString()) }
                ?: JSONObject(baselineProfile.toString())
        val pending =
            state.optJSONArray("pendingProposals")
                ?.let { JSONArray(it.toString()) }
                ?: JSONArray()
        val history =
            state.optJSONArray("history")
                ?.let { JSONArray(it.toString()) }
                ?: JSONArray()
        return JSONObject().apply {
            put("chatId", chatId)
            put("personaId", persona.optString("id", "").trim())
            put("baselineProfile", baselineProfile)
            put("currentProfile", currentProfile)
            put("pendingProposals", pending)
            put("history", history)
            put("updatedAt", state.optString("updatedAt", "").trim().ifBlank { nowIsoUtc() })
        }
    }

    private fun applyPersonaEvolutionProfile(persona: JSONObject, profile: JSONObject?): JSONObject {
        if (profile == null) return JSONObject(persona.toString())
        val next = JSONObject(persona.toString())
        profile.optString("personalityPrompt", "").trim().takeIf { it.isNotBlank() }?.let { value ->
            next.put("personalityPrompt", value)
        }
        profile.optString("stylePrompt", "").trim().takeIf { it.isNotBlank() }?.let { value ->
            next.put("stylePrompt", value)
        }
        val appearancePatch = profile.optJSONObject("appearance")
        if (appearancePatch != null && appearancePatch.length() > 0) {
            val merged = mergeJsonObjects(next.optJSONObject("appearance") ?: JSONObject(), appearancePatch)
            next.put("appearance", merged)
        }
        val advancedPatch = profile.optJSONObject("advanced")
        if (advancedPatch != null && advancedPatch.length() > 0) {
            val nextAdvanced = JSONObject((next.optJSONObject("advanced") ?: JSONObject()).toString())
            val sections = listOf("core", "voice", "behavior", "emotion", "memory")
            sections.forEach { section ->
                val sectionPatch = advancedPatch.optJSONObject(section) ?: return@forEach
                val mergedSection = mergeJsonObjects(nextAdvanced.optJSONObject(section) ?: JSONObject(), sectionPatch)
                nextAdvanced.put(section, mergedSection)
            }
            next.put("advanced", nextAdvanced)
        }
        return next
    }

    private fun mergeJsonObjects(base: JSONObject, patch: JSONObject): JSONObject {
        val merged = JSONObject(base.toString())
        val keys = patch.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = patch.opt(key)
            if (value == null || value == JSONObject.NULL) continue
            if (value is JSONObject) {
                val nested = merged.optJSONObject(key) ?: JSONObject()
                merged.put(key, mergeJsonObjects(nested, value))
            } else {
                merged.put(key, value)
            }
        }
        return merged
    }

    private fun parseOptionalJsonObject(value: Any?): JSONObject? {
        return when (value) {
            null, JSONObject.NULL -> null
            is JSONObject -> value
            is String -> {
                val normalized = value.trim()
                if (normalized.isBlank()) null else parseJsonObject(normalized).takeIf { it.length() > 0 }
            }
            else -> parseJsonObject(value.toString()).takeIf { it.length() > 0 }
        }
    }

    private fun normalizeTextPatchField(value: Any?): String? {
        if (value !is String) return null
        val normalized = value.trim()
        return normalized.ifBlank { null }
    }

    private fun normalizeStandalonePersonaTextPatchField(value: Any?): String? {
        val normalized = normalizeTextPatchField(value) ?: return null
        if (!looksLikeStandalonePersonaText(normalized)) return null
        return normalized
    }

    private fun looksLikeStandalonePersonaText(value: String): Boolean {
        val normalized = value.trim()
        if (normalized.isEmpty()) return false
        val compact = normalized.lowercase()
        if (compact.contains("->")) return false
        val deltaPrefixes =
            listOf(
                "станов",
                "стал ",
                "стала ",
                "стало ",
                "станет ",
                "делается ",
                "чуть ",
                "немного ",
                "слегка ",
                "более ",
                "менее ",
                "теперь ",
                "ещё ",
                "еще ",
                "по-прежнему ",
                "остаётся ",
                "остается ",
                "как раньше",
            )
        return deltaPrefixes.none { prefix -> compact.startsWith(prefix) }
    }

    private fun pickFirstNonNullValue(raw: JSONObject?, vararg keys: String): Any? {
        if (raw == null) return null
        for (key in keys) {
            if (!raw.has(key)) continue
            val candidate = raw.opt(key)
            if (candidate == null || candidate == JSONObject.NULL) continue
            return candidate
        }
        return null
    }

    private fun pickFirstObject(raw: JSONObject?, vararg keys: String): JSONObject? {
        return parseOptionalJsonObject(pickFirstNonNullValue(raw, *keys))
    }

    private fun isMeaningfulEvolutionReason(value: String): Boolean {
        val normalized = value.trim()
        if (normalized.length < 8) return false
        val compact = normalized.lowercase()
        if (compact == "evolution_update" || compact == "update" || compact == "patch" || compact == "n/a") {
            return false
        }
        val hasLettersOrDigits = normalized.any { character -> character.isLetterOrDigit() }
        return hasLettersOrDigits
    }

    private fun collectPatchFieldPaths(
        value: Any?,
        prefix: String,
        out: MutableList<String>,
    ) {
        if (value !is JSONObject) return
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val nested = value.opt(key)
            val path = if (prefix.isBlank()) key else "$prefix.$key"
            if (nested is JSONObject) {
                collectPatchFieldPaths(nested, path, out)
            } else if (nested != null && nested != JSONObject.NULL) {
                out.add(path)
            }
        }
    }

    private fun summarizeEvolutionPatchFields(patch: JSONObject): String {
        val paths = mutableListOf<String>()
        collectPatchFieldPaths(patch, "", paths)
        if (paths.isEmpty()) return "profile fields"
        val unique = paths.distinct().sorted()
        val preview = unique.take(4).joinToString(", ")
        return if (unique.size > 4) "$preview +" + (unique.size - 4).toString() else preview
    }

    private fun resolveEvolutionReason(
        reasonRaw: Any?,
        patch: JSONObject,
    ): String {
        val normalized = normalizeTextPatchField(reasonRaw)
        if (normalized != null && isMeaningfulEvolutionReason(normalized)) {
            return normalized
        }
        return "Sustained conversation shift detected; updated ${summarizeEvolutionPatchFields(patch)}."
    }

    private fun normalizeFiniteNumber(value: Any?): Double? {
        val number = value as? Number ?: return null
        val normalized = number.toDouble()
        return if (normalized.isFinite()) normalized else null
    }

    private fun normalizeAppearanceEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val allowed =
            listOf(
                "faceDescription" to arrayOf("faceDescription", "face_description"),
                "height" to arrayOf("height"),
                "eyes" to arrayOf("eyes"),
                "lips" to arrayOf("lips"),
                "hair" to arrayOf("hair"),
                "ageType" to arrayOf("ageType", "age_type"),
                "bodyType" to arrayOf("bodyType", "body_type"),
                "markers" to arrayOf("markers"),
                "accessories" to arrayOf("accessories"),
                "clothingStyle" to arrayOf("clothingStyle", "clothing_style"),
                "skin" to arrayOf("skin"),
            )
        val patch = JSONObject()
        allowed.forEach { field ->
            normalizeTextPatchField(pickFirstNonNullValue(raw, *field.second))?.let { value ->
                patch.put(field.first, value)
            }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeCoreEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        listOf(
            "archetype" to arrayOf("archetype"),
            "backstory" to arrayOf("backstory"),
            "goals" to arrayOf("goals"),
            "values" to arrayOf("values"),
            "boundaries" to arrayOf("boundaries"),
            "expertise" to arrayOf("expertise"),
        ).forEach { field ->
            normalizeTextPatchField(pickFirstNonNullValue(raw, *field.second))?.let { value ->
                patch.put(field.first, value)
            }
        }
        normalizeTextPatchField(pickFirstNonNullValue(raw, "selfGender", "self_gender"))?.lowercase()?.let { value ->
            if (value == "auto" || value == "female" || value == "male" || value == "neutral") {
                patch.put("selfGender", value)
            }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeVoiceEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        normalizeTextPatchField(pickFirstNonNullValue(raw, "tone"))?.let { patch.put("tone", it) }
        normalizeTextPatchField(pickFirstNonNullValue(raw, "lexicalStyle", "lexical_style"))?.let { patch.put("lexicalStyle", it) }
        normalizeTextPatchField(pickFirstNonNullValue(raw, "sentenceLength", "sentence_length"))?.lowercase()?.let { value ->
            if (value == "short" || value == "balanced" || value == "long") {
                patch.put("sentenceLength", value)
            }
        }
        listOf(
            "formality" to arrayOf("formality"),
            "expressiveness" to arrayOf("expressiveness"),
            "emoji" to arrayOf("emoji"),
        ).forEach { field ->
            normalizeFiniteNumber(pickFirstNonNullValue(raw, *field.second))?.let { value -> patch.put(field.first, value) }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeBehaviorEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        listOf(
            "initiative" to arrayOf("initiative"),
            "empathy" to arrayOf("empathy"),
            "directness" to arrayOf("directness"),
            "curiosity" to arrayOf("curiosity"),
            "challenge" to arrayOf("challenge"),
            "creativity" to arrayOf("creativity"),
        ).forEach { field ->
            normalizeFiniteNumber(pickFirstNonNullValue(raw, *field.second))?.let { value -> patch.put(field.first, value) }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeEmotionEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        normalizeTextPatchField(pickFirstNonNullValue(raw, "baselineMood", "baseline_mood"))?.let { patch.put("baselineMood", it) }
        normalizeTextPatchField(pickFirstNonNullValue(raw, "positiveTriggers", "positive_triggers"))?.let { patch.put("positiveTriggers", it) }
        normalizeTextPatchField(pickFirstNonNullValue(raw, "negativeTriggers", "negative_triggers"))?.let { patch.put("negativeTriggers", it) }
        listOf(
            "warmth" to arrayOf("warmth"),
            "stability" to arrayOf("stability"),
        ).forEach { field ->
            normalizeFiniteNumber(pickFirstNonNullValue(raw, *field.second))?.let { value -> patch.put(field.first, value) }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeMemoryEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        listOf(
            "rememberFacts" to arrayOf("rememberFacts", "remember_facts"),
            "rememberPreferences" to arrayOf("rememberPreferences", "remember_preferences"),
            "rememberGoals" to arrayOf("rememberGoals", "remember_goals"),
            "rememberEvents" to arrayOf("rememberEvents", "remember_events"),
        ).forEach { field ->
            val value = pickFirstNonNullValue(raw, *field.second)
            if (value is Boolean) {
                patch.put(field.first, value)
            }
        }
        listOf(
            "maxMemories" to arrayOf("maxMemories", "max_memories"),
            "decayDays" to arrayOf("decayDays", "decay_days"),
        ).forEach { field ->
            normalizeFiniteNumber(pickFirstNonNullValue(raw, *field.second))?.let { value -> patch.put(field.first, value) }
        }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizeAdvancedEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        normalizeCoreEvolutionPatch(pickFirstObject(raw, "core"))?.let { patch.put("core", it) }
        normalizeVoiceEvolutionPatch(pickFirstObject(raw, "voice"))?.let { patch.put("voice", it) }
        normalizeBehaviorEvolutionPatch(pickFirstObject(raw, "behavior"))?.let { patch.put("behavior", it) }
        normalizeEmotionEvolutionPatch(pickFirstObject(raw, "emotion"))?.let { patch.put("emotion", it) }
        normalizeMemoryEvolutionPatch(pickFirstObject(raw, "memory"))?.let { patch.put("memory", it) }
        return if (patch.length() > 0) patch else null
    }

    private fun normalizePersonaEvolutionPatch(raw: JSONObject?): JSONObject? {
        if (raw == null) return null
        val patch = JSONObject()
        normalizeStandalonePersonaTextPatchField(pickFirstNonNullValue(raw, "personalityPrompt", "personality_prompt"))?.let { patch.put("personalityPrompt", it) }
        normalizeStandalonePersonaTextPatchField(pickFirstNonNullValue(raw, "stylePrompt", "style_prompt"))?.let { patch.put("stylePrompt", it) }
        normalizeAppearanceEvolutionPatch(pickFirstObject(raw, "appearance"))?.let { patch.put("appearance", it) }
        normalizeAdvancedEvolutionPatch(pickFirstObject(raw, "advanced"))?.let { patch.put("advanced", it) }
        return if (patch.length() > 0) patch else null
    }

    private fun applyPersonaEvolutionPatch(
        currentProfile: JSONObject,
        patch: JSONObject,
    ): JSONObject {
        val next = JSONObject(currentProfile.toString())
        patch.optString("personalityPrompt", "").trim().takeIf { it.isNotBlank() }?.let { next.put("personalityPrompt", it) }
        patch.optString("stylePrompt", "").trim().takeIf { it.isNotBlank() }?.let { next.put("stylePrompt", it) }
        patch.optJSONObject("appearance")?.takeIf { it.length() > 0 }?.let { appearancePatch ->
            val merged = mergeJsonObjects(next.optJSONObject("appearance") ?: JSONObject(), appearancePatch)
            next.put("appearance", merged)
        }
        patch.optJSONObject("advanced")?.takeIf { it.length() > 0 }?.let { advancedPatch ->
            val mergedAdvanced = mergeJsonObjects(next.optJSONObject("advanced") ?: JSONObject(), advancedPatch)
            next.put("advanced", mergedAdvanced)
        }
        return next
    }

    private fun selectAppliedPersonaEvolutionHistory(state: JSONObject): List<JSONObject> {
        val history = state.optJSONArray("history") ?: return emptyList()
        val undoneIds = mutableSetOf<String>()
        for (index in 0 until history.length()) {
            val event = history.optJSONObject(index) ?: continue
            if (event.optString("status", "").trim().lowercase() != "undone") continue
            val targetId = event.optString("targetEventId", "").trim()
            if (targetId.isNotBlank()) {
                undoneIds.add(targetId)
            }
        }
        val applied = mutableListOf<JSONObject>()
        for (index in 0 until history.length()) {
            val event = history.optJSONObject(index) ?: continue
            if (event.optString("status", "").trim().lowercase() != "applied") continue
            val eventId = event.optString("id", "").trim()
            if (eventId.isNotBlank() && undoneIds.contains(eventId)) continue
            applied.add(JSONObject(event.toString()))
        }
        return applied
    }

    private fun processPersonaControlEvolution(
        control: JSONObject?,
        config: ChatEvolutionConfig,
        state: JSONObject,
        timestamp: String,
    ): EvolutionProcessingResult {
        if (!config.enabled || control == null) {
            return EvolutionProcessingResult(state = JSONObject(state.toString()), appliedNow = false)
        }
        val evolution =
            parseOptionalJsonObject(control.opt("evolution"))
                ?: parseOptionalJsonObject(control.opt("persona_evolution"))
                ?: return EvolutionProcessingResult(state = JSONObject(state.toString()), appliedNow = false)
        val shouldEvolve =
            when {
                evolution.has("shouldEvolve") -> evolution.optBoolean("shouldEvolve", false)
                evolution.has("should_evolve") -> evolution.optBoolean("should_evolve", false)
                else -> false
            }
        if (!shouldEvolve) {
            return EvolutionProcessingResult(state = JSONObject(state.toString()), appliedNow = false)
        }
        val patch =
            normalizePersonaEvolutionPatch(
                parseOptionalJsonObject(
                    pickFirstNonNullValue(evolution, "patch", "delta", "profile_patch", "profilePatch"),
                ),
            ) ?: return EvolutionProcessingResult(state = JSONObject(state.toString()), appliedNow = false)
        val reason =
            resolveEvolutionReason(
                reasonRaw = pickFirstNonNullValue(evolution, "reason", "rationale", "why", "trigger"),
                patch = patch,
            )
        val nextState = JSONObject(state.toString())
        if (config.applyMode == "auto") {
            val nextProfile =
                applyPersonaEvolutionPatch(
                    currentProfile = nextState.optJSONObject("currentProfile") ?: JSONObject(),
                    patch = patch,
                )
            nextState.put("currentProfile", nextProfile)
            val history = nextState.optJSONArray("history") ?: JSONArray()
            history.put(
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("status", "applied")
                    put("timestamp", timestamp)
                    put("reason", reason)
                    put("patch", JSONObject(patch.toString()))
                },
            )
            nextState.put("history", history)
            nextState.put("updatedAt", timestamp)
            return EvolutionProcessingResult(state = nextState, appliedNow = true)
        }
        val pending = nextState.optJSONArray("pendingProposals") ?: JSONArray()
        pending.put(
            JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("createdAt", timestamp)
                put("reason", reason)
                put("patch", JSONObject(patch.toString()))
            },
        )
        nextState.put("pendingProposals", pending)
        nextState.put("updatedAt", timestamp)
        return EvolutionProcessingResult(state = nextState, appliedNow = false)
    }

    private fun createInitialPersonaState(persona: JSONObject, chatId: String): JSONObject {
        val personaId = persona.optString("id", "").trim()
        val advanced = persona.optJSONObject("advanced") ?: JSONObject()
        val emotion = advanced.optJSONObject("emotion") ?: JSONObject()
        val behavior = advanced.optJSONObject("behavior") ?: JSONObject()
        val baselineMood = emotion.optString("baselineMood", "neutral").trim().ifBlank { "neutral" }
        val warmth = emotion.optInt("warmth", 50)
        val initiative = behavior.optInt("initiative", 50)
        val curiosity = behavior.optInt("curiosity", 50)
        return JSONObject().apply {
            put("chatId", chatId)
            put("personaId", personaId)
            put("mood", baselineMood)
            put("trust", clampInt(32 + (warmth * 0.2).roundToInt(), 0, 100))
            put("energy", clampInt(50 + (initiative * 0.2).roundToInt(), 0, 100))
            put("engagement", clampInt(45 + (curiosity * 0.25).roundToInt(), 0, 100))
            put("lust", 0)
            put("fear", 5)
            put("affection", clampInt(24 + (warmth * 0.18).roundToInt(), 0, 100))
            put("tension", 10)
            put("relationshipType", "neutral")
            put("relationshipDepth", 12)
            put("relationshipStage", "new")
            put("updatedAt", nowIsoUtc())
        }
    }

    private fun evolveStateFallback(
        baseState: JSONObject,
        persona: JSONObject,
        userMessage: String,
        assistantMessage: String,
    ): JSONObject {
        val next = JSONObject(baseState.toString())
        val behavior = (persona.optJSONObject("advanced") ?: JSONObject()).optJSONObject("behavior") ?: JSONObject()
        val isHostile = Regex("(туп|идиот|ненавиж|бесишь|пош[её]л|дебил|агресс|оскорб|fuck|stupid|hate|idiot)", RegexOption.IGNORE_CASE).containsMatchIn(userMessage)
        val isSupportive = Regex("(спасибо|благодар|класс|отлично|хорошо|супер|great|thanks|awesome)", RegexOption.IGNORE_CASE).containsMatchIn(userMessage)
        val hasRomanticCue =
            Regex("(люблю|поцел|обним|нежн|роман|сексу|страст|хочу тебя|want you|kiss|hug|romantic)", RegexOption.IGNORE_CASE)
                .containsMatchIn(userMessage)
        val hasThreatCue =
            Regex("(угрож|боюсь|страш|panic|паник|убью|насили|threat|danger|опасно)", RegexOption.IGNORE_CASE)
                .containsMatchIn(userMessage)

        val empathy = behavior.optInt("empathy", 50)
        val initiative = behavior.optInt("initiative", 50)
        val curiosity = behavior.optInt("curiosity", 50)
        val trustModifier = (empathy - 55).toDouble() / 25.0
        val rawTrustDelta = (if (isSupportive) 2.0 else if (isHostile) -5.0 else 0.0) + trustModifier
        val trust = clampInt(baseState.optInt("trust", 30) + rawTrustDelta.roundToInt(), 0, 100)

        val engagementModifier = (initiative + curiosity - 110).toDouble() / 20.0
        val engagementDelta = (if (userMessage.length > 50) 2.0 else -1.0) + engagementModifier
        val engagement = clampInt(baseState.optInt("engagement", 45) + engagementDelta.roundToInt(), 0, 100)

        val energyDelta = -2.0 - (assistantMessage.length.toDouble() / 100.0)
        val energy = clampInt(baseState.optInt("energy", 50) + energyDelta.roundToInt(), 0, 100)

        val depthDelta =
            when {
                rawTrustDelta > 0 && engagementDelta > 0 -> 1
                rawTrustDelta < 0 -> -2
                else -> 0
            }
        val relationshipDepth = clampInt(baseState.optInt("relationshipDepth", 12) + depthDelta, 0, 100)

        val affectionDelta = (if (isSupportive) 2 else 0) + (if (isHostile) -3 else 0) + (if (hasRomanticCue) 2 else 0)
        val affection = clampInt(baseState.optInt("affection", 25) + affectionDelta, 0, 100)

        val lustDelta = (if (hasRomanticCue) 2 else 0) + (if (isHostile) -2 else 0)
        val lust = clampInt(baseState.optInt("lust", 0) + lustDelta, 0, 100)

        val fearDelta = (if (hasThreatCue) 4 else 0) + (if (isHostile) 2 else 0) + (if (isSupportive) -1 else 0)
        val fear = clampInt(baseState.optInt("fear", 0) + fearDelta, 0, 100)

        val tensionDelta = (if (isHostile) 3 else 0) + (if (hasThreatCue) 3 else 0) + (if (isSupportive) -2 else 0)
        val tension = clampInt(baseState.optInt("tension", 10) + tensionDelta, 0, 100)

        next.put("trust", trust)
        next.put("engagement", engagement)
        next.put("energy", energy)
        next.put("affection", affection)
        next.put("lust", lust)
        next.put("fear", fear)
        next.put("tension", tension)
        next.put("relationshipDepth", relationshipDepth)
        next.put("relationshipStage", relationshipStageFromDepth(relationshipDepth))
        next.put("updatedAt", nowIsoUtc())
        return next
    }

    private fun applyPersonaControl(
        control: JSONObject?,
        baseState: JSONObject,
        userMessage: String,
    ): AppliedControlResult {
        if (control == null) {
            return AppliedControlResult(
                state = JSONObject(baseState.toString()).apply { put("updatedAt", nowIsoUtc()) },
                memoryCandidates = emptyList(),
                memoryRemovals = emptyList(),
            )
        }
        val state = JSONObject(baseState.toString())
        val stateDelta = control.optJSONObject("state_delta") ?: JSONObject()
        val trustDelta = clampInt(stateDelta.optInt("trust", 0), -8, 6)
        val engagementDelta = clampInt(stateDelta.optInt("engagement", 0), -8, 8)
        val energyDelta = clampInt(stateDelta.optInt("energy", 0), -10, 10)
        val lustDelta = clampInt(stateDelta.optInt("lust", 0), -8, 8)
        val fearDelta = clampInt(stateDelta.optInt("fear", 0), -10, 10)
        val affectionDelta = clampInt(stateDelta.optInt("affection", 0), -8, 8)
        val tensionDelta = clampInt(stateDelta.optInt("tension", 0), -10, 10)
        val relationshipDepthDelta = clampInt(stateDelta.optInt("relationshipDepth", 0), -6, 6)

        state.put("trust", clampInt(baseState.optInt("trust", 30) + trustDelta, 0, 100))
        state.put("engagement", clampInt(baseState.optInt("engagement", 45) + engagementDelta, 0, 100))
        state.put("energy", clampInt(baseState.optInt("energy", 50) + energyDelta, 0, 100))
        state.put("lust", clampInt(baseState.optInt("lust", 0) + lustDelta, 0, 100))
        state.put("fear", clampInt(baseState.optInt("fear", 0) + fearDelta, 0, 100))
        state.put("affection", clampInt(baseState.optInt("affection", 25) + affectionDelta, 0, 100))
        state.put("tension", clampInt(baseState.optInt("tension", 10) + tensionDelta, 0, 100))
        val nextRelationshipDepth =
            clampInt(baseState.optInt("relationshipDepth", 12) + relationshipDepthDelta, 0, 100)
        state.put("relationshipDepth", nextRelationshipDepth)
        state.put("relationshipStage", relationshipStageFromDepth(nextRelationshipDepth))
        val mood = stateDelta.optString("mood", "").trim()
        if (mood.isNotBlank()) {
            state.put("mood", mood)
        }
        val intents = parseStringList(control.optJSONArray("intents"))
        if (intents.isNotEmpty()) {
            state.put("currentIntent", intents.first())
        }
        state.put("updatedAt", nowIsoUtc())

        val memoryCandidates = mutableListOf<ControlMemoryCandidate>()
        val memoryAdd = control.optJSONArray("memory_add") ?: JSONArray()
        for (index in 0 until memoryAdd.length()) {
            val row = memoryAdd.optJSONObject(index) ?: continue
            var content = row.optString("content", "").trim()
            if (content.isBlank()) continue
            content =
                content
                    .replace(Regex("^\\s*(пользователь|user|сообщение|message)\\s*:\\s*", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("\\s+"), " ")
                    .trim()
            if (content.isBlank()) continue
            val layerRaw = row.optString("layer", "").trim().lowercase()
            val kindRaw = row.optString("kind", "").trim().lowercase()
            val layer =
                when (layerRaw) {
                    "episodic" -> "episodic"
                    "long_term" -> "long_term"
                    else -> if (kindRaw == "event") "episodic" else "long_term"
                }
            if (layer == "short_term") continue
            val kind =
                when (kindRaw) {
                    "fact", "preference", "goal", "event" -> kindRaw
                    else -> if (layer == "episodic") "event" else "fact"
                }
            if (layer == "long_term" && looksLikeVerbatimUserMessage(content, userMessage)) {
                continue
            }
            val salience = row.optDouble("salience", 0.72).coerceIn(0.1, 1.0)
            memoryCandidates.add(
                ControlMemoryCandidate(
                    layer = layer,
                    kind = kind,
                    content = clipText(content, 420),
                    salience = salience,
                ),
            )
        }

        val removals = mutableListOf<ControlMemoryRemoval>()
        val memoryRemove = control.optJSONArray("memory_remove") ?: JSONArray()
        for (index in 0 until memoryRemove.length()) {
            val row = memoryRemove.optJSONObject(index) ?: continue
            val id = row.optString("id", "").trim().ifBlank { null }
            val layer = row.optString("layer", "").trim().lowercase().ifBlank { null }
            val kind = row.optString("kind", "").trim().lowercase().ifBlank { null }
            val content = row.optString("content", "").trim().ifBlank { null }
            if (id == null && layer == null && kind == null && content == null) continue
            removals.add(ControlMemoryRemoval(id = id, layer = layer, kind = kind, content = content))
        }

        return AppliedControlResult(
            state = state,
            memoryCandidates = memoryCandidates,
            memoryRemovals = removals,
        )
    }

    private fun relationshipStageFromDepth(depth: Int): String {
        return when {
            depth >= 85 -> "bonded"
            depth >= 65 -> "close"
            depth >= 45 -> "friendly"
            depth >= 25 -> "acquaintance"
            else -> "new"
        }
    }

    private fun extractRelationshipProposal(control: JSONObject?): RelationshipProposalIntent? {
        if (control == null) return null
        val intents = control.optJSONArray("intents") ?: return null
        var proposedType: String? = null
        var proposedStage: String? = null
        for (index in 0 until intents.length()) {
            val rawToken = intents.optString(index, "").trim().lowercase()
            if (rawToken.isBlank()) continue
            if (rawToken.startsWith("propose_relationship_type:")) {
                val candidate = rawToken.substringAfter("propose_relationship_type:").trim()
                if (isValidRelationshipType(candidate) && proposedType == null) {
                    proposedType = candidate
                }
                continue
            }
            if (rawToken.startsWith("propose_relationship_stage:")) {
                val candidate = rawToken.substringAfter("propose_relationship_stage:").trim()
                if (isValidRelationshipStage(candidate) && proposedStage == null) {
                    proposedStage = candidate
                }
            }
        }
        if (proposedType == null && proposedStage == null) return null
        return RelationshipProposalIntent(type = proposedType, stage = proposedStage)
    }

    private fun isValidRelationshipType(value: String): Boolean {
        return when (value) {
            "neutral", "friendship", "romantic", "mentor", "playful" -> true
            else -> false
        }
    }

    private fun isValidRelationshipStage(value: String): Boolean {
        return when (value) {
            "new", "acquaintance", "friendly", "close", "bonded" -> true
            else -> false
        }
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

    private fun parseImageDescriptionType(
        rawDescription: String,
        personaName: String,
    ): ParsedImageDescriptionType {
        val description = rawDescription.trim()
        val normalized = description.lowercase()
        val typeMatch = Regex("(?:^|\\n)\\s*type\\s*:\\s*([a-z_]+)\\b", RegexOption.IGNORE_CASE).find(description)
        val subjectModeMatch =
            Regex("(?:^|\\n)\\s*subject_mode\\s*:\\s*(persona_self|other_person|no_person|group)\\b", RegexOption.IGNORE_CASE)
                .find(description)
        val explicitType =
            normalizeImageDescriptionTypeToken(typeMatch?.groupValues?.getOrNull(1))
                ?: normalizeImageDescriptionTypeToken(subjectModeMatch?.groupValues?.getOrNull(1))
        val hasExplicitType = explicitType != null
        val participantsMatch = Regex("(?:^|\\n)\\s*participants\\s*:\\s*([^\\n\\r]+)", RegexOption.IGNORE_CASE).find(description)
        val participants = participantsMatch?.groupValues?.getOrNull(1)?.trim().orEmpty().ifBlank { "-" }
        val participantsNormalized = participants.lowercase()
        val personaNameNormalized = personaName.trim().lowercase()
        val inferredType =
            explicitType
                ?: when {
                    Regex("\\bno_person\\b|\\bno person\\b|\\blandscape\\b|\\bscenery\\b|\\binterior\\b").containsMatchIn(normalized) ||
                        Regex("пейзаж|ландшафт|интерьер|без людей|без человека").containsMatchIn(normalized) -> "no_person"
                    Regex("\\bgroup\\b|\\bmultiple people\\b|\\bcrowd\\b|\\bfamily\\b|\\bfriends\\b").containsMatchIn(normalized) ||
                        Regex("групп|компан|семь|друз|толпа|двое|трое|четверо").containsMatchIn(normalized) -> "group"
                    else -> "person"
                }
        val includesPersona =
            inferredType == "person" ||
                (
                    inferredType == "group" &&
                        (
                            normalized.contains("participants: persona") ||
                                normalized.contains("participants: персона") ||
                                (personaNameNormalized.isNotBlank() && normalized.contains(personaNameNormalized)) ||
                                participantsNormalized.contains("persona") ||
                                participantsNormalized.contains("персона") ||
                                (personaNameNormalized.isNotBlank() && participantsNormalized.contains(personaNameNormalized))
                        )
                )
        return ParsedImageDescriptionType(
            type = inferredType,
            participants = participants,
            includesPersona = includesPersona,
            hasExplicitType = hasExplicitType,
        )
    }

    private fun shouldAttachPersonaReference(parsed: ParsedImageDescriptionType): Boolean {
        return when (parsed.type) {
            "no_person" -> false
            "other_person" -> false
            "group" -> parsed.includesPersona
            else -> true
        }
    }

    private fun resolveChatStyleStrength(chat: JSONObject, settings: JSONObject): Double? {
        val fromChat =
            when (val raw = chat.opt("chatStyleStrength")) {
                null, JSONObject.NULL -> null
                is Number -> raw.toDouble()
                is String -> raw.trim().toDoubleOrNull()
                else -> null
            }
        if (fromChat != null && fromChat.isFinite()) return fromChat
        val fromSettings = settings.optDouble("chatStyleStrength", Double.NaN)
        return if (fromSettings.isFinite()) fromSettings else null
    }

    private fun isComfyImageDescriptionContractInvalidError(error: Throwable): Boolean {
        val message = error.message?.trim()?.lowercase().orEmpty()
        return message.startsWith("contract_invalid:")
    }

    private fun looksLikeVerbatimUserMessage(content: String, userMessage: String): Boolean {
        val normalizedContent = normalizeMemoryText(content)
        val normalizedUser = normalizeMemoryText(userMessage)
        if (normalizedContent.length < 36 || normalizedUser.length < 36) return false
        return normalizedUser.contains(normalizedContent) || normalizedContent.contains(normalizedUser)
    }

    private fun normalizeMemoryText(value: String): String {
        return value
            .lowercase()
            .replace(Regex("\\s+"), " ")
            .replace(Regex("[“”«»\"'`]"), "")
            .trim()
    }

    private fun readChatMemories(memoriesStore: JSONArray, chatId: String): List<JSONObject> {
        val rows = mutableListOf<JSONObject>()
        for (index in 0 until memoriesStore.length()) {
            val memory = memoriesStore.optJSONObject(index) ?: continue
            if (memory.optString("chatId", "").trim() == chatId) {
                rows.add(memory)
            }
        }
        return rows
    }

    private fun writeChatMemories(
        store: JSONArray,
        chatId: String,
        memoriesForChat: List<JSONObject>,
    ) {
        val filtered = JSONArray()
        for (index in 0 until store.length()) {
            val memory = store.optJSONObject(index) ?: continue
            if (memory.optString("chatId", "").trim() == chatId) continue
            filtered.put(memory)
        }
        memoriesForChat.forEach { memory -> filtered.put(memory) }
        while (store.length() > 0) {
            store.remove(0)
        }
        for (index in 0 until filtered.length()) {
            store.put(filtered.opt(index))
        }
    }

    private fun applyMemoryRemovals(
        current: List<JSONObject>,
        removals: List<ControlMemoryRemoval>,
    ): Pair<List<JSONObject>, List<String>> {
        if (removals.isEmpty()) return Pair(current, emptyList())
        val kept = mutableListOf<JSONObject>()
        val removedIds = mutableListOf<String>()
        current.forEach { memory ->
            val shouldRemove =
                removals.any { directive ->
                    val id = memory.optString("id", "").trim()
                    if (!directive.id.isNullOrBlank() && directive.id == id) {
                        return@any true
                    }
                    if (!directive.layer.isNullOrBlank() &&
                        directive.layer != memory.optString("layer", "").trim().lowercase()
                    ) {
                        return@any false
                    }
                    if (!directive.kind.isNullOrBlank() &&
                        directive.kind != memory.optString("kind", "").trim().lowercase()
                    ) {
                        return@any false
                    }
                    if (!directive.content.isNullOrBlank()) {
                        val expected = normalizeMemoryText(directive.content)
                        val actual = normalizeMemoryText(memory.optString("content", ""))
                        if (!actual.contains(expected) && !expected.contains(actual)) {
                            return@any false
                        }
                    }
                    !directive.layer.isNullOrBlank() ||
                        !directive.kind.isNullOrBlank() ||
                        !directive.content.isNullOrBlank()
                }
            if (shouldRemove) {
                val id = memory.optString("id", "").trim()
                if (id.isNotBlank()) {
                    removedIds.add(id)
                }
            } else {
                kept.add(memory)
            }
        }
        return Pair(kept, removedIds)
    }

    private fun derivePersistentMemoriesFromUserMessage(
        persona: JSONObject,
        text: String,
    ): List<ControlMemoryCandidate> {
        val result = mutableListOf<ControlMemoryCandidate>()
        val advanced = persona.optJSONObject("advanced") ?: JSONObject()
        val memoryPolicy = advanced.optJSONObject("memory") ?: JSONObject()
        val rememberFacts = memoryPolicy.optBoolean("rememberFacts", true)
        val rememberPreferences = memoryPolicy.optBoolean("rememberPreferences", true)
        val rememberGoals = memoryPolicy.optBoolean("rememberGoals", true)
        val rememberEvents = memoryPolicy.optBoolean("rememberEvents", true)

        if (rememberFacts) {
            extractFactCandidates(text).forEach { candidate ->
                result.add(
                    ControlMemoryCandidate(
                        layer = "long_term",
                        kind = "fact",
                        content = candidate.content,
                        salience = candidate.salience,
                    ),
                )
            }
        }
        if (rememberPreferences) {
            extractPreferenceCandidates(text).forEach { candidate ->
                result.add(
                    ControlMemoryCandidate(
                        layer = "long_term",
                        kind = "preference",
                        content = candidate.content,
                        salience = candidate.salience,
                    ),
                )
            }
        }
        if (rememberGoals) {
            extractGoalCandidates(text).forEach { candidate ->
                result.add(
                    ControlMemoryCandidate(
                        layer = "long_term",
                        kind = "goal",
                        content = candidate.content,
                        salience = candidate.salience,
                    ),
                )
            }
        }
        if (rememberEvents && text.trim().length >= 70) {
            result.add(
                ControlMemoryCandidate(
                    layer = "episodic",
                    kind = "event",
                    content = "Событие диалога: ${clipText(text.trim().replace(Regex("\\s+"), " "), 220)}",
                    salience = 0.55,
                ),
            )
        }
        return result
    }

    private fun cleanCapture(value: String): String {
        return value
            .trim()
            .replace(Regex("^[\\s\"'`«»]+|[\\s\"'`«»]+$"), "")
            .replace(Regex("[.;,:!?]+$"), "")
            .trim()
    }

    private fun addCandidateUnique(
        bucket: MutableList<MemoryTextCandidate>,
        content: String,
        salience: Double,
    ) {
        val cleaned = cleanCapture(content)
        if (cleaned.isBlank()) return
        val key = cleaned.lowercase().replace(Regex("\\s+"), " ")
        val existing = bucket.firstOrNull { candidate ->
            candidate.content.lowercase().replace(Regex("\\s+"), " ") == key
        }
        if (existing != null) {
            val index = bucket.indexOf(existing)
            bucket[index] = existing.copy(salience = max(existing.salience, salience))
            return
        }
        bucket.add(MemoryTextCandidate(content = cleaned, salience = salience))
    }

    private fun extractFactCandidates(text: String): List<MemoryTextCandidate> {
        val bucket = mutableListOf<MemoryTextCandidate>()
        val patterns =
            listOf(
                Triple(Regex("(?:меня зовут|мо[её] имя|можно звать)\\s+([a-zа-я0-9\\-_ ]{2,40})", RegexOption.IGNORE_CASE), "Имя пользователя: %s", 0.95),
                Triple(Regex("(?:мне|я)\\s*(\\d{1,2})\\s*лет\\b", RegexOption.IGNORE_CASE), "Возраст пользователя: %s", 0.88),
                Triple(Regex("\\b(?:живу в|я из|нахожусь в|переехал(?:а)? в)\\s+([^.!?\\n]{2,90})", RegexOption.IGNORE_CASE), "Локация пользователя: %s", 0.84),
                Triple(Regex("\\b(?:работаю(?: сейчас)?|я работаю)\\s+(?:как|в|на позиции)\\s+([^.!?\\n]{2,100})", RegexOption.IGNORE_CASE), "Работа пользователя: %s", 0.8),
                Triple(Regex("\\b(?:учусь(?: сейчас)?|изучаю|обучаюсь)\\s+([^.!?\\n]{2,100})", RegexOption.IGNORE_CASE), "Обучение пользователя: %s", 0.76),
                Triple(Regex("\\b(?:говорю на|языки?:)\\s+([^.!?\\n]{2,100})", RegexOption.IGNORE_CASE), "Языки пользователя: %s", 0.79),
                Triple(Regex("\\b(?:мой часовой пояс|часовой пояс|timezone|utc|gmt)\\s*[:\\-]?\\s*([a-zа-я0-9_\\/+:\\-]{2,40})", RegexOption.IGNORE_CASE), "Часовой пояс пользователя: %s", 0.74),
                Triple(Regex("\\b(?:у меня есть)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE), "Личный контекст: %s", 0.7),
                Triple(Regex("\\b(?:у меня аллергия на|мне нельзя|я не могу)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE), "Ограничение пользователя: %s", 0.86),
                Triple(Regex("\\b(?:использую|работаю с|обычно работаю в)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE), "Инструменты пользователя: %s", 0.72),
            )
        patterns.forEach { pattern ->
            val match = pattern.first.find(text) ?: return@forEach
            val capture = match.groupValues.getOrNull(1).orEmpty()
            if (capture.isBlank()) return@forEach
            addCandidateUnique(bucket, pattern.second.format(capture), pattern.third)
        }
        return bucket.take(6)
    }

    private fun extractPreferenceCandidates(text: String): List<MemoryTextCandidate> {
        val bucket = mutableListOf<MemoryTextCandidate>()
        val positivePatterns =
            listOf(
                Regex("(?:я люблю|мне нравится|предпочитаю|обожаю)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE),
                Regex("(?:мне комфортно|мне подходит)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE),
            )
        val negativePatterns =
            listOf(
                Regex("(?:не люблю|терпеть не могу|ненавижу)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE),
                Regex("(?:мне не нравится|мне не подходит)\\s+([^.!?\\n]{3,120})", RegexOption.IGNORE_CASE),
            )
        positivePatterns.forEach { regex ->
            val match = regex.find(text) ?: return@forEach
            val capture = match.groupValues.getOrNull(1).orEmpty()
            if (capture.isBlank()) return@forEach
            addCandidateUnique(bucket, "Предпочтение: $capture", 0.82)
        }
        negativePatterns.forEach { regex ->
            val match = regex.find(text) ?: return@forEach
            val capture = match.groupValues.getOrNull(1).orEmpty()
            if (capture.isBlank()) return@forEach
            addCandidateUnique(bucket, "Антипредпочтение: $capture", 0.8)
        }
        return bucket.take(4)
    }

    private fun extractGoalCandidates(text: String): List<MemoryTextCandidate> {
        val bucket = mutableListOf<MemoryTextCandidate>()
        val patterns =
            listOf(
                Regex("(?:моя цель|цель сейчас|ключевая цель)\\s+([^.!?\\n]{4,140})", RegexOption.IGNORE_CASE),
                Regex("(?:я хочу|хочу)\\s+([^.!?\\n]{4,140})", RegexOption.IGNORE_CASE),
                Regex("(?:планирую|собираюсь|намерен(?:а)?)\\s+([^.!?\\n]{4,140})", RegexOption.IGNORE_CASE),
                Regex("(?:мне нужно|моя задача)\\s+([^.!?\\n]{4,140})", RegexOption.IGNORE_CASE),
                Regex("(?:к \\d{1,2}[./-]\\d{1,2}(?:[./-]\\d{2,4})?\\s+хочу)\\s+([^.!?\\n]{4,120})", RegexOption.IGNORE_CASE),
            )
        patterns.forEach { regex ->
            val match = regex.find(text) ?: return@forEach
            val capture = match.groupValues.getOrNull(1).orEmpty()
            if (capture.isBlank()) return@forEach
            addCandidateUnique(bucket, "Цель пользователя: $capture", 0.9)
        }
        return bucket.take(4)
    }

    private fun reconcileMemories(
        existing: List<JSONObject>,
        candidates: List<ControlMemoryCandidate>,
        maxMemories: Int,
        decayDays: Int,
        chatId: String,
        personaId: String,
    ): Pair<List<JSONObject>, List<String>> {
        val nowIso = nowIsoUtc()
        val persistentExisting =
            existing
                .map { row -> normalizeMemoryObject(row, nowIso) }
                .filter { row -> row.optString("layer", "").trim() != "short_term" }
        val persistentCandidates =
            candidates.map { candidate ->
                JSONObject().apply {
                    put("id", UUID.randomUUID().toString())
                    put("chatId", chatId)
                    put("personaId", personaId)
                    put("layer", candidate.layer)
                    put("kind", candidate.kind)
                    put("content", candidate.content)
                    put("salience", candidate.salience.coerceIn(0.1, 1.0))
                    put("createdAt", nowIso)
                    put("updatedAt", nowIso)
                    put("lastReferencedAt", nowIso)
                }
            }.map { row -> normalizeMemoryObject(row, nowIso) }
        val merged = (persistentExisting + persistentCandidates).toMutableList()

        val episodicPool =
            dedupeAndSortLayer(
                merged.filter { row -> row.optString("layer", "").trim() == "episodic" },
                decayDays,
            )
        val longTermPool =
            dedupeAndSortLayer(
                merged.filter { row -> row.optString("layer", "").trim() == "long_term" },
                decayDays,
            )

        val safeMax = max(6, maxMemories)
        val longTermBudget = max(6, (safeMax * 0.9).roundToInt())
        val episodicBudget = max(1, safeMax - longTermBudget)
        val kept = longTermPool.take(longTermBudget) + episodicPool.take(episodicBudget)
        val keptIds = kept.mapNotNull { row -> row.optString("id", "").trim().ifBlank { null } }.toSet()
        val removedIds =
            merged
                .mapNotNull { row -> row.optString("id", "").trim().ifBlank { null } }
                .filterNot { id -> keptIds.contains(id) }
        return Pair(kept, removedIds)
    }

    private fun dedupeAndSortLayer(memories: List<JSONObject>, decayDays: Int): List<JSONObject> {
        val nowIso = nowIsoUtc()
        val nowMs = System.currentTimeMillis()
        val byCanonical = linkedMapOf<String, JSONObject>()
        memories.forEach { memory ->
            val normalized = normalizeMemoryObject(memory, nowIso)
            val key = canonicalMemoryKey(normalized)
            val existing = byCanonical[key]
            if (existing == null) {
                byCanonical[key] = normalized
            } else {
                existing.put("salience", max(existing.optDouble("salience", 0.5), normalized.optDouble("salience", 0.5)))
                val existingUpdated = parseIsoToMillisOrNull(existing.optString("updatedAt", "")).orZero()
                val incomingUpdated = parseIsoToMillisOrNull(normalized.optString("updatedAt", "")).orZero()
                if (incomingUpdated >= existingUpdated) {
                    existing.put("updatedAt", normalized.optString("updatedAt", nowIso))
                }
                existing.put("lastReferencedAt", nowIso)
            }
        }
        return byCanonical.values.sortedByDescending { memory ->
            rankByFreshness(memory, nowMs, decayDays)
        }
    }

    private fun rankByFreshness(memory: JSONObject, nowMs: Long, decayDays: Int): Double {
        val updatedAtMs = parseIsoToMillisOrNull(memory.optString("updatedAt", "")).orZero()
        val ageMs = max(0L, nowMs - updatedAtMs)
        val decayWindow = max(1, decayDays).toLong() * 24L * 60L * 60L * 1000L
        val freshness = max(0.15, 1.0 - ageMs.toDouble() / decayWindow.toDouble())
        return memory.optDouble("salience", 0.0) * 0.72 + freshness * 0.28
    }

    private fun parseIsoToMillisOrNull(raw: String): Long? {
        return try {
            Instant.parse(raw.trim()).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    private fun Long?.orZero(): Long = this ?: 0L

    private fun normalizeMemoryObject(memory: JSONObject, nowIso: String): JSONObject {
        val normalized = JSONObject(memory.toString())
        val layer = normalized.optString("layer", "").trim().ifBlank {
            if (normalized.optString("kind", "").trim() == "event") "episodic" else "long_term"
        }
        normalized.put("layer", layer)
        if (normalized.optString("updatedAt", "").trim().isBlank()) {
            normalized.put("updatedAt", nowIso)
        }
        if (normalized.optString("createdAt", "").trim().isBlank()) {
            normalized.put("createdAt", nowIso)
        }
        normalized.put(
            "salience",
            normalized.optDouble("salience", 0.6).coerceIn(0.1, 1.0),
        )
        return normalized
    }

    private fun canonicalMemoryKey(memory: JSONObject): String {
        val layer = memory.optString("layer", "").trim().lowercase()
        val kind = memory.optString("kind", "").trim().lowercase()
        val content = normalizeMemoryText(memory.optString("content", ""))
        return "$layer::$kind::$content"
    }

    private fun formatMessageContextTime(value: String): String {
        val raw = value.trim()
        return if (raw.isBlank()) "unknown" else raw
    }

    private fun buildMemoryCard(
        memories: List<JSONObject>,
        recentMessages: JSONArray,
        decayDays: Int,
    ): JSONObject {
        val shortTerm = JSONArray()
        for (index in 0 until recentMessages.length()) {
            val row = recentMessages.optJSONObject(index) ?: continue
            val role = row.optString("role", "").trim().lowercase()
            val content = row.optString("content", "").trim()
            if (content.isBlank()) continue
            val createdAt = formatMessageContextTime(row.optString("createdAt", ""))
            val label = if (role == "assistant") "Персона" else "Пользователь"
            shortTerm.put("$label [time=$createdAt]: ${clipText(content, 220)}")
        }
        val episodicRows = JSONArray()
        val longTermRows = JSONArray()
        val normalized = memories.map { row -> normalizeMemoryObject(row, nowIsoUtc()) }
        val episodic =
            dedupeAndSortLayer(
                normalized.filter { row -> row.optString("layer", "").trim() == "episodic" },
                decayDays,
            ).take(5)
        val longTerm =
            dedupeAndSortLayer(
                normalized.filter { row -> row.optString("layer", "").trim() == "long_term" },
                decayDays,
            ).take(6)
        episodic.forEach { row -> episodicRows.put(row) }
        longTerm.forEach { row -> longTermRows.put(row) }
        return JSONObject().apply {
            put("shortTerm", shortTerm)
            put("episodic", episodicRows)
            put("longTerm", longTermRows)
        }
    }

    private fun buildConversationSummaryContext(chat: JSONObject): JSONObject? {
        val summary = chat.optString("conversationSummary", "").trim()
        val facts = parseStringList(chat.optJSONArray("summaryFacts"))
        val goals = parseStringList(chat.optJSONArray("summaryGoals"))
        val openThreads = parseStringList(chat.optJSONArray("summaryOpenThreads"))
        val agreements = parseStringList(chat.optJSONArray("summaryAgreements"))
        if (
            summary.isBlank() &&
                facts.isEmpty() &&
                goals.isEmpty() &&
                openThreads.isEmpty() &&
                agreements.isEmpty()
        ) {
            return null
        }
        return JSONObject().apply {
            put("summary", summary)
            put("facts", JSONArray(facts))
            put("goals", JSONArray(goals))
            put("openThreads", JSONArray(openThreads))
            put("agreements", JSONArray(agreements))
        }
    }

    private fun resolveChatTitle(currentTitle: String, userText: String): String {
        if (!currentTitle.trim().equals("Новый чат", ignoreCase = true)) {
            return currentTitle
        }
        val first = userText.replace(Regex("\\s+"), " ").trim().take(48)
        return if (first.isNotBlank()) first else "Новый чат"
    }

    private fun appendImageAssets(
        repository: LocalRepository,
        imageUrls: List<String>,
        meta: JSONObject,
        createdAt: String,
    ): List<ImageAssetAppendResult> {
        if (imageUrls.isEmpty()) return emptyList()
        val imageAssets = readStoreArray(repository, "imageAssets")
        val existingByDataUrl = mutableMapOf<String, String>()
        for (index in 0 until imageAssets.length()) {
            val row = imageAssets.optJSONObject(index) ?: continue
            val id = row.optString("id", "").trim()
            val dataUrl = row.optString("dataUrl", "").trim()
            if (id.isNotBlank() && dataUrl.isNotBlank()) {
                existingByDataUrl[dataUrl] = id
            }
        }
        val appended = mutableListOf<ImageAssetAppendResult>()
        var changed = false
        imageUrls.forEach { rawUrl ->
            val dataUrl = rawUrl.trim()
            if (dataUrl.isBlank()) return@forEach
            val existingId = existingByDataUrl[dataUrl]
            if (!existingId.isNullOrBlank()) {
                appended.add(
                    ImageAssetAppendResult(
                        id = existingId,
                        ref = TopicGenerationNativeExecutor.toImageRef(existingId),
                        dataUrl = dataUrl,
                        meta = JSONObject(meta.toString()),
                        createdAt = createdAt,
                    ),
                )
                return@forEach
            }
            val assetId = UUID.randomUUID().toString()
            imageAssets.put(
                JSONObject().apply {
                    put("id", assetId)
                    put("dataUrl", dataUrl)
                    put("meta", JSONObject(meta.toString()))
                    put("createdAt", createdAt)
                },
            )
            existingByDataUrl[dataUrl] = assetId
            appended.add(
                ImageAssetAppendResult(
                    id = assetId,
                    ref = TopicGenerationNativeExecutor.toImageRef(assetId),
                    dataUrl = dataUrl,
                    meta = JSONObject(meta.toString()),
                    createdAt = createdAt,
                ),
            )
            changed = true
        }
        if (changed) {
            repository.writeStoreJson("imageAssets", imageAssets.toString())
        }
        return appended
    }

    private fun upsertByChatId(items: JSONArray, next: JSONObject, key: String) {
        val id = next.optString(key, "").trim()
        if (id.isBlank()) return
        for (index in 0 until items.length()) {
            val row = items.optJSONObject(index) ?: continue
            if (row.optString(key, "").trim() == id) {
                items.put(index, next)
                return
            }
        }
        items.put(next)
    }

    private fun clampInt(value: Int, minValue: Int, maxValue: Int): Int {
        return value.coerceIn(minValue, maxValue)
    }

    private fun clipText(value: String, maxLen: Int): String {
        val normalized = value.trim()
        if (normalized.length <= maxLen) return normalized
        return "${normalized.take(maxLen - 1).trimEnd()}…"
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
            taskType = ONE_TO_ONE_CHAT_JOB_TYPE,
            scopeId = normalizedScopeId,
            kind = "state_patch",
            entityType = "stores",
            entityId = jobId?.trim()?.ifEmpty { null },
            payloadJson =
                JSONObject().apply {
                    put("stores", stores)
                    if (normalizedAssetIds.isNotEmpty()) {
                        put("assetIds", JSONArray(normalizedAssetIds))
                    }
                }.toString(),
        )
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
            taskType = ONE_TO_ONE_CHAT_JOB_TYPE,
            scopeId = normalizedScopeId,
            jobId = jobId,
            stage = stage,
            level = level,
            message = message,
            detailsJson = details?.toString(),
        )
        runtime.appendDelta(
            taskType = ONE_TO_ONE_CHAT_JOB_TYPE,
            scopeId = normalizedScopeId,
            kind = "worker_action",
            entityType = stage,
            entityId = jobId?.trim()?.ifEmpty { null },
            payloadJson =
                JSONObject().apply {
                    put("level", level)
                    put("message", message)
                    if (!jobId.isNullOrBlank()) {
                        put("jobId", jobId)
                    }
                    if (details != null) {
                        put("details", details)
                    }
                }.toString(),
        )
    }
}
