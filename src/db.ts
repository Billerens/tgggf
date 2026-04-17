import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeMemoryRecord } from "./personaDynamics";
import { normalizePersonaRecord } from "./personaProfiles";
import type {
  AppSettings,
  AuthMode,
  ChatMessage,
  ChatSession,
  EndpointAuthConfig,
  EnhanceDetailLevel,
  EnhanceDetailStrengthTable,
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  GroupSnapshot,
  GeneratorSession,
  ImageAsset,
  LlmProvider,
  Persona,
  PersonaMemory,
  PersonaRuntimeState,
  UserGender,
} from "./types";

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
  memories: {
    key: string;
    value: PersonaMemory;
    indexes: {
      "by-chat": string;
      "by-persona": string;
      "by-updatedAt": string;
    };
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
  groupRooms: {
    key: string;
    value: GroupRoom;
    indexes: { "by-updatedAt": string; "by-mode": string };
  };
  groupParticipants: {
    key: string;
    value: GroupParticipant;
    indexes: {
      "by-room": string;
      "by-persona": string;
      "by-updatedAt": string;
    };
  };
  groupMessages: {
    key: string;
    value: GroupMessage;
    indexes: {
      "by-room": string;
      "by-createdAt": string;
      "by-authorPersona": string;
    };
  };
  groupEvents: {
    key: string;
    value: GroupEvent;
    indexes: { "by-room": string; "by-createdAt": string; "by-type": string };
  };
  groupPersonaStates: {
    key: string;
    value: GroupPersonaState;
    indexes: {
      "by-room": string;
      "by-persona": string;
      "by-updatedAt": string;
    };
  };
  groupRelationEdges: {
    key: string;
    value: GroupRelationEdge;
    indexes: {
      "by-room": string;
      "by-source": string;
      "by-target": string;
      "by-updatedAt": string;
    };
  };
  groupSharedMemories: {
    key: string;
    value: GroupMemoryShared;
    indexes: { "by-room": string; "by-updatedAt": string };
  };
  groupPrivateMemories: {
    key: string;
    value: GroupMemoryPrivate;
    indexes: {
      "by-room": string;
      "by-persona": string;
      "by-updatedAt": string;
    };
  };
  groupSnapshots: {
    key: string;
    value: GroupSnapshot;
    indexes: { "by-room": string; "by-createdAt": string };
  };
}

const DB_NAME = "tg-gf-db";
const DB_VERSION = 5;
const SETTINGS_KEY = "main";
const DEV_PROXY_BASE_URL = "/lmstudio";
const FALLBACK_PROD_BASE_URL = "https://t1.tun.uforge.online";
const DEFAULT_COMFY_BASE_URL = "https://t3.tun.uforge.online";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";

const AUTH_MODES: AuthMode[] = ["none", "bearer", "token", "basic", "custom"];
const LLM_PROVIDERS: LlmProvider[] = ["lmstudio", "openrouter", "huggingface"];
const ENHANCE_DETAIL_LEVELS: EnhanceDetailLevel[] = [
  "soft",
  "medium",
  "strong",
];
const IMAGE_ASSET_STORAGE_VERSION = 2;
const IMAGE_ASSET_DATA_URL_PREFIX = "data:";
const ALL_KNOWN_STORE_NAMES = [
  "personas",
  "chats",
  "messages",
  "personaStates",
  "memories",
  "settings",
  "generatorSessions",
  "imageAssets",
  "groupRooms",
  "groupParticipants",
  "groupMessages",
  "groupEvents",
  "groupPersonaStates",
  "groupRelationEdges",
  "groupSharedMemories",
  "groupPrivateMemories",
  "groupSnapshots",
] as const;
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

type StoredImageAsset = Omit<ImageAsset, "dataUrl"> & {
  dataUrl?: string;
  blob?: Blob;
};

const imageAssetDataUrlCache = new Map<string, string>();
let imageAssetMigrationPromise: Promise<void> | null = null;

function isDataUrl(value: string) {
  return value.startsWith(IMAGE_ASSET_DATA_URL_PREFIX);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === "undefined") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("blob_to_data_url_failed"));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string) {
  if (!isDataUrl(dataUrl)) return null;
  try {
    const response = await fetch(dataUrl);
    return await response.blob();
  } catch {
    return null;
  }
}

function toStoredImageAssetRecord(
  asset: ImageAsset | StoredImageAsset,
): StoredImageAsset {
  return {
    id: toTrimmedString(asset.id),
    dataUrl: toTrimmedString(asset.dataUrl),
    blob: asset.blob instanceof Blob ? asset.blob : undefined,
    mimeType: toTrimmedString(asset.mimeType),
    byteSize:
      typeof asset.byteSize === "number" && Number.isFinite(asset.byteSize)
        ? Math.max(0, Math.floor(asset.byteSize))
        : undefined,
    storageVersion:
      typeof asset.storageVersion === "number" &&
      Number.isFinite(asset.storageVersion)
        ? Math.max(1, Math.floor(asset.storageVersion))
        : undefined,
    meta: asset.meta,
    createdAt: toTrimmedString(asset.createdAt) || new Date().toISOString(),
  };
}

