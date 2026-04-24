import { create } from "zustand";
import { DEFAULT_SETTINGS, dbApi } from "./db";
import { getRuntimeContext } from "./platform/runtimeContext";
import {
  generateComfyPromptFromImageDescription,
  generateComfyPromptsFromImageDescription,
  requestChatCompletion,
  requestConversationSummaryUpdate,
  requestOneToOneDiaryEntry,
} from "./lmstudio";
import {
  compactAppearanceLocksFromAppearance,
  isComfyImageDescriptionContractInvalidError,
  type ComfyPromptParticipantCatalogEntry,
} from "./comfyImageDescriptionContract";
import { generateComfyImages, readComfyImageGenerationMeta } from "./comfy";
import { localizeImageUrls } from "./imageStorage";
import {
  applyPersonaControlProposal,
  buildLayeredMemoryContextCard,
  buildRecentMessages,
  createInitialPersonaState,
  derivePersistentMemoriesFromUserMessage,
  ensurePersonaState,
  extractRelationshipProposal,
  evolvePersonaState,
  reconcilePersistentMemories,
  relationshipStageFromDepth,
} from "./personaDynamics";
import {
  normalizeInfluenceProfile,
  resolveInfluenceCurrentIntent,
} from "./influenceProfile";
import {
  applyPersonaEvolutionPatch,
  applyPersonaEvolutionProfile,
  createInitialPersonaEvolutionState,
  normalizePersonaEvolutionPatch,
  normalizePersonaEvolutionState,
  selectAppliedPersonaEvolutionHistory,
} from "./personaEvolution";
import type { PersonaControlPayload } from "./personaDynamics";
import { splitAssistantContent } from "./messageContent";
import {
  createDefaultAdvancedProfile,
  normalizeAdvancedProfile,
} from "./personaProfiles";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  DiaryEntry,
  ImageGenerationMeta,
  Persona,
  PersonaAdvancedProfile,
  PersonaEvolutionApplyMode,
  PersonaEvolutionHistoryItem,
  PersonaEvolutionProfile,
  PersonaEvolutionState,
  PersonaMemory,
  PersonaRuntimeState,
  RelationshipStage,
  InfluenceProfile,
} from "./types";
import {
  buildDiaryExistingTagsCatalog,
  DIARY_MIN_CHAR_COUNT,
  DIARY_MIN_MESSAGE_COUNT,
  DIARY_RECENT_MESSAGE_LIMIT,
  evaluateDiaryGenerationGate,
  normalizeGeneratedDiaryEntries,
  normalizeDiaryTags,
} from "./diary";
import { ensureRecurringBackgroundJob } from "./features/mobile/backgroundJobs";
import {
  buildOneToOneChatJobId,
  ONE_TO_ONE_CHAT_JOB_TYPE,
  ONE_TO_ONE_CHAT_MAX_ATTEMPTS,
  ONE_TO_ONE_CHAT_RETRY_DELAY_MS,
} from "./features/mobile/backgroundJobKeys";
import { triggerBackgroundRuntime } from "./features/mobile/backgroundDelta";
import {
  requestNativeDiaryPreview,
  requestNativeProactivitySimulation,
  syncOneToOneContextToNative,
  type NativeProactivitySimulationReport,
} from "./features/mobile/oneToOneNativeRuntime";

type PersonaInput = Omit<
  Persona,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "advanced"
  | "avatarImageId"
  | "fullBodyImageId"
  | "fullBodySideImageId"
  | "fullBodyBackImageId"
> & {
  advanced?: PersonaAdvancedProfile;
  avatarImageId?: string;
  fullBodyImageId?: string;
  fullBodySideImageId?: string;
  fullBodyBackImageId?: string;
  id?: string;
};

interface AppState {
  personas: Persona[];
  chats: ChatSession[];
  messages: ChatMessage[];
  activePersonaState: PersonaRuntimeState | null;
  activePersonaEvolutionState: PersonaEvolutionState | null;
  activeMemories: PersonaMemory[];
  activeDiaryEntries: DiaryEntry[];
  activePersonaId: string | null;
  activeChatId: string | null;
  settings: AppSettings;
  initialized: boolean;
  isLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  selectPersona: (personaId: string) => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  syncOneToOneStateFromDb: (preferredChatId?: string | null) => Promise<void>;
  savePersona: (input: PersonaInput) => Promise<void>;
  deletePersona: (personaId: string) => Promise<void>;
  createChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  setChatStyleStrength: (chatId: string, value: number | null) => Promise<void>;
  setChatNotificationsEnabled: (chatId: string, enabled: boolean) => Promise<void>;
  setChatDiaryEnabled: (chatId: string, enabled: boolean) => Promise<void>;
  setChatProactivityEnabled: (chatId: string, enabled: boolean) => Promise<void>;
  setChatEvolutionEnabled: (chatId: string, enabled: boolean) => Promise<void>;
  setChatEvolutionApplyMode: (
    chatId: string,
    applyMode: PersonaEvolutionApplyMode,
  ) => Promise<void>;
  addPendingEvolutionProposal: (
    chatId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => Promise<void>;
  updatePendingEvolutionProposal: (
    chatId: string,
    proposalId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => Promise<void>;
  deletePendingEvolutionProposal: (
    chatId: string,
    proposalId: string,
  ) => Promise<void>;
  applyEvolutionPatchNow: (
    chatId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => Promise<void>;
  rejectEvolutionPatchNow: (
    chatId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => Promise<void>;
  approvePendingEvolution: (chatId: string, proposalId: string) => Promise<void>;
  rejectPendingEvolution: (chatId: string, proposalId: string) => Promise<void>;
  undoLastAppliedEvolution: (chatId: string) => Promise<void>;
  updateDiaryEntryTags: (
    chatId: string,
    diaryEntryId: string,
    tags: string[],
  ) => Promise<void>;
  deleteDiaryEntry: (chatId: string, diaryEntryId: string) => Promise<void>;
  testGenerateDiaryEntry: (chatId: string) => Promise<DiaryEntry[]>;
  testSimulateProactivity: (
    chatId: string,
  ) => Promise<NativeProactivitySimulationReport | null>;
  runDiarySchedulerTick: () => Promise<void>;
  setActiveInfluenceProfile: (
    profile: Partial<InfluenceProfile> | null,
  ) => Promise<void>;
  updateActivePersonaState: (
    patch: Partial<
      Pick<
        PersonaRuntimeState,
        | "mood"
        | "trust"
        | "engagement"
        | "energy"
        | "lust"
        | "fear"
        | "affection"
        | "tension"
        | "relationshipType"
        | "relationshipDepth"
      >
    >,
  ) => Promise<void>;
  addManualMemory: (input: {
    layer: PersonaMemory["layer"];
    kind: PersonaMemory["kind"];
    content: string;
    salience?: number;
  }) => Promise<void>;
  updateActiveMemory: (
    memoryId: string,
    patch: Partial<
      Pick<PersonaMemory, "layer" | "kind" | "content" | "salience">
    >,
  ) => Promise<void>;
  deleteActiveMemory: (memoryId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  regenerateMessageComfyPromptAtIndex: (
    messageId: string,
    promptIndex: number,
  ) => Promise<void>;
  resolveRelationshipProposal: (
    messageId: string,
    decision: "accepted" | "rejected",
  ) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  clearError: () => void;
}

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const STORE_RUNTIME_STARTED_AT_MS = Date.now();
const ABANDONED_GENERATION_GRACE_MS = 10_000;
const RECENT_CONTEXT_MESSAGE_LIMIT = 6;
const DIARY_WEB_MIN_CHECK_MESSAGES = 1;
const SUMMARY_DEFAULT_TOKEN_BUDGET = 16000;
const SUMMARY_MIN_TOKEN_BUDGET = 600;
const SUMMARY_MAX_TOKEN_BUDGET = 16000;
const SUMMARY_MIN_NEW_MESSAGES = 4;
const SUMMARY_MIN_NEW_CHARS = 1200;
const SUMMARY_FACTS_MAX_ITEMS = 24;
const SUMMARY_FACTS_MAX_LEN = 320;
const SUMMARY_GOALS_MAX_ITEMS = 18;
const SUMMARY_GOALS_MAX_LEN = 320;
const SUMMARY_OPEN_THREADS_MAX_ITEMS = 24;
const SUMMARY_OPEN_THREADS_MAX_LEN = 420;
const SUMMARY_AGREEMENTS_MAX_ITEMS = 20;
const SUMMARY_AGREEMENTS_MAX_LEN = 420;
const SUMMARY_TRANSCRIPT_MAX_CHARS_PER_MESSAGE = 4000;
let diarySchedulerTickInFlight = false;
const randomSeed = () => {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return (Number(values[0]) << 1) + Number(values[1]);
};

function titleFromText(text: string) {
  const first = text.replace(/\s+/g, " ").trim().slice(0, 48);
  return first || "Новый чат";
}

function dedupeTrimmedStrings(values: string[]) {
  const deduped = values
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(deduped));
}

function collectMessageComfyPrompts(message: ChatMessage) {
  if (message.role !== "assistant") return [];
  const parsed = splitAssistantContent(message.content);
  return dedupeTrimmedStrings([
    ...(message.comfyPrompts ?? []),
    ...(parsed.comfyPrompts ?? []),
    ...(message.comfyPrompt ? [message.comfyPrompt] : []),
    ...(parsed.comfyPrompt ? [parsed.comfyPrompt] : []),
  ]);
}

function collectMessageComfyImageDescriptions(message: ChatMessage) {
  if (message.role !== "assistant") return [];
  const parsed = splitAssistantContent(message.content);
  return dedupeTrimmedStrings([
    ...(message.comfyImageDescriptions ?? []),
    ...(parsed.comfyImageDescriptions ?? []),
    ...(message.comfyImageDescription ? [message.comfyImageDescription] : []),
    ...(parsed.comfyImageDescription ? [parsed.comfyImageDescription] : []),
  ]);
}

type ImageDescriptionType = "person" | "other_person" | "no_person" | "group";

interface ParsedImageDescriptionType {
  type: ImageDescriptionType;
  participants: string;
  includesPersona: boolean;
  hasExplicitType: boolean;
}

function normalizeImageDescriptionTypeToken(token: string | undefined) {
  const normalized = (token || "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "person" || normalized === "persona_self" || normalized === "self") {
    return "person" as const;
  }
  if (normalized === "other_person" || normalized === "other") {
    return "other_person" as const;
  }
  if (normalized === "no_person" || normalized === "none" || normalized === "landscape") {
    return "no_person" as const;
  }
  if (normalized === "group" || normalized === "multi_person") {
    return "group" as const;
  }
  return undefined;
}

function parseImageDescriptionType(
  rawDescription: string,
  personaName: string,
): ParsedImageDescriptionType {
  const description = rawDescription.trim();
  const normalized = description.toLowerCase();
  const typeMatch = normalized.match(/(?:^|\n)\s*type\s*:\s*([a-z_]+)\b/i);
  const subjectModeMatch = normalized.match(
    /(?:^|\n)\s*subject_mode\s*:\s*(persona_self|other_person|no_person|group)\b/i,
  );
  const explicitType =
    normalizeImageDescriptionTypeToken(typeMatch?.[1]) ??
    normalizeImageDescriptionTypeToken(subjectModeMatch?.[1]);
  const hasExplicitType = Boolean(explicitType);
  const participantsMatch = description.match(/(?:^|\n)\s*participants\s*:\s*([^\n\r]+)/i);
  const participants = (participantsMatch?.[1] || "").trim() || "-";
  const participantsNormalized = participants.toLowerCase();
  const personaNameNormalized = personaName.trim().toLowerCase();

  const inferredType: ImageDescriptionType =
    explicitType ??
    (/\bno_person\b|\bno person\b|\blandscape\b|\bscenery\b|\binterior\b/.test(normalized) ||
    /пейзаж|ландшафт|интерьер|без людей|без человека/.test(normalized)
      ? "no_person"
      : /\bgroup\b|\bmultiple people\b|\bcrowd\b|\bfamily\b|\bfriends\b/.test(normalized) ||
          /групп|компан|семь|друз|толпа|двое|трое|четверо/.test(normalized)
        ? "group"
        : "person");

  const includesPersona =
    inferredType === "person" ||
    (inferredType === "group" &&
      (normalized.includes("participants: persona") ||
        normalized.includes("participants: персона") ||
        Boolean(personaNameNormalized && normalized.includes(personaNameNormalized)) ||
        participantsNormalized.includes("persona") ||
        participantsNormalized.includes("персона") ||
        Boolean(
          personaNameNormalized &&
            participantsNormalized.includes(personaNameNormalized),
        )));

  return {
    type: inferredType,
    participants,
    includesPersona,
    hasExplicitType,
  };
}

function shouldAttachPersonaReference(parsed: ParsedImageDescriptionType) {
  if (parsed.type === "no_person") return false;
  if (parsed.type === "other_person") return false;
  if (parsed.type === "group") return parsed.includesPersona;
  return true;
}

function buildOneToOneParticipantCatalog(
  persona: Pick<Persona, "id" | "name" | "appearance">,
): ComfyPromptParticipantCatalogEntry[] {
  const id = persona.id.trim();
  if (!id) return [];
  return [
    {
      id,
      alias: persona.name.trim() || "Self",
      isSelf: true,
      compactAppearanceLocks: compactAppearanceLocksFromAppearance(
        persona.appearance,
      ),
    },
  ];
}

interface MemoryRemovalDirective {
  id?: string;
  layer?: PersonaMemory["layer"];
  kind?: PersonaMemory["kind"];
  content?: string;
}

function parsePersonaControlRaw(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PersonaControlPayload;
  } catch {
    return undefined;
  }
}

function relationshipStageMinDepth(stage: RelationshipStage) {
  if (stage === "new") return 0;
  if (stage === "acquaintance") return 25;
  if (stage === "friendly") return 45;
  if (stage === "close") return 65;
  return 85;
}

function normalizeMemoryText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function applyMemoryRemovalDirectives(
  memories: PersonaMemory[],
  directives: MemoryRemovalDirective[],
): { kept: PersonaMemory[]; removedIds: string[] } {
  if (directives.length === 0) {
    return { kept: memories, removedIds: [] };
  }

  const removedIds = new Set<string>();
  const kept: PersonaMemory[] = [];

  for (const memory of memories) {
    const shouldRemove = directives.some((directive) => {
      if (directive.id && directive.id === memory.id) return true;
      if (directive.layer && directive.layer !== memory.layer) return false;
      if (directive.kind && directive.kind !== memory.kind) return false;
      if (directive.content) {
        const expected = normalizeMemoryText(directive.content);
        const actual = normalizeMemoryText(memory.content);
        if (!actual.includes(expected) && !expected.includes(actual)) {
          return false;
        }
      }
      return Boolean(directive.layer || directive.kind || directive.content);
    });

    if (shouldRemove) {
      removedIds.add(memory.id);
      continue;
    }
    kept.push(memory);
  }

  return { kept, removedIds: Array.from(removedIds) };
}

interface EvolutionProcessingResult {
  next: PersonaEvolutionState;
  appliedNow: boolean;
}

function getEffectivePersonaForChat(
  persona: Persona,
  chat: ChatSession | undefined,
  evolutionState: PersonaEvolutionState | undefined | null,
) {
  if (!chat?.evolutionConfig?.enabled) return persona;
  if (!evolutionState) return persona;
  return applyPersonaEvolutionProfile(persona, evolutionState.currentProfile);
}

function getAppliedEvolutionHistoryForPrompt(
  state: PersonaEvolutionState | null | undefined,
) {
  if (!state) return [] as PersonaEvolutionHistoryItem[];
  return selectAppliedPersonaEvolutionHistory(state.history).slice(-10);
}

function createEvolutionHistoryItem(input: {
  status: PersonaEvolutionHistoryItem["status"];
  reason: string;
  patch: PersonaEvolutionProfile;
  proposalId?: string;
  targetEventId?: string;
  timestamp: string;
}) {
  return {
    id: crypto.randomUUID(),
    proposalId: input.proposalId,
    targetEventId: input.targetEventId,
    status: input.status,
    timestamp: input.timestamp,
    reason: input.reason,
    patch: input.patch,
  } satisfies PersonaEvolutionHistoryItem;
}

function isMeaningfulEvolutionReason(reason: string) {
  const normalized = reason.trim();
  if (normalized.length < 8) return false;
  const compact = normalized.toLowerCase();
  if (
    compact === "evolution_update" ||
    compact === "update" ||
    compact === "patch" ||
    compact === "n/a"
  ) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(normalized);
}

function collectEvolutionPatchPaths(
  value: unknown,
  prefix: string,
  out: string[],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined || nested === null) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "object" && !Array.isArray(nested)) {
      collectEvolutionPatchPaths(nested, path, out);
      continue;
    }
    out.push(path);
  }
}

