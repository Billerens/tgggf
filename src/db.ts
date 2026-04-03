import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeMemoryRecord } from "./personaDynamics";
import { normalizePersonaRecord } from "./personaProfiles";
import type {
  AdventureExplicitnessPolicy,
  AdventureScenario,
  AdventureState,
  AppSettings,
  AuthMode,
  ChatEvent,
  ChatEventType,
  ChatMode,
  ChatParticipant,
  ChatParticipantType,
  ChatMessage,
  ChatRunStatus,
  ChatSession,
  EndpointAuthConfig,
  EnhanceDetailLevel,
  EnhanceDetailStrengthTable,
  GeneratorSession,
  ImageAsset,
  Persona,
  PersonaMemory,
  PersonaRuntimeState,
  RelationshipBondState,
  RelationshipConsentAlignment,
  RelationshipEdge,
  RelationshipRomanticIntent,
  TurnJob,
  TurnJobStage,
  TurnJobStatus,
  UserGender,
} from "./types";

interface PersonaRuntimeStateRecord extends PersonaRuntimeState {
  id: string;
}

interface TgGfDb extends DBSchema {
  personas: {
    key: string;
    value: Persona;
  };
  chats: {
    key: string;
    value: ChatSession;
    indexes: { "by-persona": string; "by-updatedAt": string };
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: { "by-chat": string; "by-createdAt": string };
  };
  personaStates: {
    key: string;
    value: PersonaRuntimeState;
    indexes: { "by-persona": string; "by-updatedAt": string };
  };
  personaStatesV2: {
    key: string;
    value: PersonaRuntimeStateRecord;
    indexes: {
      "by-chat": string;
      "by-persona": string;
      "by-updatedAt": string;
      "by-chat-persona": [string, string];
    };
  };
  memories: {
    key: string;
    value: PersonaMemory;
    indexes: { "by-chat": string; "by-persona": string; "by-updatedAt": string };
  };
  settings: {
    key: string;
    value: AppSettings;
  };
  generatorSessions: {
    key: string;
    value: GeneratorSession;
    indexes: { "by-persona": string; "by-updatedAt": string };
  };
  imageAssets: {
    key: string;
    value: ImageAsset;
    indexes: { "by-createdAt": string };
  };
  chatParticipants: {
    key: string;
    value: ChatParticipant;
    indexes: {
      "by-chat": string;
      "by-type": ChatParticipantType;
      "by-ref": string;
      "by-updatedAt": string;
    };
  };
  chatEvents: {
    key: string;
    value: ChatEvent;
    indexes: { "by-chat": string; "by-turn": string; "by-createdAt": string };
  };
  turnJobs: {
    key: string;
    value: TurnJob;
    indexes: { "by-chat": string; "by-status": TurnJobStatus; "by-createdAt": string };
  };
  relationshipEdges: {
    key: string;
    value: RelationshipEdge;
    indexes: {
      "by-chat": string;
      "by-from": string;
      "by-to": string;
      "by-updatedAt": string;
    };
  };
  adventureScenarios: {
    key: string;
    value: AdventureScenario;
    indexes: { "by-updatedAt": string };
  };
  adventureStates: {
    key: string;
    value: AdventureState;
    indexes: { "by-chat": string; "by-scenario": string; "by-updatedAt": string };
  };
}

type StoreName =
  | "personas"
  | "chats"
  | "messages"
  | "personaStates"
  | "personaStatesV2"
  | "memories"
  | "settings"
  | "generatorSessions"
  | "imageAssets"
  | "chatParticipants"
  | "chatEvents"
  | "turnJobs"
  | "relationshipEdges"
  | "adventureScenarios"
  | "adventureStates";

const DB_NAME = "tg-gf-db";
const DB_VERSION = 7;
const SETTINGS_KEY = "main";
const DEV_PROXY_BASE_URL = "/lmstudioloc/";
const FALLBACK_PROD_BASE_URL = "https://t1.tun.uforge.online";
const DEFAULT_COMFY_BASE_URL = "/comfyloc/";

const AUTH_MODES: AuthMode[] = ["none", "bearer", "token", "basic", "custom"];
const CHAT_MODES: ChatMode[] = ["direct", "group", "adventure"];
const CHAT_RUN_STATUSES: ChatRunStatus[] = ["idle", "busy", "error"];
const CHAT_PARTICIPANT_TYPES: ChatParticipantType[] = ["user", "persona", "narrator"];
const CHAT_EVENT_TYPES: ChatEventType[] = [
  "turn_started",
  "speaker_selected",
  "arbiter_decision",
  "message_created",
  "image_requested",
  "image_created",
  "turn_committed",
  "turn_failed",
  "support_offered",
  "boundary_crossed",
  "public_humiliation",
  "betrayal_hint",
  "apology_attempted",
  "apology_rejected",
  "trust_repair_step",
  "reconciliation_moment",
  "emotional_withdrawal",
  "status_challenge",
  "romantic_signal",
  "romantic_rejection",
  "relationship_commitment",
  "relationship_breakup",
  "cooling_off_period",
];
const TURN_JOB_STAGES: TurnJobStage[] = [
  "turn_start",
  "planning",
  "decision",
  "actor_response",
  "image_action",
  "commit",
  "finalize",
];
const TURN_JOB_STATUSES: TurnJobStatus[] = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
];
const RELATIONSHIP_BOND_STATES: RelationshipBondState[] = [
  "neutral",
  "interest",
  "romance",
  "partnership",
  "estranged",
  "hostile",
];
const RELATIONSHIP_ROMANTIC_INTENTS: RelationshipRomanticIntent[] = [
  "none",
  "curious",
  "attracted",
  "attached",
  "obsessed",
];
const RELATIONSHIP_CONSENT_ALIGNMENTS: RelationshipConsentAlignment[] = [
  "unknown",
  "mutual",
  "one_sided",
  "withdrawn",
];
const ADVENTURE_EXPLICITNESS_POLICIES: AdventureExplicitnessPolicy[] = [
  "fade_to_black",
  "balanced",
  "explicit",
];
const ENHANCE_DETAIL_LEVELS: EnhanceDetailLevel[] = ["soft", "medium", "strong"];
const DEFAULT_ENHANCE_DETAIL_STRENGTH_TABLE: EnhanceDetailStrengthTable = {
  soft: {
    i2iBase: 0.62,
    i2iHires: 0.22,
    face: 0.1,
    eyes: 0.1,
    nose: 0.12,
    lips: 0.13,
    hands: 0.16,
    chest: 0.12,
    vagina: 0.14,
  },
  medium: {
    i2iBase: 0.72,
    i2iHires: 0.3,
    face: 0.14,
    eyes: 0.14,
    nose: 0.18,
    lips: 0.2,
    hands: 0.22,
    chest: 0.18,
    vagina: 0.22,
  },
  strong: {
    i2iBase: 0.82,
    i2iHires: 0.38,
    face: 0.18,
    eyes: 0.18,
    nose: 0.22,
    lips: 0.24,
    hands: 0.28,
    chest: 0.24,
    vagina: 0.28,
  },
};

function toTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function normalizeAuthConfig(
  current: Partial<EndpointAuthConfig> | undefined,
  fallback: EndpointAuthConfig,
): EndpointAuthConfig {
  const merged: EndpointAuthConfig = { ...fallback, ...(current ?? {}) };

  merged.mode = AUTH_MODES.includes(merged.mode) ? merged.mode : fallback.mode;
  merged.token = toTrimmedString(merged.token);
  merged.username = toTrimmedString(merged.username);
  merged.password = toTrimmedString(merged.password);
  merged.headerName = toTrimmedString(merged.headerName) || fallback.headerName;
  merged.headerPrefix = toTrimmedString(merged.headerPrefix);

  return merged;
}

function resolveDefaultBaseUrl() {
  const fromEnv = toTrimmedString(import.meta.env.VITE_LM_BASE_URL);
  if (fromEnv) return fromEnv;
  return import.meta.env.DEV ? DEV_PROXY_BASE_URL : FALLBACK_PROD_BASE_URL;
}

function clampDetailStrengthValue(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0.01, Math.min(1, next));
}

function normalizeEnhanceDetailStrengthTable(
  current: unknown,
): EnhanceDetailStrengthTable {
  const source =
    current && typeof current === "object"
      ? (current as Partial<EnhanceDetailStrengthTable>)
      : {};
  const next = {} as EnhanceDetailStrengthTable;

  for (const level of ENHANCE_DETAIL_LEVELS) {
    const fallback = DEFAULT_ENHANCE_DETAIL_STRENGTH_TABLE[level];
    const rawLevel =
      source[level] && typeof source[level] === "object" ? source[level] : {};
    const typedRawLevel = rawLevel as Partial<typeof fallback>;
    next[level] = {
      i2iBase: clampDetailStrengthValue(typedRawLevel.i2iBase, fallback.i2iBase),
      i2iHires: clampDetailStrengthValue(typedRawLevel.i2iHires, fallback.i2iHires),
      face: clampDetailStrengthValue(typedRawLevel.face, fallback.face),
      eyes: clampDetailStrengthValue(typedRawLevel.eyes, fallback.eyes),
      nose: clampDetailStrengthValue(typedRawLevel.nose, fallback.nose),
      lips: clampDetailStrengthValue(typedRawLevel.lips, fallback.lips),
      hands: clampDetailStrengthValue(typedRawLevel.hands, fallback.hands),
      chest: clampDetailStrengthValue(typedRawLevel.chest, fallback.chest),
      vagina: clampDetailStrengthValue(typedRawLevel.vagina, fallback.vagina),
    };
  }

  return next;
}

function normalizeSettings(current: Partial<AppSettings> | undefined): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(current ?? {}) };

  const trimmedBaseUrl = toTrimmedString(merged.lmBaseUrl);
  if (!trimmedBaseUrl) {
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else if (!import.meta.env.DEV && trimmedBaseUrl === DEV_PROXY_BASE_URL) {
    // Auto-fix old persisted dev proxy URL in production static builds.
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else {
    merged.lmBaseUrl = trimmedBaseUrl;
  }

  merged.model = toTrimmedString(merged.model) || DEFAULT_SETTINGS.model;
  merged.imagePromptModel =
    toTrimmedString(merged.imagePromptModel) || merged.model || DEFAULT_SETTINGS.model;
  merged.personaGenerationModel =
    toTrimmedString(merged.personaGenerationModel) || merged.model || DEFAULT_SETTINGS.model;
  merged.comfyBaseUrl = toTrimmedString(merged.comfyBaseUrl) || DEFAULT_SETTINGS.comfyBaseUrl;
  merged.saveComfyOutputs = Boolean(merged.saveComfyOutputs);
  if (!Number.isFinite(merged.chatStyleStrength)) {
    merged.chatStyleStrength = DEFAULT_SETTINGS.chatStyleStrength;
  }
  merged.chatStyleStrength = Math.max(0, Math.min(1, Number(merged.chatStyleStrength)));
  merged.apiKey = toTrimmedString(merged.apiKey);
  merged.lmAuth = normalizeAuthConfig(merged.lmAuth, DEFAULT_SETTINGS.lmAuth);
  merged.comfyAuth = normalizeAuthConfig(
    merged.comfyAuth,
    DEFAULT_SETTINGS.comfyAuth,
  );

  // Backward compatibility for old single API key setting.
  if (!merged.lmAuth.token && merged.apiKey) {
    merged.lmAuth = {
      ...merged.lmAuth,
      mode: "bearer",
      token: merged.apiKey,
    };
  }
  const allowedGenders: UserGender[] = ["unspecified", "male", "female", "nonbinary"];
  if (!allowedGenders.includes(merged.userGender)) {
    merged.userGender = DEFAULT_SETTINGS.userGender;
  }
  merged.showSystemImageBlock = Boolean(merged.showSystemImageBlock);
  merged.showStatusChangeDetails = Boolean(merged.showStatusChangeDetails);
  merged.enableGroupChats = Boolean(merged.enableGroupChats);
  merged.enableAdventureMode = Boolean(merged.enableAdventureMode);
  if (!ENHANCE_DETAIL_LEVELS.includes(merged.enhanceDetailLevelAll)) {
    merged.enhanceDetailLevelAll = DEFAULT_SETTINGS.enhanceDetailLevelAll;
  }
  if (!ENHANCE_DETAIL_LEVELS.includes(merged.enhanceDetailLevelPart)) {
    merged.enhanceDetailLevelPart = DEFAULT_SETTINGS.enhanceDetailLevelPart;
  }
  merged.enhanceDetailStrengthTable = normalizeEnhanceDetailStrengthTable(
    merged.enhanceDetailStrengthTable,
  );
  return merged;
}

function normalizeChatSession(chat: ChatSession): ChatSession {
  const next: ChatSession = { ...chat };
  next.mode = CHAT_MODES.includes(next.mode) ? next.mode : "direct";
  next.status = CHAT_RUN_STATUSES.includes(next.status)
    ? next.status
    : "idle";
  const normalizedTurnId = toTrimmedString(next.activeTurnId);
  if (normalizedTurnId) {
    next.activeTurnId = normalizedTurnId;
  } else {
    delete next.activeTurnId;
  }
  const normalizedScenarioId = toTrimmedString(next.scenarioId);
  if (normalizedScenarioId) {
    next.scenarioId = normalizedScenarioId;
  } else {
    delete next.scenarioId;
  }
  if (typeof next.chatStyleStrength === "number" && Number.isFinite(next.chatStyleStrength)) {
    next.chatStyleStrength = Math.max(0, Math.min(1, Number(next.chatStyleStrength)));
  } else {
    delete next.chatStyleStrength;
  }
  return next;
}

function normalizeGeneratorSession(session: GeneratorSession): GeneratorSession {
  const next: GeneratorSession = {
    ...session,
    topic: session.topic.trim(),
    status:
      session.status === "running" ||
      session.status === "stopped" ||
      session.status === "completed" ||
      session.status === "error"
        ? session.status
        : "stopped",
    requestedCount:
      typeof session.requestedCount === "number" && Number.isFinite(session.requestedCount)
        ? Math.max(1, Math.floor(session.requestedCount))
        : null,
    delaySeconds: Number.isFinite(session.delaySeconds)
      ? Math.max(0, Math.min(120, Number(session.delaySeconds)))
      : 0,
    completedCount: Number.isFinite(session.completedCount)
      ? Math.max(0, Math.floor(session.completedCount))
      : 0,
    entries: Array.isArray(session.entries)
      ? session.entries
          .filter((entry) => Boolean(entry?.id))
          .map((entry) => ({
            ...entry,
            iteration: Number.isFinite(entry.iteration) ? Math.max(1, Math.floor(entry.iteration)) : 1,
            prompt: (entry.prompt ?? "").trim(),
            imageUrls: Array.isArray(entry.imageUrls)
              ? entry.imageUrls.map((url) => (url ?? "").trim()).filter(Boolean)
              : [],
            imageMetaByUrl:
              entry.imageMetaByUrl && typeof entry.imageMetaByUrl === "object"
                ? Object.fromEntries(
                    Object.entries(entry.imageMetaByUrl).filter(
                      ([key, value]) => Boolean(key) && Boolean(value && typeof value === "object"),
                    ),
                  )
                : undefined,
          }))
      : [],
  };
  return next;
}

function normalize01(value: unknown, fallback = 0): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.min(1, next));
}

