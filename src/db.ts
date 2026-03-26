import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeMemoryRecord } from "./personaDynamics";
import { normalizePersonaRecord } from "./personaProfiles";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
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
}

const DB_NAME = "tg-gf-db";
const DB_VERSION = 2;
const SETTINGS_KEY = "main";
const DEV_PROXY_BASE_URL = "/lmstudio";
const FALLBACK_PROD_BASE_URL = "https://t1.tun.uforge.online";
const DEFAULT_COMFY_BASE_URL = "http://127.0.0.1:8188";

function resolveDefaultBaseUrl() {
  const fromEnv = import.meta.env.VITE_LM_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  return import.meta.env.DEV ? DEV_PROXY_BASE_URL : FALLBACK_PROD_BASE_URL;
}

function normalizeSettings(current: Partial<AppSettings> | undefined): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(current ?? {}) };

  const trimmedBaseUrl = merged.lmBaseUrl.trim();
  if (!trimmedBaseUrl) {
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else if (!import.meta.env.DEV && trimmedBaseUrl === DEV_PROXY_BASE_URL) {
    // Auto-fix old persisted dev proxy URL in production static builds.
    merged.lmBaseUrl = DEFAULT_SETTINGS.lmBaseUrl;
  } else {
    merged.lmBaseUrl = trimmedBaseUrl;
  }

  merged.model = merged.model.trim() || DEFAULT_SETTINGS.model;
  merged.comfyBaseUrl = merged.comfyBaseUrl.trim() || DEFAULT_SETTINGS.comfyBaseUrl;
  merged.apiKey = merged.apiKey.trim();
  const allowedGenders: UserGender[] = ["unspecified", "male", "female", "nonbinary"];
  if (!allowedGenders.includes(merged.userGender)) {
    merged.userGender = DEFAULT_SETTINGS.userGender;
  }
  merged.showSystemImageBlock = Boolean(merged.showSystemImageBlock);
  merged.showStatusChangeDetails = Boolean(merged.showStatusChangeDetails);
  return merged;
}

const DEFAULT_SETTINGS: AppSettings = {
  lmBaseUrl: resolveDefaultBaseUrl(),
  comfyBaseUrl: DEFAULT_COMFY_BASE_URL,
  model: "local-model",
  temperature: 0.7,
  maxTokens: 600,
  apiKey: "",
  userGender: "unspecified",
  showSystemImageBlock: true,
  showStatusChangeDetails: false,
};

let dbPromise: Promise<IDBPDatabase<TgGfDb>> | null = null;

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
      },
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
    const tx = db.transaction(["personas", "chats", "messages", "personaStates", "memories"], "readwrite");
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

    await tx.done;
  },

  async getChats(personaId: string) {
    const db = await getDb();
    const rows = await db.getAllFromIndex("chats", "by-persona", personaId);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async saveChat(chat: ChatSession) {
    const db = await getDb();
    await db.put("chats", chat);
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
};

export { DEFAULT_SETTINGS };