function summarizeEvolutionPatchFields(patch: PersonaEvolutionProfile) {
  const paths: string[] = [];
  collectEvolutionPatchPaths(patch, "", paths);
  if (paths.length === 0) return "profile fields";
  const unique = [...new Set(paths)].sort();
  const preview = unique.slice(0, 4).join(", ");
  return unique.length > 4 ? `${preview} +${unique.length - 4}` : preview;
}

function resolveEvolutionReason(
  reason: string | undefined,
  patch: PersonaEvolutionProfile,
) {
  const normalized = (reason || "").trim();
  if (normalized && isMeaningfulEvolutionReason(normalized)) {
    return normalized;
  }
  return `Sustained conversation shift detected; updated ${summarizeEvolutionPatchFields(
    patch,
  )}.`;
}

function areEvolutionPatchesEqual(
  left: PersonaEvolutionProfile,
  right: PersonaEvolutionProfile,
) {
  const leftPatch = normalizePersonaEvolutionPatch(left);
  const rightPatch = normalizePersonaEvolutionPatch(right);
  if (!leftPatch || !rightPatch) return false;
  return JSON.stringify(leftPatch) === JSON.stringify(rightPatch);
}

function applyEvolutionPatchWithHistory(
  state: PersonaEvolutionState,
  patch: PersonaEvolutionProfile,
  reason: string,
  timestamp: string,
  proposalId?: string,
): PersonaEvolutionState {
  const appliedEvent = createEvolutionHistoryItem({
    status: "applied",
    reason: resolveEvolutionReason(reason, patch),
    patch,
    proposalId,
    timestamp,
  });
  return {
    ...state,
    currentProfile: applyPersonaEvolutionPatch(state.currentProfile, patch),
    history: [...state.history, appliedEvent],
    updatedAt: timestamp,
  };
}

function rebuildEvolutionCurrentProfile(
  baselineProfile: PersonaEvolutionProfile,
  history: PersonaEvolutionHistoryItem[],
) {
  return selectAppliedPersonaEvolutionHistory(history).reduce(
    (profile, event) => applyPersonaEvolutionPatch(profile, event.patch),
    baselineProfile,
  );
}

function processPersonaControlEvolution(params: {
  config: ChatSession["evolutionConfig"];
  state: PersonaEvolutionState;
  control: PersonaControlPayload | undefined;
  timestamp: string;
}): EvolutionProcessingResult {
  const { config, state, control, timestamp } = params;
  if (!config?.enabled) {
    return { next: state, appliedNow: false };
  }
  const evolution = control?.evolution;
  if (!evolution?.shouldEvolve) {
    return { next: state, appliedNow: false };
  }
  const patch = normalizePersonaEvolutionPatch(evolution.patch);
  if (!patch) {
    return { next: state, appliedNow: false };
  }
  const reason = resolveEvolutionReason(evolution.reason, patch);
  if (config.applyMode === "auto") {
    return {
      next: applyEvolutionPatchWithHistory(state, patch, reason, timestamp),
      appliedNow: true,
    };
  }
  const pendingProposal = {
    id: crypto.randomUUID(),
    createdAt: timestamp,
    reason,
    patch,
  };
  return {
    next: {
      ...state,
      pendingProposals: [...state.pendingProposals, pendingProposal],
      updatedAt: timestamp,
    },
    appliedNow: false,
  };
}

function clampSummaryTokenBudget(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return SUMMARY_DEFAULT_TOKEN_BUDGET;
  }
  return Math.max(
    SUMMARY_MIN_TOKEN_BUDGET,
    Math.min(SUMMARY_MAX_TOKEN_BUDGET, Math.round(value)),
  );
}