function normalizeIso(value: unknown, fallback?: string): string {
  const raw = toTrimmedString(value);
  if (raw) return raw;
  return fallback ?? new Date().toISOString();
}

function buildPersonaStateRecordId(chatId: string, personaId: string) {
  return `${chatId.trim()}:${personaId.trim()}`;
}

function toPersonaStateRecord(state: PersonaRuntimeState): PersonaRuntimeStateRecord {
  const chatId = state.chatId.trim();
  const personaId = state.personaId.trim();
  return {
    ...state,
    chatId,
    personaId,
    id: buildPersonaStateRecordId(chatId, personaId),
    mood: state.mood,
    trust: normalize01(state.trust),
    energy: normalize01(state.energy),
    engagement: normalize01(state.engagement),
    lust: normalize01(state.lust),
    fear: normalize01(state.fear),
    affection: normalize01(state.affection),
    tension: normalize01(state.tension),
    relationshipDepth: normalize01(state.relationshipDepth),
    activeTopics: Array.isArray(state.activeTopics)
      ? state.activeTopics.map((item) => toTrimmedString(item)).filter(Boolean)
      : [],
    updatedAt: normalizeIso(state.updatedAt),
  };
}

function fromPersonaStateRecord(record: PersonaRuntimeStateRecord): PersonaRuntimeState {
  return {
    chatId: record.chatId,
    personaId: record.personaId,
    mood: record.mood,
    trust: record.trust,
    energy: record.energy,
    engagement: record.engagement,
    lust: record.lust,
    fear: record.fear,
    affection: record.affection,
    tension: record.tension,
    relationshipType: record.relationshipType,
    relationshipDepth: record.relationshipDepth,
    relationshipStage: record.relationshipStage,
    activeTopics: record.activeTopics,
    updatedAt: record.updatedAt,
  };
}

function normalizeChatParticipant(participant: ChatParticipant): ChatParticipant {
  const participantType = CHAT_PARTICIPANT_TYPES.includes(participant.participantType)
    ? participant.participantType
    : "persona";
  return {
    ...participant,
    chatId: participant.chatId.trim(),
    participantType,
    participantRefId: participant.participantRefId.trim(),
    displayName: toTrimmedString(participant.displayName) || "Participant",
    order: Number.isFinite(participant.order)
      ? Math.max(0, Math.floor(participant.order))
      : 0,
    isActive: Boolean(participant.isActive),
    joinedAt: normalizeIso(participant.joinedAt),
    updatedAt: normalizeIso(participant.updatedAt),
  };
}

function normalizeChatEvent(event: ChatEvent): ChatEvent {
  return {
    ...event,
    chatId: event.chatId.trim(),
    turnId: event.turnId.trim(),
    eventType: CHAT_EVENT_TYPES.includes(event.eventType)
      ? event.eventType
      : "turn_failed",
    payload:
      event.payload && typeof event.payload === "object"
        ? event.payload
        : {},
    createdAt: normalizeIso(event.createdAt),
  };
}

function normalizeTurnJob(job: TurnJob): TurnJob {
  return {
    ...job,
    chatId: job.chatId.trim(),
    turnId: job.turnId.trim(),
    mode: CHAT_MODES.includes(job.mode) ? job.mode : "direct",
    stage: TURN_JOB_STAGES.includes(job.stage) ? job.stage : "planning",
    payload:
      job.payload && typeof job.payload === "object"
        ? job.payload
        : {},
    status: TURN_JOB_STATUSES.includes(job.status) ? job.status : "queued",
    retryCount: Number.isFinite(job.retryCount)
      ? Math.max(0, Math.floor(job.retryCount))
      : 0,
    createdAt: normalizeIso(job.createdAt),
    startedAt: toTrimmedString(job.startedAt) || undefined,
    finishedAt: toTrimmedString(job.finishedAt) || undefined,
  };
}

