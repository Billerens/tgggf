import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AppSettings, ChatMessage, ChatSession, Persona } from "./types";

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
  settings: {
    key: string;
    value: AppSettings;
  };
}

const DB_NAME = "tg-gf-db";
const DB_VERSION = 1;
const SETTINGS_KEY = "main";

const DEFAULT_SETTINGS: AppSettings = {
  lmBaseUrl: "/lmstudio",
  model: "local-model",
  temperature: 0.7,
  maxTokens: 600,
  apiKey: "",
};

let dbPromise: Promise<IDBPDatabase<TgGfDb>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<TgGfDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("personas", { keyPath: "id" });

        const chats = db.createObjectStore("chats", { keyPath: "id" });
        chats.createIndex("by-persona", "personaId");
        chats.createIndex("by-updatedAt", "updatedAt");

        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-chat", "chatId");
        messages.createIndex("by-createdAt", "createdAt");

        db.createObjectStore("settings");
      },
    });
  }

  return dbPromise;
}

export const dbApi = {
  async getPersonas() {
    const db = await getDb();
    const rows = await db.getAll("personas");
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async savePersona(persona: Persona) {
    const db = await getDb();
    await db.put("personas", persona);
  },

  async deletePersona(personaId: string) {
    const db = await getDb();
    const tx = db.transaction(["personas", "chats", "messages"], "readwrite");
    await tx.objectStore("personas").delete(personaId);

    const chats = await tx.objectStore("chats").index("by-persona").getAll(personaId);
    for (const chat of chats) {
      await tx.objectStore("chats").delete(chat.id);
      const messages = await tx.objectStore("messages").index("by-chat").getAll(chat.id);
      for (const msg of messages) {
        await tx.objectStore("messages").delete(msg.id);
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
    const tx = db.transaction(["chats", "messages"], "readwrite");
    await tx.objectStore("chats").delete(chatId);
    const messages = await tx.objectStore("messages").index("by-chat").getAll(chatId);
    for (const msg of messages) {
      await tx.objectStore("messages").delete(msg.id);
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

  async getSettings() {
    const db = await getDb();
    const current = await db.get("settings", SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(current ?? {}) };
  },

  async saveSettings(settings: AppSettings) {
    const db = await getDb();
    await db.put("settings", settings, SETTINGS_KEY);
  },
};

export { DEFAULT_SETTINGS };
