import type {
  ChatMessage,
  ChatSession,
  DiaryEntry,
  ImageAsset,
  Persona,
  PersonaMemory,
  PersonaRuntimeState,
} from "../../types";
import { dbApi } from "../../db";

interface LocalApiPluginRequestInput {
  method: "GET" | "PUT";
  path: string;
  body?: unknown;
}

interface LocalApiPluginRequestOutput {
  status: number;
  body: unknown;
}

interface LocalApiPlugin {
  request(input: LocalApiPluginRequestInput): Promise<LocalApiPluginRequestOutput>;
}

interface CapacitorLikeScope {
  Capacitor?: {
    Plugins?: {
      LocalApi?: LocalApiPlugin;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasEntityId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function normalizeStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
}

export async function requestNativeDiaryPreview(
  chatId: string,
): Promise<DiaryEntry | null> {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) return null;
  const scope = globalThis as unknown as CapacitorLikeScope;
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) return null;

  const response = await plugin.request({
    method: "PUT",
    path: "/api/background-runtime/diary/preview",
    body: {
      chatId: normalizedChatId,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`native_diary_preview_http_${response.status}`);
  }
  if (!isRecord(response.body)) return null;
  const entry = response.body.entry;
  if (!isRecord(entry)) return null;
  if (
    typeof entry.id !== "string" ||
    typeof entry.chatId !== "string" ||
    typeof entry.personaId !== "string" ||
    typeof entry.markdown !== "string"
  ) {
    return null;
  }
  return entry as unknown as DiaryEntry;
}

function parseIdbImageAssetId(value: string | undefined | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

function collectPersonaImageAssetIds(persona: Persona | null) {
  if (!persona) return [] as string[];
  const ids = new Set<string>();
  const addDirectId = (value: string | undefined | null) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) ids.add(normalized);
  };
  const addFromUrl = (value: string | undefined | null) => {
    const id = parseIdbImageAssetId(value);
    if (id) ids.add(id);
  };
  addDirectId(persona.avatarImageId);
  addDirectId(persona.fullBodyImageId);
  addDirectId(persona.fullBodySideImageId);
  addDirectId(persona.fullBodyBackImageId);
  addFromUrl(persona.avatarUrl);
  addFromUrl(persona.fullBodyUrl);
  addFromUrl(persona.fullBodySideUrl);
  addFromUrl(persona.fullBodyBackUrl);
  return Array.from(ids);
}

function collectChatImageAssetIds(messages: ChatMessage[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const url of message.imageUrls ?? []) {
      const imageId = parseIdbImageAssetId(url);
      if (imageId) {
        ids.add(imageId);
      }
    }
  }
  return Array.from(ids);
}

export async function syncOneToOneContextToNative(input: {
  chatId: string;
  personaId: string;
}) {
  const scope = globalThis as unknown as CapacitorLikeScope;
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) return;

  const [settings, personas, chats, chatMessages, chatState, chatMemories, chatDiaryEntries] = await Promise.all([
    dbApi.getSettings(),
    dbApi.getPersonas(),
    dbApi.getAllChats(),
    dbApi.getMessages(input.chatId),
    dbApi.getPersonaState(input.chatId),
    dbApi.getMemories(input.chatId),
    dbApi.getDiaryEntries(input.chatId),
  ]);
  const targetPersona =
    personas.find((persona) => persona.id === input.personaId) ??
    personas.find((persona) => persona.id === chats.find((chat) => chat.id === input.chatId)?.personaId) ??
    null;
  const imageAssetIds = Array.from(
    new Set([
      ...collectPersonaImageAssetIds(targetPersona),
      ...collectChatImageAssetIds(chatMessages),
    ]),
  );
  const imageAssets = imageAssetIds.length > 0 ? await dbApi.getImageAssets(imageAssetIds) : [];

  const response = await plugin.request({
    method: "PUT",
    path: "/api/background-runtime/context",
    body: {
      mode: "merge",
      stores: {
        settings,
        personas,
        chats,
        messages: chatMessages,
        personaStates: chatState ? [chatState] : [],
        memories: chatMemories,
        diaryEntries: chatDiaryEntries,
        imageAssets,
      },
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`native_context_sync_http_${response.status}`);
  }
}

export async function applyOneToOneStatePatch(
  stores: Record<string, unknown>,
  preferredChatId: string | null,
  syncOneToOneStateFromDb?: (preferredChatId?: string | null) => Promise<void> | void,
) {
  let touched = false;

  const chats = normalizeStoreRows(stores, "chats").filter(
    (row): row is Record<string, unknown> & { id: string } => hasEntityId(row),
  );
  for (const chat of chats) {
    await dbApi.saveChat(chat as unknown as ChatSession);
    touched = true;
  }

  const messages = normalizeStoreRows(stores, "messages").filter(
    (row): row is Record<string, unknown> & { id: string } => hasEntityId(row),
  );
  for (const message of messages) {
    await dbApi.saveMessage(message as unknown as ChatMessage);
    touched = true;
  }

  const personaStates = normalizeStoreRows(stores, "personaStates").filter(
    (row): row is Record<string, unknown> => typeof row.chatId === "string" && row.chatId.trim().length > 0,
  );
  for (const state of personaStates) {
    await dbApi.savePersonaState(state as unknown as PersonaRuntimeState);
    touched = true;
  }

  const memories = normalizeStoreRows(stores, "memories").filter(
    (row): row is Record<string, unknown> & { id: string } =>
      hasEntityId(row) && typeof row.chatId === "string" && row.chatId.trim().length > 0,
  );
  if (memories.length > 0) {
    await dbApi.saveMemories(memories as unknown as PersonaMemory[]);
    touched = true;
  }

  const diaryEntries = normalizeStoreRows(stores, "diaryEntries").filter(
    (row): row is Record<string, unknown> & { id: string } =>
      hasEntityId(row) &&
      typeof row.chatId === "string" &&
      row.chatId.trim().length > 0 &&
      typeof row.personaId === "string" &&
      row.personaId.trim().length > 0,
  );
  if (diaryEntries.length > 0) {
    await dbApi.saveDiaryEntries(diaryEntries as unknown as DiaryEntry[]);
    touched = true;
  }

  const imageAssets = normalizeStoreRows(stores, "imageAssets").filter(
    (row): row is Record<string, unknown> & { id: string } =>
      hasEntityId(row) &&
      typeof row.dataUrl === "string" &&
      row.dataUrl.trim().length > 0 &&
      typeof row.createdAt === "string" &&
      row.createdAt.trim().length > 0,
  );
  if (imageAssets.length > 0) {
    for (const imageAsset of imageAssets) {
      await dbApi.saveImageAsset(imageAsset as unknown as ImageAsset);
    }
    touched = true;
  }

  const deletedMemoryIdsRaw = stores.deletedMemoryIds;
  if (Array.isArray(deletedMemoryIdsRaw)) {
    const deletedMemoryIds = deletedMemoryIdsRaw
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (deletedMemoryIds.length > 0) {
      await dbApi.deleteMemories(deletedMemoryIds);
      touched = true;
    }
  }

  const deletedDiaryEntryIdsRaw = stores.deletedDiaryEntryIds;
  if (Array.isArray(deletedDiaryEntryIdsRaw)) {
    const deletedDiaryEntryIds = deletedDiaryEntryIdsRaw
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (deletedDiaryEntryIds.length > 0) {
      await dbApi.deleteDiaryEntries(deletedDiaryEntryIds);
      touched = true;
    }
  }

  if (touched && syncOneToOneStateFromDb) {
    await syncOneToOneStateFromDb(preferredChatId);
  }
}
