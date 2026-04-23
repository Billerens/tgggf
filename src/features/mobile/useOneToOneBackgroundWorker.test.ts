import { describe, expect, it } from "vitest";
import {
  ONE_TO_ONE_CHAT_JOB_TYPE,
  ONE_TO_ONE_PROACTIVE_JOB_TYPE,
} from "./backgroundJobKeys";
import {
  ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS,
  shouldClearLoadingAfterFallbackSync,
} from "./useOneToOneBackgroundWorker";

describe("useOneToOneBackgroundWorker delta task config", () => {
  it("includes chat and proactive task types for polling", () => {
    const taskTypes = ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.map(
      (item) => item.taskType,
    );
    expect(taskTypes).toEqual([
      ONE_TO_ONE_CHAT_JOB_TYPE,
      ONE_TO_ONE_PROACTIVE_JOB_TYPE,
    ]);
  });

  it("uses unique since-id storage keys per task type", () => {
    const keys = ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.map(
      (item) => item.sinceIdStorageKey,
    );
    expect(new Set(keys).size).toBe(ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.length);
  });
});

describe("shouldClearLoadingAfterFallbackSync", () => {
  it("clears typing when latest message is assistant and no pending user messages", () => {
    expect(
      shouldClearLoadingAfterFallbackSync({
        preferredChatId: "chat-1",
        activeChatId: "chat-1",
        messages: [
          { chatId: "chat-1", role: "user", nativeStatus: "completed" },
          { chatId: "chat-1", role: "assistant", nativeStatus: undefined },
        ],
      }),
    ).toBe(true);
  });

  it("keeps typing when there is a pending user message", () => {
    expect(
      shouldClearLoadingAfterFallbackSync({
        preferredChatId: "chat-1",
        activeChatId: "chat-1",
        messages: [
          { chatId: "chat-1", role: "user", nativeStatus: "pending" },
          { chatId: "chat-1", role: "assistant", nativeStatus: undefined },
        ],
      }),
    ).toBe(false);
  });

  it("keeps typing when the latest chat message is not assistant", () => {
    expect(
      shouldClearLoadingAfterFallbackSync({
        preferredChatId: "chat-1",
        activeChatId: "chat-1",
        messages: [{ chatId: "chat-1", role: "user", nativeStatus: "completed" }],
      }),
    ).toBe(false);
  });
});
