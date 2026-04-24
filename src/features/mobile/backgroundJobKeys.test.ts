import { describe, expect, it } from "vitest";
import {
  buildOneToOneChatJobId,
  buildOneToOneProactiveJobId,
  readOneToOneChatScope,
  readOneToOneProactiveScope,
} from "./backgroundJobKeys";

describe("backgroundJobKeys (one_to_one_chat)", () => {
  it("builds deterministic one-to-one job id", () => {
    expect(buildOneToOneChatJobId("chat-1", "msg-2")).toBe(
      "one_to_one_chat:chat-1:msg-2",
    );
  });

  it("parses scope from payload first", () => {
    const scope = readOneToOneChatScope({
      id: "one_to_one_chat:chat-a:msg-a",
      payload: {
        chatId: "chat-payload",
        userMessageId: "msg-payload",
      },
    });
    expect(scope).toEqual({
      chatId: "chat-payload",
      userMessageId: "msg-payload",
    });
  });

  it("falls back to parsing scope from job id", () => {
    const scope = readOneToOneChatScope({
      id: "one_to_one_chat:chat-id:msg-id",
      payload: {},
    });
    expect(scope).toEqual({
      chatId: "chat-id",
      userMessageId: "msg-id",
    });
  });

  it("builds deterministic proactive one-to-one job id", () => {
    expect(buildOneToOneProactiveJobId("chat-1")).toBe(
      "one_to_one_proactive:chat-1",
    );
  });

  it("parses proactive scope from payload first", () => {
    const scope = readOneToOneProactiveScope({
      id: "one_to_one_proactive:chat-a",
      payload: {
        chatId: "chat-payload",
      },
    });
    expect(scope).toEqual({
      chatId: "chat-payload",
    });
  });

  it("falls back to parsing proactive scope from job id", () => {
    const scope = readOneToOneProactiveScope({
      id: "one_to_one_proactive:chat-id",
      payload: {},
    });
    expect(scope).toEqual({
      chatId: "chat-id",
    });
  });
});
