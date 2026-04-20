import type {
  AppSettings,
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  Persona,
} from "./types";
import type { PersonaControlPayload } from "./personaDynamics";
import {
  emitLlmToolingTelemetry,
  requestGenericToolRuntime,
} from "./lmstudio";
import {
  buildGroupOrchestratorSystemPrompt,
  buildGroupOrchestratorUserInput,
  buildGroupPersonaSystemPrompt,
  buildGroupPersonaUserInput,
} from "./groupPrompts";
import {
  createGroupOrchestratorToolConfig,
  createGroupPersonaTurnToolConfig,
} from "./tooling/registry";

export interface GroupOrchestratorTickInput {
  room: GroupRoom;
  participants: GroupParticipant[];
  messages: GroupMessage[];
  events: GroupEvent[];
  relationEdges: GroupRelationEdge[];
  personas: Persona[];
  settings: AppSettings;
  userName: string;
}

export type GroupOrchestratorTickStatus = "spoke" | "waiting" | "skipped";

export interface GroupOrchestratorTickDecision {
  status: GroupOrchestratorTickStatus;
  reason: string;
  speakerPersonaId?: string;
  messageText?: string;
  waitForUser: boolean;
  waitReason?: string;
  userContextAction?: "keep" | "clear";
  debug: Record<string, unknown>;
}

export interface PersonaSpeechValidationResult {
  valid: boolean;
  reason?: string;
}

