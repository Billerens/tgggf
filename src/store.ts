import { create } from "zustand";
import { DEFAULT_SETTINGS, dbApi } from "./db";
import { requestChatCompletion } from "./lmstudio";
import type { AppSettings, ChatMessage, ChatSession, Persona } from "./types";

interface AppState {
  personas: Persona[];
  chats: ChatSession[];
  messages: ChatMessage[];
  activePersonaId: string | null;
  activeChatId: string | null;
  settings: AppSettings;
  isLoading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  selectPersona: (personaId: string) => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  savePersona: (input: Omit<Persona, "id" | "createdAt" | "updatedAt"> & { id?: string }) => Promise<void>;
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

export const useAppStore = create<AppState>((set, get) => ({
  personas: [],
  chats: [],
  messages: [],
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
          appearancePrompt: "Короткие серебристые волосы, спокойный взгляд, минималистичный футуристичный стиль.",
          stylePrompt: "Говорит понятно, спокойно и по делу, без лишней воды.",
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
      const messages = activeChatId ? await dbApi.getMessages(activeChatId) : [];

      set({
        personas,
        settings,
        activePersonaId,
        chats,
        activeChatId,
        messages,
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
      const messages = activeChatId ? await dbApi.getMessages(activeChatId) : [];
      set({ activePersonaId: personaId, chats, activeChatId, messages, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  selectChat: async (chatId) => {
    set({ isLoading: true, error: null });
    try {
      const messages = await dbApi.getMessages(chatId);
      set({ activeChatId: chatId, messages, isLoading: false });
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
        avatarUrl: input.avatarUrl.trim(),
        createdAt:
          get().personas.find((p) => p.id === input.id)?.createdAt ?? ts,
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
      const messages = activeChatId ? await dbApi.getMessages(activeChatId) : [];
      set({
        personas,
        activePersonaId: nextActive,
        chats,
        activeChatId,
        messages,
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
      const chats = await dbApi.getChats(activePersonaId);
      set({ chats, activeChatId: chat.id, messages: [], isLoading: false });
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
        set({ chats: [], activeChatId: null, messages: [], isLoading: false });
        return;
      }
      const chats = await dbApi.getChats(activePersonaId);
      const activeChatId = chats[0]?.id ?? null;
      const messages = activeChatId ? await dbApi.getMessages(activeChatId) : [];
      set({ chats, activeChatId, messages, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  sendMessage: async (content) => {
    const state = get();
    const activePersona = state.personas.find((p) => p.id === state.activePersonaId);
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

      const activeChat = get().chats.find((c) => c.id === activeChatId);
      const answer = await requestChatCompletion(
        get().settings,
        activePersona,
        content.trim(),
        activeChat?.lastResponseId,
      );
      const assistantMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "assistant",
        content: answer.content,
        comfyPrompt: answer.comfyPrompt,
        createdAt: nowIso(),
      };

      const finalMessages = [...nextMessages, assistantMessage];
      await dbApi.saveMessage(assistantMessage);

      if (activeChat) {
        const updatedChat: ChatSession = {
          ...activeChat,
          title:
            activeChat.title === "Новый чат" ? titleFromText(content) : activeChat.title,
          lastResponseId: answer.responseId ?? activeChat.lastResponseId,
          updatedAt: nowIso(),
        };
        await dbApi.saveChat(updatedChat);
      }

      const chats = await dbApi.getChats(activePersona.id);
      set({ messages: finalMessages, chats, isLoading: false });
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