function normalizeRelationshipEdge(edge: RelationshipEdge): RelationshipEdge {
  return {
    ...edge,
    chatId: edge.chatId.trim(),
    fromPersonaId: edge.fromPersonaId.trim(),
    toPersonaId: edge.toPersonaId.trim(),
    bondState: RELATIONSHIP_BOND_STATES.includes(edge.bondState)
      ? edge.bondState
      : "neutral",
    romanticIntent: RELATIONSHIP_ROMANTIC_INTENTS.includes(edge.romanticIntent)
      ? edge.romanticIntent
      : "none",
    consentAlignment: RELATIONSHIP_CONSENT_ALIGNMENTS.includes(edge.consentAlignment)
      ? edge.consentAlignment
      : "unknown",
    trust: normalize01(edge.trust),
    safety: normalize01(edge.safety),
    respect: normalize01(edge.respect),
    affection: normalize01(edge.affection),
    attraction: normalize01(edge.attraction),
    admiration: normalize01(edge.admiration),
    gratitude: normalize01(edge.gratitude),
    dependency: normalize01(edge.dependency),
    jealousy: normalize01(edge.jealousy),
    envy: normalize01(edge.envy),
    irritation: normalize01(edge.irritation),
    contempt: normalize01(edge.contempt),
    aversion: normalize01(edge.aversion),
    fear: normalize01(edge.fear),
    tension: normalize01(edge.tension),
    intimacy: normalize01(edge.intimacy),
    distancePreference: normalize01(edge.distancePreference),
    conflictHistoryScore: normalize01(edge.conflictHistoryScore),
    repairReadiness: normalize01(edge.repairReadiness),
    lastSignificantEventId: toTrimmedString(edge.lastSignificantEventId) || undefined,
    lastBondShiftAt: toTrimmedString(edge.lastBondShiftAt) || undefined,
    updatedAt: normalizeIso(edge.updatedAt),
  };
}

function normalizeAdventureScenario(scenario: AdventureScenario): AdventureScenario {
  return {
    ...scenario,
    title: toTrimmedString(scenario.title) || "Scenario",
    startContext: toTrimmedString(scenario.startContext),
    initialGoal: toTrimmedString(scenario.initialGoal),
    narratorStyle: toTrimmedString(scenario.narratorStyle),
    worldTone:
      scenario.worldTone === "light" ||
      scenario.worldTone === "balanced" ||
      scenario.worldTone === "dark"
        ? scenario.worldTone
        : "balanced",
    explicitnessPolicy: ADVENTURE_EXPLICITNESS_POLICIES.includes(
      scenario.explicitnessPolicy,
    )
      ? scenario.explicitnessPolicy
      : "fade_to_black",
    createdAt: normalizeIso(scenario.createdAt),
    updatedAt: normalizeIso(scenario.updatedAt),
  };
}

