import { describe, expect, it } from "vitest";
import {
  buildConversationSummary,
  buildRecentMessages,
} from "../personaDynamics";
import type { ChatMessage } from "../types";

const makeMessage = (
  index: number,
  role: "user" | "assistant",
  content: string,
): ChatMessage => ({
  id: `m-${index}`,
  chatId: "chat-1",
  role,
  content,
  createdAt: `2026-04-03T00:00:${String(index).padStart(2, "0")}.000Z`,
});

describe("context summary policy", () => {
  it("returns empty summary for short dialogues", () => {
    const messages: ChatMessage[] = [
      makeMessage(1, "user", "Привет"),
      makeMessage(2, "assistant", "Привет!"),
      makeMessage(3, "user", "Как дела?"),
      makeMessage(4, "assistant", "Всё хорошо."),
    ];

    const summary = buildConversationSummary(messages, 6, 4);
    expect(summary).toHaveLength(0);
  });

  it("compacts older dialogue and excludes recent window", () => {
    const messages: ChatMessage[] = [
      makeMessage(1, "user", "old-1 user"),
      makeMessage(2, "assistant", "old-2 assistant"),
      makeMessage(3, "user", "old-3 user"),
      makeMessage(4, "assistant", "old-4 assistant"),
      makeMessage(5, "user", "old-5 user"),
      makeMessage(6, "assistant", "old-6 assistant"),
      makeMessage(7, "user", "recent-7 user"),
      makeMessage(8, "assistant", "recent-8 assistant"),
      makeMessage(9, "user", "recent-9 user"),
      makeMessage(10, "assistant", "recent-10 assistant"),
    ];

    const summary = buildConversationSummary(messages, 4, 3);
    const merged = summary.join(" | ");

    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(3);
    expect(merged).toContain("old-");
    expect(merged).not.toContain("recent-9 user");
    expect(merged).not.toContain("recent-10 assistant");
  });

  it("keeps recent messages compact and bounded", () => {
    const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) =>
      makeMessage(
        i + 1,
        i % 2 === 0 ? "user" : "assistant",
        `msg-${i + 1} ${"x".repeat(300)}`,
      ),
    );

    const recent = buildRecentMessages(messages, 5);
    expect(recent).toHaveLength(5);
    expect(recent.every((message) => message.content.length <= 260)).toBe(true);
  });
});
