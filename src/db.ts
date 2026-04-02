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
  GeneratorSession,
  ImageAsset,
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
}

const DB_NAME = "tg-gf-db";
const DB_VERSION = 4;
const SETTINGS_KEY = "main";
const DEV_PROXY_BASE_URL = "/lmstudio";
const FALLBACK_PROD_BASE_URL = "https://t1.tun.uforge.online";
const DEFAULT_COMFY_BASE_URL = "http://127.0.0.1:8188";

const AUTH_MODES: AuthMode[] = ["none", "bearer", "token", "basic", "custom"];
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
          const personaStates = db.createObjectStore("personaStates", { keyPath: "chatId" });
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
          const sessions = db.createObjectStore("generatorSessions", { keyPath: "id" });
          sessions.createIndex("by-persona", "personaId");
          sessions.createIndex("by-updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains("imageAssets")) {
          const imageAssets = db.createObjectStore("imageAssets", { keyPath: "id" });
          imageAssets.createIndex("by-createdAt", "createdAt");
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

  return dbPromise;
}

export const dbApi = {
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
      ["personas", "chats", "messages", "personaStates", "memories", "generatorSessions"],
      "readwrite",
    );
    await tx.objectStore("personas").delete(personaId);
    const personaStateKeys = await tx.objectStore("personaStates").index("by-persona").getAllKeys(personaId);
    for (const key of personaStateKeys) {
      await tx.objectStore("personaStates").delete(key);
    }
    const memoryKeys = await tx.objectStore("memories").index("by-persona").getAllKeys(personaId);
    for (const key of memoryKeys) {
      await tx.objectStore("memories").delete(key);
    }

    const chats = await tx.objectStore("chats").index("by-persona").getAll(personaId);
    for (const chat of chats) {
      await tx.objectStore("chats").delete(chat.id);
      const messages = await tx.objectStore("messages").index("by-chat").getAll(chat.id);
      for (const msg of messages) {
        await tx.objectStore("messages").delete(msg.id);
      }
      await tx.objectStore("personaStates").delete(chat.id);
      const memories = await tx.objectStore("memories").index("by-chat").getAll(chat.id);
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

    await tx.done;
  },

  async getChats(personaId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("chats", "by-persona", personaId);
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
    const tx = db.transaction(["chats", "messages", "personaStates", "memories"], "readwrite");
    await tx.objectStore("chats").delete(chatId);
    const messages = await tx.objectStore("messages").index("by-chat").getAll(chatId);
    for (const msg of messages) {
      await tx.objectStore("messages").delete(msg.id);
    }
    await tx.objectStore("personaStates").delete(chatId);
    const memories = await tx.objectStore("memories").index("by-chat").getAll(chatId);
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

  async saveMessage(message: ChatMessage) {
    const db = await getDb();
    await db.put("messages", message);
  },

  async getPersonaState(chatId: string) {
    const db = await getDb();
    return db.get("personaStates", chatId);
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
};

export { DEFAULT_SETTINGS };
