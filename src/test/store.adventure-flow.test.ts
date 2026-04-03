import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lmstudio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lmstudio")>();
  return {
    ...actual,
    requestAdventureArbiterDecision: vi.fn(async () => ({
      narration:
        "Рассказчик отмечает: тяжелая дверь со скрипом открывается, и в коридор врывается холодный ветер.",
      currentScene: "Тусклый коридор за входной дверью.",
      sceneObjective: "Осмотреть коридор и найти безопасный путь вперед.",
      openThreads: ["Тайный наблюдатель в коридоре"],
      resolvedThreads: ["Вход в здание"],
      timelineSummary: "Герои проникли внутрь и получили первую зацепку.",
      rationale:
        "Выбран результат, который продвигает сцену и сохраняет напряжение без резкого скачка.",
      confidence: 0.88,
    })),
  };
});

import { requestAdventureArbiterDecision } from "../lmstudio";
import { useAppStore } from "../store";
import { dbApi } from "../db";

const buildArbiterDecision = () => ({
  narration:
    "Рассказчик отмечает: тяжелая дверь со скрипом открывается, и в коридор врывается холодный ветер.",
  currentScene: "Тусклый коридор за входной дверью.",
  sceneObjective: "Осмотреть коридор и найти безопасный путь вперед.",
  openThreads: ["Тайный наблюдатель в коридоре"],
  resolvedThreads: ["Вход в здание"],
  timelineSummary: "Герои проникли внутрь и получили первую зацепку.",
  rationale:
    "Выбран результат, который продвигает сцену и сохраняет напряжение без резкого скачка.",
  confidence: 0.88,
});

const createAdventureForActivePersona = async (title: string) => {
  const activePersonaId = useAppStore.getState().activePersonaId;
  expect(activePersonaId).toBeTruthy();
  await useAppStore.getState().createAdventureChat([activePersonaId!], {
    title,
    startContext: "Ночь, дождь и пустой особняк на холме.",
    initialGoal: "Попасть внутрь и понять, кто следит за героями.",
    narratorStyle: "Кинематографичный и мрачный",
    worldTone: "dark",
    explicitnessPolicy: "fade_to_black",
  });
  const chatId = useAppStore.getState().activeChatId;
  expect(chatId).toBeTruthy();
  return chatId!;
};

describe("adventure turn pipeline", () => {
  beforeEach(async () => {
    await dbApi.clearAllData();
    vi.mocked(requestAdventureArbiterDecision).mockReset();
    vi.mocked(requestAdventureArbiterDecision).mockImplementation(async () =>
      buildArbiterDecision(),
    );
    await useAppStore.getState().initialize();
  });

  it("creates narrator response, updates adventure state, and writes arbiter events", async () => {
    const chatId = await createAdventureForActivePersona("Тайна старого особняка");

    await useAppStore.getState().sendMessage("Я открываю дверь и иду внутрь.");

    const finalState = useAppStore.getState();
    const lastMessage = finalState.messages[finalState.messages.length - 1];

    expect(lastMessage).toBeTruthy();
    expect(lastMessage.role).toBe("assistant");
    expect(lastMessage.messageType).toBe("narration");
    expect(lastMessage.content).toContain("тяжелая дверь");

    const [adventureState, events, chat] = await Promise.all([
      dbApi.getAdventureState(chatId!),
      dbApi.getChatEvents(chatId!, 200),
      dbApi.getChatById(chatId!),
    ]);

    expect(adventureState?.sceneObjective).toBe(
      "Осмотреть коридор и найти безопасный путь вперед.",
    );
    expect(adventureState?.openThreads).toContain("Тайный наблюдатель в коридоре");
    expect(adventureState?.resolvedThreads).toContain("Вход в здание");
    expect(events.some((event) => event.eventType === "arbiter_decision")).toBe(true);
    expect(events.some((event) => event.eventType === "turn_committed")).toBe(true);
    expect(chat?.status).toBe("idle");
    expect(vi.mocked(requestAdventureArbiterDecision)).toHaveBeenCalledTimes(1);
  });

  it("blocks new turn in another chat while one chat is busy", async () => {
    const firstChatId = await createAdventureForActivePersona("Линия A");
    const secondChatId = await createAdventureForActivePersona("Линия B");

    const lock = await dbApi.acquireChatTurnLock(firstChatId);
    expect(lock).toBeTruthy();

    try {
      await useAppStore.getState().sendMessage("Пробую отправить ход во втором чате.");
      const state = useAppStore.getState();
      expect(state.activeChatId).toBe(secondChatId);
      expect(state.error).toContain("Система занята активной генерацией");

      const secondChatJobs = await dbApi.getTurnJobs(secondChatId);
      expect(secondChatJobs).toHaveLength(0);
    } finally {
      if (lock) {
        await dbApi.releaseChatTurnLock(firstChatId, lock.turnId, "idle");
      }
    }
  });

  it("keeps single in-flight turn for concurrent send attempts", async () => {
    const chatId = await createAdventureForActivePersona("Гонка ходов");
    vi.mocked(requestAdventureArbiterDecision).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return buildArbiterDecision();
    });

    await Promise.all([
      useAppStore.getState().sendMessage("Первый ход"),
      useAppStore.getState().sendMessage("Второй ход"),
    ]);

    const [messages, events, jobs, chat] = await Promise.all([
      dbApi.getMessages(chatId),
      dbApi.getChatEvents(chatId, 200),
      dbApi.getTurnJobs(chatId),
      dbApi.getChatById(chatId),
    ]);

    const userTurnMessages = messages.filter(
      (message) => message.role === "user" && Boolean(message.turnId),
    );
    const narrationTurnMessages = messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.messageType === "narration" &&
        Boolean(message.turnId),
    );

    expect(userTurnMessages).toHaveLength(1);
    expect(narrationTurnMessages).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "turn_started")).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "done")).toHaveLength(1);
    expect(chat?.status).toBe("idle");
  });

  it("restores adventure artifacts from IndexedDB after initialize", async () => {
    const chatId = await createAdventureForActivePersona("Reload test");
    await useAppStore.getState().sendMessage("Сделай шаг вперёд.");

    useAppStore.setState({
      chats: [],
      activeChatId: null,
      messages: [],
      activeChatEvents: [],
      activeChatParticipants: [],
      activePersonaState: null,
      activeMemories: [],
      initialized: false,
      isLoading: false,
      error: null,
    });

    await useAppStore.getState().initialize();

    const rehydratedState = useAppStore.getState();
    expect(rehydratedState.initialized).toBe(true);
    expect(rehydratedState.activeChatId).toBe(chatId);
    expect(rehydratedState.messages.length).toBeGreaterThanOrEqual(3);
    expect(
      rehydratedState.activeChatEvents.some(
        (event) => event.eventType === "arbiter_decision",
      ),
    ).toBe(true);

    const persistedAdventureState = await dbApi.getAdventureState(chatId);
    expect(persistedAdventureState?.sceneObjective).toBe(
      "Осмотреть коридор и найти безопасный путь вперед.",
    );
  });
});