async function toBlobStoredImageAsset(
  asset: ImageAsset | StoredImageAsset,
): Promise<StoredImageAsset> {
  const normalized = toStoredImageAssetRecord(asset);
  const normalizedDataUrl = normalized.dataUrl ?? "";
  if (!normalized.id) {
    return {
      ...normalized,
      id: crypto.randomUUID(),
      dataUrl: normalizedDataUrl,
    };
  }

  if (normalized.blob instanceof Blob) {
    return {
      ...normalized,
      dataUrl: "",
      mimeType: normalized.mimeType || normalized.blob.type || undefined,
      byteSize: normalized.byteSize ?? normalized.blob.size,
      storageVersion: IMAGE_ASSET_STORAGE_VERSION,
    };
  }

  if (!normalizedDataUrl || !isDataUrl(normalizedDataUrl)) {
    return {
      ...normalized,
      dataUrl: normalizedDataUrl,
    };
  }

  const blob = await dataUrlToBlob(normalizedDataUrl);
  if (!(blob instanceof Blob)) {
    return {
      ...normalized,
      dataUrl: normalizedDataUrl,
    };
  }

  return {
    ...normalized,
    dataUrl: "",
    blob,
    mimeType: normalized.mimeType || blob.type || undefined,
    byteSize: normalized.byteSize ?? blob.size,
    storageVersion: IMAGE_ASSET_STORAGE_VERSION,
  };
}

async function hydrateImageAssetRecord(
  asset: ImageAsset | StoredImageAsset,
): Promise<ImageAsset | null> {
  const normalized = toStoredImageAssetRecord(asset);
  if (!normalized.id) return null;

  let dataUrl = normalized.dataUrl ?? "";
  if (!dataUrl) {
    const cached = imageAssetDataUrlCache.get(normalized.id);
    if (cached) {
      dataUrl = cached;
    }
  }

  if (!dataUrl && normalized.blob instanceof Blob) {
    dataUrl = await blobToDataUrl(normalized.blob).catch(() => "");
  }

  if (dataUrl) {
    imageAssetDataUrlCache.set(normalized.id, dataUrl);
  } else {
    imageAssetDataUrlCache.delete(normalized.id);
  }

  return {
    id: normalized.id,
    dataUrl,
    mimeType: normalized.mimeType,
    byteSize: normalized.byteSize,
    storageVersion: normalized.storageVersion,
    meta: normalized.meta,
    createdAt: normalized.createdAt,
  };
}

async function serializeRawImageAssetRecord(asset: unknown): Promise<unknown> {
  if (!asset || typeof asset !== "object") return asset;
  const normalized = toStoredImageAssetRecord(asset as StoredImageAsset);
  const blob = normalized.blob;
  if (!(blob instanceof Blob)) {
    return {
      ...normalized,
      blob: undefined,
    };
  }

  const cached = imageAssetDataUrlCache.get(normalized.id) ?? "";
  const dataUrl = cached || (await blobToDataUrl(blob).catch(() => ""));
  return {
    id: normalized.id,
    dataUrl,
    mimeType: normalized.mimeType || blob.type || undefined,
    byteSize: normalized.byteSize ?? blob.size,
    storageVersion: normalized.storageVersion ?? IMAGE_ASSET_STORAGE_VERSION,
    meta: normalized.meta,
    createdAt: normalized.createdAt,
  };
}

async function migrateImageAssetsToBlobStorage(db: IDBPDatabase<TgGfDb>) {
  if (!db.objectStoreNames.contains("imageAssets")) return;

  const scanTx = db.transaction("imageAssets", "readonly");
  const rows = await scanTx.store.getAll();
  await scanTx.done;

  for (const row of rows) {
    const normalized = toStoredImageAssetRecord(row as StoredImageAsset);
    const dataUrl = normalized.dataUrl ?? "";
    if (!dataUrl || !isDataUrl(dataUrl)) continue;
    if (
      normalized.blob instanceof Blob &&
      normalized.storageVersion === IMAGE_ASSET_STORAGE_VERSION
    ) {
      continue;
    }
    const blob = await dataUrlToBlob(dataUrl);
    if (!(blob instanceof Blob)) continue;
    await db.put("imageAssets", {
      ...normalized,
      dataUrl: "",
      blob,
      mimeType: normalized.mimeType || blob.type || undefined,
      byteSize: normalized.byteSize ?? blob.size,
      storageVersion: IMAGE_ASSET_STORAGE_VERSION,
    });
    imageAssetDataUrlCache.set(normalized.id, dataUrl);
  }
}

function toTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value).trim();
  }
  return "";
}

const GROUP_ROOM_MODES: GroupRoom["mode"][] = [
  "personas_only",
  "personas_plus_user",
];
const GROUP_ROOM_STATUSES: GroupRoom["status"][] = [
  "active",
  "paused",
  "archived",
];
const GROUP_ROOM_PHASES: GroupRoom["state"]["phase"][] = [
  "idle",
  "orchestrating",
  "generating",
  "committing",
  "waiting_user",
  "paused",
  "error",
];

function toOptionalTrimmedString(value: unknown): string | undefined {
  const normalized = toTrimmedString(value);
  return normalized || undefined;
}

function toIsoDateString(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const normalized = toTrimmedString(value);
  if (!normalized) return fallback;
  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return fallback;
}