export interface GroupPersonaSpeechDraft {
  visibleText: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  personaControl?: PersonaControlPayload;
  responseId?: string;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function clip(value: string, max = 220) {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function collectMessageVisualDescriptions(message: GroupMessage) {
  const candidates = [
    ...(message.comfyImageDescriptions ?? []),
    ...(message.comfyImageDescription ? [message.comfyImageDescription] : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.length === 0) return [];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of candidates) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function buildPromptMessageContent(message: GroupMessage, contentMaxLen: number) {
  const baseContent = clip(message.content || "", contentMaxLen);
  const visualDescriptions = collectMessageVisualDescriptions(message)
    .slice(0, 2)
    .map((value) => clip(value, 170));
  const attachmentCount = message.imageAttachments?.length ?? 0;
  const contextParts: string[] = [];
  if (visualDescriptions.length > 0) {
    contextParts.push(`visual_context: ${visualDescriptions.join(" | ")}`);
  }
  if (attachmentCount > 0) {
    contextParts.push(`images_attached: ${attachmentCount}`);
  }
  if (contextParts.length === 0) {
    return baseContent;
  }
  const combined =
    baseContent.length > 0
      ? `${baseContent} [${contextParts.join("; ")}]`
      : `[${contextParts.join("; ")}]`;
  return clip(combined, contentMaxLen + 260);
}

function sanitizePersonaVisibleText(raw: string) {
  return raw
    .replace(/!\[[^\]]*]\([^)]+\)/gi, "")
    .replace(/https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getLastUserMessage(messages: GroupMessage[], roomId: string) {
  return [...messages]
    .reverse()
    .find(
      (message) => message.roomId === roomId && message.authorType === "user",
    );
}

function getFocusedUserMessage(messages: GroupMessage[], room: GroupRoom) {
  const markerRaw = room.orchestratorUserFocusMessageId;
  if (typeof markerRaw === "string") {
    const marker = markerRaw.trim();
    if (!marker) return undefined;
    const focused = messages.find(
      (message) =>
        message.roomId === room.id &&
        message.authorType === "user" &&
        message.id === marker,
    );
    if (focused) return focused;
  }
  return getLastUserMessage(messages, room.id);
}

function getLastSpeakerPersonaId(events: GroupEvent[]) {
  const lastSpeakerEvent = [...events]
    .reverse()
    .find((event) => event.type === "speaker_selected");
  const personaId = lastSpeakerEvent?.payload?.personaId;
  return typeof personaId === "string" ? personaId : "";
}

function getMentionDrivenPersonaId(
  lastUserMessage: GroupMessage | undefined,
  participants: GroupParticipant[],
) {
  if (!lastUserMessage?.mentions?.length) return "";
  const allowed = new Set(participants.map((item) => item.personaId));
  const mention = lastUserMessage.mentions.find(
    (item) => item.targetType === "persona" && allowed.has(item.targetId),
  );
  return mention?.targetId ?? "";
}

function buildRecentSpeakerIds(
  events: GroupEvent[],
  roomId: string,
  limit = 24,
) {
  return [...events]
    .filter(
      (event) => event.roomId === roomId && event.type === "speaker_selected",
    )
    .map((event) => {
      const personaId = event.payload?.personaId;
      return typeof personaId === "string" ? personaId : "";
    })
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

function getLastRoomMessage(messages: GroupMessage[], roomId: string) {
  return [...messages]
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function getLatestPendingImageMessage(messages: GroupMessage[], roomId: string) {
  return [...messages]
    .filter((message) => message.roomId === roomId && message.imageGenerationPending)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function estimatePersonaTypingDelayMs(message: GroupMessage) {
  const textLength = message.content.trim().length;
  const boundedLength = Math.max(18, Math.min(420, textLength));
  const byLength = boundedLength * 32;
  return Math.max(6500, Math.min(22000, byLength));
}

function buildPersonaMessageText(
  room: GroupRoom,
  speaker: Persona,
  lastUserMessage: GroupMessage | undefined,
  userName: string,
) {
  const firstPersonaIntent =
    speaker.personalityPrompt.split(/[.!?]/)[0]?.trim() ||
    "сохранить ход разговора";
  const baseTopic = lastUserMessage?.content?.trim()
    ? `Реагирую на последний вброс: "${lastUserMessage.content.trim().slice(0, 110)}".`
    : "Поддерживаю развитие обсуждения в группе.";

  if (room.mode === "personas_plus_user") {
    return `${baseTopic} @${userName}, что думаешь об этом с позиции ${speaker.advanced.core.archetype || "моего подхода"}?`;
  }

  return `${baseTopic} Как ${speaker.name}, сейчас считаю важным ${firstPersonaIntent}.`;
}

export function buildFallbackPersonaMessageText(params: {
  room: GroupRoom;
  speaker: Persona;
  messages: GroupMessage[];
  userName: string;
}) {
  const lastUserMessage = getFocusedUserMessage(params.messages, params.room);
  return buildPersonaMessageText(
    params.room,
    params.speaker,
    lastUserMessage,
    params.userName,
  );
}

function buildParticipantNameMap(
  participants: GroupParticipant[],
  personas: Persona[],
) {
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  return participants
    .map((participant) => {
      const persona = personaById.get(participant.personaId);
      if (!persona) return null;
      return {
        personaId: participant.personaId,
        name: persona.name,
      };
    })
    .filter((item): item is { personaId: string; name: string } =>
      Boolean(item),
    );
}

function summarizePersonaAppearance(persona: Persona) {
  const parts = [
    persona.appearance.hair,
    persona.appearance.eyes,
    persona.appearance.bodyType,
    persona.appearance.clothingStyle,
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return clip(parts.join(", "), 120);
}

function buildOrchestratorParticipantProfiles(
  participants: GroupParticipant[],
  personas: Persona[],
) {
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  return participants
    .map((participant) => {
      const persona = personaById.get(participant.personaId);
      if (!persona) return null;
      return {
        personaId: participant.personaId,
        name: persona.name,
        archetype: clip(persona.advanced.core.archetype || "", 60),
        character: clip(persona.personalityPrompt || "", 120),
        voiceTone: clip(persona.advanced.voice.tone || "", 40),
        lexicalStyle: clip(persona.advanced.voice.lexicalStyle || "", 48),
        sentenceLength: persona.advanced.voice.sentenceLength,
        formality: persona.advanced.voice.formality,
        expressiveness: persona.advanced.voice.expressiveness,
        emoji: persona.advanced.voice.emoji,
        initiative: persona.advanced.behavior.initiative,
        curiosity: persona.advanced.behavior.curiosity,
        empathy: persona.advanced.behavior.empathy,
        appearance: summarizePersonaAppearance(persona),
      };
    })
    .filter(
      (
        item,
      ): item is {
        personaId: string;
        name: string;
        archetype: string;
        character: string;
        voiceTone: string;
        lexicalStyle: string;
        sentenceLength: "short" | "balanced" | "long";
        formality: number;
        expressiveness: number;
        emoji: number;
        initiative: number;
        curiosity: number;
        empathy: number;
        appearance: string;
      } => Boolean(item),
    );
}

function normalizeLlmStatus(
  value: string | undefined,
): GroupOrchestratorTickStatus | "" {
  const token = normalizeToken(value || "");
  if (token === "speak") return "spoke";
  if (token === "wait") return "waiting";
  if (token === "skip") return "skipped";
  return "";
}

function normalizeLlmUserContextAction(
  value: string | undefined,
): "keep" | "clear" | "" {
  const token = normalizeToken(value || "");
  if (token === "keep") return "keep";
  if (token === "clear") return "clear";
  return "";
}

export function validatePersonaSpeaksOnlyForSelf(
  speaker: Persona,
  messageText: string,
  personas: Persona[],
): PersonaSpeechValidationResult {
  const text = messageText.trim();
  if (!text) {
    return { valid: false, reason: "empty_message" };
  }

  const otherPersonaNames = personas
    .map((persona) => persona.name.trim())
    .filter(
      (name) =>
        name.length > 0 &&
        normalizeToken(name) !== normalizeToken(speaker.name),
    );

  for (const name of otherPersonaNames) {
    const namePattern = escapeRegExp(name);
    const speakerPrefixRx = new RegExp(
      `(^|\\n)\\s*@?${namePattern}\\s*[:\\-—]\\s*`,
      "i",
    );
    if (speakerPrefixRx.test(text)) {
      return {
        valid: false,
        reason: `multi_speaker_pattern_detected:${name}`,
      };
    }
  }

  return { valid: true };
}

export async function requestLlmOrchestratorDecision(
  input: GroupOrchestratorTickInput,
) {
  const participantNames = buildParticipantNameMap(
    input.participants,
    input.personas,
  );
  const participantProfiles = buildOrchestratorParticipantProfiles(
    input.participants,
    input.personas,
  );
  const participantNameById = Object.fromEntries(
    participantNames.map((item) => [item.personaId, item.name]),
  );
  if (participantProfiles.length === 0) return null;

  const allowedPersonaIds = new Set(
    participantProfiles.map((item) => item.personaId),
  );
  const lastUserMessage = getFocusedUserMessage(input.messages, input.room);
  const mentionPriorityHints =
    lastUserMessage?.mentions
      ?.map((mention) => {
        if (mention.targetType === "persona") {
          const name = participantNameById[mention.targetId];
          if (!name) return "";
          return `persona:${name} (${mention.targetId})`;
        }
        if (mention.targetType === "user") {
          return `user:${input.userName}`;
        }
        return "";
      })
      .filter(Boolean) ?? [];
  const recentMessages = input.messages
    .filter((message) => message.roomId === input.room.id)
    .slice(-8)
    .map((message) => ({
      author: message.authorDisplayName,
      authorType: message.authorType,
      content: buildPromptMessageContent(message, 220),
      createdAt: message.createdAt,
    }));
  const recentEvents = input.events
    .filter((event) => event.roomId === input.room.id)
    .slice(-8)
    .map((event) => ({
      type: event.type,
      payload: event.payload,
    }));
  const now = Date.now();
  const participantRuntimeHints = input.participants
    .filter((participant) =>
      participantProfiles.some(
        (profile) => profile.personaId === participant.personaId,
      ),
    )
    .map((participant) => {
      const profile = participantProfiles.find(
        (item) => item.personaId === participant.personaId,
      );
      const cooldownMs = participant.muteUntil
        ? Math.max(0, new Date(participant.muteUntil).getTime() - now)
        : 0;
      return `${profile?.name || participant.personaId} (${participant.personaId}): initiativeBias=${participant.initiativeBias}, aliveScore=${participant.aliveScore}, cooldownMs=${cooldownMs}`;
    });

  const systemPrompt = buildGroupOrchestratorSystemPrompt({
    room: input.room,
    userName: input.userName,
    participants: participantProfiles,
  });
  const userInput = buildGroupOrchestratorUserInput({
    userMessage: lastUserMessage?.content || "",
    mentionPriorityHints,
    participantRuntimeHints,
    recentMessages,
    recentEvents,
  });

  const groupOrchestratorToolConfig = createGroupOrchestratorToolConfig();
  const runtime = await requestGenericToolRuntime(input.settings, {
    task: "group_orchestrator",
    request: {
      model: input.settings.groupOrchestratorModel || input.settings.model,
      input: userInput,
      systemPrompt,
      maxOutputTokens: Math.max(120, Math.min(320, input.settings.maxTokens)),
      temperature: Math.max(0.15, Math.min(0.7, input.settings.temperature)),
      store: false,
    },
    ...groupOrchestratorToolConfig,
  });

  const parsed = runtime.value;

  const status = normalizeLlmStatus(parsed.status);
  if (!status) return null;
  const userContextAction = normalizeLlmUserContextAction(
    parsed.userContextAction,
  );

  const speakerPersonaId = (parsed.speakerPersonaId || "").trim();
  if (status === "spoke" && !allowedPersonaIds.has(speakerPersonaId)) {
    return null;
  }

  return {
    status,
    speakerPersonaId: status === "spoke" ? speakerPersonaId : undefined,
    waitForUser:
      typeof parsed.waitForUser === "boolean"
        ? parsed.waitForUser
        : status === "waiting",
    waitReason: (parsed.waitReason || "").trim() || undefined,
    reason: (parsed.reason || "").trim() || "llm_orchestrator_decision",
    intent: (parsed.intent || "").trim() || undefined,
    userContextAction: userContextAction || undefined,
  };
}

export async function requestLlmPersonaMessage(params: {
  room: GroupRoom;
  speaker: Persona;
  userName: string;
  participantNames: string[];
  messages: GroupMessage[];
  personaState: GroupPersonaState | null;
  relationEdges: GroupRelationEdge[];
  participantNameById: Record<string, string>;
  sharedMemories: GroupMemoryShared[];
  privateMemories: GroupMemoryPrivate[];
  recentEvents: GroupEvent[];
  settings: AppSettings;
  previousResponseId?: string;
}) {
  const lastUserMessage = getFocusedUserMessage(params.messages, params.room);
  const mentionContext = {
    addressedToCurrentPersona:
      lastUserMessage?.mentions?.some(
        (mention) =>
          mention.targetType === "persona" &&
          mention.targetId === params.speaker.id,
      ) ?? false,
    mentionedPersonaNames:
      lastUserMessage?.mentions
        ?.filter((mention) => mention.targetType === "persona")
        .map((mention) => mention.label || mention.targetId)
        .filter(Boolean) ?? [],
    rawLabels:
      lastUserMessage?.mentions?.map((mention) => `@${mention.label}`) ?? [],
  };
  const recentMessages = params.messages
    .filter((message) => message.roomId === params.room.id)
    .slice(params.previousResponseId ? -5 : -8)
    .map((message) => ({
      author: message.authorDisplayName,
      authorType: message.authorType,
      content: buildPromptMessageContent(
        message,
        params.previousResponseId ? 220 : 280,
      ),
      createdAt: message.createdAt,
    }));

  const systemPrompt = buildGroupPersonaSystemPrompt({
    room: params.room,
    persona: params.speaker,
    personaState: params.personaState,
    userName: params.userName,
    participantNames: params.participantNames,
  });
  const userInput = buildGroupPersonaUserInput({
    userName: params.userName,
    lastUserMessage: lastUserMessage?.content || "",
    recentMessages,
    personaState: params.personaState,
    relationEdges: params.relationEdges,
    participantNameById: params.participantNameById,
    sharedMemories: params.sharedMemories,
    privateMemories: params.privateMemories,
    recentEvents: params.recentEvents,
    mentionContext,
  });

  const groupPersonaTurnToolConfig = createGroupPersonaTurnToolConfig();
  const runtime = await requestGenericToolRuntime(params.settings, {
    task: "group_persona",
    request: {
      model: params.settings.groupPersonaModel || params.settings.model,
      input: userInput,
      systemPrompt,
      maxOutputTokens: Math.max(120, Math.min(500, params.settings.maxTokens)),
      temperature: Math.max(0.25, Math.min(0.9, params.settings.temperature)),
      store: true,
      previousResponseId: params.previousResponseId,
    },
    ...groupPersonaTurnToolConfig,
  });

  const isLegacyOnly = runtime.mode === "legacy_only";
  const prefix = `${params.speaker.name}:`;
  let visibleText = sanitizePersonaVisibleText(
    (runtime.value.visibleText || "").trim(),
  );
  if (visibleText.toLowerCase().startsWith(prefix.toLowerCase())) {
    visibleText = visibleText.slice(prefix.length).trim();
  }
  visibleText = sanitizePersonaVisibleText(visibleText);
  if (!visibleText && isLegacyOnly) {
    emitLlmToolingTelemetry({
      event: "llm_legacy_fallback_used",
      task: "group_persona",
      mode: runtime.mode,
      reason: "empty_visible_text_after_sanitization_replaced_with_fallback_text",
      source: "requestLlmPersonaMessage",
    });
    visibleText = buildPersonaMessageText(
      params.room,
      params.speaker,
      lastUserMessage,
      params.userName,
    );
  }

  return {
    visibleText,
    comfyPrompt: runtime.value.comfyPrompt,
    comfyPrompts: runtime.value.comfyPrompts,
    comfyImageDescription: runtime.value.comfyImageDescription,
    comfyImageDescriptions: runtime.value.comfyImageDescriptions,
    personaControl: runtime.value.personaControl,
    responseId: runtime.responseId,
  };
}

export function runGroupOrchestratorTick({
  room,
  participants,
  messages,
  events,
  relationEdges,
  personas,
  settings,
  userName,
}: GroupOrchestratorTickInput): GroupOrchestratorTickDecision {
  if (room.status !== "active") {
    return {
      status: "skipped",
      reason: "room_not_active",
      waitForUser: room.waitingForUser,
      waitReason: room.waitingReason,
      debug: {
        roomStatus: room.status,
      },
    };
  }

  if (room.mode === "personas_plus_user" && room.waitingForUser) {
    return {
      status: "waiting",
      reason: "waiting_for_user",
      waitForUser: true,
      waitReason:
        room.waitingReason ||
        `Ожидается ответ пользователя (${userName.trim() || "Пользователь"})`,
      debug: {
        waitingForUser: room.waitingForUser,
      },
    };
  }

  const now = Date.now();
  const pendingImageMessage = getLatestPendingImageMessage(messages, room.id);
  if (pendingImageMessage) {
    return {
      status: "skipped",
      reason: "pending_image_generation",
      waitForUser: false,
      debug: {
        pendingMessageId: pendingImageMessage.id,
        pendingAuthorType: pendingImageMessage.authorType,
        pendingExpected: pendingImageMessage.imageGenerationExpected,
        pendingCompleted: pendingImageMessage.imageGenerationCompleted,
      },
    };
  }

  const lastRoomMessage = getLastRoomMessage(messages, room.id);
  if (lastRoomMessage) {
    const elapsedMs = now - new Date(lastRoomMessage.createdAt).getTime();
    const requiredDelayMs =
      lastRoomMessage.authorType === "persona"
        ? estimatePersonaTypingDelayMs(lastRoomMessage)
        : 2000;
    if (elapsedMs < requiredDelayMs) {
      return {
        status: "skipped",
        reason: "typing_delay",
        waitForUser: false,
        debug: {
          lastAuthorType: lastRoomMessage.authorType,
          elapsedMs,
          requiredDelayMs,
        },
      };
    }
  }

  const activeParticipants = participants
    .filter((item) => item.roomId === room.id)
    .filter((item) => {
      if (!item.muteUntil) return true;
      return new Date(item.muteUntil).getTime() <= now;
    })
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));

  if (activeParticipants.length === 0) {
    return {
      status: "skipped",
      reason: "no_active_participants",
      waitForUser: false,
      debug: {
        participantCount: participants.length,
      },
    };
  }

  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const lastUserMessage = getLastUserMessage(messages, room.id);
  const focusedUserMessage = getFocusedUserMessage(messages, room);
  const mentionDrivenPersonaId =
    lastUserMessage && lastRoomMessage?.id === lastUserMessage.id
      ? getMentionDrivenPersonaId(lastUserMessage, activeParticipants)
      : "";
  const lastSpeakerPersonaId = getLastSpeakerPersonaId(events);
  const recentSpeakers = buildRecentSpeakerIds(events, room.id, 24);
  const recentWindowSize = Math.max(
    8,
    Math.min(24, activeParticipants.length * 4),
  );
  const recentWindow = recentSpeakers.slice(0, recentWindowSize);
  const frequencyByPersonaId = new Map<string, number>();
  for (const personaId of recentWindow) {
    frequencyByPersonaId.set(
      personaId,
      (frequencyByPersonaId.get(personaId) || 0) + 1,
    );
  }
  const allSpeakerCounts = new Map<string, number>();
  for (const event of events) {
    if (event.roomId !== room.id || event.type !== "speaker_selected") continue;
    const personaId = event.payload?.personaId;
    if (typeof personaId !== "string" || !personaId) continue;
    allSpeakerCounts.set(personaId, (allSpeakerCounts.get(personaId) || 0) + 1);
  }
  const minAllSpeakerCount =
    activeParticipants.length > 0
      ? Math.min(
          ...activeParticipants.map(
            (participant) =>
              allSpeakerCounts.get(participant.personaId) || 0,
          ),
        )
      : 0;
  const relationByTargetId = new Map<string, GroupRelationEdge>();
  if (lastSpeakerPersonaId) {
    for (const edge of relationEdges) {
      if (
        edge.roomId === room.id &&
        edge.fromPersonaId === lastSpeakerPersonaId
      ) {
        relationByTargetId.set(edge.toPersonaId, edge);
      }
    }
  }

  const scoredParticipants = activeParticipants.map((participant) => {
    const recentFrequency = frequencyByPersonaId.get(participant.personaId) || 0;
    const allTimeFrequency = allSpeakerCounts.get(participant.personaId) || 0;
    const recentIndex = recentWindow.indexOf(participant.personaId);
    const mentionBoost =
      participant.personaId === mentionDrivenPersonaId ? 40 : 0;
    const repeatPenalty =
      participant.personaId === lastSpeakerPersonaId ? 46 : 0;
    const recentDominancePenalty =
      recentFrequency * 12 +
      (recentFrequency >= Math.ceil(recentWindowSize * 0.45) ? 18 : 0);
    const historicalGap = Math.max(0, minAllSpeakerCount + 1 - allTimeFrequency);
    const fairnessBoost = historicalGap * 14;
    const neverSpokeBoost =
      allTimeFrequency === 0 && mentionBoost === 0 ? 10 : 0;
    const relationEdge = relationByTargetId.get(participant.personaId);
    const relationBias = relationEdge
      ? Math.round(
          (relationEdge.affinity - 50) * 0.2 +
            (relationEdge.trust - 50) * 0.15 +
            (relationEdge.respect - 50) * 0.1 -
            (relationEdge.tension - 20) * 0.2,
        )
      : 0;
    const dormancyBoost =
      recentIndex < 0
        ? 16
        : recentIndex >= 7
          ? 10
          : recentIndex >= 4
            ? 5
            : 0;
    const score = Math.round(
      participant.initiativeBias * 0.25 +
        participant.aliveScore * 0.2 +
        22 +
        mentionBoost +
        fairnessBoost +
        neverSpokeBoost +
        relationBias +
        dormancyBoost -
        recentDominancePenalty -
        repeatPenalty,
    );
    return {
      participant,
      score,
      explain: {
        initiativeBias: participant.initiativeBias,
        aliveScore: participant.aliveScore,
        recentFrequency,
        allTimeFrequency,
        recentIndex,
        mentionBoost,
        fairnessBoost,
        neverSpokeBoost,
        relationBias,
        dormancyBoost,
        recentDominancePenalty,
        repeatPenalty,
      },
    };
  });

  scoredParticipants.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.participant.aliveScore !== a.participant.aliveScore) {
      return b.participant.aliveScore - a.participant.aliveScore;
    }
    return a.participant.joinedAt.localeCompare(b.participant.joinedAt);
  });

  let selectedParticipant = scoredParticipants[0]?.participant;
  let selectedBy: "mention" | "score" | "anti_repeat" =
    selectedParticipant?.personaId === mentionDrivenPersonaId &&
    mentionDrivenPersonaId
      ? "mention"
      : "score";
  if (
    room.mode === "personas_only" &&
    activeParticipants.length > 1 &&
    selectedParticipant?.personaId === lastSpeakerPersonaId
  ) {
    const alternate = scoredParticipants.find(
      (item) => item.participant.personaId !== lastSpeakerPersonaId,
    )?.participant;
    if (alternate) {
      selectedParticipant = alternate;
      selectedBy = "anti_repeat";
    }
  }
  if (!selectedParticipant) {
    return {
      status: "skipped",
      reason: "speaker_not_found",
      waitForUser: false,
      debug: {
        participantCount: activeParticipants.length,
      },
    };
  }

  const speaker = personaById.get(selectedParticipant.personaId);
  if (!speaker) {
    return {
      status: "skipped",
      reason: "speaker_not_found",
      waitForUser: false,
      debug: {
        selectedPersonaId: selectedParticipant.personaId,
      },
    };
  }

  const messageText = buildPersonaMessageText(
    room,
    speaker,
    focusedUserMessage,
    userName,
  );

  return {
    status: "spoke",
    reason: "speaker_selected",
    speakerPersonaId: speaker.id,
    messageText,
    waitForUser: room.mode === "personas_plus_user",
    waitReason:
      room.mode === "personas_plus_user"
        ? `Ожидаем ответ пользователя (${userName.trim() || "Пользователь"}) после реплики ${speaker.name}`
        : undefined,
    debug: {
      selectedBy,
      mentionDrivenPersonaId,
      lastSpeakerPersonaId,
      scoreBoard: scoredParticipants.slice(0, 5).map((item) => ({
        personaId: item.participant.personaId,
        score: item.score,
        explain: item.explain,
      })),
      model: settings.model,
      participantCount: activeParticipants.length,
    },
  };
}
