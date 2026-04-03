import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { dbApi } from "../db";
import type { PersonaRuntimeState } from "../types";

const DB_NAME = "tg-gf-db";
const DB_VERSION = 7;

describe("db migration and normalization", () => {
  beforeEach(async () => {
    await dbApi.clearAllData();
  });

  it("normalizes legacy chat fields on read and persists normalized values", async () => {
    const rawDb = await openDB<any>(DB_NAME, DB_VERSION);
    try {
      const ts = new Date().toISOString();
      const chatId = crypto.randomUUID();

      await rawDb.put("chats", {
        id: chatId,
        personaId: "legacy-persona",
        mode: "legacy_mode",
        status: "unknown_status",
        activeTurnId: "   ",
        title: "Legacy chat",
        createdAt: ts,
        updatedAt: ts,
      });

      const normalized = await dbApi.getChatById(chatId);
      expect(normalized?.mode).toBe("direct");
      expect(normalized?.status).toBe("idle");
      expect(normalized?.activeTurnId).toBeUndefined();

      const storedAfterRead = await rawDb.get("chats", chatId);
      expect(storedAfterRead.mode).toBe("direct");
      expect(storedAfterRead.status).toBe("idle");
      expect(Object.prototype.hasOwnProperty.call(storedAfterRead, "activeTurnId")).toBe(
        false,
      );
    } finally {
      rawDb.close();
    }
  });

  it("backfills legacy personaStates into personaStatesV2 during read", async () => {
    const rawDb = await openDB<any>(DB_NAME, DB_VERSION);
    try {
      const ts = new Date().toISOString();
      const chatId = crypto.randomUUID();
      const personaId = crypto.randomUUID();

      const legacyState: PersonaRuntimeState = {
        chatId,
        personaId,
        mood: "calm",
        trust: 0.52,
        energy: 0.61,
        engagement: 0.55,
        lust: 0.18,
        fear: 0.11,
        affection: 0.47,
        tension: 0.22,
        relationshipType: "neutral",
        relationshipDepth: 0.29,
        relationshipStage: "new",
        activeTopics: ["legacy backfill"],
        updatedAt: ts,
      };

      await rawDb.put("personaStates", legacyState);
      const loaded = await dbApi.getPersonaState(chatId, personaId);
      expect(loaded?.personaId).toBe(personaId);

      const v2Rows = await rawDb.getAllFromIndex("personaStatesV2", "by-chat", chatId);
      expect(v2Rows).toHaveLength(1);
      expect(v2Rows[0].id).toBe(`${chatId}:${personaId}`);
      expect(v2Rows[0].personaId).toBe(personaId);
    } finally {
      rawDb.close();
    }
  });
});
