import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./lmstudio";
import {
  buildGroupPersonaSystemPrompt,
  buildGroupPersonaUserInput,
} from "./groupPrompts";
import type {
  GroupPersonaState,
  GroupRoom,
  InfluenceProfile,
  Persona,
  PersonaRuntimeState,
} from "./types";

function createTestPersona(): Persona {
  return {
    id: "p1",
    name: "Луна",
    personalityPrompt: "Нежная и внимательная",
    stylePrompt: "Теплая, уверенная речь",
    appearance: {
      faceDescription: "Овальное лицо",
      height: "170 см",
      eyes: "Голубые",
      lips: "Яркие",
      hair: "Светлые",
      ageType: "Молодая",
      bodyType: "Стройная",
      markers: "Нет",
      accessories: "Кулон",
      clothingStyle: "Элегантный",
      skin: "Светлая",
    },
    imageCheckpoint: "",
    advanced: {
      core: {
        archetype: "Соблазнительница",
        backstory: "История",
        goals: "Близость",
        values: "Искренность",
        boundaries: "Не переходить личные границы",
        expertise: "Эмоциональная поддержка",
        selfGender: "female",
      },
      voice: {
        tone: "Теплый",
        lexicalStyle: "Разговорный",
        sentenceLength: "balanced",
        formality: 45,
        expressiveness: 65,
        emoji: 30,
      },
      behavior: {
        initiative: 55,
        empathy: 70,
        directness: 45,
        curiosity: 60,
        challenge: 20,
        creativity: 50,
      },
      emotion: {
        baselineMood: "warm",
        warmth: 75,
        stability: 60,
        positiveTriggers: "",
        negativeTriggers: "",
      },
      memory: {
        rememberFacts: true,
        rememberPreferences: true,
        rememberGoals: true,
        rememberEvents: true,
        maxMemories: 120,
        decayDays: 30,
      },
    },
    avatarUrl: "",
    fullBodyUrl: "",
    fullBodySideUrl: "",
    fullBodyBackUrl: "",
    avatarImageId: "",
    fullBodyImageId: "",
    fullBodySideImageId: "",
    fullBodyBackImageId: "",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
  };
}

function createInfluenceProfile(): InfluenceProfile {
  return {
    enabled: true,
    thoughts: [{ text: "Быть внимательной к эмоциям пользователя", strength: 55 }],
    desires: [{ text: "Сблизиться через доверительный диалог", strength: 67 }],
    goals: [{ text: "Укрепить эмоциональную связь", strength: 84 }],
    freeform: "Подводи диалог к более теплому эмоциональному контакту",
    updatedAt: "2026-04-17T00:00:00.000Z",
  };
}

describe("influence prompt integration", () => {
  it("injects hidden influence block into one-to-one system prompt", () => {
    const persona = createTestPersona();
    const influenceProfile = createInfluenceProfile();
    const runtimeState: PersonaRuntimeState = {
      chatId: "chat-1",
      personaId: persona.id,
      mood: "warm",
      trust: 52,
      energy: 49,
      engagement: 61,
      lust: 8,
      fear: 5,
      affection: 58,
      tension: 12,
      relationshipType: "neutral",
      relationshipDepth: 20,
      relationshipStage: "new",
      currentIntent: "Укрепить эмоциональную связь",
      influenceProfile,
      updatedAt: "2026-04-17T00:00:00.000Z",
    };

    const prompt = buildSystemPrompt(
      persona,
      { userGender: "male", userName: "Артем" },
      {
        runtimeState,
        influenceProfile,
        currentIntent: "Укрепить эмоциональную связь",
      },
    );

    expect(prompt).toContain("=== HIDDEN INFLUENCE VECTOR ===");
    expect(prompt).toContain("currentIntent=Укрепить эмоциональную связь");
    expect(prompt).toContain("При конфликте influence-вектора");
  });

  it("injects influence context into group persona prompts", () => {
    const persona = createTestPersona();
    const influenceProfile = createInfluenceProfile();
    const room: GroupRoom = {
      id: "room-1",
      title: "Группа",
      mode: "personas_plus_user",
      status: "active",
      state: {
        phase: "idle",
        updatedAt: "2026-04-17T00:00:00.000Z",
      },
      waitingForUser: false,
      orchestratorVersion: "v0",
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z",
    };
    const personaState: GroupPersonaState = {
      id: "state-1",
      roomId: room.id,
      personaId: persona.id,
      mood: "warm",
      trustToUser: 51,
      energy: 54,
      engagement: 59,
      initiative: 53,
      affectionToUser: 56,
      tension: 16,
      activeTopics: [],
      currentIntent: "Укрепить эмоциональную связь",
      influenceProfile,
      aliveScore: 50,
      updatedAt: "2026-04-17T00:00:00.000Z",
    };

    const systemPrompt = buildGroupPersonaSystemPrompt({
      room,
      persona,
      personaState,
      userName: "Пользователь",
      participantNames: ["Луна", "Селена"],
    });
    const userInput = buildGroupPersonaUserInput({
      userName: "Пользователь",
      lastUserMessage: "Давай пообщаемся глубже",
      recentMessages: [],
      personaState,
      relationEdges: [],
      participantNameById: {},
      sharedMemories: [],
      privateMemories: [],
      recentEvents: [],
      mentionContext: {
        addressedToCurrentPersona: true,
        mentionedPersonaNames: ["Луна"],
        rawLabels: ["@Луна"],
      },
    });

    expect(systemPrompt).toContain("Скрытый influence-вектор:");
    expect(systemPrompt).toContain("currentIntent=Укрепить эмоциональную связь");
    expect(systemPrompt).toContain("При конфликте influence-вектора");
    expect(userInput).toContain("Скрытый influence-вектор:");
    expect(userInput).toContain("goals=Укрепить эмоциональную связь [84]");
  });
});
