import { create } from "zustand";
import { DEFAULT_SETTINGS, dbApi } from "./db";
import {
  generateComfyPromptFromImageDescription,
  requestAdventureArbiterDecision,
  requestChatCompletion,
  requestGroupDirectorDecision,
  type AdventureArbiterRecentMessage,
  type GroupDirectorCandidate,
  type GroupDirectorRecentMessage,
} from "./lmstudio";
import { generateComfyImages, readComfyImageGenerationMeta } from "./comfy";
import { localizeImageUrls } from "./imageStorage";
import {
  applyPersonaControlProposal,
  buildConversationSummary,
  buildLayeredMemoryContextCard,
  buildRecentMessages,
  createInitialPersonaState,
  derivePersistentMemoriesFromUserMessage,
  ensurePersonaState,
  evolvePersonaState,
  reconcilePersistentMemories,
} from "./personaDynamics";
import { createDefaultAdvancedProfile, normalizeAdvancedProfile } from "./personaProfiles";
import type {
  AdventureScenario,
  AdventureState,
  AppSettings,
  ChatEvent,
  ChatMessage,
  ChatParticipant,
  ChatSession,
  ImageGenerationMeta,
  Persona,
  PersonaAdvancedProfile,
  PersonaMemory,
  PersonaRuntimeState,
  TurnJob,
} from "./types";

type PersonaInput = Omit<
  Persona,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "advanced"
  | "avatarImageId"
  | "fullBodyImageId"
  | "fullBodySideImageId"
  | "fullBodyBackImageId"
> & {
  advanced?: PersonaAdvancedProfile;
  avatarImageId?: string;
  fullBodyImageId?: string;
  fullBodySideImageId?: string;
  fullBodyBackImageId?: string;
  id?: string;
};

interface AppState {
  personas: Persona[];
  chats: ChatSession[];
  messages: ChatMessage[];
  activeChatEvents: ChatEvent[];
  activeChatParticipants: ChatParticipant[];
  activePersonaState: PersonaRuntimeState | null;
  activeMemories: PersonaMemory[];
  activePersonaId: string | null;
  activeChatId: string | null;
  settings: AppSettings;
  initialized: boolean;
  isLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  selectPersona: (personaId: string) => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  savePersona: (input: PersonaInput) => Promise<void>;
  deletePersona: (personaId: string) => Promise<void>;
  createChat: () => Promise<void>;
  createGroupChat: (
    participantPersonaIds: string[],
    title?: string,
  ) => Promise<void>;
  createAdventureChat: (
    participantPersonaIds: string[],
    scenario: {
      title: string;
      startContext: string;
      initialGoal: string;
      narratorStyle: string;
      worldTone: AdventureScenario["worldTone"];
      explicitnessPolicy: AdventureScenario["explicitnessPolicy"];
    },
  ) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  setChatStyleStrength: (chatId: string, value: number | null) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  clearError: () => void;
}

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const GLOBAL_ACTIVE_TURN_LIMIT = 1;
const RETRYABLE_STAGE_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 600;
const IMAGE_ACTION_COOLDOWN_ASSISTANT_TURNS = 2;
const IMAGE_ACTION_WINDOW_ASSISTANT_TURNS = 12;
const IMAGE_ACTION_MAX_PER_WINDOW = 3;
const GROUP_AUTONOMOUS_REPLY_COUNT = 1;
const ADVENTURE_AUTONOMOUS_REPLY_COUNT = 1;
const randomSeed = () => {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return (Number(values[0]) << 1) + Number(values[1]);
};

function buildUserParticipant(chatId: string, order: number): ChatParticipant {
  const ts = nowIso();
  return {
    id: id(),
    chatId,
    participantType: "user",
    participantRefId: "user",
    displayName: "Вы",
    order,
    isActive: true,
    joinedAt: ts,
    updatedAt: ts,
  };
}

function buildPersonaParticipant(
  chatId: string,
  persona: Persona,
  order: number,
): ChatParticipant {
  const ts = nowIso();
  return {
    id: id(),
    chatId,
    participantType: "persona",
    participantRefId: persona.id,
    displayName: persona.name.trim() || "Персона",
    order,
    isActive: true,
    joinedAt: ts,
    updatedAt: ts,
  };
}

function buildNarratorParticipant(chatId: string, order: number): ChatParticipant {
  const ts = nowIso();
  return {
    id: id(),
    chatId,
    participantType: "narrator",
    participantRefId: "narrator",
    displayName: "Рассказчик",
    order,
    isActive: true,
    joinedAt: ts,
    updatedAt: ts,
  };
}

interface GroupSpeakerSelection {
  participant?: ChatParticipant;
  persona: Persona;
  reason: "mentioned" | "round_robin" | "fallback" | "director_llm";
  mentionToken?: string;
}

function normalizeSpeakerHint(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveGroupSpeaker(
  participants: ChatParticipant[],
  personasById: Map<string, Persona>,
  userInput: string,
  messageHistory: ChatMessage[],
  preferredPersonaId: string,
): GroupSpeakerSelection | null {
  const speakerEntries = participants
    .filter((participant) => participant.participantType === "persona" && participant.isActive)
    .map((participant) => {
      const persona = personasById.get(participant.participantRefId.trim());
      if (!persona) return null;
      return { participant, persona };
    })
    .filter(
      (entry): entry is { participant: ChatParticipant; persona: Persona } =>
        Boolean(entry),
    )
    .sort((left, right) => left.participant.order - right.participant.order);

  if (speakerEntries.length === 0) return null;

  const normalizedInput = normalizeSpeakerHint(userInput);
  if (normalizedInput) {
    for (const entry of speakerEntries) {
      const tokens = Array.from(
        new Set(
          [entry.participant.displayName, entry.persona.name]
            .map((value) => normalizeSpeakerHint(value))
            .filter((value) => value.length >= 2),
        ),
      ).sort((left, right) => right.length - left.length);
      for (const token of tokens) {
        if (normalizedInput.includes(`@${token}`) || normalizedInput.includes(token)) {
          return {
            participant: entry.participant,
            persona: entry.persona,
            reason: "mentioned",
            mentionToken: token,
          };
        }
      }
    }
  }

  const lastAssistantMessage = [...messageHistory]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        typeof message.authorParticipantId === "string" &&
        message.authorParticipantId.trim().length > 0,
    );
  const lastSpeakerIndex = speakerEntries.findIndex(
    (entry) => entry.participant.id === lastAssistantMessage?.authorParticipantId,
  );
  if (lastSpeakerIndex >= 0) {
    const nextSpeaker = speakerEntries[(lastSpeakerIndex + 1) % speakerEntries.length];
    return {
      participant: nextSpeaker.participant,
      persona: nextSpeaker.persona,
      reason: "round_robin",
    };
  }

  const preferredSpeaker = speakerEntries.find(
    (entry) => entry.persona.id === preferredPersonaId,
  );
  if (preferredSpeaker) {
    return {
      participant: preferredSpeaker.participant,
      persona: preferredSpeaker.persona,
      reason: "fallback",
    };
  }

  const [firstSpeaker] = speakerEntries;
  return {
    participant: firstSpeaker.participant,
    persona: firstSpeaker.persona,
    reason: "fallback",
  };
}

function resolveConsecutiveAssistantSpeaker(messages: ChatMessage[]) {
  let participantId: string | null = null;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const authorParticipantId = message.authorParticipantId?.trim();
    if (!authorParticipantId) continue;
    if (!participantId) {
      participantId = authorParticipantId;
      count = 1;
      continue;
    }
    if (authorParticipantId !== participantId) break;
    count += 1;
  }
  if (!participantId || count <= 0) return null;
  return { participantId, count };
}

function buildAutonomousFollowupPrompt(
  mode: "group" | "adventure",
  userInput: string,
  recentMessages: ChatMessage[],
  sceneObjective?: string,
) {
  const recentLines = recentMessages
    .slice(-4)
    .map((message) =>
      `${message.role === "user" ? "Пользователь" : "Участник"}: ${message.content
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220)}`,
    );
  const base = [
    `Исходная реплика пользователя: ${userInput}`,
    ...(recentLines.length > 0
      ? ["Последние реплики в чате:", ...recentLines]
      : []),
  ];
  if (mode === "adventure") {
    base.push(
      `Цель текущей сцены: ${sceneObjective?.trim() || "развивай сюжет поступательно"}`,
      "Ответь как участник приключения и продвинь сцену на один небольшой шаг.",
    );
  } else {
    base.push(
      "Ответь как участник группового чата на реплики других персонажей и развивай их диалог между собой.",
    );
  }
  return base.join("\n");
}

function messageHasImages(message: ChatMessage) {
  const attachmentHasImage = (message.attachments ?? []).some(
    (attachment) => attachment.type === "image",
  );
  return (
    attachmentHasImage ||
    (message.imageUrls?.length ?? 0) > 0 ||
    (message.imageGenerationCompleted ?? 0) > 0
  );
}