function normalizeGroupRoomRecord(room: GroupRoom): GroupRoom {
  const source = (room ?? {}) as Partial<GroupRoom> & {
    state?: Partial<GroupRoom["state"]> | null;
  };
  const nowIso = new Date().toISOString();

  const id = toTrimmedString(source.id);
  const updatedAt = toIsoDateString(source.updatedAt, nowIso);
  const createdAt = toIsoDateString(source.createdAt, updatedAt);
  const mode = GROUP_ROOM_MODES.includes(source.mode as GroupRoom["mode"])
    ? (source.mode as GroupRoom["mode"])
    : "personas_plus_user";
  const status = GROUP_ROOM_STATUSES.includes(
    source.status as GroupRoom["status"],
  )
    ? (source.status as GroupRoom["status"])
    : "paused";
  const waitingForUser = Boolean(source.waitingForUser);
  const waitingReason = toOptionalTrimmedString(source.waitingReason);

  const stateSource = (source.state ?? {}) as Partial<GroupRoom["state"]>;
  const stateTurnId = toOptionalTrimmedString(stateSource.turnId);
  const stateSpeakerPersonaId = toOptionalTrimmedString(
    stateSource.speakerPersonaId,
  );
  const stateReason = toOptionalTrimmedString(stateSource.reason);
  const stateError = toOptionalTrimmedString(stateSource.error);
  const fallbackPhase: GroupRoom["state"]["phase"] =
    status === "paused" ? "paused" : waitingForUser ? "waiting_user" : "idle";
  const statePhase = GROUP_ROOM_PHASES.includes(
    stateSource.phase as GroupRoom["state"]["phase"],
  )
    ? (stateSource.phase as GroupRoom["state"]["phase"])
    : fallbackPhase;
  const stateUpdatedAt = toIsoDateString(stateSource.updatedAt, updatedAt);

  const lastTickAtRaw = toOptionalTrimmedString(source.lastTickAt);
  const lastResponseId = toOptionalTrimmedString(source.lastResponseId);
  const orchestratorUserFocusMessageId = toOptionalTrimmedString(
    source.orchestratorUserFocusMessageId,
  );

  return {
    id,
    title: toTrimmedString(source.title) || "Групповой чат",
    mode,
    status,
    state: {
      phase: statePhase,
      updatedAt: stateUpdatedAt,
      ...(stateTurnId ? { turnId: stateTurnId } : {}),
      ...(stateSpeakerPersonaId
        ? { speakerPersonaId: stateSpeakerPersonaId }
        : {}),
      ...(stateReason ? { reason: stateReason } : {}),
      ...(stateError ? { error: stateError } : {}),
    },
    waitingForUser,
    ...(waitingReason ? { waitingReason } : {}),
    ...(lastTickAtRaw
      ? { lastTickAt: toIsoDateString(lastTickAtRaw, updatedAt) }
      : {}),
    ...(lastResponseId ? { lastResponseId } : {}),
    ...(orchestratorUserFocusMessageId
      ? { orchestratorUserFocusMessageId }
      : {}),
    orchestratorVersion: toTrimmedString(source.orchestratorVersion) || "v0",
    createdAt,
    updatedAt,
  };
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
      i2iBase: clampDetailStrengthValue(
        typedRawLevel.i2iBase,
        fallback.i2iBase,
      ),
      i2iHires: clampDetailStrengthValue(
        typedRawLevel.i2iHires,
        fallback.i2iHires,
      ),
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

function normalizeSettings(
  current: Partial<AppSettings> | undefined,
): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(current ?? {}) };
  const mergedRecord = merged as AppSettings & Record<string, unknown>;
  // Legacy Android rollout flags are deprecated in native-only mode.
  // Remove persisted stale values from older builds to avoid accidental reuse.
  delete mergedRecord.androidNativeGroupImagesV1;
  delete mergedRecord.androidNativeGroupImagesV1Disable;
  delete mergedRecord.androidNativeGroupIterationV1;

  const trimmedBaseUrl = toTrimmedString(merged.lmBaseUrl);
  if (!trimmedBaseUrl) {
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else if (!import.meta.env.DEV && trimmedBaseUrl === DEV_PROXY_BASE_URL) {
    // Auto-fix old persisted dev proxy URL in production static builds.
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else {
    merged.lmBaseUrl = trimmedBaseUrl;
  }

  merged.openRouterBaseUrl =
    toTrimmedString(merged.openRouterBaseUrl) ||
    DEFAULT_SETTINGS.openRouterBaseUrl;
  merged.huggingFaceBaseUrl =
    toTrimmedString(merged.huggingFaceBaseUrl) ||
    DEFAULT_SETTINGS.huggingFaceBaseUrl;

  merged.oneToOneProvider = LLM_PROVIDERS.includes(merged.oneToOneProvider)
    ? merged.oneToOneProvider
    : DEFAULT_SETTINGS.oneToOneProvider;
  merged.groupOrchestratorProvider = LLM_PROVIDERS.includes(
    merged.groupOrchestratorProvider,
  )
    ? merged.groupOrchestratorProvider
    : DEFAULT_SETTINGS.groupOrchestratorProvider;
  merged.groupPersonaProvider = LLM_PROVIDERS.includes(
    merged.groupPersonaProvider,
  )
    ? merged.groupPersonaProvider
    : DEFAULT_SETTINGS.groupPersonaProvider;
  merged.imagePromptProvider = LLM_PROVIDERS.includes(
    merged.imagePromptProvider,
  )
    ? merged.imagePromptProvider
    : DEFAULT_SETTINGS.imagePromptProvider;
  merged.personaGenerationProvider = LLM_PROVIDERS.includes(
    merged.personaGenerationProvider,
  )
    ? merged.personaGenerationProvider
    : DEFAULT_SETTINGS.personaGenerationProvider;

  merged.model = toTrimmedString(merged.model) || DEFAULT_SETTINGS.model;
  merged.groupOrchestratorModel =
    toTrimmedString(merged.groupOrchestratorModel) ||
    merged.model ||
    DEFAULT_SETTINGS.model;
  merged.groupPersonaModel =
    toTrimmedString(merged.groupPersonaModel) ||
    merged.model ||
    DEFAULT_SETTINGS.model;
  merged.imagePromptModel =
    toTrimmedString(merged.imagePromptModel) ||
    merged.model ||
    DEFAULT_SETTINGS.model;
  merged.personaGenerationModel =
    toTrimmedString(merged.personaGenerationModel) ||
    merged.model ||
    DEFAULT_SETTINGS.model;
  merged.comfyBaseUrl =
    toTrimmedString(merged.comfyBaseUrl) || DEFAULT_SETTINGS.comfyBaseUrl;
  merged.googleDriveClientId = toTrimmedString(merged.googleDriveClientId);
  merged.googleDriveFolderId = toTrimmedString(merged.googleDriveFolderId);
  merged.saveComfyOutputs = Boolean(merged.saveComfyOutputs);
  if (!Number.isFinite(merged.chatStyleStrength)) {
    merged.chatStyleStrength = DEFAULT_SETTINGS.chatStyleStrength;
  }
  merged.chatStyleStrength = Math.max(
    0,
    Math.min(1, Number(merged.chatStyleStrength)),
  );
  merged.apiKey = toTrimmedString(merged.apiKey);
  merged.lmAuth = normalizeAuthConfig(merged.lmAuth, DEFAULT_SETTINGS.lmAuth);
  merged.openRouterAuth = normalizeAuthConfig(
    merged.openRouterAuth,
    DEFAULT_SETTINGS.openRouterAuth,
  );
  merged.huggingFaceAuth = normalizeAuthConfig(
    merged.huggingFaceAuth,
    DEFAULT_SETTINGS.huggingFaceAuth,
  );
  merged.comfyAuth = normalizeAuthConfig(
    merged.comfyAuth,
    DEFAULT_SETTINGS.comfyAuth,
  );
  merged.userName =
    toTrimmedString(merged.userName) || DEFAULT_SETTINGS.userName;

  // Backward compatibility for old single API key setting.
  if (!merged.lmAuth.token && merged.apiKey) {
    merged.lmAuth = {
      ...merged.lmAuth,
      mode: "bearer",
      token: merged.apiKey,
    };
  }
  if (!merged.openRouterAuth.token && merged.apiKey) {
    merged.openRouterAuth = {
      ...merged.openRouterAuth,
      mode: "bearer",
      token: merged.apiKey,
    };
  }
  if (!merged.huggingFaceAuth.token && merged.apiKey) {
    merged.huggingFaceAuth = {
      ...merged.huggingFaceAuth,
      mode: "bearer",
      token: merged.apiKey,
    };
  }
  const allowedGenders: UserGender[] = [
    "unspecified",
    "male",
    "female",
    "nonbinary",
  ];
  if (!allowedGenders.includes(merged.userGender)) {
    merged.userGender = DEFAULT_SETTINGS.userGender;
  }
  merged.showSystemImageBlock = Boolean(merged.showSystemImageBlock);
  merged.showStatusChangeDetails = Boolean(merged.showStatusChangeDetails);
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
  if (
    typeof next.chatStyleStrength === "number" &&
    Number.isFinite(next.chatStyleStrength)
  ) {
    next.chatStyleStrength = Math.max(
      0,
      Math.min(1, Number(next.chatStyleStrength)),
    );
  } else {
    delete next.chatStyleStrength;
  }
  const normalizeSummaryList = (
    input: unknown,
    maxItems = 10,
    maxLen = 220,
  ) => {
    if (!Array.isArray(input)) return [] as string[];
    return input
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .map((item) =>
        item.length > maxLen
          ? `${item.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
          : item,
      )
      .slice(0, maxItems);
  };
  const summaryText = toTrimmedString(next.conversationSummary);
  if (summaryText) {
    next.conversationSummary =
      summaryText.length > 6000
        ? `${summaryText.slice(0, 5999).trimEnd()}…`
        : summaryText;
  } else {
    delete next.conversationSummary;
  }
  next.summaryFacts = normalizeSummaryList(next.summaryFacts, 10, 180);
  next.summaryGoals = normalizeSummaryList(next.summaryGoals, 8, 180);
  next.summaryOpenThreads = normalizeSummaryList(
    next.summaryOpenThreads,
    10,
    200,
  );
  next.summaryAgreements = normalizeSummaryList(next.summaryAgreements, 8, 200);
  if (!next.summaryFacts.length) delete next.summaryFacts;
  if (!next.summaryGoals.length) delete next.summaryGoals;
  if (!next.summaryOpenThreads.length) delete next.summaryOpenThreads;
  if (!next.summaryAgreements.length) delete next.summaryAgreements;
  const cursor = toTrimmedString(next.summaryCursorMessageId);
  if (cursor) {
    next.summaryCursorMessageId = cursor;
  } else {
    delete next.summaryCursorMessageId;
  }
  const summaryUpdatedAt = toTrimmedString(next.summaryUpdatedAt);
  if (summaryUpdatedAt) {
    next.summaryUpdatedAt = summaryUpdatedAt;
  } else {
    delete next.summaryUpdatedAt;
  }
  if (
    typeof next.summaryTokenBudget === "number" &&
    Number.isFinite(next.summaryTokenBudget)
  ) {
    const normalizedBudget = Math.max(
      600,
      Math.min(3000, Math.round(next.summaryTokenBudget)),
    );
    // Migrate legacy low values to the current default budget.
    next.summaryTokenBudget = Math.max(3000, normalizedBudget);
  } else {
    delete next.summaryTokenBudget;
  }
  return next;
}

function normalizeGeneratorSession(
  session: GeneratorSession,
): GeneratorSession {
  const normalizedName = toTrimmedString((session as { name?: string }).name);
  const next: GeneratorSession = {
    ...session,
    name: normalizedName || "Новая сессия",
    topic: session.topic.trim(),
    status:
      session.status === "running" ||
      session.status === "stopped" ||
      session.status === "completed" ||
      session.status === "error"
        ? session.status
        : "stopped",
    requestedCount:
      typeof session.requestedCount === "number" &&
      Number.isFinite(session.requestedCount)
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
            iteration: Number.isFinite(entry.iteration)
              ? Math.max(1, Math.floor(entry.iteration))
              : 1,
            prompt: (entry.prompt ?? "").trim(),
            imageUrls: Array.isArray(entry.imageUrls)
              ? entry.imageUrls.map((url) => (url ?? "").trim()).filter(Boolean)
              : [],
            imageMetaByUrl:
              entry.imageMetaByUrl && typeof entry.imageMetaByUrl === "object"
                ? Object.fromEntries(
                    Object.entries(entry.imageMetaByUrl).filter(
                      ([key, value]) =>
                        Boolean(key) &&
                        Boolean(value && typeof value === "object"),
                    ),
                  )
                : undefined,
          }))
      : [],
  };
  return next;
}

const DEFAULT_SETTINGS: AppSettings = {
  lmBaseUrl: resolveDefaultBaseUrl(),
  openRouterBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
  huggingFaceBaseUrl: DEFAULT_HUGGINGFACE_BASE_URL,
  comfyBaseUrl: DEFAULT_COMFY_BASE_URL,
  googleDriveClientId: "",
  googleDriveFolderId: "",
  saveComfyOutputs: false,
  oneToOneProvider: "lmstudio",
  groupOrchestratorProvider: "lmstudio",
  groupPersonaProvider: "lmstudio",
  imagePromptProvider: "lmstudio",
  personaGenerationProvider: "lmstudio",
  model: "local-model",
  groupOrchestratorModel: "local-model",
  groupPersonaModel: "local-model",
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
  openRouterAuth: {
    mode: "none",
    token: "",
    username: "",
    password: "",
    headerName: "Authorization",
    headerPrefix: "Bearer",
  },
  huggingFaceAuth: {
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
  userName: "Пользователь",
  userGender: "unspecified",
  showSystemImageBlock: true,
  showStatusChangeDetails: false,
  enhanceDetailLevelAll: "medium",
  enhanceDetailLevelPart: "strong",
  enhanceDetailStrengthTable: normalizeEnhanceDetailStrengthTable(undefined),
};

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
      upgrade(db) {
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
          const personaStates = db.createObjectStore("personaStates", {
            keyPath: "chatId",
          });
          personaStates.createIndex("by-persona", "personaId");
          personaStates.createIndex("by-updatedAt", "updatedAt");
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
          const sessions = db.createObjectStore("generatorSessions", {
            keyPath: "id",
          });
          sessions.createIndex("by-persona", "personaId");
          sessions.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("imageAssets")) {
          const imageAssets = db.createObjectStore("imageAssets", {
            keyPath: "id",
          });
          imageAssets.createIndex("by-createdAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("groupRooms")) {
          const groupRooms = db.createObjectStore("groupRooms", {
            keyPath: "id",
          });
          groupRooms.createIndex("by-updatedAt", "updatedAt");
          groupRooms.createIndex("by-mode", "mode");
        }

        if (!db.objectStoreNames.contains("groupParticipants")) {
          const groupParticipants = db.createObjectStore("groupParticipants", {
            keyPath: "id",
          });
          groupParticipants.createIndex("by-room", "roomId");
          groupParticipants.createIndex("by-persona", "personaId");
          groupParticipants.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("groupMessages")) {
          const groupMessages = db.createObjectStore("groupMessages", {
            keyPath: "id",
          });
          groupMessages.createIndex("by-room", "roomId");
          groupMessages.createIndex("by-createdAt", "createdAt");
          groupMessages.createIndex("by-authorPersona", "authorPersonaId");
        }

        if (!db.objectStoreNames.contains("groupEvents")) {
          const groupEvents = db.createObjectStore("groupEvents", {
            keyPath: "id",
          });
          groupEvents.createIndex("by-room", "roomId");
          groupEvents.createIndex("by-createdAt", "createdAt");
          groupEvents.createIndex("by-type", "type");
        }

        if (!db.objectStoreNames.contains("groupPersonaStates")) {
          const groupPersonaStates = db.createObjectStore(
            "groupPersonaStates",
            { keyPath: "id" },
          );
          groupPersonaStates.createIndex("by-room", "roomId");
          groupPersonaStates.createIndex("by-persona", "personaId");
          groupPersonaStates.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("groupRelationEdges")) {
          const groupRelationEdges = db.createObjectStore(
            "groupRelationEdges",
            { keyPath: "id" },
          );
          groupRelationEdges.createIndex("by-room", "roomId");
          groupRelationEdges.createIndex("by-source", "fromPersonaId");
          groupRelationEdges.createIndex("by-target", "toPersonaId");
          groupRelationEdges.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("groupSharedMemories")) {
          const groupSharedMemories = db.createObjectStore(
            "groupSharedMemories",
            { keyPath: "id" },
          );
          groupSharedMemories.createIndex("by-room", "roomId");
          groupSharedMemories.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("groupPrivateMemories")) {
          const groupPrivateMemories = db.createObjectStore(
            "groupPrivateMemories",
            { keyPath: "id" },
          );
          groupPrivateMemories.createIndex("by-room", "roomId");
          groupPrivateMemories.createIndex("by-persona", "personaId");
          groupPrivateMemories.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("groupSnapshots")) {
          const groupSnapshots = db.createObjectStore("groupSnapshots", {
            keyPath: "id",
          });
          groupSnapshots.createIndex("by-room", "roomId");
          groupSnapshots.createIndex("by-createdAt", "createdAt");
        }
      },
    }).catch((error) => {
      if (!isVersionDowngradeError(error)) {
        throw error;
      }
      // Fallback: open at current on-disk version to keep app operational after stale bundle races.
      return openDB<TgGfDb>(DB_NAME);
    });
  }

  return dbPromise.then(async (db) => {
    if (!imageAssetMigrationPromise) {
      imageAssetMigrationPromise = migrateImageAssetsToBlobStorage(db);
    }
    try {
      await imageAssetMigrationPromise;
    } catch {
      // Non-fatal: keep app operational and continue with lazy hydration.
    }
    return db;
  });
}

export const dbApi = {
  async clearAllData() {
    const db = await getDb();
    const existingStoreNames = Array.from(db.objectStoreNames).map((name) =>
      String(name),
    );
    const existingStoreSet = new Set(existingStoreNames);
    const targetStores = ALL_KNOWN_STORE_NAMES.filter((storeName) =>
      existingStoreSet.has(storeName),
    );
    const missingStores = ALL_KNOWN_STORE_NAMES.filter(
      (storeName) => !existingStoreSet.has(storeName),
    );

    if (targetStores.length === 0) return;

    try {
      const tx = db.transaction(targetStores as never, "readwrite");
      for (const storeName of targetStores) {
        await tx.objectStore(storeName as never).clear();
      }
      await tx.done;
      imageAssetDataUrlCache.clear();
      imageAssetMigrationPromise = null;
    } catch (error) {
      const baseMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          "IndexedDB clearAllData failed.",
          `existingStores=${existingStoreNames.join(",") || "(none)"}`,
          `targetStores=${targetStores.join(",") || "(none)"}`,
          `missingKnownStores=${missingStores.join(",") || "(none)"}`,
          `cause=${baseMessage}`,
        ].join(" "),
      );
    }
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
    const tx = db.transaction(
      [
        "personas",
        "chats",
        "messages",
        "personaStates",
        "memories",
        "generatorSessions",
        "groupParticipants",
        "groupPersonaStates",
        "groupRelationEdges",
        "groupPrivateMemories",
      ],
      "readwrite",
    );
    await tx.objectStore("personas").delete(personaId);
    const personaStateKeys = await tx
      .objectStore("personaStates")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of personaStateKeys) {
      await tx.objectStore("personaStates").delete(key);
    }
    const memoryKeys = await tx
      .objectStore("memories")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of memoryKeys) {
      await tx.objectStore("memories").delete(key);
    }

    const chats = await tx
      .objectStore("chats")
      .index("by-persona")
      .getAll(personaId);
    for (const chat of chats) {
      await tx.objectStore("chats").delete(chat.id);
      const messages = await tx
        .objectStore("messages")
        .index("by-chat")
        .getAll(chat.id);
      for (const msg of messages) {
        await tx.objectStore("messages").delete(msg.id);
      }
      await tx.objectStore("personaStates").delete(chat.id);
      const memories = await tx
        .objectStore("memories")
        .index("by-chat")
        .getAll(chat.id);
      for (const memory of memories) {
        await tx.objectStore("memories").delete(memory.id);
      }
    }

    const generatorSessionKeys = await tx
      .objectStore("generatorSessions")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of generatorSessionKeys) {
      await tx.objectStore("generatorSessions").delete(key);
    }

    const groupParticipantKeys = await tx
      .objectStore("groupParticipants")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of groupParticipantKeys) {
      await tx.objectStore("groupParticipants").delete(key);
    }

    const groupPersonaStateKeys = await tx
      .objectStore("groupPersonaStates")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of groupPersonaStateKeys) {
      await tx.objectStore("groupPersonaStates").delete(key);
    }

    const groupPrivateMemoryKeys = await tx
      .objectStore("groupPrivateMemories")
      .index("by-persona")
      .getAllKeys(personaId);
    for (const key of groupPrivateMemoryKeys) {
      await tx.objectStore("groupPrivateMemories").delete(key);
    }

    const relationBySource = await tx
      .objectStore("groupRelationEdges")
      .index("by-source")
      .getAllKeys(personaId);
    for (const key of relationBySource) {
      await tx.objectStore("groupRelationEdges").delete(key);
    }
    const relationByTarget = await tx
      .objectStore("groupRelationEdges")
      .index("by-target")
      .getAllKeys(personaId);
    for (const key of relationByTarget) {
      await tx.objectStore("groupRelationEdges").delete(key);
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

  async deleteChat(chatId: string) {
    const db = await getDb();
    const tx = db.transaction(
      ["chats", "messages", "personaStates", "memories"],
      "readwrite",
    );
    await tx.objectStore("chats").delete(chatId);
    const messages = await tx
      .objectStore("messages")
      .index("by-chat")
      .getAll(chatId);
    for (const msg of messages) {
      await tx.objectStore("messages").delete(msg.id);
    }
    await tx.objectStore("personaStates").delete(chatId);
    const memories = await tx
      .objectStore("memories")
      .index("by-chat")
      .getAll(chatId);
    for (const memory of memories) {
      await tx.objectStore("memories").delete(memory.id);
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

  async getPersonaState(chatId: string) {
    const db = await getDb();
    return db.get("personaStates", chatId);
  },

  async getAllPersonaStates() {
    const db = await getDb();
    const rows = await db.getAll("personaStates");
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async savePersonaState(state: PersonaRuntimeState) {
    const db = await getDb();
    await db.put("personaStates", state);
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
    const rows = await db.getAllFromIndex(
      "generatorSessions",
      "by-persona",
      personaId,
    );
    const normalized = rows.map((row) => normalizeGeneratorSession(row));
    await Promise.all(
      normalized.map((row) => db.put("generatorSessions", row)),
    );
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getAllGeneratorSessions() {
    const db = await getDb();
    const rows = await db.getAll("generatorSessions");
    const normalized = rows.map((row) => normalizeGeneratorSession(row));
    await Promise.all(
      normalized.map((row) => db.put("generatorSessions", row)),
    );
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
    const row = await db.get("imageAssets", imageId);
    if (!row) return null;
    return hydrateImageAssetRecord(row as StoredImageAsset);
  },

  async getImageAssets(imageIds: string[]) {
    const uniqueIds = Array.from(
      new Set(imageIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return [];
    const db = await getDb();
    const rows = await Promise.all(
      uniqueIds.map((imageId) => db.get("imageAssets", imageId)),
    );
    const hydrated = await Promise.all(
      rows
        .filter((row): row is ImageAsset => Boolean(row))
        .map((row) => hydrateImageAssetRecord(row as StoredImageAsset)),
    );
    return hydrated.filter((row): row is ImageAsset => Boolean(row));
  },

  async getAllImageAssets() {
    const db = await getDb();
    const rows = await db.getAll("imageAssets");
    const hydrated = await Promise.all(
      rows.map((row) => hydrateImageAssetRecord(row as StoredImageAsset)),
    );
    return hydrated
      .filter((row): row is ImageAsset => Boolean(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveImageAsset(asset: ImageAsset) {
    const db = await getDb();
    const stored = await toBlobStoredImageAsset(asset);
    await db.put("imageAssets", stored as ImageAsset);
    const cachedDataUrl = toTrimmedString(asset.dataUrl);
    if (cachedDataUrl) {
      imageAssetDataUrlCache.set(stored.id, cachedDataUrl);
    } else {
      imageAssetDataUrlCache.delete(stored.id);
    }
  },

  async deleteImageAssets(imageIds: string[]) {
    const uniqueIds = Array.from(
      new Set(imageIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("imageAssets", "readwrite");
    for (const imageId of uniqueIds) {
      await tx.store.delete(imageId);
      imageAssetDataUrlCache.delete(imageId);
    }
    await tx.done;
  },

  async getGroupRooms() {
    const db = await getDb();
    const rows = await db.getAll("groupRooms");
    const normalized = rows
      .map((row) => normalizeGroupRoomRecord(row as GroupRoom))
      .filter((room) => room.id);
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getGroupRoom(roomId: string) {
    const db = await getDb();
    const row = await db.get("groupRooms", roomId);
    if (!row) return undefined;
    const normalized = normalizeGroupRoomRecord(row as GroupRoom);
    if (!normalized.id) return undefined;
    return normalized;
  },

  async saveGroupRoom(room: GroupRoom) {
    const db = await getDb();
    const normalized = normalizeGroupRoomRecord(room);
    if (!normalized.id) {
      throw new Error("group_room_id_missing");
    }
    await db.put("groupRooms", normalized);
  },

  async deleteGroupRoom(roomId: string) {
    const db = await getDb();
    const tx = db.transaction(
      [
        "groupRooms",
        "groupParticipants",
        "groupMessages",
        "groupEvents",
        "groupPersonaStates",
        "groupRelationEdges",
        "groupSharedMemories",
        "groupPrivateMemories",
        "groupSnapshots",
      ],
      "readwrite",
    );

    await tx.objectStore("groupRooms").delete(roomId);

    const byRoomStores: Array<
      | "groupParticipants"
      | "groupMessages"
      | "groupEvents"
      | "groupPersonaStates"
      | "groupRelationEdges"
      | "groupSharedMemories"
      | "groupPrivateMemories"
      | "groupSnapshots"
    > = [
      "groupParticipants",
      "groupMessages",
      "groupEvents",
      "groupPersonaStates",
      "groupRelationEdges",
      "groupSharedMemories",
      "groupPrivateMemories",
      "groupSnapshots",
    ];

    for (const storeName of byRoomStores) {
      const keys = await tx
        .objectStore(storeName)
        .index("by-room")
        .getAllKeys(roomId);
      for (const key of keys) {
        await tx.objectStore(storeName).delete(key);
      }
    }

    await tx.done;
  },

  async getGroupParticipants(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex(
      "groupParticipants",
      "by-room",
      roomId,
    );
    return rows.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  },

  async saveGroupParticipant(participant: GroupParticipant) {
    const db = await getDb();
    await db.put("groupParticipants", participant);
  },

  async saveGroupParticipants(participants: GroupParticipant[]) {
    if (participants.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupParticipants", "readwrite");
    for (const participant of participants) {
      await tx.store.put(participant);
    }
    await tx.done;
  },

  async deleteGroupParticipant(participantId: string) {
    const db = await getDb();
    await db.delete("groupParticipants", participantId);
  },

  async getGroupMessages(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("groupMessages", "by-room", roomId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async saveGroupMessage(message: GroupMessage) {
    const db = await getDb();
    await db.put("groupMessages", message);
  },

  async getGroupEvents(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("groupEvents", "by-room", roomId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async saveGroupEvent(event: GroupEvent) {
    const db = await getDb();
    await db.put("groupEvents", event);
  },

  async appendGroupEvents(events: GroupEvent[]) {
    if (events.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupEvents", "readwrite");
    for (const event of events) {
      await tx.store.put(event);
    }
    await tx.done;
  },

  async getGroupPersonaStates(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex(
      "groupPersonaStates",
      "by-room",
      roomId,
    );
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveGroupPersonaState(state: GroupPersonaState) {
    const db = await getDb();
    await db.put("groupPersonaStates", state);
  },

  async saveGroupPersonaStates(states: GroupPersonaState[]) {
    if (states.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupPersonaStates", "readwrite");
    for (const state of states) {
      await tx.store.put(state);
    }
    await tx.done;
  },

  async getGroupRelationEdges(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex(
      "groupRelationEdges",
      "by-room",
      roomId,
    );
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveGroupRelationEdges(edges: GroupRelationEdge[]) {
    if (edges.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupRelationEdges", "readwrite");
    for (const edge of edges) {
      await tx.store.put(edge);
    }
    await tx.done;
  },

  async getGroupSharedMemories(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex(
      "groupSharedMemories",
      "by-room",
      roomId,
    );
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveGroupSharedMemories(memories: GroupMemoryShared[]) {
    if (memories.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupSharedMemories", "readwrite");
    for (const memory of memories) {
      await tx.store.put(memory);
    }
    await tx.done;
  },

  async deleteGroupSharedMemories(memoryIds: string[]) {
    const uniqueIds = Array.from(
      new Set(memoryIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupSharedMemories", "readwrite");
    for (const memoryId of uniqueIds) {
      await tx.store.delete(memoryId);
    }
    await tx.done;
  },

  async getGroupPrivateMemories(roomId: string, personaId?: string) {
    const db = await getDb();
    if (personaId?.trim()) {
      const rows = await db.getAllFromIndex(
        "groupPrivateMemories",
        "by-persona",
        personaId.trim(),
      );
      return rows
        .filter((row) => row.roomId === roomId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const rows = await db.getAllFromIndex(
      "groupPrivateMemories",
      "by-room",
      roomId,
    );
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveGroupPrivateMemories(memories: GroupMemoryPrivate[]) {
    if (memories.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupPrivateMemories", "readwrite");
    for (const memory of memories) {
      await tx.store.put(memory);
    }
    await tx.done;
  },

  async deleteGroupPrivateMemories(memoryIds: string[]) {
    const uniqueIds = Array.from(
      new Set(memoryIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return;
    const db = await getDb();
    const tx = db.transaction("groupPrivateMemories", "readwrite");
    for (const memoryId of uniqueIds) {
      await tx.store.delete(memoryId);
    }
    await tx.done;
  },

  async getGroupSnapshots(roomId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("groupSnapshots", "by-room", roomId);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveGroupSnapshot(snapshot: GroupSnapshot) {
    const db = await getDb();
    await db.put("groupSnapshots", snapshot);
  },

  async exportRawSnapshot() {
    const db = await getDb();
    const snapshot: Record<
      string,
      Array<{ key: unknown; value: unknown }>
    > = {};
    const storeNames = Array.from(db.objectStoreNames);
    for (const storeName of storeNames) {
      const tx = db.transaction(storeName as never, "readonly");
      const store = tx.store;
      const [keys, values] = await Promise.all([
        store.getAllKeys(),
        store.getAll(),
      ]);
      const serializedValues =
        storeName === "imageAssets"
          ? await Promise.all(
              values.map((value) => serializeRawImageAssetRecord(value)),
            )
          : values;
      snapshot[storeName] = values.map((_, index) => ({
        key: keys[index],
        value: serializedValues[index],
      }));
      await tx.done;
    }
    return snapshot;
  },

  async importRawSnapshot(
    snapshot: Record<string, unknown[]>,
    mode: "merge" | "replace" = "merge",
  ) {
    if (mode === "replace") {
      await this.clearAllData();
    }

    const db = await getDb();
    const storeNames = Array.from(db.objectStoreNames);

    for (const storeName of storeNames) {
      const rows = Array.isArray(snapshot[storeName])
        ? snapshot[storeName]
        : [];
      if (rows.length === 0) continue;
      const tx = db.transaction(storeName as never, "readwrite");
      const hasInlineKey = tx.store.keyPath !== null;
      for (const row of rows) {
        const isEntryShape =
          row &&
          typeof row === "object" &&
          "value" in (row as Record<string, unknown>);
        if (isEntryShape) {
          const entry = row as { key?: unknown; value: unknown };
          if (!hasInlineKey && entry.key !== undefined) {
            await tx.store.put(entry.value as never, entry.key as never);
          } else if (!hasInlineKey && storeName === "settings") {
            await tx.store.put(entry.value as never, SETTINGS_KEY as never);
          } else {
            await tx.store.put(entry.value as never);
          }
          continue;
        }

        if (!hasInlineKey && storeName === "settings") {
          await tx.store.put(row as never, SETTINGS_KEY as never);
          continue;
        }

        if (hasInlineKey) {
          await tx.store.put(row as never);
        }
      }
      await tx.done;
    }

    await migrateImageAssetsToBlobStorage(db);
  },

  async getStoreNames() {
    const db = await getDb();
    return Array.from(db.objectStoreNames)
      .map((name) => String(name))
      .sort((a, b) => a.localeCompare(b));
  },
};

export { DEFAULT_SETTINGS };