function normalizeAdventureState(state: AdventureState): AdventureState {
  return {
    ...state,
    chatId: state.chatId.trim(),
    scenarioId: state.scenarioId.trim(),
    currentScene: toTrimmedString(state.currentScene),
    sceneObjective: toTrimmedString(state.sceneObjective),
    openThreads: Array.isArray(state.openThreads)
      ? state.openThreads.map((item) => toTrimmedString(item)).filter(Boolean)
      : [],
    resolvedThreads: Array.isArray(state.resolvedThreads)
      ? state.resolvedThreads.map((item) => toTrimmedString(item)).filter(Boolean)
      : [],
    timelineSummary: toTrimmedString(state.timelineSummary),
    updatedAt: normalizeIso(state.updatedAt),
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  lmBaseUrl: resolveDefaultBaseUrl(),
  comfyBaseUrl: DEFAULT_COMFY_BASE_URL,
  saveComfyOutputs: false,
  model: "local-model",
  imagePromptModel: "local-model",
  personaGenerationModel: "local-model",
  temperature: 0.7,
  maxTokens: 600,
  chatStyleStrength: 0.9,
  apiKey: "",
  lmAuth: {
    mode: "none",
    token: "",
    username: "",
    password: "",
    headerName: "Authorization",
    headerPrefix: "Bearer",
  },
  comfyAuth: {
    mode: "none",
    token: "",
    username: "",
    password: "",
    headerName: "Authorization",
    headerPrefix: "Bearer",
  },
  userGender: "unspecified",
  showSystemImageBlock: true,
  showStatusChangeDetails: false,
  enableGroupChats: false,
  enableAdventureMode: false,
  enhanceDetailLevelAll: "medium",
  enhanceDetailLevelPart: "strong",
  enhanceDetailStrengthTable: normalizeEnhanceDetailStrengthTable(undefined),
};

function runUpgradeMigrations(_oldVersion: number) {
  // v5 introduces chat mode/status and feature flags normalization in application layer.
  // v6 introduces new data-layer stores for group/adventure features.
  // v7 re-applies object store creation to repair partial v6 schema states.
  // Existing records are backfilled lazily by normalizeChatSession / normalizeSettings /
  // personaState fallback migration in dbApi.
}

function filterExistingStoreNames<T extends readonly StoreName[]>(
  db: IDBPDatabase<TgGfDb>,
  names: T,
) {
  return names.filter((name): name is StoreName => db.objectStoreNames.contains(name));
}

let dbPromise: Promise<IDBPDatabase<TgGfDb>> | null = null;

function isVersionDowngradeError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "VersionError" ||
    message.includes("requested version") ||
    message.includes("less than the existing version")
  );
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<TgGfDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("personas")) {
          db.createObjectStore("personas", { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains("chats")) {
          const chats = db.createObjectStore("chats", { keyPath: "id" });
          chats.createIndex("by-persona", "personaId");
          chats.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("messages")) {
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-chat", "chatId");
          messages.createIndex("by-createdAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("personaStates")) {
          const personaStates = db.createObjectStore("personaStates", { keyPath: "chatId" });
          personaStates.createIndex("by-persona", "personaId");
          personaStates.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("personaStatesV2")) {
          const personaStatesV2 = db.createObjectStore("personaStatesV2", { keyPath: "id" });
          personaStatesV2.createIndex("by-chat", "chatId");
          personaStatesV2.createIndex("by-persona", "personaId");
          personaStatesV2.createIndex("by-updatedAt", "updatedAt");
          personaStatesV2.createIndex("by-chat-persona", ["chatId", "personaId"]);
        }

        if (!db.objectStoreNames.contains("memories")) {
          const memories = db.createObjectStore("memories", { keyPath: "id" });
          memories.createIndex("by-chat", "chatId");
          memories.createIndex("by-persona", "personaId");
          memories.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings");
        }

        if (!db.objectStoreNames.contains("generatorSessions")) {
          const sessions = db.createObjectStore("generatorSessions", { keyPath: "id" });
          sessions.createIndex("by-persona", "personaId");
          sessions.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("imageAssets")) {
          const imageAssets = db.createObjectStore("imageAssets", { keyPath: "id" });
          imageAssets.createIndex("by-createdAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("chatParticipants")) {
          const participants = db.createObjectStore("chatParticipants", { keyPath: "id" });
          participants.createIndex("by-chat", "chatId");
          participants.createIndex("by-type", "participantType");
          participants.createIndex("by-ref", "participantRefId");
          participants.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("chatEvents")) {
          const events = db.createObjectStore("chatEvents", { keyPath: "id" });
          events.createIndex("by-chat", "chatId");
          events.createIndex("by-turn", "turnId");
          events.createIndex("by-createdAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("turnJobs")) {
          const turnJobs = db.createObjectStore("turnJobs", { keyPath: "id" });
          turnJobs.createIndex("by-chat", "chatId");
          turnJobs.createIndex("by-status", "status");
          turnJobs.createIndex("by-createdAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("relationshipEdges")) {
          const relationshipEdges = db.createObjectStore("relationshipEdges", { keyPath: "id" });
          relationshipEdges.createIndex("by-chat", "chatId");
          relationshipEdges.createIndex("by-from", "fromPersonaId");
          relationshipEdges.createIndex("by-to", "toPersonaId");
          relationshipEdges.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("adventureScenarios")) {
          const adventureScenarios = db.createObjectStore("adventureScenarios", { keyPath: "id" });
          adventureScenarios.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("adventureStates")) {
          const adventureStates = db.createObjectStore("adventureStates", { keyPath: "id" });
          adventureStates.createIndex("by-chat", "chatId");
          adventureStates.createIndex("by-scenario", "scenarioId");
          adventureStates.createIndex("by-updatedAt", "updatedAt");
        }

        runUpgradeMigrations(oldVersion);
      },
    }).catch((error) => {
      if (!isVersionDowngradeError(error)) {
        throw error;
      }
      // Fallback: open at current on-disk version to keep app operational after stale bundle races.
      return openDB<TgGfDb>(DB_NAME);
    });
  }

  return dbPromise;
}

export const dbApi = {
  async clearAllData() {
    const db = await getDb();
    const requested = [
      "personas",
      "chats",
      "messages",
      "personaStates",
      "personaStatesV2",
      "memories",
      "settings",
      "generatorSessions",
      "imageAssets",
      "chatParticipants",
      "chatEvents",
      "turnJobs",
      "relationshipEdges",
      "adventureScenarios",
      "adventureStates",
    ] as const;
    const existing = filterExistingStoreNames(db, requested);
    if (existing.length === 0) return;
    const tx = db.transaction(existing, "readwrite");
    for (const storeName of existing) {
      await tx.objectStore(storeName).clear();
    }
    await tx.done;
  },

  async getPersonas() {
    const db = await getDb();
    const rows = await db.getAll("personas");
    const normalized = rows.map((row) => normalizePersonaRecord(row));
    await Promise.all(normalized.map((row) => db.put("personas", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async savePersona(persona: Persona) {
    const db = await getDb();
    await db.put("personas", normalizePersonaRecord(persona));
  },

  async deletePersona(personaId: string) {
    const db = await getDb();
    const requested = [
      "personas",
      "chats",
      "messages",
      "personaStates",
      "personaStatesV2",
      "memories",
      "generatorSessions",
      "chatParticipants",
      "chatEvents",
      "turnJobs",
      "relationshipEdges",
      "adventureStates",
    ] as const;
    const existing = filterExistingStoreNames(db, requested);
    if (existing.length === 0) return;
    const tx = db.transaction(existing, "readwrite");
    const existingSet = new Set<string>(existing.map((name) => String(name)));
    const hasStore = (name: StoreName) => existingSet.has(String(name));

    const personasStore = hasStore("personas") ? tx.objectStore("personas") : null;
    const chatsStore = hasStore("chats") ? tx.objectStore("chats") : null;
    const messagesStore = hasStore("messages") ? tx.objectStore("messages") : null;
    const personaStatesStore = hasStore("personaStates") ? tx.objectStore("personaStates") : null;
    const personaStatesV2Store = hasStore("personaStatesV2")
      ? tx.objectStore("personaStatesV2")
      : null;
    const memoriesStore = hasStore("memories") ? tx.objectStore("memories") : null;
    const generatorSessionsStore = hasStore("generatorSessions")
      ? tx.objectStore("generatorSessions")
      : null;
    const chatParticipantsStore = hasStore("chatParticipants")
      ? tx.objectStore("chatParticipants")
      : null;
    const chatEventsStore = hasStore("chatEvents") ? tx.objectStore("chatEvents") : null;
    const turnJobsStore = hasStore("turnJobs") ? tx.objectStore("turnJobs") : null;
    const relationshipEdgesStore = hasStore("relationshipEdges")
      ? tx.objectStore("relationshipEdges")
      : null;
    const adventureStatesStore = hasStore("adventureStates")
      ? tx.objectStore("adventureStates")
      : null;

    if (personasStore) {
      await personasStore.delete(personaId);
    }

    if (personaStatesStore) {
      const personaStateKeys = await personaStatesStore.index("by-persona").getAllKeys(personaId);
      for (const key of personaStateKeys) {
        await personaStatesStore.delete(key);
      }
    }

    if (personaStatesV2Store) {
      const personaStateKeysV2 = await personaStatesV2Store
        .index("by-persona")
        .getAllKeys(personaId);
      for (const key of personaStateKeysV2) {
        await personaStatesV2Store.delete(key);
      }
    }

    if (memoriesStore) {
      const memoryKeys = await memoriesStore.index("by-persona").getAllKeys(personaId);
      for (const key of memoryKeys) {
        await memoriesStore.delete(key);
      }
    }

    if (relationshipEdgesStore) {
      const relationshipFromKeys = await relationshipEdgesStore
        .index("by-from")
        .getAllKeys(personaId);
      for (const key of relationshipFromKeys) {
        await relationshipEdgesStore.delete(key);
      }
      const relationshipToKeys = await relationshipEdgesStore
        .index("by-to")
        .getAllKeys(personaId);
      for (const key of relationshipToKeys) {
        await relationshipEdgesStore.delete(key);
      }
    }

    if (chatParticipantsStore) {
      const participantRowsByRef = await chatParticipantsStore
        .index("by-ref")
        .getAll(personaId);
      for (const participant of participantRowsByRef) {
        if (participant.participantType !== "persona") continue;
        await chatParticipantsStore.delete(participant.id);
      }
    }

    const chats = chatsStore ? await chatsStore.index("by-persona").getAll(personaId) : [];
    for (const chat of chats) {
      if (chatsStore) {
        await chatsStore.delete(chat.id);
      }
      if (messagesStore) {
        const messages = await messagesStore.index("by-chat").getAll(chat.id);
        for (const msg of messages) {
          await messagesStore.delete(msg.id);
        }
      }
      if (personaStatesStore) {
        await personaStatesStore.delete(chat.id);
      }
      if (personaStatesV2Store) {
        const stateKeysV2ByChat = await personaStatesV2Store
          .index("by-chat")
          .getAllKeys(chat.id);
        for (const key of stateKeysV2ByChat) {
          await personaStatesV2Store.delete(key);
        }
      }
      if (memoriesStore) {
        const memories = await memoriesStore.index("by-chat").getAll(chat.id);
        for (const memory of memories) {
          await memoriesStore.delete(memory.id);
        }
      }
      if (chatParticipantsStore) {
        const participantKeys = await chatParticipantsStore
          .index("by-chat")
          .getAllKeys(chat.id);
        for (const key of participantKeys) {
          await chatParticipantsStore.delete(key);
        }
      }
      if (chatEventsStore) {
        const eventKeys = await chatEventsStore.index("by-chat").getAllKeys(chat.id);
        for (const key of eventKeys) {
          await chatEventsStore.delete(key);
        }
      }
      if (turnJobsStore) {
        const turnJobKeys = await turnJobsStore.index("by-chat").getAllKeys(chat.id);
        for (const key of turnJobKeys) {
          await turnJobsStore.delete(key);
        }
      }
      if (relationshipEdgesStore) {
        const relationshipKeysByChat = await relationshipEdgesStore
          .index("by-chat")
          .getAllKeys(chat.id);
        for (const key of relationshipKeysByChat) {
          await relationshipEdgesStore.delete(key);
        }
      }
      if (adventureStatesStore) {
        const adventureStateKeys = await adventureStatesStore
          .index("by-chat")
          .getAllKeys(chat.id);
        for (const key of adventureStateKeys) {
          await adventureStatesStore.delete(key);
        }
      }
    }

    if (generatorSessionsStore) {
      const generatorSessionKeys = await generatorSessionsStore
        .index("by-persona")
        .getAllKeys(personaId);
      for (const key of generatorSessionKeys) {
        await generatorSessionsStore.delete(key);
      }
    }

    await tx.done;
  },

  async getChats(personaId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("chats", "by-persona", personaId);
    const normalized = rows.map((row) => normalizeChatSession(row));
    await Promise.all(normalized.map((row) => db.put("chats", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getChatsForPersona(personaId: string) {
    const db = await getDb();
    const normalizedPersonaId = personaId.trim();
    if (!normalizedPersonaId) return [];
    const ownRows = await db.getAllFromIndex("chats", "by-persona", normalizedPersonaId);
    const participantRows = await db.getAllFromIndex(
      "chatParticipants",
      "by-ref",
      normalizedPersonaId,
    );
    const chatIds = new Set<string>(ownRows.map((row) => row.id));
    for (const participant of participantRows) {
      if (participant.participantType !== "persona") continue;
      if (!participant.chatId?.trim()) continue;
      chatIds.add(participant.chatId.trim());
    }
    const rows = (
      await Promise.all(
        Array.from(chatIds).map((chatId) => db.get("chats", chatId)),
      )
    ).filter((row): row is ChatSession => Boolean(row));
    const normalized = rows.map((row) => normalizeChatSession(row));
    await Promise.all(normalized.map((row) => db.put("chats", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getAllChats() {
    const db = await getDb();
    const rows = await db.getAll("chats");
    const normalized = rows.map((row) => normalizeChatSession(row));
    await Promise.all(normalized.map((row) => db.put("chats", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveChat(chat: ChatSession) {
    const db = await getDb();
    await db.put("chats", normalizeChatSession(chat));
  },

  async getChatById(chatId: string) {
    const db = await getDb();
    const row = await db.get("chats", chatId.trim());
    if (!row) return null;
    const normalized = normalizeChatSession(row);
    await db.put("chats", normalized);
    return normalized;
  },

  async acquireChatTurnLock(chatId: string) {
    const db = await getDb();
    const tx = db.transaction("chats", "readwrite");
    const key = chatId.trim();
    const row = await tx.store.get(key);
    if (!row) {
      await tx.done;
      return null;
    }
    const current = normalizeChatSession(row);
    if (current.status === "busy") {
      await tx.done;
      return null;
    }
    const turnId = crypto.randomUUID();
    const locked: ChatSession = {
      ...current,
      status: "busy",
      activeTurnId: turnId,
      updatedAt: new Date().toISOString(),
    };
    await tx.store.put(locked);
    await tx.done;
    return { turnId, chat: locked };
  },

  async releaseChatTurnLock(
    chatId: string,
    turnId: string,
    nextStatus: Exclude<ChatRunStatus, "busy"> = "idle",
  ) {
    const db = await getDb();
    const tx = db.transaction("chats", "readwrite");
    const key = chatId.trim();
    const row = await tx.store.get(key);
    if (!row) {
      await tx.done;
      return null;
    }
    const current = normalizeChatSession(row);
    if (current.activeTurnId !== turnId) {
      await tx.done;
      return null;
    }
    const released: ChatSession = {
      ...current,
      status: nextStatus,
      activeTurnId: undefined,
      updatedAt: new Date().toISOString(),
    };
    await tx.store.put(released);
    await tx.done;
    return released;
  },

  async deleteChat(chatId: string) {
    const db = await getDb();
    const requested = [
      "chats",
      "messages",
      "personaStates",
      "personaStatesV2",
      "memories",
      "chatParticipants",
      "chatEvents",
      "turnJobs",
      "relationshipEdges",
      "adventureStates",
    ] as const;
    const existing = filterExistingStoreNames(db, requested);
    if (existing.length === 0) return;
    const tx = db.transaction(existing, "readwrite");
    const existingSet = new Set<string>(existing.map((name) => String(name)));
    const hasStore = (name: StoreName) => existingSet.has(String(name));

    const chatsStore = hasStore("chats") ? tx.objectStore("chats") : null;
    const messagesStore = hasStore("messages") ? tx.objectStore("messages") : null;
    const personaStatesStore = hasStore("personaStates") ? tx.objectStore("personaStates") : null;
    const personaStatesV2Store = hasStore("personaStatesV2")
      ? tx.objectStore("personaStatesV2")
      : null;
    const memoriesStore = hasStore("memories") ? tx.objectStore("memories") : null;
    const chatParticipantsStore = hasStore("chatParticipants")
      ? tx.objectStore("chatParticipants")
      : null;
    const chatEventsStore = hasStore("chatEvents") ? tx.objectStore("chatEvents") : null;
    const turnJobsStore = hasStore("turnJobs") ? tx.objectStore("turnJobs") : null;
    const relationshipEdgesStore = hasStore("relationshipEdges")
      ? tx.objectStore("relationshipEdges")
      : null;
    const adventureStatesStore = hasStore("adventureStates")
      ? tx.objectStore("adventureStates")
      : null;

    if (chatsStore) {
      await chatsStore.delete(chatId);
    }
    if (messagesStore) {
      const messages = await messagesStore.index("by-chat").getAll(chatId);
      for (const msg of messages) {
        await messagesStore.delete(msg.id);
      }
    }
    if (personaStatesStore) {
      await personaStatesStore.delete(chatId);
    }
    if (personaStatesV2Store) {
      const personaStatesV2Keys = await personaStatesV2Store
        .index("by-chat")
        .getAllKeys(chatId);
      for (const key of personaStatesV2Keys) {
        await personaStatesV2Store.delete(key);
      }
    }
    if (memoriesStore) {
      const memories = await memoriesStore.index("by-chat").getAll(chatId);
      for (const memory of memories) {
        await memoriesStore.delete(memory.id);
      }
    }
    if (chatParticipantsStore) {
      const participantKeys = await chatParticipantsStore
        .index("by-chat")
        .getAllKeys(chatId);
      for (const key of participantKeys) {
        await chatParticipantsStore.delete(key);
      }
    }
    if (chatEventsStore) {
      const eventKeys = await chatEventsStore.index("by-chat").getAllKeys(chatId);
      for (const key of eventKeys) {
        await chatEventsStore.delete(key);
      }
    }
    if (turnJobsStore) {
      const turnJobKeys = await turnJobsStore.index("by-chat").getAllKeys(chatId);
      for (const key of turnJobKeys) {
        await turnJobsStore.delete(key);
      }
    }
    if (relationshipEdgesStore) {
      const relationshipKeys = await relationshipEdgesStore
        .index("by-chat")
        .getAllKeys(chatId);
      for (const key of relationshipKeys) {
        await relationshipEdgesStore.delete(key);
      }
    }
    if (adventureStatesStore) {
      const adventureStateKeys = await adventureStatesStore
        .index("by-chat")
        .getAllKeys(chatId);
      for (const key of adventureStateKeys) {
        await adventureStatesStore.delete(key);
      }
    }
    await tx.done;
  },

  async getMessages(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("messages", "by-chat", chatId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async getAllMessages() {
    const db = await getDb();
    const rows = await db.getAll("messages");
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async saveMessage(message: ChatMessage) {
    const db = await getDb();
    await db.put("messages", message);
  },

  async commitTurnArtifacts({
    chat,
    messages,
    events,
    turnJob,
    adventureState,
  }: {
    chat?: ChatSession;
    messages?: ChatMessage[];
    events?: ChatEvent[];
    turnJob?: TurnJob;
    adventureState?: AdventureState;
  }) {
    const messageBatch = (messages ?? []).filter(Boolean);
    const eventBatch = (events ?? []).filter(Boolean);
    if (
      !chat &&
      !turnJob &&
      !adventureState &&
      messageBatch.length === 0 &&
      eventBatch.length === 0
    ) {
      return;
    }

    const db = await getDb();
    const txStores: StoreName[] = [
      "chats",
      "messages",
      "chatEvents",
      "turnJobs",
    ];
    if (adventureState) {
      txStores.push("adventureStates");
    }
    const tx = db.transaction(txStores, "readwrite");

    if (chat) {
      await tx.objectStore("chats").put(normalizeChatSession(chat));
    }

    if (messageBatch.length > 0) {
      const messagesStore = tx.objectStore("messages");
      for (const message of messageBatch) {
        await messagesStore.put(message);
      }
    }

    if (eventBatch.length > 0) {
      const eventsStore = tx.objectStore("chatEvents");
      for (const event of eventBatch) {
        await eventsStore.put(normalizeChatEvent(event));
      }
    }

    if (turnJob) {
      await tx.objectStore("turnJobs").put(normalizeTurnJob(turnJob));
    }

    if (adventureState) {
      await tx.objectStore("adventureStates").put(normalizeAdventureState(adventureState));
    }

    await tx.done;
  },

  async getPersonaState(chatId: string, personaId?: string) {
    const db = await getDb();
    const normalizedChatId = chatId.trim();
    const normalizedPersonaId = toTrimmedString(personaId);
    if (normalizedPersonaId) {
      const recordId = buildPersonaStateRecordId(normalizedChatId, normalizedPersonaId);
      const v2Record = await db.get("personaStatesV2", recordId);
      if (v2Record) return fromPersonaStateRecord(v2Record);
      const legacyRecord = await db.get("personaStates", normalizedChatId);
      if (legacyRecord?.personaId === normalizedPersonaId) {
        await db.put("personaStatesV2", toPersonaStateRecord(legacyRecord));
        return legacyRecord;
      }
      return undefined;
    }
    const v2Rows = await db.getAllFromIndex("personaStatesV2", "by-chat", normalizedChatId);
    if (v2Rows.length > 0) {
      v2Rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return fromPersonaStateRecord(v2Rows[0]);
    }
    const legacyRecord = await db.get("personaStates", normalizedChatId);
    if (legacyRecord) {
      await db.put("personaStatesV2", toPersonaStateRecord(legacyRecord));
    }
    return legacyRecord ?? undefined;
  },

  async getPersonaStatesByChat(chatId: string) {
    const db = await getDb();
    const normalizedChatId = chatId.trim();
    const rows = await db.getAllFromIndex("personaStatesV2", "by-chat", normalizedChatId);
    const mapped = rows.map((row) => fromPersonaStateRecord(row));
    if (mapped.length > 0) {
      return mapped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const legacyRecord = await db.get("personaStates", normalizedChatId);
    if (!legacyRecord) return [];
    await db.put("personaStatesV2", toPersonaStateRecord(legacyRecord));
    return [legacyRecord];
  },

  async getAllPersonaStates() {
    const db = await getDb();
    const rows = await db.getAll("personaStatesV2");
    if (rows.length > 0) {
      return rows
        .map((row) => fromPersonaStateRecord(row))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const legacyRows = await db.getAll("personaStates");
    if (legacyRows.length > 0) {
      const records = legacyRows.map((row) => toPersonaStateRecord(row));
      await Promise.all(records.map((record) => db.put("personaStatesV2", record)));
      return legacyRows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return [];
  },

  async savePersonaState(state: PersonaRuntimeState) {
    const db = await getDb();
    await db.put("personaStatesV2", toPersonaStateRecord(state));
  },

  async getMemories(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("memories", "by-chat", chatId);
    const normalized = rows.map((row) => normalizeMemoryRecord(row));
    await Promise.all(normalized.map((row) => db.put("memories", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getAllMemories() {
    const db = await getDb();
    const rows = await db.getAll("memories");
    const normalized = rows.map((row) => normalizeMemoryRecord(row));
    await Promise.all(normalized.map((row) => db.put("memories", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveMemories(memories: PersonaMemory[]) {
    if (memories.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("memories", "readwrite");
    for (const memory of memories) {
      await tx.store.put(normalizeMemoryRecord(memory));
    }
    await tx.done;
  },

  async deleteMemories(ids: string[]) {
    if (ids.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("memories", "readwrite");
    for (const memoryId of ids) {
      await tx.store.delete(memoryId);
    }
    await tx.done;
  },

  async getSettings() {
    const db = await getDb();
    const current = await db.get("settings", SETTINGS_KEY);
    return normalizeSettings(current);
  },

  async saveSettings(settings: AppSettings) {
    const db = await getDb();
    await db.put("settings", settings, SETTINGS_KEY);
  },

  async getGeneratorSessions(personaId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("generatorSessions", "by-persona", personaId);
    const normalized = rows.map((row) => normalizeGeneratorSession(row));
    await Promise.all(normalized.map((row) => db.put("generatorSessions", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getAllGeneratorSessions() {
    const db = await getDb();
    const rows = await db.getAll("generatorSessions");
    const normalized = rows.map((row) => normalizeGeneratorSession(row));
    await Promise.all(normalized.map((row) => db.put("generatorSessions", row)));
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getGeneratorSession(sessionId: string) {
    const db = await getDb();
    const row = await db.get("generatorSessions", sessionId);
    if (!row) return null;
    const normalized = normalizeGeneratorSession(row);
    await db.put("generatorSessions", normalized);
    return normalized;
  },

  async saveGeneratorSession(session: GeneratorSession) {
    const db = await getDb();
    await db.put("generatorSessions", normalizeGeneratorSession(session));
  },

  async deleteGeneratorSession(sessionId: string) {
    const db = await getDb();
    await db.delete("generatorSessions", sessionId);
  },

  async getImageAsset(imageId: string) {
    const db = await getDb();
    return db.get("imageAssets", imageId);
  },

  async getImageAssets(imageIds: string[]) {
    const uniqueIds = Array.from(
      new Set(
        imageIds
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    if (uniqueIds.length === 0) return [];
    const db = await getDb();
    const rows = await Promise.all(uniqueIds.map((imageId) => db.get("imageAssets", imageId)));
    return rows.filter((row): row is ImageAsset => Boolean(row));
  },

  async getAllImageAssets() {
    const db = await getDb();
    const rows = await db.getAll("imageAssets");
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveImageAsset(asset: ImageAsset) {
    const db = await getDb();
    await db.put("imageAssets", asset);
  },

  async deleteImageAssets(imageIds: string[]) {
    const uniqueIds = Array.from(
      new Set(
        imageIds
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    if (uniqueIds.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("imageAssets", "readwrite");
    for (const imageId of uniqueIds) {
      await tx.store.delete(imageId);
    }
    await tx.done;
  },

  async getChatParticipants(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("chatParticipants", "by-chat", chatId.trim());
    return rows
      .map((row) => normalizeChatParticipant(row))
      .sort((a, b) => a.order - b.order || a.joinedAt.localeCompare(b.joinedAt));
  },

  async saveChatParticipant(participant: ChatParticipant) {
    const db = await getDb();
    await db.put("chatParticipants", normalizeChatParticipant(participant));
  },

  async saveChatParticipants(participants: ChatParticipant[]) {
    if (participants.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("chatParticipants", "readwrite");
    for (const participant of participants) {
      await tx.store.put(normalizeChatParticipant(participant));
    }
    await tx.done;
  },

  async deleteChatParticipants(chatId: string) {
    const db = await getDb();
    const tx = db.transaction("chatParticipants", "readwrite");
    const keys = await tx.store.index("by-chat").getAllKeys(chatId.trim());
    for (const key of keys) {
      await tx.store.delete(key);
    }
    await tx.done;
  },

  async getChatEvents(chatId: string, limit?: number) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("chatEvents", "by-chat", chatId.trim());
    const normalized = rows
      .map((row) => normalizeChatEvent(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return normalized.slice(-Math.floor(limit));
    }
    return normalized;
  },

  async saveChatEvent(event: ChatEvent) {
    const db = await getDb();
    await db.put("chatEvents", normalizeChatEvent(event));
  },

  async saveChatEvents(events: ChatEvent[]) {
    if (events.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("chatEvents", "readwrite");
    for (const event of events) {
      await tx.store.put(normalizeChatEvent(event));
    }
    await tx.done;
  },

  async deleteChatEvents(chatId: string) {
    const db = await getDb();
    const tx = db.transaction("chatEvents", "readwrite");
    const keys = await tx.store.index("by-chat").getAllKeys(chatId.trim());
    for (const key of keys) {
      await tx.store.delete(key);
    }
    await tx.done;
  },

  async getTurnJobs(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("turnJobs", "by-chat", chatId.trim());
    return rows
      .map((row) => normalizeTurnJob(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async saveTurnJob(job: TurnJob) {
    const db = await getDb();
    await db.put("turnJobs", normalizeTurnJob(job));
  },

  async deleteTurnJob(jobId: string) {
    const db = await getDb();
    await db.delete("turnJobs", jobId.trim());
  },

  async getRelationshipEdges(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("relationshipEdges", "by-chat", chatId.trim());
    return rows
      .map((row) => normalizeRelationshipEdge(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveRelationshipEdge(edge: RelationshipEdge) {
    const db = await getDb();
    await db.put("relationshipEdges", normalizeRelationshipEdge(edge));
  },

  async saveRelationshipEdges(edges: RelationshipEdge[]) {
    if (edges.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("relationshipEdges", "readwrite");
    for (const edge of edges) {
      await tx.store.put(normalizeRelationshipEdge(edge));
    }
    await tx.done;
  },

  async deleteRelationshipEdges(chatId: string) {
    const db = await getDb();
    const tx = db.transaction("relationshipEdges", "readwrite");
    const keys = await tx.store.index("by-chat").getAllKeys(chatId.trim());
    for (const key of keys) {
      await tx.store.delete(key);
    }
    await tx.done;
  },

  async getAdventureScenarios() {
    const db = await getDb();
    const rows = await db.getAll("adventureScenarios");
    return rows
      .map((row) => normalizeAdventureScenario(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getAdventureScenario(scenarioId: string) {
    const db = await getDb();
    const row = await db.get("adventureScenarios", scenarioId.trim());
    if (!row) return null;
    return normalizeAdventureScenario(row);
  },

  async saveAdventureScenario(scenario: AdventureScenario) {
    const db = await getDb();
    await db.put("adventureScenarios", normalizeAdventureScenario(scenario));
  },

  async deleteAdventureScenario(scenarioId: string) {
    const db = await getDb();
    await db.delete("adventureScenarios", scenarioId.trim());
  },

  async getAdventureState(chatId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("adventureStates", "by-chat", chatId.trim());
    const normalized = rows
      .map((row) => normalizeAdventureState(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return normalized[0] ?? null;
  },

  async saveAdventureState(state: AdventureState) {
    const db = await getDb();
    await db.put("adventureStates", normalizeAdventureState(state));
  },

  async deleteAdventureState(chatId: string) {
    const db = await getDb();
    const tx = db.transaction("adventureStates", "readwrite");
    const keys = await tx.store.index("by-chat").getAllKeys(chatId.trim());
    for (const key of keys) {
      await tx.store.delete(key);
    }
    await tx.done;
  },
};

export { DEFAULT_SETTINGS };