function evaluateImageActionPolicy(
  messages: ChatMessage[],
  speakerParticipantId: string | null | undefined,
) {
  const normalizedParticipantId = speakerParticipantId?.trim() ?? "";
  if (!normalizedParticipantId) {
    return {
      blocked: false,
      reason: null as string | null,
    };
  }
  const assistantTurns = messages.filter(
    (message) =>
      message.role === "assistant" &&
      (message.authorParticipantId?.trim() ?? "") === normalizedParticipantId,
  );
  if (assistantTurns.length === 0) {
    return {
      blocked: false,
      reason: null as string | null,
    };
  }

  let turnsSinceLastImage = Number.POSITIVE_INFINITY;
  for (let index = assistantTurns.length - 1, offset = 0; index >= 0; index -= 1, offset += 1) {
    if (messageHasImages(assistantTurns[index])) {
      turnsSinceLastImage = offset;
      break;
    }
  }
  if (
    Number.isFinite(turnsSinceLastImage) &&
    turnsSinceLastImage < IMAGE_ACTION_COOLDOWN_ASSISTANT_TURNS
  ) {
    return {
      blocked: true,
      reason: "cooldown",
    };
  }

  const windowMessages = assistantTurns.slice(-IMAGE_ACTION_WINDOW_ASSISTANT_TURNS);
  const imageMessagesInWindow = windowMessages.filter((message) =>
    messageHasImages(message),
  ).length;
  if (imageMessagesInWindow >= IMAGE_ACTION_MAX_PER_WINDOW) {
    return {
      blocked: true,
      reason: "window_limit",
    };
  }

  return {
    blocked: false,
    reason: null as string | null,
  };
}

function titleFromText(text: string) {
  const first = text.replace(/\s+/g, " ").trim().slice(0, 48);
  return first || "Новый чат";
}

interface MemoryRemovalDirective {
  id?: string;
  layer?: PersonaMemory["layer"];
  kind?: PersonaMemory["kind"];
  content?: string;
}

function normalizeMemoryText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function applyMemoryRemovalDirectives(
  memories: PersonaMemory[],
  directives: MemoryRemovalDirective[],
): { kept: PersonaMemory[]; removedIds: string[] } {
  if (directives.length === 0) {
    return { kept: memories, removedIds: [] };
  }

  const removedIds = new Set<string>();
  const kept: PersonaMemory[] = [];

  for (const memory of memories) {
    const shouldRemove = directives.some((directive) => {
      if (directive.id && directive.id === memory.id) return true;
      if (directive.layer && directive.layer !== memory.layer) return false;
      if (directive.kind && directive.kind !== memory.kind) return false;
      if (directive.content) {
        const expected = normalizeMemoryText(directive.content);
        const actual = normalizeMemoryText(memory.content);
        if (!actual.includes(expected) && !expected.includes(actual)) {
          return false;
        }
      }
      return Boolean(directive.layer || directive.kind || directive.content);
    });

    if (shouldRemove) {
      removedIds.add(memory.id);
      continue;
    }
    kept.push(memory);
  }

  return { kept, removedIds: Array.from(removedIds) };
}

