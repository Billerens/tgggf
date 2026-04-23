import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "./types";

const {
  mockDbApi,
  mockSyncOneToOneContextToNative,
  mockRequestNativeProactivitySimulation,
  mockTriggerBackgroundRuntime,
  mockEnsureRecurringBackgroundJob,
  runtimeRef,
} = vi.hoisted(() => ({
  mockDbApi: {
    saveChat: vi.fn(),
    getChats: vi.fn(),
    saveMessage: vi.fn(),
  },
  mockSyncOneToOneContextToNative: vi.fn(),
  mockRequestNativeProactivitySimulation: vi.fn(),
  mockTriggerBackgroundRuntime: vi.fn(),
  mockEnsureRecurringBackgroundJob: vi.fn(),
  runtimeRef: { mode: "android" as "android" | "web" },
}));

vi.mock("./db", () => ({
  DEFAULT_SETTINGS: {} as Record<string, unknown>,
  dbApi: mockDbApi,
}));

vi.mock("./platform/runtimeContext", () => ({
  getRuntimeContext: () => ({ mode: runtimeRef.mode }),
}));

vi.mock("./features/mobile/oneToOneNativeRuntime", () => ({
  syncOneToOneContextToNative: mockSyncOneToOneContextToNative,
  requestNativeDiaryPreview: vi.fn(),
  requestNativeProactivitySimulation: mockRequestNativeProactivitySimulation,
  applyOneToOneStatePatch: vi.fn(),
}));

vi.mock("./features/mobile/backgroundDelta", () => ({
  triggerBackgroundRuntime: mockTriggerBackgroundRuntime,
}));

vi.mock("./features/mobile/backgroundJobs", () => ({
  ensureRecurringBackgroundJob: mockEnsureRecurringBackgroundJob,
}));

import { useAppStore } from "./store";

function createBaseChat(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1",
    personaId: "persona-1",
    title: "Test chat",
    notificationsEnabled: true,
    diaryConfig: { enabled: false },
    proactivityConfig: { enabled: false },
    evolutionConfig: { enabled: false, applyMode: "manual" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("store.setChatProactivityEnabled", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtimeRef.mode = "android";
    const baseChat = createBaseChat();
    useAppStore.setState({
      chats: [baseChat],
      activeChatId: baseChat.id,
      isLoading: false,
      error: null,
    });
  });

  it("updates chat config and triggers android native sync", async () => {
    const updatedChat = createBaseChat({ proactivityConfig: { enabled: true } });
    mockDbApi.getChats.mockResolvedValue([updatedChat]);

    await useAppStore.getState().setChatProactivityEnabled("chat-1", true);

    expect(mockDbApi.saveChat).toHaveBeenCalledTimes(1);
    expect(mockDbApi.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "chat-1",
        proactivityConfig: expect.objectContaining({ enabled: true }),
      }),
    );
    expect(mockDbApi.getChats).toHaveBeenCalledWith("persona-1");
    expect(mockSyncOneToOneContextToNative).toHaveBeenCalledWith({
      chatId: "chat-1",
      personaId: "persona-1",
    });
    expect(mockTriggerBackgroundRuntime).toHaveBeenCalledWith(
      "one_to_one_proactivity_toggle",
    );
    expect(useAppStore.getState().chats[0]?.proactivityConfig?.enabled).toBe(
      true,
    );
  });

  it("does not call native sync outside android runtime", async () => {
    runtimeRef.mode = "web";
    mockDbApi.getChats.mockResolvedValue([
      createBaseChat({ proactivityConfig: { enabled: true } }),
    ]);

    await useAppStore.getState().setChatProactivityEnabled("chat-1", true);

    expect(mockDbApi.saveChat).toHaveBeenCalledTimes(1);
    expect(mockSyncOneToOneContextToNative).not.toHaveBeenCalled();
    expect(mockTriggerBackgroundRuntime).not.toHaveBeenCalled();
  });
});

describe("store.testSimulateProactivity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtimeRef.mode = "android";
    const baseChat = createBaseChat();
    useAppStore.setState({
      chats: [baseChat],
      activeChatId: baseChat.id,
      isLoading: false,
      error: null,
    });
  });

  it("runs Android dry-run simulation through native runtime", async () => {
    const report = {
      chatId: "chat-1",
      personaId: "persona-1",
      simulatedAt: "2026-01-01T00:00:00.000Z",
      stages: [
        {
          id: "planner_call",
          title: "Planner",
          status: "ok",
          details: { actionCount: 1 },
        },
      ],
      summary: { dryRun: true },
    };
    mockRequestNativeProactivitySimulation.mockResolvedValue(report);

    const result = await useAppStore.getState().testSimulateProactivity("chat-1");

    expect(mockSyncOneToOneContextToNative).toHaveBeenCalledWith({
      chatId: "chat-1",
      personaId: "persona-1",
    });
    expect(mockRequestNativeProactivitySimulation).toHaveBeenCalledWith("chat-1");
    expect(result).toEqual(report);
  });

  it("returns null outside Android runtime", async () => {
    runtimeRef.mode = "web";

    const result = await useAppStore.getState().testSimulateProactivity("chat-1");

    expect(result).toBeNull();
    expect(mockSyncOneToOneContextToNative).not.toHaveBeenCalled();
    expect(mockRequestNativeProactivitySimulation).not.toHaveBeenCalled();
  });
});

describe("store.sendMessage (android)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtimeRef.mode = "android";
    const baseChat = createBaseChat();
    useAppStore.setState({
      personas: [
        {
          id: "persona-1",
          name: "Persona",
        } as any,
      ],
      chats: [baseChat],
      messages: [],
      activePersonaId: "persona-1",
      activeChatId: baseChat.id,
      isLoading: false,
      error: null,
    });
    mockDbApi.getChats.mockResolvedValue([baseChat]);
  });

  it("does not overwrite freshly synced assistant messages with stale nextMessages", async () => {
    mockTriggerBackgroundRuntime.mockImplementationOnce(async () => {
      const current = useAppStore.getState().messages;
      const currentChats = useAppStore.getState().chats;
      useAppStore.setState({
        messages: [
          ...current,
          {
            id: "assistant-1",
            chatId: "chat-1",
            role: "assistant",
            content: "native reply",
            createdAt: "2026-01-01T00:00:01.000Z",
          } as any,
        ],
        chats: currentChats.map((chat) =>
          chat.id === "chat-1"
            ? ({
                ...chat,
                conversationSummary: "summary from native delta",
              } as any)
            : chat,
        ),
      });
    });

    await useAppStore.getState().sendMessage("hello");

    const messages = useAppStore.getState().messages;
    const chat = useAppStore.getState().chats.find((item) => item.id === "chat-1");
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect((chat as any)?.conversationSummary).toBe("summary from native delta");
  });
});
