import { create } from "zustand";
import { DEFAULT_SETTINGS, dbApi } from "./db";
import { requestChatCompletion } from "./lmstudio";
import {
  applyPersonaControlProposal,
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
  AppSettings,
  ChatMessage,
  ChatSession,
  Persona,
  PersonaAdvancedProfile,
  PersonaMemory,
  PersonaRuntimeState,
} from "./types";

type PersonaInput = Omit<Persona, "id" | "createdAt" | "updatedAt" | "advanced"> & {
  advanced?: PersonaAdvancedProfile;
  id?: string;
};

interface AppState {
  personas: Persona[];
  chats: ChatSession[];
  messages: ChatMessage[];
  activePersonaState: PersonaRuntimeState | null;
  activeMemories: PersonaMemory[];
  activePersonaId: string | null;
  activeChatId: string | null;
  settings: AppSettings;
  isLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  selectPersona: (personaId: string) => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  savePersona: (input: PersonaInput) => Promise<void>;
  deletePersona: (personaId: string) => Promise<void>;
  createChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  clearError: () => void;
}

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();

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

async function loadChatArtifacts(chatId: string | null) {
  if (!chatId) {
    return {
      messages: [] as ChatMessage[],
      state: null as PersonaRuntimeState | null,
      memories: [] as PersonaMemory[],
    };
  }
  const [messages, state, memories] = await Promise.all([
    dbApi.getMessages(chatId),
    dbApi.getPersonaState(chatId),
    dbApi.getMemories(chatId),
  ]);
  return {
    messages,
    state: state ?? null,
    memories,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  personas: [],
  chats: [],
  messages: [],
  activePersonaState: null,
  activeMemories: [],
  activePersonaId: null,
  activeChatId: null,
  settings: DEFAULT_SETTINGS,
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
          appearancePrompt:
            "Короткие серебристые волосы, спокойный взгляд, минималистичный футуристичный стиль.",
          stylePrompt: "Говорит понятно, спокойно и по делу, без лишней воды.",
          advanced: createDefaultAdvancedProfile(),
          avatarUrl: "",
          createdAt: ts,
          updatedAt: ts,
        };
        await dbApi.savePersona(starter);
        personas = [starter];
      }

      const activePersonaId = personas[0].id;
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        personas,
        settings,
        activePersonaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  selectPersona: async (personaId) => {
    set({ isLoading: true, error: null });
    try {
      const chats = await dbApi.getChats(personaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        activePersonaId: personaId,
        chats,
        activeChatId,
        messages: artifacts.messages,
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
      const artifacts = await loadChatArtifacts(chatId);
      set({
        activeChatId: chatId,
        messages: artifacts.messages,
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
        appearancePrompt: input.appearancePrompt.trim(),
        stylePrompt: input.stylePrompt.trim(),
        advanced: normalizeAdvancedProfile(input.advanced ?? createDefaultAdvancedProfile()),
        avatarUrl: input.avatarUrl.trim(),
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
      const chats = nextActive ? await dbApi.getChats(nextActive) : [];
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        personas,
        activePersonaId: nextActive,
        chats,
        activeChatId,
        messages: artifacts.messages,
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
        title: "Новый чат",
        createdAt: ts,
        updatedAt: ts,
      };
      await dbApi.saveChat(chat);

      const persona = get().personas.find((item) => item.id === activePersonaId);
      const initialState = persona ? createInitialPersonaState(persona, chat.id) : null;
      if (initialState) {
        await dbApi.savePersonaState(initialState);
      }

      const chats = await dbApi.getChats(activePersonaId);
      set({
        chats,
        activeChatId: chat.id,
        messages: [],
        activePersonaState: initialState,
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
          activePersonaState: null,
          activeMemories: [],
          isLoading: false,
        });
        return;
      }
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const artifacts = await loadChatArtifacts(activeChatId);

      set({
        chats,
        activeChatId,
        messages: artifacts.messages,
        activePersonaState: artifacts.state,
        activeMemories: artifacts.memories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  sendMessage: async (content) => {
    const state = get();
    const activePersona = state.personas.find((persona) => persona.id === state.activePersonaId);
    if (!activePersona) return;

    let activeChatId = state.activeChatId;
    if (!activeChatId) {
      await get().createChat();
      activeChatId = get().activeChatId;
    }
    if (!activeChatId) return;

    const userMessage: ChatMessage = {
      id: id(),
      chatId: activeChatId,
      role: "user",
      content: content.trim(),
      createdAt: nowIso(),
    };

    const currentMessages = get().messages;
    const nextMessages = [...currentMessages, userMessage];
    set({ messages: nextMessages, isLoading: true, error: null });

    try {
      await dbApi.saveMessage(userMessage);

      const activeChat = get().chats.find((chat) => chat.id === activeChatId);
      const loadedState = get().activePersonaState ?? (await dbApi.getPersonaState(activeChatId));
      const runtimeState = ensurePersonaState(loadedState ?? undefined, activePersona, activeChatId);
      if (!loadedState) {
        await dbApi.savePersonaState(runtimeState);
      }

      const memoryPool = get().activeMemories.length > 0 ? get().activeMemories : await dbApi.getMemories(activeChatId);
      const recentMessages = buildRecentMessages(nextMessages);
      const memoryCard = buildLayeredMemoryContextCard(
        memoryPool,
        recentMessages,
        activePersona.advanced.memory.decayDays,
      );

      const answer = await requestChatCompletion(
        get().settings,
        activePersona,
        content.trim(),
        activeChat?.lastResponseId,
        {
          runtimeState,
          memoryCard,
          recentMessages,
        },
      );

      const assistantMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "assistant",
        content: answer.content,
        comfyPrompt: answer.comfyPrompt,
        personaControlRaw: answer.personaControl ? JSON.stringify(answer.personaControl) : undefined,
        createdAt: nowIso(),
      };

      const finalMessages = [...nextMessages, assistantMessage];
      await dbApi.saveMessage(assistantMessage);

      const fallbackState = evolvePersonaState(runtimeState, activePersona, content.trim(), assistantMessage.content);
      let resolvedState = fallbackState;
      let controlMemories: PersonaMemory[] = [];
      let controlMemoryRemovals: MemoryRemovalDirective[] = [];
      if (answer.personaControl) {
        const controlled = applyPersonaControlProposal({
          control: answer.personaControl,
          baseState: fallbackState,
          persona: activePersona,
          chatId: activeChatId,
          userMessage: content.trim(),
        });
        resolvedState = controlled.state;
        controlMemories = controlled.memoryCandidates;
        controlMemoryRemovals = controlled.memoryRemovals;
      }
      await dbApi.savePersonaState(resolvedState);

      const memoryPoolAfterRemovals = applyMemoryRemovalDirectives(memoryPool, controlMemoryRemovals);
      const candidates = [
        ...(answer.personaControl
          ? []
          : derivePersistentMemoriesFromUserMessage(activePersona, activeChatId, content.trim())),
        ...controlMemories,
      ];
      const memoryReconciliation = reconcilePersistentMemories(
        memoryPoolAfterRemovals.kept,
        candidates,
        activePersona.advanced.memory.maxMemories,
        activePersona.advanced.memory.decayDays,
      );
      await dbApi.saveMemories(memoryReconciliation.kept);
      await dbApi.deleteMemories([
        ...new Set([...memoryReconciliation.removedIds, ...memoryPoolAfterRemovals.removedIds]),
      ]);

      if (activeChat) {
        const updatedChat: ChatSession = {
          ...activeChat,
          title: activeChat.title === "Новый чат" ? titleFromText(content) : activeChat.title,
          lastResponseId: answer.responseId ?? activeChat.lastResponseId,
          updatedAt: nowIso(),
        };
        await dbApi.saveChat(updatedChat);
      }

      const chats = await dbApi.getChats(activePersona.id);
      set({
        messages: finalMessages,
        chats,
        activePersonaState: resolvedState,
        activeMemories: memoryReconciliation.kept,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
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