function trimSummaryItems(
  items: string[] | undefined,
  maxItems = 10,
  maxLen = 220,
) {
  if (!Array.isArray(items)) return [] as string[];
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) =>
      item.length > maxLen
        ? `${item.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
        : item,
    )
    .slice(0, maxItems);
}

function buildConversationSummaryContext(chat: ChatSession | undefined) {
  if (!chat) return undefined;
  const summary = (chat.conversationSummary || "").trim();
  const facts = trimSummaryItems(
    chat.summaryFacts,
    SUMMARY_FACTS_MAX_ITEMS,
    SUMMARY_FACTS_MAX_LEN,
  );
  const goals = trimSummaryItems(
    chat.summaryGoals,
    SUMMARY_GOALS_MAX_ITEMS,
    SUMMARY_GOALS_MAX_LEN,
  );
  const openThreads = trimSummaryItems(
    chat.summaryOpenThreads,
    SUMMARY_OPEN_THREADS_MAX_ITEMS,
    SUMMARY_OPEN_THREADS_MAX_LEN,
  );
  const agreements = trimSummaryItems(
    chat.summaryAgreements,
    SUMMARY_AGREEMENTS_MAX_ITEMS,
    SUMMARY_AGREEMENTS_MAX_LEN,
  );
  if (
    !summary &&
    facts.length === 0 &&
    goals.length === 0 &&
    openThreads.length === 0 &&
    agreements.length === 0
  ) {
    return undefined;
  }
  return {
    summary,
    facts,
    goals,
    openThreads,
    agreements,
  };
}

function buildDialogTimeline(messages: ChatMessage[]) {
  return messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim().length > 0,
  );
}

async function maybeRefreshConversationSummary(params: {
  chat: ChatSession;
  persona: Persona;
  settings: AppSettings;
  messages: ChatMessage[];
}) {
  const timeline = buildDialogTimeline(params.messages);
  if (timeline.length <= RECENT_CONTEXT_MESSAGE_LIMIT) return null;
  const boundaryIndexExclusive = timeline.length - RECENT_CONTEXT_MESSAGE_LIMIT;
  if (boundaryIndexExclusive <= 0) return null;

  const cursorId = (params.chat.summaryCursorMessageId || "").trim();
  const cursorIndex = cursorId
    ? timeline.findIndex((message) => message.id === cursorId)
    : -1;
  const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  if (startIndex >= boundaryIndexExclusive) return null;

  const pending = timeline.slice(startIndex, boundaryIndexExclusive);
  const pendingChars = pending.reduce(
    (acc, message) => acc + message.content.trim().length,
    0,
  );
  if (
    pending.length < SUMMARY_MIN_NEW_MESSAGES &&
    pendingChars < SUMMARY_MIN_NEW_CHARS
  ) {
    return null;
  }

  const existing = {
    summary: (params.chat.conversationSummary || "").trim(),
    facts: trimSummaryItems(
      params.chat.summaryFacts,
      SUMMARY_FACTS_MAX_ITEMS,
      SUMMARY_FACTS_MAX_LEN,
    ),
    goals: trimSummaryItems(
      params.chat.summaryGoals,
      SUMMARY_GOALS_MAX_ITEMS,
      SUMMARY_GOALS_MAX_LEN,
    ),
    openThreads: trimSummaryItems(
      params.chat.summaryOpenThreads,
      SUMMARY_OPEN_THREADS_MAX_ITEMS,
      SUMMARY_OPEN_THREADS_MAX_LEN,
    ),
    agreements: trimSummaryItems(
      params.chat.summaryAgreements,
      SUMMARY_AGREEMENTS_MAX_ITEMS,
      SUMMARY_AGREEMENTS_MAX_LEN,
    ),
  };
  const targetTokens = clampSummaryTokenBudget(params.chat.summaryTokenBudget);
  const transcript = pending.map((message) => ({
    role: message.role as "user" | "assistant",
    content:
      message.content.length > SUMMARY_TRANSCRIPT_MAX_CHARS_PER_MESSAGE
        ? `${message.content
            .slice(0, SUMMARY_TRANSCRIPT_MAX_CHARS_PER_MESSAGE - 1)
            .trimEnd()}…`
        : message.content,
    createdAt: message.createdAt,
  }));

  try {
    const next = await requestConversationSummaryUpdate(
      params.settings,
      params.persona,
      {
        existing,
        transcript,
        targetTokens,
      },
    );
    const cursorMessageId = timeline[boundaryIndexExclusive - 1]?.id;
    if (!cursorMessageId) return null;
    return {
      conversationSummary: next.summary || undefined,
      summaryFacts: next.facts.length > 0 ? next.facts : undefined,
      summaryGoals: next.goals.length > 0 ? next.goals : undefined,
      summaryOpenThreads:
        next.openThreads.length > 0 ? next.openThreads : undefined,
      summaryAgreements:
        next.agreements.length > 0 ? next.agreements : undefined,
      summaryCursorMessageId: cursorMessageId,
      summaryUpdatedAt: nowIso(),
      summaryTokenBudget: targetTokens,
    } satisfies Partial<ChatSession>;
  } catch {
    return null;
  }
}

async function loadChatArtifacts(chatId: string | null) {
  if (!chatId) {
    return {
      messages: [] as ChatMessage[],
      state: null as PersonaRuntimeState | null,
      evolutionState: null as PersonaEvolutionState | null,
      memories: [] as PersonaMemory[],
      diaryEntries: [] as DiaryEntry[],
    };
  }
  const [messages, state, evolutionState, memories, diaryEntries] =
    await Promise.all([
    dbApi.getMessages(chatId),
    dbApi.getPersonaState(chatId),
    dbApi.getPersonaEvolutionState(chatId),
    dbApi.getMemories(chatId),
    dbApi.getDiaryEntries(chatId),
    ]);
  const recoveredMessages =
    await recoverAbandonedChatImageGenerations(messages);
  return {
    messages: recoveredMessages,
    state: state ?? null,
    evolutionState: evolutionState ?? null,
    memories,
    diaryEntries,
  };
}

function buildDiaryEntriesFromDraft(params: {
  chatId: string;
  personaId: string;
  sourceMessages: ChatMessage[];
  draftEntries: Array<{ markdown: string; tags: string[] }>;
  nowMs?: number;
}) {
  const nowMs = Number.isFinite(params.nowMs) ? params.nowMs ?? Date.now() : Date.now();
  const timestamp = nowIso();
  const dateTag = `date:${new Date(nowMs).toISOString().slice(0, 10)}` as `date:${string}`;
  const normalizedEntries = normalizeGeneratedDiaryEntries(
    params.draftEntries,
    dateTag,
  );
  const firstSource = params.sourceMessages[0];
  const lastSource = params.sourceMessages[params.sourceMessages.length - 1];
  return normalizedEntries.map((entry) => ({
    id: id(),
    chatId: params.chatId,
    personaId: params.personaId,
    markdown: entry.markdown,
    tags: entry.tags,
    sourceRange: {
      fromMessageId: firstSource?.id,
      toMessageId: lastSource?.id,
      fromCreatedAt: firstSource?.createdAt,
      toCreatedAt: lastSource?.createdAt,
      messageCount: params.sourceMessages.length,
    },
    autoGenerated: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

function isAbandonedPendingFromPreviousSession(createdAt: string) {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return (
    createdAtMs < STORE_RUNTIME_STARTED_AT_MS - ABANDONED_GENERATION_GRACE_MS
  );
}

async function recoverAbandonedChatImageGenerations(messages: ChatMessage[]) {
  const updatedById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (!message.imageGenerationPending) continue;
    if (!isAbandonedPendingFromPreviousSession(message.createdAt)) continue;

    const completed =
      typeof message.imageGenerationCompleted === "number"
        ? message.imageGenerationCompleted
        : (message.imageUrls?.length ?? 0);
    const expected =
      typeof message.imageGenerationExpected === "number"
        ? Math.max(message.imageGenerationExpected, completed)
        : completed > 0
          ? completed
          : undefined;

    const recoveredMessage: ChatMessage = {
      ...message,
      imageGenerationPending: false,
      imageGenerationExpected: expected,
      imageGenerationCompleted: completed,
    };
    await dbApi.saveMessage(recoveredMessage);
    updatedById.set(recoveredMessage.id, recoveredMessage);
  }

  if (updatedById.size === 0) return messages;
  return messages.map((message) => updatedById.get(message.id) ?? message);
}

export const useAppStore = create<AppState>((set, get) => ({
  personas: [],
  chats: [],
  messages: [],
  activePersonaState: null,
  activePersonaEvolutionState: null,
  activeMemories: [],
  activeDiaryEntries: [],
  activePersonaId: null,
  activeChatId: null,
  settings: DEFAULT_SETTINGS,
  initialized: false,
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  initialize: async () => {
    set({ isLoading: true, error: null });
    try {
      let personas = await dbApi.getPersonas();
      const settings = await dbApi.getSettings();

      if (personas.length === 0) {
        const ts = nowIso();
        const starter: Persona = {
          id: id(),
          name: "Астра",
          personalityPrompt:
            "Доброжелательная, любопытная, поддерживающая, структурная.",
          stylePrompt: "Говорит понятно, спокойно и по делу, без лишней воды.",
          appearance: {
            faceDescription: "мягкие черты лица, спокойный взгляд",
            height: "средний рост",
            eyes: "светлые глаза, аккуратная форма",
            lips: "естественные, средней полноты",
            hair: "короткие серебристые волосы",
            ageType: "young adult",
            bodyType: "стройное телосложение",
            markers: "",
            accessories: "",
            clothingStyle: "minimalist futuristic casual",
            skin: "светлая ровная кожа",
          },
          imageCheckpoint: "",
          advanced: createDefaultAdvancedProfile(),
          avatarUrl: "",
          fullBodyUrl: "",
          fullBodySideUrl: "",
          fullBodyBackUrl: "",
          avatarImageId: "",
          fullBodyImageId: "",
          fullBodySideImageId: "",
          fullBodyBackImageId: "",
          createdAt: ts,
          updatedAt: ts,
        };
        await dbApi.savePersona(starter);
        personas = [starter];
      }

      const activePersonaId = personas[0].id;
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        personas,
        settings,
        activePersonaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
        initialized: true,
        isLoading: false,
      });
    } catch (error) {
      set({
        initialized: true,
        isLoading: false,
        error: (error as Error).message,
      });
    }
  },

  selectPersona: async (personaId) => {
    set({ isLoading: true, error: null });
    try {
      const chats = await dbApi.getChats(personaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        activePersonaId: personaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  selectChat: async (chatId) => {
    set({ isLoading: true, error: null });
    try {
      const artifacts = await loadChatArtifacts(chatId);
      set({
        activeChatId: chatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  syncOneToOneStateFromDb: async (preferredChatId = null) => {
    const state = get();
    const activePersonaId = state.activePersonaId;
    if (!activePersonaId) return;
    try {
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId =
        preferredChatId && chats.some((chat) => chat.id === preferredChatId)
          ? preferredChatId
          : state.activeChatId && chats.some((chat) => chat.id === state.activeChatId)
            ? state.activeChatId
            : chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);
      set({
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
      });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  savePersona: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const persona: Persona = {
        id: input.id ?? id(),
        name: input.name.trim(),
        personalityPrompt: input.personalityPrompt.trim(),
        stylePrompt: input.stylePrompt.trim(),
        appearance: {
          faceDescription: input.appearance.faceDescription.trim(),
          height: input.appearance.height.trim(),
          eyes: input.appearance.eyes.trim(),
          lips: input.appearance.lips.trim(),
          hair: input.appearance.hair.trim(),
          ageType: input.appearance.ageType.trim(),
          bodyType: input.appearance.bodyType.trim(),
          markers: input.appearance.markers.trim(),
          accessories: input.appearance.accessories.trim(),
          clothingStyle: input.appearance.clothingStyle.trim(),
          skin: input.appearance.skin.trim(),
        },
        imageCheckpoint: input.imageCheckpoint.trim(),
        advanced: normalizeAdvancedProfile(
          input.advanced ?? createDefaultAdvancedProfile(),
        ),
        avatarUrl: input.avatarUrl.trim(),
        fullBodyUrl: input.fullBodyUrl.trim(),
        fullBodySideUrl: input.fullBodySideUrl.trim(),
        fullBodyBackUrl: input.fullBodyBackUrl.trim(),
        avatarImageId: input.avatarImageId?.trim() ?? "",
        fullBodyImageId: input.fullBodyImageId?.trim() ?? "",
        fullBodySideImageId: input.fullBodySideImageId?.trim() ?? "",
        fullBodyBackImageId: input.fullBodyBackImageId?.trim() ?? "",
        imageMetaByUrl: input.imageMetaByUrl,
        lookPromptCache: input.lookPromptCache,
        createdAt:
          get().personas.find((personaItem) => personaItem.id === input.id)
            ?.createdAt ?? ts,
        updatedAt: ts,
      };

      await dbApi.savePersona(persona);
      const personas = await dbApi.getPersonas();

      let activePersonaId = get().activePersonaId;
      if (!activePersonaId) {
        activePersonaId = persona.id;
      }

      set({ personas, activePersonaId, isLoading: false });
      if (activePersonaId === persona.id) {
        await get().selectPersona(activePersonaId);
      }
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  deletePersona: async (personaId) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.deletePersona(personaId);
      const personas = await dbApi.getPersonas();
      const nextActive = personas[0]?.id ?? null;
      const chats = nextActive ? await dbApi.getChats(nextActive) : [];
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        personas,
        activePersonaId: nextActive,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  createChat: async () => {
    const activePersonaId = get().activePersonaId;
    if (!activePersonaId) return;

    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const chat: ChatSession = {
        id: id(),
        personaId: activePersonaId,
        title: "Новый чат",
        notificationsEnabled: true,
        diaryConfig: {
          enabled: false,
        },
        proactivityConfig: {
          enabled: false,
        },
        evolutionConfig: {
          enabled: false,
          applyMode: "manual",
        },
        chatStyleStrength: undefined,
        createdAt: ts,
        updatedAt: ts,
      };
      await dbApi.saveChat(chat);

      const persona = get().personas.find(
        (item) => item.id === activePersonaId,
      );
      const initialState = persona
        ? createInitialPersonaState(persona, chat.id)
        : null;
      if (initialState) {
        await dbApi.savePersonaState(initialState);
      }
      const personaEvolutionState = persona
        ? createInitialPersonaEvolutionState(chat.id, persona, ts)
        : null;
      if (personaEvolutionState) {
        await dbApi.savePersonaEvolutionState(personaEvolutionState);
      }

      const chats = await dbApi.getChats(activePersonaId);
      set({
        chats,
        activeChatId: chat.id,
        messages: [],
        activePersonaState: initialState,
        activePersonaEvolutionState: personaEvolutionState,
        activeMemories: [],
        activeDiaryEntries: [],
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  deleteChat: async (chatId) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.deleteChat(chatId);
      const activePersonaId = get().activePersonaId;
      if (!activePersonaId) {
        set({
          chats: [],
          activeChatId: null,
          messages: [],
          activePersonaState: null,
          activePersonaEvolutionState: null,
          activeMemories: [],
          activeDiaryEntries: [],
          isLoading: false,
        });
        return;
      }
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activePersonaEvolutionState: artifacts.evolutionState,
        activeMemories: artifacts.memories,
        activeDiaryEntries: artifacts.diaryEntries,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  renameChat: async (chatId, title) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }

      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        set({ isLoading: false, error: "Название чата не может быть пустым." });
        return;
      }

      if (normalizedTitle === currentChat.title) {
        set({ isLoading: false });
        return;
      }

      const updatedChat: ChatSession = {
        ...currentChat,
        title: normalizedTitle,
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatStyleStrength: async (chatId, value) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const normalizedValue =
        typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, Math.min(1, Number(value)))
          : undefined;
      const updatedChat: ChatSession = {
        ...currentChat,
        chatStyleStrength: normalizedValue,
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatNotificationsEnabled: async (chatId, enabled) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const updatedChat: ChatSession = {
        ...currentChat,
        notificationsEnabled: Boolean(enabled),
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedChat.personaId,
        });
      }
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatDiaryEnabled: async (chatId, enabled) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const nextDiaryConfig = {
        ...(currentChat.diaryConfig ?? { enabled: false }),
        enabled,
      };
      const updatedChat: ChatSession = {
        ...currentChat,
        diaryConfig: nextDiaryConfig,
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedChat.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_diary_toggle");
      }
      const chats = await dbApi.getChats(updatedChat.personaId);
      let activeDiaryEntries = get().activeDiaryEntries;
      if (get().activeChatId === chatId) {
        activeDiaryEntries = await dbApi.getDiaryEntries(chatId);
      }
      set({
        chats,
        activeDiaryEntries,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatProactivityEnabled: async (chatId, enabled) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const nextProactivityConfig = {
        ...(currentChat.proactivityConfig ?? { enabled: false }),
        enabled,
      };
      const updatedChat: ChatSession = {
        ...currentChat,
        proactivityConfig: nextProactivityConfig,
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedChat.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_proactivity_toggle");
      }
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatEvolutionEnabled: async (chatId, enabled) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const updatedChat: ChatSession = {
        ...currentChat,
        evolutionConfig: {
          enabled,
          applyMode: currentChat.evolutionConfig?.applyMode ?? "manual",
        },
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedChat.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_toggle");
      }
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatEvolutionApplyMode: async (chatId, applyMode) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const updatedChat: ChatSession = {
        ...currentChat,
        evolutionConfig: {
          enabled: currentChat.evolutionConfig?.enabled ?? false,
          applyMode: applyMode === "auto" ? "auto" : "manual",
        },
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedChat.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_apply_mode");
      }
      const chats = await dbApi.getChats(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  addPendingEvolutionProposal: async (chatId, payload) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const patch = normalizePersonaEvolutionPatch(payload.patch);
      if (!patch) {
        throw new Error(
          "Невалидный patch эволюции. Разрешены только поля personalityPrompt/stylePrompt/appearance/advanced.",
        );
      }
      const timestamp = nowIso();
      const reason = resolveEvolutionReason(payload.reason, patch);
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        pendingProposals: [
          ...evolutionState.pendingProposals,
          {
            id: crypto.randomUUID(),
            createdAt: timestamp,
            reason,
            patch,
          },
        ],
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_pending_add");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updatePendingEvolutionProposal: async (chatId, proposalId, payload) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const target = evolutionState.pendingProposals.find(
        (proposal) => proposal.id === proposalId,
      );
      if (!target) return;
      const patch = normalizePersonaEvolutionPatch(payload.patch);
      if (!patch) {
        throw new Error(
          "Невалидный patch эволюции. Разрешены только поля personalityPrompt/stylePrompt/appearance/advanced.",
        );
      }
      const timestamp = nowIso();
      const reason = resolveEvolutionReason(payload.reason, patch);
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        pendingProposals: evolutionState.pendingProposals.map((proposal) =>
          proposal.id === proposalId
            ? {
                ...proposal,
                reason,
                patch,
              }
            : proposal,
        ),
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_pending_update");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  deletePendingEvolutionProposal: async (chatId, proposalId) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      if (!evolutionState.pendingProposals.some((item) => item.id === proposalId)) {
        return;
      }
      const timestamp = nowIso();
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        pendingProposals: evolutionState.pendingProposals.filter(
          (item) => item.id !== proposalId,
        ),
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_pending_delete");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  applyEvolutionPatchNow: async (chatId, payload) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    if (!activeChat.evolutionConfig?.enabled) return;
    if ((activeChat.evolutionConfig?.applyMode ?? "manual") !== "manual") return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const patch = normalizePersonaEvolutionPatch(payload.patch);
      if (!patch) {
        throw new Error(
          "Невалидный patch эволюции. Разрешены только поля personalityPrompt/stylePrompt/appearance/advanced.",
        );
      }
      const reason = resolveEvolutionReason(payload.reason, patch);
      const timestamp = nowIso();

      const matchingPending = evolutionState.pendingProposals.find(
        (proposal) =>
          proposal.reason === reason &&
          areEvolutionPatchesEqual(proposal.patch, patch),
      );

      const appliedState = applyEvolutionPatchWithHistory(
        evolutionState,
        matchingPending?.patch ?? patch,
        matchingPending?.reason ?? reason,
        timestamp,
        matchingPending?.id,
      );

      const nextState: PersonaEvolutionState = {
        ...appliedState,
        pendingProposals: matchingPending
          ? evolutionState.pendingProposals.filter(
              (proposal) => proposal.id !== matchingPending.id,
            )
          : evolutionState.pendingProposals,
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_approve");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  rejectEvolutionPatchNow: async (chatId, payload) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    if (!activeChat.evolutionConfig?.enabled) return;
    if ((activeChat.evolutionConfig?.applyMode ?? "manual") !== "manual") return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const patch = normalizePersonaEvolutionPatch(payload.patch);
      if (!patch) {
        throw new Error(
          "Невалидный patch эволюции. Разрешены только поля personalityPrompt/stylePrompt/appearance/advanced.",
        );
      }
      const reason = resolveEvolutionReason(payload.reason, patch);
      const timestamp = nowIso();

      const matchingPending = evolutionState.pendingProposals.find((proposal) =>
        areEvolutionPatchesEqual(proposal.patch, patch),
      );

      const rejectedEvent = createEvolutionHistoryItem({
        status: "rejected",
        reason: matchingPending?.reason ?? reason,
        patch: matchingPending?.patch ?? patch,
        proposalId: matchingPending?.id,
        timestamp,
      });
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        pendingProposals: matchingPending
          ? evolutionState.pendingProposals.filter(
              (proposal) => proposal.id !== matchingPending.id,
            )
          : evolutionState.pendingProposals,
        history: [...evolutionState.history, rejectedEvent],
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_reject");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  approvePendingEvolution: async (chatId, proposalId) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const proposal = evolutionState.pendingProposals.find(
        (item) => item.id === proposalId,
      );
      if (!proposal) return;
      const timestamp = nowIso();
      const applied = applyEvolutionPatchWithHistory(
        evolutionState,
        proposal.patch,
        proposal.reason,
        timestamp,
        proposal.id,
      );
      const nextState: PersonaEvolutionState = {
        ...applied,
        pendingProposals: evolutionState.pendingProposals.filter(
          (item) => item.id !== proposalId,
        ),
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_approve");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  rejectPendingEvolution: async (chatId, proposalId) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const proposal = evolutionState.pendingProposals.find(
        (item) => item.id === proposalId,
      );
      if (!proposal) return;
      const timestamp = nowIso();
      const rejectedEvent = createEvolutionHistoryItem({
        status: "rejected",
        reason: proposal.reason,
        patch: proposal.patch,
        proposalId: proposal.id,
        timestamp,
      });
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        pendingProposals: evolutionState.pendingProposals.filter(
          (item) => item.id !== proposalId,
        ),
        history: [...evolutionState.history, rejectedEvent],
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_reject");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  undoLastAppliedEvolution: async (chatId) => {
    const state = get();
    const activeChat = state.chats.find((chat) => chat.id === chatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === activeChat?.personaId,
    );
    if (!activeChat || !activePersona) return;
    try {
      const loaded =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loaded ?? undefined,
        chatId,
        activePersona,
      );
      const applied = selectAppliedPersonaEvolutionHistory(evolutionState.history);
      const target = applied[applied.length - 1];
      if (!target) return;
      const timestamp = nowIso();
      const undoEvent = createEvolutionHistoryItem({
        status: "undone",
        reason: `undo:${target.reason}`,
        patch: target.patch,
        targetEventId: target.id,
        timestamp,
      });
      const nextHistory = [...evolutionState.history, undoEvent];
      const nextState: PersonaEvolutionState = {
        ...evolutionState,
        history: nextHistory,
        currentProfile: rebuildEvolutionCurrentProfile(
          evolutionState.baselineProfile,
          nextHistory,
        ),
        updatedAt: timestamp,
      };
      await dbApi.savePersonaEvolutionState(nextState);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: activePersona.id,
        });
        await triggerBackgroundRuntime("one_to_one_evolution_undo");
      }
      if (state.activeChatId === chatId) {
        set({ activePersonaEvolutionState: nextState });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updateDiaryEntryTags: async (chatId, diaryEntryId, tags) => {
    const normalizedTags = normalizeDiaryTags(tags);
    try {
      const activeChatId = get().activeChatId;
      const sourceEntries =
        activeChatId === chatId
          ? get().activeDiaryEntries
          : await dbApi.getDiaryEntries(chatId);
      const target = sourceEntries.find((entry) => entry.id === diaryEntryId);
      if (!target) return;
      const updatedEntry: DiaryEntry = {
        ...target,
        tags: normalizedTags,
        updatedAt: nowIso(),
      };
      await dbApi.saveDiaryEntry(updatedEntry);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: updatedEntry.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_diary_tags");
      }
      if (activeChatId === chatId) {
        const activeDiaryEntries = sourceEntries
          .map((entry) => (entry.id === diaryEntryId ? updatedEntry : entry))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        set({ activeDiaryEntries });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  deleteDiaryEntry: async (chatId, diaryEntryId) => {
    try {
      const activeChatId = get().activeChatId;
      const sourceEntries =
        activeChatId === chatId
          ? get().activeDiaryEntries
          : await dbApi.getDiaryEntries(chatId);
      const target = sourceEntries.find((entry) => entry.id === diaryEntryId);
      if (!target) return;

      await dbApi.deleteDiaryEntries([diaryEntryId]);
      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: target.personaId,
        });
        await triggerBackgroundRuntime("one_to_one_diary_delete");
      }
      if (activeChatId === chatId) {
        const activeDiaryEntries = sourceEntries
          .filter((entry) => entry.id !== diaryEntryId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        set({ activeDiaryEntries });
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  testGenerateDiaryEntry: async (chatId) => {
    try {
      const state = get();
      const chat = state.chats.find((candidate) => candidate.id === chatId);
      if (!chat) return [];
      const persona =
        state.personas.find((candidate) => candidate.id === chat.personaId) ??
        (await dbApi.getPersonas()).find((candidate) => candidate.id === chat.personaId);
      if (!persona) return [];
      const loadedEvolutionState =
        state.activePersonaEvolutionState?.chatId === chatId
          ? state.activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(chatId);
      const evolutionState = normalizePersonaEvolutionState(
        loadedEvolutionState ?? undefined,
        chatId,
        persona,
      );
      if (!loadedEvolutionState) {
        await dbApi.savePersonaEvolutionState(evolutionState);
      }
      const effectivePersona = getEffectivePersonaForChat(
        persona,
        chat,
        evolutionState,
      );
      const evolutionHistoryForPrompt =
        getAppliedEvolutionHistoryForPrompt(evolutionState);

      if (getRuntimeContext().mode === "android") {
        await syncOneToOneContextToNative({
          chatId,
          personaId: chat.personaId,
        });
        return requestNativeDiaryPreview(chatId);
      }

      const sourceDiaryEntries =
        state.activeChatId === chatId
          ? state.activeDiaryEntries
          : await dbApi.getDiaryEntries(chatId);
      const existingTags = buildDiaryExistingTagsCatalog(sourceDiaryEntries);

      const rawMessages =
        state.activeChatId === chatId ? state.messages : await dbApi.getMessages(chatId);
      const timeline = rawMessages
        .filter((message) => {
          if (message.role !== "user" && message.role !== "assistant") return false;
          return message.content.trim().length > 0;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      const sourceWatermarkMs = chat.diaryConfig?.lastSourceMessageAtMs ?? 0;
      const newMessages = timeline.filter((message) => {
        const createdAtMs = Date.parse(message.createdAt);
        return Number.isFinite(createdAtMs) && createdAtMs > sourceWatermarkMs;
      });
      const sourceMessages = (newMessages.length > 0 ? newMessages : timeline).slice(
        -DIARY_RECENT_MESSAGE_LIMIT,
      );
      if (sourceMessages.length === 0) return [];

      const newCharCount = sourceMessages.reduce(
        (total, message) => total + message.content.trim().length,
        0,
      );
      if (
        sourceMessages.length < DIARY_MIN_MESSAGE_COUNT &&
        newCharCount < DIARY_MIN_CHAR_COUNT
      ) {
        return [];
      }

      const diaryDraft = await requestOneToOneDiaryEntry(
        state.settings,
        effectivePersona,
        {
          chat,
          transcript: sourceMessages.map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content.trim(),
            createdAt: message.createdAt,
          })),
          existingTags,
          evolutionHistoryApplied: evolutionHistoryForPrompt,
        },
      );
      if (!diaryDraft.shouldWrite || diaryDraft.entries.length === 0) {
        return [];
      }

      return buildDiaryEntriesFromDraft({
        chatId: chat.id,
        personaId: chat.personaId,
        sourceMessages,
        draftEntries: diaryDraft.entries,
      });
    } catch (error) {
      set({ error: (error as Error).message });
      return [];
    }
  },

  testSimulateProactivity: async (chatId) => {
    try {
      const state = get();
      const chat = state.chats.find((candidate) => candidate.id === chatId);
      if (!chat) return null;
      if (getRuntimeContext().mode !== "android") return null;

      await syncOneToOneContextToNative({
        chatId,
        personaId: chat.personaId,
      });
      return requestNativeProactivitySimulation(chatId);
    } catch (error) {
      set({ error: (error as Error).message });
      return null;
    }
  },

  runDiarySchedulerTick: async () => {
    if (diarySchedulerTickInFlight) return;
    if (getRuntimeContext().mode === "android") return;
    diarySchedulerTickInFlight = true;
    try {
      const state = get();
      const settings = state.settings;
      const nowMs = Date.now();
      const [personas, allChats, allMessages, allEvolutionStates, allDiaryEntries] =
        await Promise.all([
        dbApi.getPersonas(),
        dbApi.getAllChats(),
        dbApi.getAllMessages(),
        dbApi.getAllPersonaEvolutionStates(),
        dbApi.getAllDiaryEntries(),
      ]);
      const personaById = new Map(personas.map((persona) => [persona.id, persona]));
      const evolutionStateByChatId = new Map(
        allEvolutionStates.map((item) => [item.chatId, item]),
      );
      const diaryEntriesByChatId = new Map<string, DiaryEntry[]>();
      for (const entry of allDiaryEntries) {
        const bucket = diaryEntriesByChatId.get(entry.chatId) ?? [];
        bucket.push(entry);
        diaryEntriesByChatId.set(entry.chatId, bucket);
      }
      const timelineByChatId = new Map<string, ChatMessage[]>();
      for (const message of allMessages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const content = message.content.trim();
        if (!content) continue;
        const bucket = timelineByChatId.get(message.chatId) ?? [];
        bucket.push(message);
        timelineByChatId.set(message.chatId, bucket);
      }
      for (const timeline of timelineByChatId.values()) {
        timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }

      const touchedChatIds = new Set<string>();
      const changedActiveDiaryEntries: DiaryEntry[] = [];
      const activeChatId = state.activeChatId;
      const activePersonaId = state.activePersonaId;

      for (const chat of allChats) {
        const diaryConfig = chat.diaryConfig ?? { enabled: false };
        if (!diaryConfig.enabled) continue;
        const timeline = timelineByChatId.get(chat.id) ?? [];
        const lastMessage = timeline[timeline.length - 1];
        const lastActivityAtMs = lastMessage ? Date.parse(lastMessage.createdAt) : undefined;
        const sourceWatermarkMs = diaryConfig.lastSourceMessageAtMs ?? 0;
        const newMessages = timeline.filter((message) => {
          const createdAtMs = Date.parse(message.createdAt);
          return Number.isFinite(createdAtMs) && createdAtMs > sourceWatermarkMs;
        });
        const sourceMessages = newMessages.slice(-DIARY_RECENT_MESSAGE_LIMIT);
        const newCharCount = sourceMessages.reduce(
          (total, message) => total + message.content.trim().length,
          0,
        );
        const gate = evaluateDiaryGenerationGate({
          enabled: diaryConfig.enabled,
          nowMs,
          lastActivityAtMs,
          lastGeneratedAtMs: diaryConfig.lastGeneratedAtMs,
          lastCheckedAtMs: diaryConfig.lastCheckedAtMs,
          hasNewSource: sourceMessages.length >= DIARY_WEB_MIN_CHECK_MESSAGES,
          newMessageCount: sourceMessages.length,
          newCharCount,
        });
        if (!gate.eligible) {
          if (
            gate.reason === "no_new_source" ||
            gate.reason === "insufficient_content"
          ) {
            const nextChat: ChatSession = {
              ...chat,
              diaryConfig: {
                ...diaryConfig,
                lastCheckedAtMs: nowMs,
              },
            };
            await dbApi.saveChat(nextChat);
            touchedChatIds.add(chat.id);
          }
          continue;
        }

        const persona = personaById.get(chat.personaId);
        if (!persona || sourceMessages.length === 0) continue;
        const normalizedEvolutionState = normalizePersonaEvolutionState(
          evolutionStateByChatId.get(chat.id),
          chat.id,
          persona,
        );
        if (!evolutionStateByChatId.has(chat.id)) {
          await dbApi.savePersonaEvolutionState(normalizedEvolutionState);
          evolutionStateByChatId.set(chat.id, normalizedEvolutionState);
        }
        const effectivePersona = getEffectivePersonaForChat(
          persona,
          chat,
          normalizedEvolutionState,
        );
        const evolutionHistoryForPrompt =
          getAppliedEvolutionHistoryForPrompt(normalizedEvolutionState);
        const existingTags = buildDiaryExistingTagsCatalog(
          diaryEntriesByChatId.get(chat.id) ?? [],
          nowMs,
        );

        const diaryDraft = await requestOneToOneDiaryEntry(
          settings,
          effectivePersona,
          {
            chat,
            transcript: sourceMessages.map((message) => ({
              role: message.role === "assistant" ? "assistant" : "user",
              content: message.content.trim(),
              createdAt: message.createdAt,
            })),
            existingTags,
            evolutionHistoryApplied: evolutionHistoryForPrompt,
          },
        );
        if (!diaryDraft.shouldWrite || diaryDraft.entries.length === 0) {
          const nextChat: ChatSession = {
            ...chat,
            diaryConfig: {
              ...diaryConfig,
              lastCheckedAtMs: nowMs,
            },
          };
          await dbApi.saveChat(nextChat);
          touchedChatIds.add(chat.id);
          continue;
        }

        const entries = buildDiaryEntriesFromDraft({
          chatId: chat.id,
          personaId: chat.personaId,
          sourceMessages,
          draftEntries: diaryDraft.entries,
          nowMs,
        });
        if (entries.length === 0) {
          const nextChat: ChatSession = {
            ...chat,
            diaryConfig: {
              ...diaryConfig,
              lastCheckedAtMs: nowMs,
            },
          };
          await dbApi.saveChat(nextChat);
          touchedChatIds.add(chat.id);
          continue;
        }
        await dbApi.saveDiaryEntries(entries);

        const lastSource = sourceMessages[sourceMessages.length - 1];
        const lastSourceAtMs = Date.parse(lastSource.createdAt);
        const nextChat: ChatSession = {
          ...chat,
          diaryConfig: {
            ...diaryConfig,
            enabled: true,
            lastCheckedAtMs: nowMs,
            lastGeneratedAtMs: nowMs,
            lastSourceMessageAtMs: Number.isFinite(lastSourceAtMs)
              ? Math.max(0, Math.floor(lastSourceAtMs))
              : sourceWatermarkMs,
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveChat(nextChat);
        touchedChatIds.add(chat.id);
        diaryEntriesByChatId.set(chat.id, [
          ...(diaryEntriesByChatId.get(chat.id) ?? []),
          ...entries,
        ]);

        if (activeChatId === chat.id) {
          changedActiveDiaryEntries.push(...entries);
        }
      }

      if (touchedChatIds.size > 0 && activePersonaId) {
        const chats = await dbApi.getChats(activePersonaId);
        if (changedActiveDiaryEntries.length > 0 && activeChatId) {
          const activeDiaryEntries = await dbApi.getDiaryEntries(activeChatId);
          set({ chats, activeDiaryEntries });
        } else {
          set({ chats });
        }
      }
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      diarySchedulerTickInFlight = false;
    }
  },

  setActiveInfluenceProfile: async (profile) => {
    const state = get();
    const activeChatId = state.activeChatId;
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activeChatId || !activePersona) return;

    try {
      const loadedState =
        state.activePersonaState ?? (await dbApi.getPersonaState(activeChatId));
      const currentState = ensurePersonaState(
        loadedState ?? undefined,
        activePersona,
        activeChatId,
      );
      const updatedAt = nowIso();
      if (!profile) {
        const nextState = ensurePersonaState(
          {
            ...currentState,
            currentIntent: undefined,
            influenceProfile: undefined,
            updatedAt,
          },
          activePersona,
          activeChatId,
        );
        nextState.updatedAt = updatedAt;
        await dbApi.savePersonaState(nextState);
        set({ activePersonaState: nextState, error: null });
        return;
      }

      const normalizedProfile = normalizeInfluenceProfile(profile, updatedAt);
      const nextState = ensurePersonaState(
        {
          ...currentState,
          currentIntent: resolveInfluenceCurrentIntent(normalizedProfile),
          influenceProfile: normalizedProfile,
          updatedAt,
        },
        activePersona,
        activeChatId,
      );
      nextState.updatedAt = updatedAt;
      await dbApi.savePersonaState(nextState);
      set({ activePersonaState: nextState, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updateActivePersonaState: async (patch) => {
    const state = get();
    const activeChatId = state.activeChatId;
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activeChatId || !activePersona) return;

    try {
      const loadedState =
        state.activePersonaState ?? (await dbApi.getPersonaState(activeChatId));
      const currentState = ensurePersonaState(
        loadedState ?? undefined,
        activePersona,
        activeChatId,
      );
      const updatedAt = nowIso();
      const nextState = ensurePersonaState(
        {
          ...currentState,
          ...patch,
          updatedAt,
        },
        activePersona,
        activeChatId,
      );
      nextState.updatedAt = updatedAt;
      await dbApi.savePersonaState(nextState);
      set({ activePersonaState: nextState, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  addManualMemory: async (input) => {
    const state = get();
    const activeChatId = state.activeChatId;
    const activeChat = state.chats.find((chat) => chat.id === activeChatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activeChatId || !activeChat || !activePersona) return;

    const loadedEvolutionState =
      state.activePersonaEvolutionState?.chatId === activeChatId
        ? state.activePersonaEvolutionState
        : await dbApi.getPersonaEvolutionState(activeChatId);
    const evolutionState = normalizePersonaEvolutionState(
      loadedEvolutionState ?? undefined,
      activeChatId,
      activePersona,
    );
    const effectivePersona = getEffectivePersonaForChat(
      activePersona,
      activeChat,
      evolutionState,
    );

    const content = input.content.trim();
    if (!content) {
      set({ error: "Текст памяти не может быть пустым." });
      return;
    }

    const layer =
      input.layer === "episodic" || input.layer === "long_term"
        ? input.layer
        : "long_term";
    const kind =
      layer === "episodic"
        ? input.kind === "event" ||
          input.kind === "fact" ||
          input.kind === "preference" ||
          input.kind === "goal"
          ? input.kind
          : "event"
        : input.kind === "fact" ||
            input.kind === "preference" ||
            input.kind === "goal" ||
            input.kind === "event"
          ? input.kind
          : "fact";
    const salience =
      typeof input.salience === "number" && Number.isFinite(input.salience)
        ? Math.max(0.1, Math.min(1, input.salience))
        : 0.82;
    const ts = nowIso();
    const manualMemory: PersonaMemory = {
      id: id(),
      chatId: activeChatId,
      personaId: activePersona.id,
      layer,
      kind,
      content,
      salience,
      createdAt: ts,
      updatedAt: ts,
      lastReferencedAt: ts,
    };

    try {
      const existing =
        state.activeMemories.length > 0
          ? state.activeMemories
          : await dbApi.getMemories(activeChatId);
      const reconciled = reconcilePersistentMemories(
        existing,
        [manualMemory],
        effectivePersona.advanced.memory.maxMemories,
        effectivePersona.advanced.memory.decayDays,
      );
      await dbApi.saveMemories(reconciled.kept);
      await dbApi.deleteMemories(reconciled.removedIds);
      set({ activeMemories: reconciled.kept, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updateActiveMemory: async (memoryId, patch) => {
    const state = get();
    const activeChatId = state.activeChatId;
    if (!activeChatId) return;

    try {
      const memoryPool =
        state.activeMemories.length > 0
          ? state.activeMemories
          : await dbApi.getMemories(activeChatId);
      const existing = memoryPool.find(
        (memory) => memory.id === memoryId && memory.chatId === activeChatId,
      );
      if (!existing) {
        set({ error: "Запись памяти не найдена." });
        return;
      }

      const nextLayer =
        patch.layer === "episodic" || patch.layer === "long_term"
          ? patch.layer
          : existing.layer;
      const nextKind =
        patch.kind === "fact" ||
        patch.kind === "preference" ||
        patch.kind === "goal" ||
        patch.kind === "event"
          ? patch.kind
          : existing.kind;
      const nextContent =
        typeof patch.content === "string" ? patch.content.trim() : existing.content;
      if (!nextContent) {
        set({ error: "Текст памяти не может быть пустым." });
        return;
      }
      const nextSalience =
        typeof patch.salience === "number" && Number.isFinite(patch.salience)
          ? Math.max(0.1, Math.min(1, patch.salience))
          : existing.salience;
      const ts = nowIso();
      const updated: PersonaMemory = {
        ...existing,
        layer: nextLayer,
        kind: nextKind,
        content: nextContent,
        salience: nextSalience,
        updatedAt: ts,
        lastReferencedAt: ts,
      };
      await dbApi.saveMemories([updated]);
      const nextMemories = memoryPool
        .map((memory) => (memory.id === updated.id ? updated : memory))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      set({ activeMemories: nextMemories, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  deleteActiveMemory: async (memoryId) => {
    const state = get();
    const activeChatId = state.activeChatId;
    if (!activeChatId) return;

    try {
      await dbApi.deleteMemories([memoryId]);
      const memoryPool =
        state.activeMemories.length > 0
          ? state.activeMemories
          : await dbApi.getMemories(activeChatId);
      const nextMemories = memoryPool.filter((memory) => memory.id !== memoryId);
      set({ activeMemories: nextMemories, error: null });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  sendMessage: async (content) => {
    const state = get();
    const isAndroidRuntime = getRuntimeContext().mode === "android";
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activePersona) return;

    let activeChatId = state.activeChatId;
    if (!activeChatId) {
      await get().createChat();
      activeChatId = get().activeChatId;
    }
    if (!activeChatId) return;

    const userMessage: ChatMessage = {
      id: id(),
      chatId: activeChatId,
      role: "user",
      content: content.trim(),
      nativeStatus: isAndroidRuntime ? "pending" : undefined,
      createdAt: nowIso(),
    };

    const currentMessages = get().messages;
    const nextMessages = [...currentMessages, userMessage];
    set({ messages: nextMessages, isLoading: true, error: null });

    try {
      await dbApi.saveMessage(userMessage);

      const activeChat = get().chats.find((chat) => chat.id === activeChatId);
      if (isAndroidRuntime) {
        const nextChat =
          activeChat != null
            ? {
                ...activeChat,
                title:
                  activeChat.title === "Новый чат"
                    ? titleFromText(content)
                    : activeChat.title,
                updatedAt: nowIso(),
              }
            : null;
        if (nextChat) {
          await dbApi.saveChat(nextChat);
        }
        await syncOneToOneContextToNative({
          chatId: activeChatId,
          personaId: activePersona.id,
        });
        await ensureRecurringBackgroundJob({
          id: buildOneToOneChatJobId(activeChatId, userMessage.id),
          type: ONE_TO_ONE_CHAT_JOB_TYPE,
          payload: {
            chatId: activeChatId,
            userMessageId: userMessage.id,
            personaId: activePersona.id,
            enqueuedAtMs: Date.now(),
            maxAttempts: ONE_TO_ONE_CHAT_MAX_ATTEMPTS,
            retryDelayMs: ONE_TO_ONE_CHAT_RETRY_DELAY_MS,
          },
          runAtMs: Date.now(),
          maxAttempts: ONE_TO_ONE_CHAT_MAX_ATTEMPTS,
        });
        await triggerBackgroundRuntime("one_to_one_enqueue");
        const chats = await dbApi.getChats(activePersona.id);
        set({
          chats,
          messages: nextMessages,
        });
        return;
      }

      const loadedState =
        get().activePersonaState ?? (await dbApi.getPersonaState(activeChatId));
      const runtimeState = ensurePersonaState(
        loadedState ?? undefined,
        activePersona,
        activeChatId,
      );
      if (!loadedState) {
        await dbApi.savePersonaState(runtimeState);
      }
      const loadedEvolutionState =
        get().activePersonaEvolutionState?.chatId === activeChatId
          ? get().activePersonaEvolutionState
          : await dbApi.getPersonaEvolutionState(activeChatId);
      const evolutionState = normalizePersonaEvolutionState(
        loadedEvolutionState ?? undefined,
        activeChatId,
        activePersona,
      );
      if (!loadedEvolutionState) {
        await dbApi.savePersonaEvolutionState(evolutionState);
      }
      const effectivePersona = getEffectivePersonaForChat(
        activePersona,
        activeChat,
        evolutionState,
      );
      const evolutionHistoryForPrompt =
        getAppliedEvolutionHistoryForPrompt(evolutionState);

      const memoryPool =
        get().activeMemories.length > 0
          ? get().activeMemories
          : await dbApi.getMemories(activeChatId);
      const recentMessages = buildRecentMessages(
        nextMessages,
        RECENT_CONTEXT_MESSAGE_LIMIT,
      );
      const memoryCard = buildLayeredMemoryContextCard(
        memoryPool,
        recentMessages,
        effectivePersona.advanced.memory.decayDays,
      );
      const conversationSummary = buildConversationSummaryContext(activeChat);

      const answer = await requestChatCompletion(
        get().settings,
        effectivePersona,
        content.trim(),
        activeChat?.lastResponseId,
        {
          runtimeState,
          influenceProfile: runtimeState.influenceProfile,
          currentIntent: runtimeState.currentIntent,
          memoryCard,
          recentMessages,
          conversationSummary,
          evolutionHistoryApplied: evolutionHistoryForPrompt,
        },
      );

      let assistantMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "assistant",
        content: answer.content,
        comfyPrompt: answer.comfyPrompt,
        comfyPrompts: answer.comfyPrompts,
        comfyImageDescription: answer.comfyImageDescription,
        comfyImageDescriptions: answer.comfyImageDescriptions,
        imageGenerationPending: false,
        personaControlRaw: answer.personaControl
          ? JSON.stringify(answer.personaControl)
          : undefined,
        createdAt: nowIso(),
      };
      const relationshipProposal = extractRelationshipProposal(
        answer.personaControl,
      );
      if (relationshipProposal) {
        assistantMessage = {
          ...assistantMessage,
          relationshipProposalType: relationshipProposal.type,
          relationshipProposalStage: relationshipProposal.stage,
          relationshipProposalStatus: "pending",
        };
      }

      const promptBlocks =
        assistantMessage.comfyPrompts ??
        (assistantMessage.comfyPrompt ? [assistantMessage.comfyPrompt] : []);
      const imageDescriptionBlocks =
        assistantMessage.comfyImageDescriptions ??
        (assistantMessage.comfyImageDescription
          ? [assistantMessage.comfyImageDescription]
          : []);
      const requestedImageCount =
        imageDescriptionBlocks.length > 0
          ? imageDescriptionBlocks.length
          : promptBlocks.length;
      if (requestedImageCount > 0) {
        assistantMessage = {
          ...assistantMessage,
          imageGenerationPending: true,
          imageGenerationExpected: requestedImageCount,
          imageGenerationCompleted: 0,
        };
      }

      await dbApi.saveMessage(assistantMessage);

      const finalMessages = [...nextMessages, assistantMessage];
      set({ messages: finalMessages });

      const patchAssistantMessage = async (patch: Partial<ChatMessage>) => {
        assistantMessage = {
          ...assistantMessage,
          ...patch,
        };
        await dbApi.saveMessage(assistantMessage);
        set((current) => ({
          messages: current.messages.map((message) =>
            message.id === assistantMessage.id ? assistantMessage : message,
          ),
        }));
      };

      if (requestedImageCount > 0) {
        void (async () => {
          const aggregatedLocalizedUrls: string[] = [];
          const aggregatedMetaByUrl: Record<string, ImageGenerationMeta> = {};
          let completedCount = 0;
          let expectedGenerationCount = requestedImageCount;
          const personaStyleReferenceImage =
            effectivePersona.avatarUrl.trim() ||
            effectivePersona.fullBodyUrl.trim() ||
            undefined;
          const chatStyleStrength =
            typeof activeChat?.chatStyleStrength === "number"
              ? activeChat.chatStyleStrength
              : get().settings.chatStyleStrength;
          const participantCatalog =
            buildOneToOneParticipantCatalog(effectivePersona);
          let promptsForGeneration = [...promptBlocks];
          let parsedTypesForGeneration = promptsForGeneration.map((prompt) =>
            parseImageDescriptionType(prompt, effectivePersona.name),
          );

          try {
            if (imageDescriptionBlocks.length > 0) {
              const generatedPromptBatches = await Promise.all(
                imageDescriptionBlocks.map((description, index) =>
                  generateComfyPromptsFromImageDescription(
                    get().settings,
                    effectivePersona,
                    description,
                    index + 1,
                    {
                      participantCatalog,
                      evolutionHistoryApplied: evolutionHistoryForPrompt,
                    },
                  ),
                ),
              );
              const parsedTypesByDescription = imageDescriptionBlocks.map(
                (description) =>
                  parseImageDescriptionType(description, effectivePersona.name),
              );
              const promptsWithType = generatedPromptBatches.flatMap(
                (batch, batchIndex) =>
                  batch
                    .map((value) => value.trim())
                    .filter(Boolean)
                    .map((prompt) => ({
                      prompt,
                      parsedType: parsedTypesByDescription[batchIndex] ?? {
                        type: "person" as const,
                        participants: "-",
                        includesPersona: true,
                        hasExplicitType: false,
                      },
                    })),
              );
              promptsForGeneration = promptsWithType.map((item) => item.prompt);
              parsedTypesForGeneration = promptsWithType.map(
                (item) => item.parsedType,
              );
              expectedGenerationCount = promptsForGeneration.length;
              await patchAssistantMessage({
                comfyPrompt: promptsForGeneration[0],
                comfyPrompts:
                  promptsForGeneration.length > 0
                    ? promptsForGeneration
                    : undefined,
                imageGenerationPending: promptsForGeneration.length > 0,
                imageGenerationExpected: expectedGenerationCount,
                imageGenerationCompleted: 0,
              });
            }
          } catch (error) {
            if (isComfyImageDescriptionContractInvalidError(error)) {
              console.warn(
                "[image_generation] comfy_image_description contract_invalid",
                error,
              );
            }
            await patchAssistantMessage({
              imageGenerationPending: false,
              imageGenerationExpected: requestedImageCount,
              imageGenerationCompleted: 0,
            });
            return;
          }

          if (promptsForGeneration.length === 0) {
            await patchAssistantMessage({
              imageGenerationPending: false,
              imageGenerationExpected: requestedImageCount,
              imageGenerationCompleted: 0,
            });
            return;
          }

          const comfyItems = promptsForGeneration.map((prompt, index) => {
            const parsedType =
              parsedTypesForGeneration[index] ??
              parseImageDescriptionType(prompt, effectivePersona.name);
            const styleReferenceImage = shouldAttachPersonaReference(parsedType)
              ? personaStyleReferenceImage
              : undefined;
            return {
              flow: "base" as const,
              prompt,
              checkpointName: effectivePersona.imageCheckpoint || undefined,
              seed: randomSeed(),
              styleReferenceImage,
              styleStrength: styleReferenceImage
                ? chatStyleStrength
                : undefined,
              compositionStrength: 0,
              saveComfyOutputs: get().settings.saveComfyOutputs,
            };
          });

          try {
            await generateComfyImages(
              comfyItems,
              get().settings.comfyBaseUrl,
              get().settings.comfyAuth,
              async (promptImageUrls, index) => {
                completedCount += 1;
                const localizedChunk = await localizeImageUrls(promptImageUrls);
                const item = comfyItems[index];
                const extractedMeta = promptImageUrls[0]
                  ? await readComfyImageGenerationMeta(
                      promptImageUrls[0],
                      get().settings.comfyBaseUrl,
                      get().settings.comfyAuth,
                    )
                  : null;
                const meta: ImageGenerationMeta = {
                  seed: extractedMeta?.seed ?? item.seed,
                  prompt: extractedMeta?.prompt ?? item.prompt,
                  model: extractedMeta?.model ?? item.checkpointName,
                  flow: extractedMeta?.flow ?? item.flow,
                };
                await Promise.all(
                  localizedChunk.map((localized) =>
                    dbApi.saveImageAsset({
                      id: crypto.randomUUID(),
                      dataUrl: localized,
                      meta,
                      createdAt: nowIso(),
                    }),
                  ),
                );
                for (const localized of localizedChunk) {
                  if (!aggregatedLocalizedUrls.includes(localized)) {
                    aggregatedLocalizedUrls.push(localized);
                  }
                  aggregatedMetaByUrl[localized] = meta;
                }
                for (const original of promptImageUrls) {
                  if (original?.trim()) {
                    aggregatedMetaByUrl[original] = meta;
                  }
                }

                await patchAssistantMessage({
                  imageUrls: [...aggregatedLocalizedUrls],
                  imageMetaByUrl: { ...aggregatedMetaByUrl },
                  imageGenerationPending:
                    completedCount < expectedGenerationCount,
                  imageGenerationExpected: expectedGenerationCount,
                  imageGenerationCompleted: completedCount,
                });
              },
            );
            await patchAssistantMessage({
              imageUrls: [...aggregatedLocalizedUrls],
              imageMetaByUrl: { ...aggregatedMetaByUrl },
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: expectedGenerationCount,
            });
          } catch {
            await patchAssistantMessage({
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: completedCount,
            });
          }
        })();
      }

      const fallbackState = evolvePersonaState(
        runtimeState,
        effectivePersona,
        content.trim(),
        assistantMessage.content,
      );
      let resolvedState = fallbackState;
      let controlMemories: PersonaMemory[] = [];
      let controlMemoryRemovals: MemoryRemovalDirective[] = [];
      if (answer.personaControl) {
        const controlled = applyPersonaControlProposal({
          control: answer.personaControl,
          baseState: fallbackState,
          persona: effectivePersona,
          chatId: activeChatId,
          userMessage: content.trim(),
        });
        resolvedState = controlled.state;
        controlMemories = controlled.memoryCandidates;
        controlMemoryRemovals = controlled.memoryRemovals;
      }
      await dbApi.savePersonaState(resolvedState);
      const evolutionProcessed = processPersonaControlEvolution({
        config: activeChat?.evolutionConfig,
        state: evolutionState,
        control: answer.personaControl,
        timestamp: nowIso(),
      });
      const resolvedEvolutionState = evolutionProcessed.next;
      await dbApi.savePersonaEvolutionState(resolvedEvolutionState);

      const memoryPoolAfterRemovals = applyMemoryRemovalDirectives(
        memoryPool,
        controlMemoryRemovals,
      );
      const candidates = [
        ...(answer.personaControl
          ? []
          : derivePersistentMemoriesFromUserMessage(
              effectivePersona,
              activeChatId,
              content.trim(),
            )),
        ...controlMemories,
      ];
      const memoryReconciliation = reconcilePersistentMemories(
        memoryPoolAfterRemovals.kept,
        candidates,
        effectivePersona.advanced.memory.maxMemories,
        effectivePersona.advanced.memory.decayDays,
      );
      await dbApi.saveMemories(memoryReconciliation.kept);
      await dbApi.deleteMemories([
        ...new Set([
          ...memoryReconciliation.removedIds,
          ...memoryPoolAfterRemovals.removedIds,
        ]),
      ]);

      if (activeChat) {
        let updatedChat: ChatSession = {
          ...activeChat,
          title:
            activeChat.title === "Новый чат"
              ? titleFromText(content)
              : activeChat.title,
          lastResponseId: answer.responseId ?? activeChat.lastResponseId,
          updatedAt: nowIso(),
        };
        const summaryPatch = await maybeRefreshConversationSummary({
          chat: updatedChat,
          persona: effectivePersona,
          settings: get().settings,
          messages: finalMessages,
        });
        if (summaryPatch) {
          updatedChat = {
            ...updatedChat,
            ...summaryPatch,
          };
        }
        await dbApi.saveChat(updatedChat);
      }

      const chats = await dbApi.getChats(activePersona.id);
      set({
        chats,
        activePersonaState: resolvedState,
        activePersonaEvolutionState: resolvedEvolutionState,
        activeMemories: memoryReconciliation.kept,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  regenerateMessageComfyPromptAtIndex: async (messageId, promptIndex) => {
    const state = get();
    const activeChatId = state.activeChatId;
    const activeChat = state.chats.find((chat) => chat.id === activeChatId);
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activeChatId || !activeChat || !activePersona) return;

    const loadedEvolutionState =
      state.activePersonaEvolutionState?.chatId === activeChatId
        ? state.activePersonaEvolutionState
        : await dbApi.getPersonaEvolutionState(activeChatId);
    const evolutionState = normalizePersonaEvolutionState(
      loadedEvolutionState ?? undefined,
      activeChatId,
      activePersona,
    );
    const effectivePersona = getEffectivePersonaForChat(
      activePersona,
      activeChat,
      evolutionState,
    );

    const targetMessage = state.messages.find(
      (message) =>
        message.id === messageId &&
        message.chatId === activeChatId &&
        message.role === "assistant",
    );
    if (!targetMessage) return;

    const currentPrompts = collectMessageComfyPrompts(targetMessage);
    if (currentPrompts.length === 0) {
      set({ error: "В сообщении нет ComfyUI prompt для перегенерации." });
      return;
    }

    const normalizedIndex = Math.max(
      0,
      Math.min(currentPrompts.length - 1, Math.floor(promptIndex || 0)),
    );
    const currentPrompt = currentPrompts[normalizedIndex];
    const imageDescriptions = collectMessageComfyImageDescriptions(targetMessage);
    const sourceDescription =
      imageDescriptions[normalizedIndex] ||
      imageDescriptions[0] ||
      currentPrompt;
    const participantCatalog = buildOneToOneParticipantCatalog(effectivePersona);

    set({ isLoading: true, error: null });
    try {
      let regeneratedPrompt = (
        await generateComfyPromptFromImageDescription(
          get().settings,
          effectivePersona,
          sourceDescription,
          normalizedIndex + 1,
          { participantCatalog },
        )
      ).trim();

      if (!regeneratedPrompt) {
        throw new Error("Не удалось перегенерировать ComfyUI prompt.");
      }

      if (regeneratedPrompt === currentPrompt) {
        regeneratedPrompt = (
          await generateComfyPromptFromImageDescription(
            get().settings,
            effectivePersona,
          `${sourceDescription}\nНужна другая вариация композиции и света, сохранив смысл сцены.`,
          normalizedIndex + 101,
          { participantCatalog },
        )
      ).trim();
      }

      if (!regeneratedPrompt) {
        throw new Error("Не удалось получить новый вариант ComfyUI prompt.");
      }

      const nextPrompts = [...currentPrompts];
      nextPrompts[normalizedIndex] = regeneratedPrompt;

      const sourceImageUrls = [...(targetMessage.imageUrls ?? [])];
      const sourceUrl = sourceImageUrls[normalizedIndex] ?? sourceImageUrls[0] ?? "";
      const parsedType = parseImageDescriptionType(
        sourceDescription,
        effectivePersona.name,
      );
      const personaStyleReferenceImage =
        effectivePersona.avatarUrl.trim() ||
        effectivePersona.fullBodyUrl.trim() ||
        undefined;
      const styleReferenceImage = shouldAttachPersonaReference(parsedType)
        ? personaStyleReferenceImage
        : undefined;
      const activeChat = get().chats.find((chat) => chat.id === activeChatId);
      const chatStyleStrength =
        typeof activeChat?.chatStyleStrength === "number"
          ? activeChat.chatStyleStrength
          : get().settings.chatStyleStrength;
      const item = {
        flow: "base" as const,
        prompt: regeneratedPrompt,
        checkpointName: effectivePersona.imageCheckpoint || undefined,
        seed: randomSeed(),
        styleReferenceImage,
        styleStrength: styleReferenceImage ? chatStyleStrength : undefined,
        compositionStrength: 0,
        saveComfyOutputs: get().settings.saveComfyOutputs,
      };
      const generatedUrls = await generateComfyImages(
        [item],
        get().settings.comfyBaseUrl,
        get().settings.comfyAuth,
      );
      const localizedUrls = await localizeImageUrls(generatedUrls);
      const localizedImageUrl = localizedUrls[0] ?? "";
      if (!localizedImageUrl) {
        throw new Error("ComfyUI не вернул изображение для нового prompt.");
      }

      const extractedMeta = generatedUrls[0]
        ? await readComfyImageGenerationMeta(
            generatedUrls[0],
            get().settings.comfyBaseUrl,
            get().settings.comfyAuth,
          )
        : null;
      const nextMeta: ImageGenerationMeta = {
        seed: extractedMeta?.seed ?? item.seed,
        prompt: extractedMeta?.prompt ?? item.prompt,
        model: extractedMeta?.model ?? item.checkpointName,
        flow: extractedMeta?.flow ?? item.flow,
      };
      await dbApi.saveImageAsset({
        id: crypto.randomUUID(),
        dataUrl: localizedImageUrl,
        meta: nextMeta,
        createdAt: nowIso(),
      });

      let nextImageUrls = [...sourceImageUrls];
      if (nextImageUrls.length === 0) {
        nextImageUrls = [localizedImageUrl];
      } else if (normalizedIndex < nextImageUrls.length) {
        nextImageUrls[normalizedIndex] = localizedImageUrl;
      } else {
        nextImageUrls.push(localizedImageUrl);
      }

      const nextContent =
        sourceUrl && targetMessage.content.includes(sourceUrl)
          ? targetMessage.content.split(sourceUrl).join(localizedImageUrl)
          : targetMessage.content;

      const sourceMetaByUrl = { ...(targetMessage.imageMetaByUrl ?? {}) };
      if (sourceUrl) {
        delete sourceMetaByUrl[sourceUrl];
      }
      sourceMetaByUrl[localizedImageUrl] = nextMeta;
      const nextMetaByUrl = Object.fromEntries(
        Object.entries(sourceMetaByUrl).filter(([url]) => nextImageUrls.includes(url)),
      ) as Record<string, ImageGenerationMeta>;
      nextMetaByUrl[localizedImageUrl] = nextMeta;

      const updatedMessage: ChatMessage = {
        ...targetMessage,
        content: nextContent,
        comfyPrompt: nextPrompts[0],
        comfyPrompts: nextPrompts,
        imageUrls: nextImageUrls,
        imageMetaByUrl: nextMetaByUrl,
        imageGenerationPending: false,
        imageGenerationExpected: Math.max(
          targetMessage.imageGenerationExpected ?? 0,
          nextPrompts.length,
        ),
        imageGenerationCompleted: nextImageUrls.length,
      };

      await dbApi.saveMessage(updatedMessage);

      set((current) => ({
        messages: current.messages.map((message) =>
          message.id === updatedMessage.id ? updatedMessage : message,
        ),
        isLoading: false,
      }));
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  resolveRelationshipProposal: async (messageId, decision) => {
    const state = get();
    const activeChatId = state.activeChatId;
    if (!activeChatId) return;

    const targetMessage = state.messages.find(
      (message) => message.id === messageId && message.chatId === activeChatId,
    );
    if (!targetMessage || targetMessage.role !== "assistant") return;
    if (targetMessage.relationshipProposalStatus && targetMessage.relationshipProposalStatus !== "pending") {
      return;
    }

    const parsedFromRaw = parsePersonaControlRaw(targetMessage.personaControlRaw);
    const parsedFromContent = splitAssistantContent(targetMessage.content).personaControl;
    const proposal =
      extractRelationshipProposal(parsedFromRaw) ??
      extractRelationshipProposal(parsedFromContent);
    const proposalType = targetMessage.relationshipProposalType ?? proposal?.type;
    const proposalStage = targetMessage.relationshipProposalStage ?? proposal?.stage;
    if (!proposalType && !proposalStage) return;

    const handledAt = nowIso();
    const updatedMessage: ChatMessage = {
      ...targetMessage,
      relationshipProposalType: proposalType,
      relationshipProposalStage: proposalStage,
      relationshipProposalStatus: decision,
      relationshipProposalHandledAt: handledAt,
    };
    await dbApi.saveMessage(updatedMessage);

    let nextActiveState = state.activePersonaState;
    if (decision === "accepted") {
      const activePersona = state.personas.find(
        (persona) => persona.id === state.activePersonaId,
      );
      if (activePersona) {
        const loadedState =
          state.activePersonaState ?? (await dbApi.getPersonaState(activeChatId));
        const runtimeState = ensurePersonaState(
          loadedState ?? undefined,
          activePersona,
          activeChatId,
        );
        let nextState: PersonaRuntimeState = {
          ...runtimeState,
        };
        if (proposalType) {
          nextState.relationshipType = proposalType;
        }
        if (proposalStage) {
          nextState.relationshipDepth = Math.max(
            nextState.relationshipDepth,
            relationshipStageMinDepth(proposalStage),
          );
        }
        nextState.relationshipStage = relationshipStageFromDepth(
          nextState.relationshipDepth,
        );
        nextState.updatedAt = handledAt;
        await dbApi.savePersonaState(nextState);
        nextActiveState = nextState;
      }
    }

    set((current) => ({
      messages: current.messages.map((message) =>
        message.id === updatedMessage.id ? updatedMessage : message,
      ),
      activePersonaState: nextActiveState ?? current.activePersonaState,
    }));
  },

  saveSettings: async (settings) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.saveSettings(settings);
      set({ settings, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },
}));
