import { beforeEach, describe, expect, it } from "vitest";
import { dbApi } from "../db";
import type {
  AdventureScenario,
  AdventureState,
  ChatEvent,
  ChatMessage,
  ChatSession,
  TurnJob,
} from "../types";

describe("dbApi adventure persistence", () => {
  beforeEach(async () => {
    await dbApi.clearAllData();
  });

  it("normalizes invalid explicitness policy to fade_to_black", async () => {
    const ts = new Date().toISOString();
    const scenario = {
      id: crypto.randomUUID(),
      title: "Scenario",
      startContext: "Night in old town.",
      initialGoal: "Find the missing map.",
      narratorStyle: "Noir and tense",
      worldTone: "dark",
      explicitnessPolicy: "invalid_policy",
      createdAt: ts,
      updatedAt: ts,
    } as unknown as AdventureScenario;

    await dbApi.saveAdventureScenario(scenario);
    const saved = await dbApi.getAdventureScenario(scenario.id);

    expect(saved).not.toBeNull();
    expect(saved?.explicitnessPolicy).toBe("fade_to_black");
  });

  it("commits chat artifacts and adventure state in one transaction path", async () => {
    const ts = new Date().toISOString();
    const chatId = crypto.randomUUID();
    const turnId = crypto.randomUUID();

    const chat: ChatSession = {
      id: chatId,
      personaId: "persona-1",
      mode: "adventure",
      status: "idle",
      scenarioId: "scenario-1",
      title: "Adventure chat",
      createdAt: ts,
      updatedAt: ts,
    };
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      chatId,
      role: "assistant",
      messageType: "narration",
      content: "Narration text",
      turnId,
      createdAt: ts,
    };
    const event: ChatEvent = {
      id: crypto.randomUUID(),
      chatId,
      turnId,
      eventType: "turn_committed",
      payload: { ok: true },
      createdAt: ts,
    };
    const turnJob: TurnJob = {
      id: crypto.randomUUID(),
      chatId,
      turnId,
      mode: "adventure",
      stage: "finalize",
      payload: {},
      status: "done",
      retryCount: 0,
      createdAt: ts,
      startedAt: ts,
      finishedAt: ts,
    };
    const adventureState: AdventureState = {
      id: chatId,
      chatId,
      scenarioId: "scenario-1",
      currentScene: "On the bridge after the storm.",
      sceneObjective: "Negotiate with the guard captain.",
      openThreads: ["Guard loyalty"],
      resolvedThreads: ["Cross the gate"],
      timelineSummary: "Party entered the city and found the captain.",
      updatedAt: ts,
    };

    await dbApi.commitTurnArtifacts({
      chat,
      messages: [message],
      events: [event],
      turnJob,
      adventureState,
    });

    const [savedChat, savedMessages, savedEvents, savedJobs, savedAdventureState] =
      await Promise.all([
        dbApi.getChatById(chatId),
        dbApi.getMessages(chatId),
        dbApi.getChatEvents(chatId),
        dbApi.getTurnJobs(chatId),
        dbApi.getAdventureState(chatId),
      ]);

    expect(savedChat?.title).toBe("Adventure chat");
    expect(savedMessages.map((item) => item.id)).toContain(message.id);
    expect(savedEvents.map((item) => item.id)).toContain(event.id);
    expect(savedJobs.map((item) => item.id)).toContain(turnJob.id);
    expect(savedAdventureState?.sceneObjective).toBe(
      "Negotiate with the guard captain.",
    );
  });
});