async function loadChatArtifacts(chatId: string | null, personaId?: string | null) {
  if (!chatId) {
    return {
      messages: [] as ChatMessage[],
      state: null as PersonaRuntimeState | null,
      memories: [] as PersonaMemory[],
      events: [] as ChatEvent[],
      participants: [] as ChatParticipant[],
    };
  }
  const [messages, state, memories, events, participants] = await Promise.all([
    dbApi.getMessages(chatId),
    dbApi.getPersonaState(chatId, personaId ?? undefined),
    dbApi.getMemories(chatId),
    dbApi.getChatEvents(chatId, 200),
    dbApi.getChatParticipants(chatId),
  ]);
  return {
    messages,
    state: state ?? null,
    memories,
    events,
    participants,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  personas: [],
  chats: [],
  messages: [],
  activeChatEvents: [],
  activeChatParticipants: [],
  activePersonaState: null,
  activeMemories: [],
  activePersonaId: null,
  activeChatId: null,
  settings: DEFAULT_SETTINGS,
  initialized: false,
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  initialize: async () => {
    set({ isLoading: true, error: null });
    try {
      let personas = await dbApi.getPersonas();
      const settings = await dbApi.getSettings();

      if (personas.length === 0) {
        const ts = nowIso();
        const starter: Persona = {
          id: id(),
          name: "Астра",
          personalityPrompt: "Доброжелательная, любопытная, поддерживающая, структурная.",
          stylePrompt: "Говорит понятно, спокойно и по делу, без лишней воды.",
          appearance: {
            faceDescription: "мягкие черты лица, спокойный взгляд",
            height: "средний рост",
            eyes: "светлые глаза, аккуратная форма",
            lips: "естественные, средней полноты",
            hair: "короткие серебристые волосы",
            ageType: "young adult",
            bodyType: "стройное телосложение",
            markers: "",
            accessories: "",
            clothingStyle: "minimalist futuristic casual",
            skin: "светлая ровная кожа",
          },
          imageCheckpoint: "",
          advanced: createDefaultAdvancedProfile(),
          avatarUrl: "",
          fullBodyUrl: "",
          fullBodySideUrl: "",
          fullBodyBackUrl: "",
          avatarImageId: "",
          fullBodyImageId: "",
          fullBodySideImageId: "",
          fullBodyBackImageId: "",
          createdAt: ts,
          updatedAt: ts,
        };
        await dbApi.savePersona(starter);
        personas = [starter];
      }

      const activePersonaId = personas[0].id;
      const chats = await dbApi.getChatsForPersona(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId, activePersonaId);

      set({
        personas,
        settings,
        activePersonaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activeChatEvents: artifacts.events,
        activeChatParticipants: artifacts.participants,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        initialized: true,
        isLoading: false,
      });
    } catch (error) {
      set({ initialized: true, isLoading: false, error: (error as Error).message });
    }
  },

  selectPersona: async (personaId) => {
    set({ isLoading: true, error: null });
    try {
      const chats = await dbApi.getChatsForPersona(personaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId, personaId);

      set({
        activePersonaId: personaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activeChatEvents: artifacts.events,
        activeChatParticipants: artifacts.participants,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  selectChat: async (chatId) => {
    set({ isLoading: true, error: null });
    try {
      const artifacts = await loadChatArtifacts(chatId, get().activePersonaId);
      set({
        activeChatId: chatId,
        messages: artifacts.messages,
        activeChatEvents: artifacts.events,
        activeChatParticipants: artifacts.participants,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  savePersona: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const persona: Persona = {
        id: input.id ?? id(),
        name: input.name.trim(),
        personalityPrompt: input.personalityPrompt.trim(),
        stylePrompt: input.stylePrompt.trim(),
        appearance: {
          faceDescription: input.appearance.faceDescription.trim(),
          height: input.appearance.height.trim(),
          eyes: input.appearance.eyes.trim(),
          lips: input.appearance.lips.trim(),
          hair: input.appearance.hair.trim(),
          ageType: input.appearance.ageType.trim(),
          bodyType: input.appearance.bodyType.trim(),
          markers: input.appearance.markers.trim(),
          accessories: input.appearance.accessories.trim(),
          clothingStyle: input.appearance.clothingStyle.trim(),
          skin: input.appearance.skin.trim(),
        },
        imageCheckpoint: input.imageCheckpoint.trim(),
        advanced: normalizeAdvancedProfile(input.advanced ?? createDefaultAdvancedProfile()),
        avatarUrl: input.avatarUrl.trim(),
        fullBodyUrl: input.fullBodyUrl.trim(),
        fullBodySideUrl: input.fullBodySideUrl.trim(),
        fullBodyBackUrl: input.fullBodyBackUrl.trim(),
        avatarImageId: input.avatarImageId?.trim() ?? "",
        fullBodyImageId: input.fullBodyImageId?.trim() ?? "",
        fullBodySideImageId: input.fullBodySideImageId?.trim() ?? "",
        fullBodyBackImageId: input.fullBodyBackImageId?.trim() ?? "",
        imageMetaByUrl: input.imageMetaByUrl,
        lookPromptCache: input.lookPromptCache,
        createdAt: get().personas.find((personaItem) => personaItem.id === input.id)?.createdAt ?? ts,
        updatedAt: ts,
      };

      await dbApi.savePersona(persona);
      const personas = await dbApi.getPersonas();

      let activePersonaId = get().activePersonaId;
      if (!activePersonaId) {
        activePersonaId = persona.id;
      }

      set({ personas, activePersonaId, isLoading: false });
      if (activePersonaId === persona.id) {
        await get().selectPersona(activePersonaId);
      }
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  deletePersona: async (personaId) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.deletePersona(personaId);
      const personas = await dbApi.getPersonas();
      const nextActive = personas[0]?.id ?? null;
      const chats = nextActive ? await dbApi.getChatsForPersona(nextActive) : [];
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId, nextActive);

      set({
        personas,
        activePersonaId: nextActive,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activeChatEvents: artifacts.events,
        activeChatParticipants: artifacts.participants,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  createChat: async () => {
    const activePersonaId = get().activePersonaId;
    if (!activePersonaId) return;

    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const chat: ChatSession = {
        id: id(),
        personaId: activePersonaId,
        mode: "direct",
        status: "idle",
        title: "Новый чат",
        chatStyleStrength: undefined,
        createdAt: ts,
        updatedAt: ts,
      };
      await dbApi.saveChat(chat);

      const persona = get().personas.find((item) => item.id === activePersonaId);
      const initialState = persona ? createInitialPersonaState(persona, chat.id) : null;
      if (initialState) {
        await dbApi.savePersonaState(initialState);
      }
      const chatParticipants: ChatParticipant[] = [
        buildUserParticipant(chat.id, 0),
        ...(persona ? [buildPersonaParticipant(chat.id, persona, 1)] : []),
      ];
      await dbApi.saveChatParticipants(chatParticipants);

      const chats = await dbApi.getChatsForPersona(activePersonaId);
      set({
        chats,
        activeChatId: chat.id,
        messages: [],
        activeChatEvents: [],
        activeChatParticipants: chatParticipants,
        activePersonaState: initialState,
        activeMemories: [],
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  createGroupChat: async (participantPersonaIds, title) => {
    const activePersonaId = get().activePersonaId;
    if (!activePersonaId) return;

    const selectedIds = Array.from(
      new Set([
        activePersonaId,
        ...participantPersonaIds.map((value) => value.trim()).filter(Boolean),
      ]),
    );
    const selectedPersonas = get().personas.filter((persona) =>
      selectedIds.includes(persona.id),
    );

    if (selectedPersonas.length < 2) {
      set({
        error: "Для группового чата нужно выбрать минимум 2 персоны.",
      });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const cleanTitle = title?.trim();
      const generatedTitle = `Группа: ${selectedPersonas
        .slice(0, 3)
        .map((persona) => persona.name.trim() || "Персона")
        .join(" + ")}${selectedPersonas.length > 3 ? "..." : ""}`;
      const chat: ChatSession = {
        id: id(),
        personaId: activePersonaId,
        mode: "group",
        status: "idle",
        title: cleanTitle || generatedTitle,
        chatStyleStrength: undefined,
        createdAt: ts,
        updatedAt: ts,
      };
      await dbApi.saveChat(chat);

      const participants: ChatParticipant[] = [
        buildUserParticipant(chat.id, 0),
        ...selectedPersonas.map((persona, index) =>
          buildPersonaParticipant(chat.id, persona, index + 1),
        ),
      ];
      await dbApi.saveChatParticipants(participants);
      await Promise.all(
        selectedPersonas.map((persona) =>
          dbApi.savePersonaState(createInitialPersonaState(persona, chat.id)),
        ),
      );

      const chats = await dbApi.getChatsForPersona(activePersonaId);
      const activeState = await dbApi.getPersonaState(chat.id, activePersonaId);
      set({
        chats,
        activeChatId: chat.id,
        messages: [],
        activeChatEvents: [],
        activeChatParticipants: participants,
        activePersonaState: activeState ?? null,
        activeMemories: [],
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  createAdventureChat: async (participantPersonaIds, scenario) => {
    const activePersonaId = get().activePersonaId;
    if (!activePersonaId) return;

    const selectedIds = Array.from(
      new Set([
        activePersonaId,
        ...participantPersonaIds.map((value) => value.trim()).filter(Boolean),
      ]),
    );
    const selectedPersonas = get().personas.filter((persona) =>
      selectedIds.includes(persona.id),
    );

    if (selectedPersonas.length < 1) {
      set({
        error: "Для приключения нужно выбрать хотя бы одну персону.",
      });
      return;
    }

    const cleanTitle = scenario.title.trim();
    const cleanStartContext = scenario.startContext.trim();
    const cleanInitialGoal = scenario.initialGoal.trim();
    const cleanNarratorStyle = scenario.narratorStyle.trim();
    const worldTone: AdventureScenario["worldTone"] =
      scenario.worldTone === "light" ||
      scenario.worldTone === "balanced" ||
      scenario.worldTone === "dark"
        ? scenario.worldTone
        : "balanced";
    const explicitnessPolicy: AdventureScenario["explicitnessPolicy"] =
      scenario.explicitnessPolicy === "fade_to_black" ||
      scenario.explicitnessPolicy === "balanced" ||
      scenario.explicitnessPolicy === "explicit"
        ? scenario.explicitnessPolicy
        : "fade_to_black";

    if (!cleanStartContext || !cleanInitialGoal) {
      set({
        error: "Для приключения заполните стартовый контекст и цель сцены.",
      });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const ts = nowIso();
      const chatId = id();
      const scenarioId = id();
      const fallbackTitle = `Приключение: ${selectedPersonas
        .slice(0, 2)
        .map((persona) => persona.name.trim() || "Персона")
        .join(" + ")}${selectedPersonas.length > 2 ? "..." : ""}`;
      const chatTitle = cleanTitle || fallbackTitle;

      const adventureScenario: AdventureScenario = {
        id: scenarioId,
        title: chatTitle,
        startContext: cleanStartContext,
        initialGoal: cleanInitialGoal,
        narratorStyle:
          cleanNarratorStyle || "Кинематографичный, эмоционально точный рассказчик.",
        worldTone,
        explicitnessPolicy,
        createdAt: ts,
        updatedAt: ts,
      };
      const chat: ChatSession = {
        id: chatId,
        personaId: activePersonaId,
        mode: "adventure",
        status: "idle",
        scenarioId,
        title: chatTitle,
        chatStyleStrength: undefined,
        createdAt: ts,
        updatedAt: ts,
      };
      const participants: ChatParticipant[] = [
        buildUserParticipant(chat.id, 0),
        buildNarratorParticipant(chat.id, 1),
        ...selectedPersonas.map((persona, index) =>
          buildPersonaParticipant(chat.id, persona, index + 2),
        ),
      ];
      const adventureState: AdventureState = {
        id: chat.id,
        chatId: chat.id,
        scenarioId: adventureScenario.id,
        currentScene: adventureScenario.startContext,
        sceneObjective: adventureScenario.initialGoal,
        openThreads: [adventureScenario.initialGoal],
        resolvedThreads: [],
        timelineSummary: `Старт приключения: ${adventureScenario.title}`,
        updatedAt: ts,
      };
      const bootstrapNarration: ChatMessage = {
        id: id(),
        chatId: chat.id,
        role: "system",
        messageType: "narration",
        authorParticipantId: participants.find(
          (participant) => participant.participantType === "narrator",
        )?.id,
        content: `${adventureScenario.startContext}\n\nЦель сцены: ${adventureScenario.initialGoal}`,
        createdAt: ts,
      };

      await dbApi.saveAdventureScenario(adventureScenario);
      await dbApi.saveChat(chat);
      await dbApi.saveChatParticipants(participants);
      await dbApi.saveAdventureState(adventureState);
      await dbApi.saveMessage(bootstrapNarration);
      await Promise.all(
        selectedPersonas.map((persona) =>
          dbApi.savePersonaState(createInitialPersonaState(persona, chat.id)),
        ),
      );

      const chats = await dbApi.getChatsForPersona(activePersonaId);
      const activeState = await dbApi.getPersonaState(chat.id, activePersonaId);
      set({
        chats,
        activeChatId: chat.id,
        messages: [bootstrapNarration],
        activeChatEvents: [],
        activeChatParticipants: participants,
        activePersonaState: activeState ?? null,
        activeMemories: [],
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  deleteChat: async (chatId) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.deleteChat(chatId);
      const activePersonaId = get().activePersonaId;
      if (!activePersonaId) {
        set({
          chats: [],
          activeChatId: null,
          messages: [],
          activeChatEvents: [],
          activeChatParticipants: [],
          activePersonaState: null,
          activeMemories: [],
          isLoading: false,
        });
        return;
      }
      const chats = await dbApi.getChatsForPersona(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId, activePersonaId);

      set({
        chats,
        activeChatId,
        messages: artifacts.messages,
        activeChatEvents: artifacts.events,
        activeChatParticipants: artifacts.participants,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  setChatStyleStrength: async (chatId, value) => {
    set({ isLoading: true, error: null });
    try {
      const currentChat = get().chats.find((chat) => chat.id === chatId);
      if (!currentChat) {
        set({ isLoading: false });
        return;
      }
      const normalizedValue =
        typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, Math.min(1, Number(value)))
          : undefined;
      const updatedChat: ChatSession = {
        ...currentChat,
        chatStyleStrength: normalizedValue,
        updatedAt: nowIso(),
      };
      await dbApi.saveChat(updatedChat);
      const chats = await dbApi.getChatsForPersona(updatedChat.personaId);
      set({
        chats,
        activeChatId: chatId,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  sendMessage: async (content) => {
    const trimmedContent = content.trim();
    if (!trimmedContent) return;

    const state = get();
    const activePersona = state.personas.find(
      (persona) => persona.id === state.activePersonaId,
    );
    if (!activePersona) return;

    let activeChatId = state.activeChatId;
    if (!activeChatId) {
      await get().createChat();
      activeChatId = get().activeChatId;
    }
    if (!activeChatId) return;

    let activeChat =
      get().chats.find((chat) => chat.id === activeChatId) ??
      (await dbApi.getChatById(activeChatId));
    if (!activeChat) return;

    const allChats = await dbApi.getAllChats();
    const busyOtherChats = allChats.filter(
      (chat) => chat.status === "busy" && chat.id !== activeChatId,
    );
    if (busyOtherChats.length >= GLOBAL_ACTIVE_TURN_LIMIT) {
      set({
        error: "Система занята активной генерацией в другом чате. Дождитесь завершения.",
      });
      return;
    }

    if (activeChat.status === "busy") {
      set({
        error: "Чат уже обрабатывает предыдущий ход. Дождитесь завершения.",
      });
      return;
    }

    let turnId: string | null = null;
    let turnJob: TurnJob | null = null;
    let resolvedState: PersonaRuntimeState | null = null;
    let processingError: Error | null = null;

    const updateTurnJob = async (patch: Partial<TurnJob>) => {
      if (!turnJob) return;
      turnJob = {
        ...turnJob,
        ...patch,
      };
      await dbApi.saveTurnJob(turnJob);
    };

    const appendChatEvent = (event: ChatEvent) => {
      set((current) => {
        if (current.activeChatId !== activeChatId) {
          return current;
        }
        const nextEvents = [...current.activeChatEvents, event]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(-200);
        return {
          activeChatEvents: nextEvents,
        };
      });
    };

    const buildChatEvent = (
      eventType: ChatEvent["eventType"],
      payload: Record<string, unknown>,
    ) => {
      if (!turnId) return null;
      const event: ChatEvent = {
        id: id(),
        chatId: activeChatId,
        turnId,
        eventType,
        payload,
        createdAt: nowIso(),
      };
      return event;
    };

    const pushChatEvent = async (
      eventType: ChatEvent["eventType"],
      payload: Record<string, unknown>,
    ) => {
      const event = buildChatEvent(eventType, payload);
      if (!event) return;
      await dbApi.saveChatEvent(event);
      appendChatEvent(event);
    };

    const runStageWithRetry = async <T>(
      stageName: string,
      runner: () => Promise<T>,
      maxAttempts = RETRYABLE_STAGE_ATTEMPTS,
    ) => {
      let attempt = 0;
      let lastError: Error | null = null;
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          return await runner();
        } catch (error) {
          lastError = error as Error;
          if (attempt >= maxAttempts) break;
          await updateTurnJob({
            retryCount: Math.max(turnJob?.retryCount ?? 0, attempt),
            payload: {
              retryStage: stageName,
              retryAttempt: attempt,
            },
          });
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BACKOFF_MS * attempt),
          );
        }
      }
      throw lastError ?? new Error(`Stage ${stageName} failed`);
    };

    try {
      const lock = await dbApi.acquireChatTurnLock(activeChatId);
      if (!lock) {
        set({
          error: "Чат уже обрабатывает предыдущий ход. Дождитесь завершения.",
        });
        return;
      }
      turnId = lock.turnId;
      activeChat = lock.chat;

      set((current) => ({
        isLoading: true,
        error: null,
        chats: current.chats.map((chat) =>
          chat.id === activeChatId ? lock.chat : chat,
        ),
      }));

      turnJob = {
        id: id(),
        chatId: activeChatId,
        turnId,
        mode: activeChat.mode,
        stage: "turn_start",
        payload: {
          userMessageLength: trimmedContent.length,
        },
        status: "running",
        retryCount: 0,
        createdAt: nowIso(),
        startedAt: nowIso(),
      };
      await dbApi.saveTurnJob(turnJob);
      await pushChatEvent("turn_started", {
        mode: activeChat.mode,
      });

      const currentMessages = get().messages;
      const chatParticipants =
        get().activeChatId === activeChatId && get().activeChatParticipants.length > 0
          ? get().activeChatParticipants
          : await dbApi.getChatParticipants(activeChatId);
      const personasById = new Map(
        get().personas.map((persona) => [persona.id, persona] as const),
      );
      const personaSpeakerEntries = chatParticipants
        .filter(
          (participant) =>
            participant.participantType === "persona" && participant.isActive,
        )
        .map((participant) => {
          const persona = personasById.get(participant.participantRefId.trim());
          if (!persona) return null;
          return { participant, persona };
        })
        .filter(
          (entry): entry is { participant: ChatParticipant; persona: Persona } =>
            Boolean(entry),
        )
        .sort((left, right) => left.participant.order - right.participant.order);
      const userParticipant =
        chatParticipants.find(
          (participant) =>
            participant.participantType === "user" && participant.isActive,
        ) ??
        chatParticipants.find(
          (participant) => participant.participantType === "user",
        ) ??
        null;

      const userMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "user",
        authorParticipantId: userParticipant?.id,
        content: trimmedContent,
        turnId,
        createdAt: nowIso(),
      };

      const nextMessages = [...currentMessages, userMessage];
      set({ messages: nextMessages });
      const userMessageEvent = buildChatEvent("message_created", {
        role: "user",
        messageId: userMessage.id,
        authorParticipantId: userMessage.authorParticipantId ?? null,
      });
      if (userMessageEvent) {
        await dbApi.commitTurnArtifacts({
          messages: [userMessage],
          events: [userMessageEvent],
        });
        appendChatEvent(userMessageEvent);
      } else {
        await dbApi.saveMessage(userMessage);
      }

      if (activeChat.mode === "adventure") {
        const adventureChatTitle = activeChat.title;
        await updateTurnJob({
          stage: "planning",
          payload: {
            recentMessages: nextMessages.length,
            mode: "adventure",
          },
        });

        const narratorParticipant =
          chatParticipants.find(
            (participant) =>
              participant.participantType === "narrator" && participant.isActive,
          ) ??
          chatParticipants.find(
            (participant) => participant.participantType === "narrator",
          ) ??
          null;
        const [adventureScenario, currentAdventureState] = await Promise.all([
          activeChat.scenarioId
            ? dbApi.getAdventureScenario(activeChat.scenarioId)
            : Promise.resolve(null),
          dbApi.getAdventureState(activeChatId),
        ]);
        const worldTone =
          adventureScenario?.worldTone === "light" ||
          adventureScenario?.worldTone === "balanced" ||
          adventureScenario?.worldTone === "dark"
            ? adventureScenario.worldTone
            : "balanced";
        const fallbackState: AdventureState = {
          id: activeChatId,
          chatId: activeChatId,
          scenarioId:
            currentAdventureState?.scenarioId ??
            adventureScenario?.id ??
            activeChat.scenarioId ??
            activeChatId,
          currentScene:
            currentAdventureState?.currentScene ??
            adventureScenario?.startContext ??
            "Сцена только начинается.",
          sceneObjective:
            currentAdventureState?.sceneObjective ??
            adventureScenario?.initialGoal ??
            "Определить ближайшую цель.",
          openThreads:
            currentAdventureState?.openThreads ??
            (adventureScenario?.initialGoal
              ? [adventureScenario.initialGoal]
              : []),
          resolvedThreads: currentAdventureState?.resolvedThreads ?? [],
          timelineSummary:
            currentAdventureState?.timelineSummary ??
            `Старт приключения: ${adventureScenario?.title ?? adventureChatTitle}`,
          updatedAt: nowIso(),
        };
        const recentAdventureMessages: AdventureArbiterRecentMessage[] =
          nextMessages.slice(-10).map((message) => {
            const author = message.authorParticipantId
              ? chatParticipants.find(
                  (participant) => participant.id === message.authorParticipantId,
                )
              : undefined;
            const authorName =
              author?.displayName ??
              (message.role === "user"
                ? "Вы"
                : message.role === "assistant"
                  ? "Участник"
                  : "Система");
            return {
              role: message.role,
              authorName,
              content: message.content,
            };
          });

        const arbiterDecision = await runStageWithRetry("decision", () =>
          requestAdventureArbiterDecision(get().settings, {
            userMessage: trimmedContent,
            scenario: {
              title: adventureScenario?.title ?? adventureChatTitle,
              startContext:
                adventureScenario?.startContext ?? fallbackState.currentScene,
              initialGoal:
                adventureScenario?.initialGoal ?? fallbackState.sceneObjective,
              narratorStyle:
                adventureScenario?.narratorStyle ??
                "Кинематографичный и эмоционально точный рассказчик",
              worldTone,
              explicitnessPolicy:
                adventureScenario?.explicitnessPolicy ?? "fade_to_black",
            },
            state: {
              currentScene: fallbackState.currentScene,
              sceneObjective: fallbackState.sceneObjective,
              openThreads: fallbackState.openThreads,
              resolvedThreads: fallbackState.resolvedThreads,
              timelineSummary: fallbackState.timelineSummary,
            },
            participants: personaSpeakerEntries.map(
              (entry) => entry.participant.displayName,
            ),
            recentMessages: recentAdventureMessages,
          }),
        );

        await updateTurnJob({
          stage: "decision",
          payload: {
            mode: "adventure",
            currentScene: arbiterDecision.currentScene,
            sceneObjective: arbiterDecision.sceneObjective,
            openThreads: arbiterDecision.openThreads,
            resolvedThreads: arbiterDecision.resolvedThreads,
            confidence: arbiterDecision.confidence,
          },
        });

        const narrationMessage: ChatMessage = {
          id: id(),
          chatId: activeChatId,
          role: "assistant",
          messageType: "narration",
          authorParticipantId: narratorParticipant?.id,
          content: arbiterDecision.narration,
          turnId,
          createdAt: nowIso(),
        };
        const nextAdventureState: AdventureState = {
          id: fallbackState.id,
          chatId: fallbackState.chatId,
          scenarioId: fallbackState.scenarioId,
          currentScene: arbiterDecision.currentScene,
          sceneObjective: arbiterDecision.sceneObjective,
          openThreads: arbiterDecision.openThreads,
          resolvedThreads: arbiterDecision.resolvedThreads,
          timelineSummary: arbiterDecision.timelineSummary,
          updatedAt: nowIso(),
        };
        const arbiterDecisionEvent = buildChatEvent("arbiter_decision", {
          governanceProtocol: "propose_review_arbitrate",
          rationale: arbiterDecision.rationale,
          confidence: arbiterDecision.confidence,
          currentScene: arbiterDecision.currentScene,
          sceneObjective: arbiterDecision.sceneObjective,
          openThreads: arbiterDecision.openThreads,
          resolvedThreads: arbiterDecision.resolvedThreads,
          timelineSummary: arbiterDecision.timelineSummary,
        });
        const narrationCreatedEvent = buildChatEvent("message_created", {
          role: "assistant",
          messageType: "narration",
          messageId: narrationMessage.id,
          authorParticipantId: narrationMessage.authorParticipantId ?? null,
        });
        const adventureMessages: ChatMessage[] = [...nextMessages, narrationMessage];
        const adventureAssistantMessages: ChatMessage[] = [narrationMessage];
        const adventureEvents: ChatEvent[] = [
          arbiterDecisionEvent,
          narrationCreatedEvent,
        ].filter((event): event is ChatEvent => Boolean(event));
        let latestResponseId = activeChat.lastResponseId;
        const usedAdventureSpeakerIds = new Set<string>();

        if (personaSpeakerEntries.length > 0 && ADVENTURE_AUTONOMOUS_REPLY_COUNT > 0) {
          for (
            let beatIndex = 0;
            beatIndex < ADVENTURE_AUTONOMOUS_REPLY_COUNT;
            beatIndex += 1
          ) {
            const availableEntries = personaSpeakerEntries.filter(
              (entry) => !usedAdventureSpeakerIds.has(entry.participant.id),
            );
            const candidateEntries =
              availableEntries.length > 0 ? availableEntries : personaSpeakerEntries;
            if (candidateEntries.length === 0) break;

            let selectedEntry =
              candidateEntries.find(
                (entry) => entry.persona.id === activePersona.id,
              ) ?? candidateEntries[0];

            if (candidateEntries.length > 1) {
              const directorCandidates: GroupDirectorCandidate[] =
                candidateEntries.map((entry) => ({
                  participantId: entry.participant.id,
                  personaId: entry.persona.id,
                  displayName: entry.participant.displayName,
                }));
              const directorRecentMessages: GroupDirectorRecentMessage[] =
                adventureMessages.slice(-8).map((message) => {
                  const author = message.authorParticipantId
                    ? chatParticipants.find(
                        (participant) => participant.id === message.authorParticipantId,
                      )
                    : undefined;
                  const authorName =
                    author?.displayName ??
                    (message.role === "user"
                      ? "Вы"
                      : message.role === "assistant"
                        ? "Участник"
                        : "Система");
                  return {
                    role: message.role,
                    authorName,
                    content: message.content,
                  };
                });
              try {
                const directorDecision = await runStageWithRetry("decision", () =>
                  requestGroupDirectorDecision(get().settings, {
                    userMessage: trimmedContent,
                    candidates: directorCandidates,
                    recentMessages: directorRecentMessages,
                    blockedParticipantIds: Array.from(usedAdventureSpeakerIds),
                  }),
                );
                const directedEntry = candidateEntries.find(
                  (entry) =>
                    entry.participant.id === directorDecision.speakerParticipantId,
                );
                if (directedEntry) {
                  selectedEntry = directedEntry;
                }
              } catch {
                // fallback to deterministic selection
              }
            }

            usedAdventureSpeakerIds.add(selectedEntry.participant.id);
            const speakerSelectedEvent = buildChatEvent("speaker_selected", {
              mode: "adventure",
              speakerParticipantId: selectedEntry.participant.id,
              speakerPersonaId: selectedEntry.persona.id,
              reason: "autonomous_reply",
            });
            if (speakerSelectedEvent) {
              adventureEvents.push(speakerSelectedEvent);
            }

            try {
              const loadedState = await dbApi.getPersonaState(
                activeChatId,
                selectedEntry.persona.id,
              );
              const runtimeState = ensurePersonaState(
                loadedState ?? undefined,
                selectedEntry.persona,
                activeChatId,
              );
              if (!loadedState) {
                await dbApi.savePersonaState(runtimeState);
              }

              const allMemories = await dbApi.getMemories(activeChatId);
              const memoryPool = allMemories.filter(
                (memory) => memory.personaId === selectedEntry.persona.id,
              );
              const followupInput = buildAutonomousFollowupPrompt(
                "adventure",
                trimmedContent,
                adventureMessages,
                nextAdventureState.sceneObjective,
              );
              const recentMessages = buildRecentMessages(adventureMessages, 5);
              const conversationSummary = buildConversationSummary(
                adventureMessages,
                8,
                5,
              );
              const memoryCard = buildLayeredMemoryContextCard(
                memoryPool,
                recentMessages,
                selectedEntry.persona.advanced.memory.decayDays,
              );
              const followupAnswer = await runStageWithRetry("actor_response", () =>
                requestChatCompletion(
                  get().settings,
                  selectedEntry.persona,
                  followupInput,
                  latestResponseId,
                  {
                    runtimeState,
                    memoryCard,
                    recentMessages,
                    conversationSummary,
                  },
                ),
              );
              latestResponseId =
                followupAnswer.responseId ?? latestResponseId;

              const followupMessage: ChatMessage = {
                id: id(),
                chatId: activeChatId,
                role: "assistant",
                authorParticipantId: selectedEntry.participant.id,
                content: followupAnswer.content,
                personaControlRaw: followupAnswer.personaControl
                  ? JSON.stringify(followupAnswer.personaControl)
                  : undefined,
                turnId,
                createdAt: nowIso(),
              };

              adventureAssistantMessages.push(followupMessage);
              adventureMessages.push(followupMessage);
              const followupCreatedEvent = buildChatEvent("message_created", {
                role: "assistant",
                messageId: followupMessage.id,
                authorParticipantId: followupMessage.authorParticipantId ?? null,
              });
              if (followupCreatedEvent) {
                adventureEvents.push(followupCreatedEvent);
              }

              const evolvedState = evolvePersonaState(
                runtimeState,
                selectedEntry.persona,
                followupInput,
                followupMessage.content,
              );
              await dbApi.savePersonaState(evolvedState);
              if (selectedEntry.persona.id === activePersona.id) {
                resolvedState = evolvedState;
              }
            } catch {
              break;
            }
          }
        }

        set({ messages: adventureMessages });
        await updateTurnJob({
          stage: "commit",
          payload: {
            mode: "adventure",
            sceneObjective: nextAdventureState.sceneObjective,
            openThreadsCount: nextAdventureState.openThreads.length,
            resolvedThreadsCount: nextAdventureState.resolvedThreads.length,
            assistantMessages: adventureAssistantMessages.length,
          },
        });

        const latestChat = (await dbApi.getChatById(activeChatId)) ?? activeChat;
        const updatedChat: ChatSession = {
          ...latestChat,
          title:
            latestChat.title === "Новый чат"
              ? titleFromText(trimmedContent)
              : latestChat.title,
          lastResponseId: latestResponseId,
          updatedAt: nowIso(),
        };
        const committedEvent = buildChatEvent("turn_committed", {
          mode: "adventure",
          messageId:
            adventureAssistantMessages[adventureAssistantMessages.length - 1]?.id ??
            narrationMessage.id,
          assistantMessages: adventureAssistantMessages.length,
        });
        if (committedEvent) {
          adventureEvents.push(committedEvent);
        }
        const finalizedTurnJob = turnJob
          ? {
              ...turnJob,
              stage: "finalize" as const,
              status: "done" as const,
              finishedAt: nowIso(),
            }
          : null;
        if (finalizedTurnJob) {
          turnJob = finalizedTurnJob;
        }

        await dbApi.commitTurnArtifacts({
          chat: updatedChat,
          messages: adventureAssistantMessages,
          events: adventureEvents,
          turnJob: finalizedTurnJob ?? undefined,
          adventureState: nextAdventureState,
        });
        for (const event of adventureEvents) {
          appendChatEvent(event);
        }
        return;
      }

      const defaultSpeakerEntry =
        personaSpeakerEntries.find(
          (entry) => entry.participant.participantRefId === activePersona.id,
        ) ?? personaSpeakerEntries[0];
      let speakerSelection: GroupSpeakerSelection | null =
        activeChat.mode === "group"
          ? resolveGroupSpeaker(
              chatParticipants,
              personasById,
              trimmedContent,
              nextMessages,
              activePersona.id,
            )
          : null;
      if (!speakerSelection && defaultSpeakerEntry) {
        speakerSelection = {
          participant: defaultSpeakerEntry.participant,
          persona: defaultSpeakerEntry.persona,
          reason: "fallback",
        };
      }
      if (!speakerSelection) {
        speakerSelection = {
          participant: defaultSpeakerEntry?.participant,
          persona: defaultSpeakerEntry?.persona ?? activePersona,
          reason: "fallback",
        };
      }

      let decisionSource: "heuristic" | "director_llm" = "heuristic";
      const consecutiveAssistant = resolveConsecutiveAssistantSpeaker(currentMessages);
      const blockedParticipantIds =
        consecutiveAssistant && consecutiveAssistant.count >= 2
          ? [consecutiveAssistant.participantId]
          : [];
      let antiRepeatGuardApplied = false;

      if (activeChat.mode === "group" && personaSpeakerEntries.length > 1) {
        const directorCandidates: GroupDirectorCandidate[] = personaSpeakerEntries.map(
          (entry) => ({
            participantId: entry.participant.id,
            personaId: entry.persona.id,
            displayName: entry.participant.displayName,
          }),
        );
        const directorRecentMessages: GroupDirectorRecentMessage[] = nextMessages
          .slice(-8)
          .map((message) => {
            const author = message.authorParticipantId
              ? chatParticipants.find(
                  (participant) => participant.id === message.authorParticipantId,
                )
              : undefined;
            const authorName =
              author?.displayName ??
              (message.role === "user" ? "Вы" : message.role === "assistant" ? "Персона" : "Система");
            return {
              role: message.role,
              authorName,
              content: message.content,
            };
          });

        try {
          const directorDecision = await runStageWithRetry("decision", () =>
            requestGroupDirectorDecision(get().settings, {
              userMessage: trimmedContent,
              candidates: directorCandidates,
              recentMessages: directorRecentMessages,
              blockedParticipantIds,
            }),
          );
          const selectedEntry = personaSpeakerEntries.find(
            (entry) => entry.participant.id === directorDecision.speakerParticipantId,
          );
          if (selectedEntry) {
            speakerSelection = {
              participant: selectedEntry.participant,
              persona: selectedEntry.persona,
              reason: "director_llm",
            };
            decisionSource = "director_llm";
          }
        } catch {
          // fallback to deterministic heuristic selection
        }
      }

      if (
        blockedParticipantIds.length > 0 &&
        !!speakerSelection.participant &&
        blockedParticipantIds.includes(speakerSelection.participant.id) &&
        personaSpeakerEntries.length > 1
      ) {
        const alternativeEntry =
          personaSpeakerEntries.find(
            (entry) =>
              !blockedParticipantIds.includes(entry.participant.id),
          ) ?? null;
        if (alternativeEntry) {
          speakerSelection = {
            participant: alternativeEntry.participant,
            persona: alternativeEntry.persona,
            reason: "round_robin",
          };
          antiRepeatGuardApplied = true;
        }
      }

      const speakerParticipant = speakerSelection.participant ?? null;
      const speakerPersona = speakerSelection.persona;
      const speakerDecisionReason = speakerSelection.reason;
      const speakerMentionToken = speakerSelection.mentionToken ?? null;

      await updateTurnJob({
        stage: "planning",
        payload: {
          recentMessages: nextMessages.length,
        },
      });

      await updateTurnJob({
        stage: "decision",
        payload: {
          speakerParticipantId: speakerParticipant?.id ?? null,
          speakerPersonaId: speakerPersona.id,
          reason: speakerDecisionReason,
          mentionToken: speakerMentionToken,
          decisionSource,
          blockedParticipantIds,
          antiRepeatGuardApplied,
        },
      });
      if (activeChat.mode === "group" && speakerParticipant) {
        await pushChatEvent("speaker_selected", {
          speakerParticipantId: speakerParticipant.id,
          speakerPersonaId: speakerPersona.id,
          reason: speakerDecisionReason,
          mentionToken: speakerMentionToken,
          decisionSource,
          blockedParticipantIds,
          antiRepeatGuardApplied,
        });
      }

      const loadedState =
        get().activeChatId === activeChatId &&
        get().activePersonaState?.personaId === speakerPersona.id
          ? get().activePersonaState
          : await dbApi.getPersonaState(activeChatId, speakerPersona.id);
      const runtimeState = ensurePersonaState(
        loadedState ?? undefined,
        speakerPersona,
        activeChatId,
      );
      if (!loadedState) {
        await dbApi.savePersonaState(runtimeState);
      }

      const allMemories =
        get().activeChatId === activeChatId && get().activeMemories.length > 0
          ? get().activeMemories
          : await dbApi.getMemories(activeChatId);
      const memoryPool = allMemories.filter(
        (memory) => memory.personaId === speakerPersona.id,
      );
      const recentMessages = buildRecentMessages(nextMessages, 5);
      const conversationSummary = buildConversationSummary(nextMessages, 8, 5);
      const memoryCard = buildLayeredMemoryContextCard(
        memoryPool,
        recentMessages,
        speakerPersona.advanced.memory.decayDays,
      );

      const answer = await runStageWithRetry("actor_response", () =>
        requestChatCompletion(
          get().settings,
          speakerPersona,
          trimmedContent,
          activeChat?.lastResponseId,
          {
            runtimeState,
            memoryCard,
            recentMessages,
            conversationSummary,
          },
        ),
      );

      let assistantMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "assistant",
        authorParticipantId: speakerParticipant?.id,
        content: answer.content,
        comfyPrompt: answer.comfyPrompt,
        comfyPrompts: answer.comfyPrompts,
        comfyImageDescription: answer.comfyImageDescription,
        comfyImageDescriptions: answer.comfyImageDescriptions,
        imageGenerationPending: false,
        personaControlRaw: answer.personaControl
          ? JSON.stringify(answer.personaControl)
          : undefined,
        turnId,
        createdAt: nowIso(),
      };

      const promptBlocks =
        assistantMessage.comfyPrompts ??
        (assistantMessage.comfyPrompt ? [assistantMessage.comfyPrompt] : []);
      const imageDescriptionBlocks =
        assistantMessage.comfyImageDescriptions ??
        (assistantMessage.comfyImageDescription
          ? [assistantMessage.comfyImageDescription]
          : []);
      const initialRequestedImageCount =
        imageDescriptionBlocks.length > 0
          ? imageDescriptionBlocks.length
          : promptBlocks.length;
      const imageActionPolicy = evaluateImageActionPolicy(
        currentMessages,
        speakerParticipant?.id ?? null,
      );
      let requestedImageCount = initialRequestedImageCount;
      if (requestedImageCount > 0 && imageActionPolicy.blocked) {
        requestedImageCount = 0;
        assistantMessage = {
          ...assistantMessage,
          comfyPrompt: undefined,
          comfyPrompts: undefined,
          comfyImageDescription: undefined,
          comfyImageDescriptions: undefined,
        };
      }

      await updateTurnJob({
        stage: "actor_response",
        payload: {
          responseId: answer.responseId ?? null,
          initialRequestedImageCount,
          requestedImageCount,
          imageActionBlocked: imageActionPolicy.blocked,
          imageActionBlockReason: imageActionPolicy.reason,
        },
      });

      if (requestedImageCount > 0) {
        assistantMessage = {
          ...assistantMessage,
          imageGenerationPending: true,
          imageGenerationExpected: requestedImageCount,
          imageGenerationCompleted: 0,
        };
      }

      const assistantMessageEvent = buildChatEvent("message_created", {
        role: "assistant",
        messageId: assistantMessage.id,
        authorParticipantId: assistantMessage.authorParticipantId ?? null,
      });
      if (assistantMessageEvent) {
        await dbApi.commitTurnArtifacts({
          messages: [assistantMessage],
          events: [assistantMessageEvent],
        });
        appendChatEvent(assistantMessageEvent);
      } else {
        await dbApi.saveMessage(assistantMessage);
      }

      const finalMessages = [...nextMessages, assistantMessage];
      set({ messages: finalMessages });

      const patchAssistantMessage = async (patch: Partial<ChatMessage>) => {
        assistantMessage = {
          ...assistantMessage,
          ...patch,
        };
        await dbApi.saveMessage(assistantMessage);
        set((current) => ({
          messages: current.messages.map((message) =>
            message.id === assistantMessage.id ? assistantMessage : message,
          ),
        }));
      };

      if (requestedImageCount > 0) {
        await updateTurnJob({
          stage: "image_action",
          payload: {
            requestedImageCount,
          },
        });
        await pushChatEvent("image_requested", {
          messageId: assistantMessage.id,
          requestedImageCount,
        });

        const aggregatedLocalizedUrls: string[] = [];
        const aggregatedAttachments: NonNullable<ChatMessage["attachments"]> = [];
        const aggregatedMetaByUrl: Record<string, ImageGenerationMeta> = {};
        let completedCount = 0;
        let expectedGenerationCount = requestedImageCount;
        const styleReferenceImage =
          speakerPersona.avatarUrl.trim() ||
          speakerPersona.fullBodyUrl.trim() ||
          undefined;
        const chatStyleStrength =
          typeof activeChat.chatStyleStrength === "number"
            ? activeChat.chatStyleStrength
            : get().settings.chatStyleStrength;
        let promptsForGeneration = [...promptBlocks];

        try {
          if (imageDescriptionBlocks.length > 0) {
            const generatedPrompts = await runStageWithRetry("image_action", () =>
              Promise.all(
                imageDescriptionBlocks.map((description, index) =>
                  generateComfyPromptFromImageDescription(
                    get().settings,
                    speakerPersona,
                    description,
                    index + 1,
                  ),
                ),
              ),
            );
            promptsForGeneration = generatedPrompts
              .map((value) => value.trim())
              .filter(Boolean);
            expectedGenerationCount = promptsForGeneration.length;
            await patchAssistantMessage({
              comfyPrompt: promptsForGeneration[0],
              comfyPrompts:
                promptsForGeneration.length > 0
                  ? promptsForGeneration
                  : undefined,
              imageGenerationPending: promptsForGeneration.length > 0,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: 0,
            });
          }
        } catch {
          await patchAssistantMessage({
            imageGenerationPending: false,
            imageGenerationExpected: requestedImageCount,
            imageGenerationCompleted: 0,
          });
          promptsForGeneration = [];
        }

        if (promptsForGeneration.length > 0) {
          const comfyItems = promptsForGeneration.map((prompt) => ({
            flow: "base" as const,
            prompt,
            checkpointName: speakerPersona.imageCheckpoint || undefined,
            seed: randomSeed(),
            styleReferenceImage,
            styleStrength: styleReferenceImage ? chatStyleStrength : undefined,
            compositionStrength: 0,
            saveComfyOutputs: get().settings.saveComfyOutputs,
          }));

          try {
            await generateComfyImages(
              comfyItems,
              get().settings.comfyBaseUrl,
              get().settings.comfyAuth,
              async (promptImageUrls, index) => {
                completedCount += 1;
                const localizedChunk = await localizeImageUrls(promptImageUrls);
                const item = comfyItems[index];
                const extractedMeta =
                  promptImageUrls[0]
                    ? await readComfyImageGenerationMeta(
                        promptImageUrls[0],
                        get().settings.comfyBaseUrl,
                        get().settings.comfyAuth,
                      )
                    : null;
                const meta: ImageGenerationMeta = {
                  seed: extractedMeta?.seed ?? item.seed,
                  prompt: extractedMeta?.prompt ?? item.prompt,
                  model: extractedMeta?.model ?? item.checkpointName,
                  flow: extractedMeta?.flow ?? item.flow,
                };
                for (const localized of localizedChunk) {
                  if (!aggregatedLocalizedUrls.includes(localized)) {
                    aggregatedLocalizedUrls.push(localized);
                    const imageAssetId = crypto.randomUUID();
                    await dbApi.saveImageAsset({
                      id: imageAssetId,
                      dataUrl: localized,
                      meta,
                      createdAt: nowIso(),
                    });
                    aggregatedAttachments.push({
                      id: crypto.randomUUID(),
                      type: "image",
                      imageAssetId,
                      visibility: "all",
                      createdAt: nowIso(),
                    });
                  }
                  aggregatedMetaByUrl[localized] = meta;
                }
                for (const original of promptImageUrls) {
                  if (original?.trim()) {
                    aggregatedMetaByUrl[original] = meta;
                  }
                }

                await patchAssistantMessage({
                  imageUrls: [...aggregatedLocalizedUrls],
                  imageMetaByUrl: { ...aggregatedMetaByUrl },
                  attachments: [...aggregatedAttachments],
                  imageGenerationPending:
                    completedCount < expectedGenerationCount,
                  imageGenerationExpected: expectedGenerationCount,
                  imageGenerationCompleted: completedCount,
                });
              },
            );
            await patchAssistantMessage({
              imageUrls: [...aggregatedLocalizedUrls],
              imageMetaByUrl: { ...aggregatedMetaByUrl },
              attachments: [...aggregatedAttachments],
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: expectedGenerationCount,
            });
          } catch {
            await patchAssistantMessage({
              attachments: [...aggregatedAttachments],
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: completedCount,
            });
          }
        } else {
          await patchAssistantMessage({
            imageGenerationPending: false,
            imageGenerationExpected: requestedImageCount,
            imageGenerationCompleted: 0,
          });
        }

        const imageCreatedEvent = buildChatEvent("image_created", {
          messageId: assistantMessage.id,
          completedCount: assistantMessage.imageGenerationCompleted ?? 0,
          attachmentCount: assistantMessage.attachments?.length ?? 0,
        });
        if (imageCreatedEvent) {
          await dbApi.commitTurnArtifacts({
            messages: [assistantMessage],
            events: [imageCreatedEvent],
          });
          appendChatEvent(imageCreatedEvent);
        }
      } else if (initialRequestedImageCount > 0 && imageActionPolicy.blocked) {
        await pushChatEvent("image_requested", {
          messageId: assistantMessage.id,
          requestedImageCount: 0,
          blocked: true,
          reason: imageActionPolicy.reason,
        });
      }

      const fallbackState = evolvePersonaState(
        runtimeState,
        speakerPersona,
        trimmedContent,
        assistantMessage.content,
      );
      resolvedState = fallbackState;
      let controlMemories: PersonaMemory[] = [];
      let controlMemoryRemovals: MemoryRemovalDirective[] = [];
      if (answer.personaControl) {
        const controlled = applyPersonaControlProposal({
          control: answer.personaControl,
          baseState: fallbackState,
          persona: speakerPersona,
          chatId: activeChatId,
          userMessage: trimmedContent,
        });
        resolvedState = controlled.state;
        controlMemories = controlled.memoryCandidates;
        controlMemoryRemovals = controlled.memoryRemovals;
      }
      await dbApi.savePersonaState(resolvedState);

      const memoryPoolAfterRemovals = applyMemoryRemovalDirectives(
        memoryPool,
        controlMemoryRemovals,
      );
      const candidates = [
        ...(answer.personaControl
          ? []
          : derivePersistentMemoriesFromUserMessage(
              speakerPersona,
              activeChatId,
              trimmedContent,
            )),
        ...controlMemories,
      ];
      const memoryReconciliation = reconcilePersistentMemories(
        memoryPoolAfterRemovals.kept,
        candidates,
        speakerPersona.advanced.memory.maxMemories,
        speakerPersona.advanced.memory.decayDays,
      );
      await dbApi.saveMemories(memoryReconciliation.kept);
      await dbApi.deleteMemories([
        ...new Set([
          ...memoryReconciliation.removedIds,
          ...memoryPoolAfterRemovals.removedIds,
        ]),
      ]);

      const extraAssistantMessages: ChatMessage[] = [];
      const extraEvents: ChatEvent[] = [];
      let rollingMessages = [...nextMessages, assistantMessage];
      let latestResponseId = answer.responseId ?? activeChat.lastResponseId;

      if (
        activeChat.mode === "group" &&
        personaSpeakerEntries.length > 1 &&
        GROUP_AUTONOMOUS_REPLY_COUNT > 0
      ) {
        const usedSpeakerIds = new Set<string>();
        if (speakerParticipant?.id) {
          usedSpeakerIds.add(speakerParticipant.id);
        }

        for (
          let beatIndex = 0;
          beatIndex < GROUP_AUTONOMOUS_REPLY_COUNT;
          beatIndex += 1
        ) {
          const availableEntries = personaSpeakerEntries.filter(
            (entry) => !usedSpeakerIds.has(entry.participant.id),
          );
          const candidateEntries =
            availableEntries.length > 0 ? availableEntries : personaSpeakerEntries;
          if (candidateEntries.length === 0) break;

          let selectedEntry = candidateEntries[0];
          let followupDecisionSource: "director_llm" | "round_robin" = "round_robin";

          if (candidateEntries.length > 1) {
            const directorCandidates: GroupDirectorCandidate[] =
              candidateEntries.map((entry) => ({
                participantId: entry.participant.id,
                personaId: entry.persona.id,
                displayName: entry.participant.displayName,
              }));
            const directorRecentMessages: GroupDirectorRecentMessage[] =
              rollingMessages.slice(-8).map((message) => {
                const author = message.authorParticipantId
                  ? chatParticipants.find(
                      (participant) => participant.id === message.authorParticipantId,
                    )
                  : undefined;
                const authorName =
                  author?.displayName ??
                  (message.role === "user"
                    ? "Вы"
                    : message.role === "assistant"
                      ? "Участник"
                      : "Система");
                return {
                  role: message.role,
                  authorName,
                  content: message.content,
                };
              });
            try {
              const directorDecision = await runStageWithRetry("decision", () =>
                requestGroupDirectorDecision(get().settings, {
                  userMessage: trimmedContent,
                  candidates: directorCandidates,
                  recentMessages: directorRecentMessages,
                  blockedParticipantIds: Array.from(usedSpeakerIds),
                }),
              );
              const directedEntry = candidateEntries.find(
                (entry) =>
                  entry.participant.id === directorDecision.speakerParticipantId,
              );
              if (directedEntry) {
                selectedEntry = directedEntry;
                followupDecisionSource = "director_llm";
              }
            } catch {
              // fallback to round-robin
            }
          }

          usedSpeakerIds.add(selectedEntry.participant.id);
          const followupSpeakerEvent = buildChatEvent("speaker_selected", {
            speakerParticipantId: selectedEntry.participant.id,
            speakerPersonaId: selectedEntry.persona.id,
            reason: "autonomous_reply",
            decisionSource: followupDecisionSource,
          });
          if (followupSpeakerEvent) {
            extraEvents.push(followupSpeakerEvent);
          }

          try {
            const followupLoadedState = await dbApi.getPersonaState(
              activeChatId,
              selectedEntry.persona.id,
            );
            const followupRuntimeState = ensurePersonaState(
              followupLoadedState ?? undefined,
              selectedEntry.persona,
              activeChatId,
            );
            if (!followupLoadedState) {
              await dbApi.savePersonaState(followupRuntimeState);
            }

            const followupAllMemories = await dbApi.getMemories(activeChatId);
            const followupMemoryPool = followupAllMemories.filter(
              (memory) => memory.personaId === selectedEntry.persona.id,
            );
            const followupInput = buildAutonomousFollowupPrompt(
              "group",
              trimmedContent,
              rollingMessages,
            );
            const followupRecentMessages = buildRecentMessages(rollingMessages, 5);
            const followupConversationSummary = buildConversationSummary(
              rollingMessages,
              8,
              5,
            );
            const followupMemoryCard = buildLayeredMemoryContextCard(
              followupMemoryPool,
              followupRecentMessages,
              selectedEntry.persona.advanced.memory.decayDays,
            );

            const followupAnswer = await runStageWithRetry("actor_response", () =>
              requestChatCompletion(
                get().settings,
                selectedEntry.persona,
                followupInput,
                latestResponseId,
                {
                  runtimeState: followupRuntimeState,
                  memoryCard: followupMemoryCard,
                  recentMessages: followupRecentMessages,
                  conversationSummary: followupConversationSummary,
                },
              ),
            );
            latestResponseId = followupAnswer.responseId ?? latestResponseId;

            const followupMessage: ChatMessage = {
              id: id(),
              chatId: activeChatId,
              role: "assistant",
              authorParticipantId: selectedEntry.participant.id,
              content: followupAnswer.content,
              personaControlRaw: followupAnswer.personaControl
                ? JSON.stringify(followupAnswer.personaControl)
                : undefined,
              turnId,
              createdAt: nowIso(),
            };

            extraAssistantMessages.push(followupMessage);
            rollingMessages = [...rollingMessages, followupMessage];
            set({ messages: rollingMessages });

            const followupCreatedEvent = buildChatEvent("message_created", {
              role: "assistant",
              messageId: followupMessage.id,
              authorParticipantId: followupMessage.authorParticipantId ?? null,
            });
            if (followupCreatedEvent) {
              extraEvents.push(followupCreatedEvent);
            }

            const followupState = evolvePersonaState(
              followupRuntimeState,
              selectedEntry.persona,
              followupInput,
              followupMessage.content,
            );
            await dbApi.savePersonaState(followupState);
            if (selectedEntry.persona.id === activePersona.id) {
              resolvedState = followupState;
            }
          } catch {
            break;
          }
        }
      }

      await updateTurnJob({
        stage: "commit",
        payload: {
          memoryCount: memoryReconciliation.kept.length,
          assistantMessages: 1 + extraAssistantMessages.length,
        },
      });

      const latestChat = (await dbApi.getChatById(activeChatId)) ?? activeChat;
      const updatedChat: ChatSession = {
        ...latestChat,
        title:
          latestChat.title === "Новый чат"
            ? titleFromText(trimmedContent)
            : latestChat.title,
        lastResponseId: latestResponseId ?? latestChat.lastResponseId,
        updatedAt: nowIso(),
      };
      const committedEvent = buildChatEvent("turn_committed", {
        messageId:
          extraAssistantMessages[extraAssistantMessages.length - 1]?.id ??
          assistantMessage.id,
        assistantMessages: 1 + extraAssistantMessages.length,
      });
      const finalizedTurnJob = turnJob
        ? {
          ...turnJob,
          stage: "finalize" as const,
            status: "done" as const,
            finishedAt: nowIso(),
          }
        : null;
      if (finalizedTurnJob) {
        turnJob = finalizedTurnJob;
      }

      await dbApi.commitTurnArtifacts({
        chat: updatedChat,
        messages: [assistantMessage, ...extraAssistantMessages],
        events: committedEvent
          ? [...extraEvents, committedEvent]
          : extraEvents.length > 0
            ? extraEvents
            : undefined,
        turnJob: finalizedTurnJob ?? undefined,
      });
      for (const event of extraEvents) {
        appendChatEvent(event);
      }
      if (committedEvent) {
        appendChatEvent(committedEvent);
      }
    } catch (error) {
      const typedError = error as Error;
      processingError = typedError;

      const failedEvent = buildChatEvent("turn_failed", {
        error: typedError.message,
      });
      const failedTurnJob = turnJob
        ? {
            ...turnJob,
            stage: "finalize" as const,
            status: "failed" as const,
            finishedAt: nowIso(),
            payload: {
              error: typedError.message,
            },
          }
        : null;
      if (failedTurnJob) {
        turnJob = failedTurnJob;
      }

      if (failedEvent || failedTurnJob) {
        try {
          await dbApi.commitTurnArtifacts({
            events: failedEvent ? [failedEvent] : undefined,
            turnJob: failedTurnJob ?? undefined,
          });
          if (failedEvent) {
            appendChatEvent(failedEvent);
          }
        } catch {
          // no-op
        }
      }

      set({ error: typedError.message });
    } finally {
      try {
        if (turnId) {
          await dbApi.releaseChatTurnLock(
            activeChatId,
            turnId,
            processingError ? "error" : "idle",
          );
        }

        const chats = await dbApi.getChatsForPersona(activePersona.id);
        const [latestEvents, latestMemories] = await Promise.all([
          dbApi.getChatEvents(activeChatId, 200),
          dbApi.getMemories(activeChatId),
        ]);
        set((current) => ({
          chats:
            current.activePersonaId === activePersona.id ? chats : current.chats,
          activeChatEvents:
            current.activeChatId === activeChatId
              ? latestEvents
              : current.activeChatEvents,
          activePersonaState:
            resolvedState &&
            current.activeChatId === activeChatId &&
            current.activePersonaId === resolvedState.personaId
              ? resolvedState
              : current.activePersonaState,
          activeMemories:
            current.activeChatId === activeChatId
              ? latestMemories
              : current.activeMemories,
          isLoading: false,
        }));
      } catch (finalizeError) {
        set({
          isLoading: false,
          error:
            processingError?.message ??
            (finalizeError as Error).message,
        });
      }
    }
  },

  saveSettings: async (settings) => {
    set({ isLoading: true, error: null });
    try {
      await dbApi.saveSettings(settings);
      set({ settings, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },
}));
