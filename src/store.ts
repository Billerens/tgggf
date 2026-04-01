import { create } from "zustand";
import { DEFAULT_SETTINGS, dbApi } from "./db";
import {
  generateComfyPromptFromImageDescription,
  requestChatCompletion,
} from "./lmstudio";
import { generateComfyImages, readComfyImageGenerationMeta } from "./comfy";
import { localizeImageUrls } from "./imageStorage";
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
  ImageGenerationMeta,
  Persona,
  PersonaAdvancedProfile,
  PersonaMemory,
  PersonaRuntimeState,
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
  deleteChat: (chatId: string) => Promise<void>;
  setChatStyleStrength: (chatId: string, value: number | null) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  clearError: () => void;
}

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const randomSeed = () => {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return (Number(values[0]) << 1) + Number(values[1]);
};

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
      const chats = await dbApi.getChats(updatedChat.personaId);
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

      let assistantMessage: ChatMessage = {
        id: id(),
        chatId: activeChatId,
        role: "assistant",
        content: answer.content,
        comfyPrompt: answer.comfyPrompt,
        comfyPrompts: answer.comfyPrompts,
        comfyImageDescription: answer.comfyImageDescription,
        comfyImageDescriptions: answer.comfyImageDescriptions,
        imageGenerationPending: false,
        personaControlRaw: answer.personaControl ? JSON.stringify(answer.personaControl) : undefined,
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
      const requestedImageCount =
        imageDescriptionBlocks.length > 0
          ? imageDescriptionBlocks.length
          : promptBlocks.length;
      if (requestedImageCount > 0) {
        assistantMessage = {
          ...assistantMessage,
          imageGenerationPending: true,
          imageGenerationExpected: requestedImageCount,
          imageGenerationCompleted: 0,
        };
      }

      await dbApi.saveMessage(assistantMessage);

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
        void (async () => {
          const aggregatedLocalizedUrls: string[] = [];
          const aggregatedMetaByUrl: Record<string, ImageGenerationMeta> = {};
          let completedCount = 0;
          let expectedGenerationCount = requestedImageCount;
          const styleReferenceImage =
            activePersona.avatarUrl.trim() || activePersona.fullBodyUrl.trim() || undefined;
          const chatStyleStrength =
            typeof activeChat?.chatStyleStrength === "number"
              ? activeChat.chatStyleStrength
              : get().settings.chatStyleStrength;
          let promptsForGeneration = [...promptBlocks];

          try {
            if (imageDescriptionBlocks.length > 0) {
              const generatedPrompts = await Promise.all(
                imageDescriptionBlocks.map((description, index) =>
                  generateComfyPromptFromImageDescription(
                    get().settings,
                    activePersona,
                    description,
                    index + 1,
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
            return;
          }

          if (promptsForGeneration.length === 0) {
            await patchAssistantMessage({
              imageGenerationPending: false,
              imageGenerationExpected: requestedImageCount,
              imageGenerationCompleted: 0,
            });
            return;
          }

          const comfyItems = promptsForGeneration.map((prompt) => ({
            flow: "base" as const,
            prompt,
            checkpointName: activePersona.imageCheckpoint || undefined,
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
                await Promise.all(
                  localizedChunk.map((localized) =>
                    dbApi.saveImageAsset({
                      id: crypto.randomUUID(),
                      dataUrl: localized,
                      meta,
                      createdAt: nowIso(),
                    }),
                  ),
                );
                for (const localized of localizedChunk) {
                  if (!aggregatedLocalizedUrls.includes(localized)) {
                    aggregatedLocalizedUrls.push(localized);
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
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: expectedGenerationCount,
            });
          } catch {
            await patchAssistantMessage({
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: completedCount,
            });
          }
        })();
      }

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
