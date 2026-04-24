import { describe, expect, it } from "vitest";
import type { ChatSession } from "./types";
import { __dbTestUtils } from "./db";

const BASE_CHAT: ChatSession = {
  id: "chat-1",
  personaId: "persona-1",
  title: "Test chat",
  notificationsEnabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("db proactivity normalization", () => {
  it("normalizes empty proactivity config to disabled defaults", () => {
    expect(__dbTestUtils.normalizeChatProactivityConfig(undefined)).toEqual(
      expect.objectContaining({
        enabled: false,
        lastActivityAtMs: undefined,
        nextRunAtMs: undefined,
        lastProactiveAtMs: undefined,
        lastDeltaConsumedAtMs: undefined,
      }),
    );
  });

  it("keeps boolean enabled and sanitizes runtime meta timestamps", () => {
    expect(
      __dbTestUtils.normalizeChatProactivityConfig({
        enabled: 1,
        lastActivityAtMs: 1234.9,
        nextRunAtMs: -90,
        lastProactiveAtMs: Number.NaN,
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        lastActivityAtMs: 1234,
        nextRunAtMs: 0,
        lastProactiveAtMs: undefined,
        lastDeltaConsumedAtMs: undefined,
      }),
    );
  });

  it("normalizes proactivityConfig in chat session shape", () => {
    const chat = __dbTestUtils.normalizeChatSession({
      ...BASE_CHAT,
      proactivityConfig: {
        enabled: true,
        lastActivityAtMs: 15_001.7,
        nextRunAtMs: 16_444.9,
      },
    });

    expect(chat.proactivityConfig).toEqual(
      expect.objectContaining({
        enabled: true,
        lastActivityAtMs: 15_001,
        nextRunAtMs: 16_444,
        lastProactiveAtMs: undefined,
        lastDeltaConsumedAtMs: undefined,
      }),
    );
  });
});
