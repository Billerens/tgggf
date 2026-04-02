import JSZip from "jszip";
import { dbApi } from "../../db";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  GeneratorSession,
  ImageAsset,
  Persona,
  PersonaMemory,
  PersonaRuntimeState,
} from "../../types";

export type BackupExportScope =
  | "all"
  | "personas"
  | "all_chats"
  | "chat"
  | "generation_sessions";

export type BackupExportFormat = "json" | "zip";
export type BackupImportMode = "merge" | "replace";

interface BackupDataBundle {
  settings?: AppSettings;
  personas: Persona[];
  chats: ChatSession[];
  messages: ChatMessage[];
  personaStates: PersonaRuntimeState[];
  memories: PersonaMemory[];
  generatorSessions: GeneratorSession[];
  imageAssets: ImageAsset[];
}

export interface AppBackupPayload {
  schemaVersion: 1;
  exportedAt: string;
  exportScope: BackupExportScope;
  data: BackupDataBundle;
  meta: {
    personas: number;
    chats: number;
    messages: number;
    personaStates: number;
    memories: number;
    generatorSessions: number;
    imageAssets: number;
    includesSettings: boolean;
  };
}

interface BuildBackupPayloadOptions {
  scope: BackupExportScope;
  chatId?: string;
}

const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_JSON_FILE_NAME = "backup.json";

export interface PreparedBackupFile {
  fileName: string;
  blob: Blob;
}

function toUniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseImageAssetId(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

function collectImageAssetIdsFromPersonas(personas: Persona[]) {
  const ids: string[] = [];
  for (const persona of personas) {
    ids.push(
      persona.avatarImageId,
      persona.fullBodyImageId,
      persona.fullBodySideImageId,
      persona.fullBodyBackImageId,
    );
    ids.push(
      parseImageAssetId(persona.avatarUrl),
      parseImageAssetId(persona.fullBodyUrl),
      parseImageAssetId(persona.fullBodySideUrl),
      parseImageAssetId(persona.fullBodyBackUrl),
    );
  }
  return toUniqueIds(ids);
}

function collectImageAssetIdsFromMessages(messages: ChatMessage[]) {
  const ids: string[] = [];
  for (const message of messages) {
    for (const url of message.imageUrls ?? []) {
      ids.push(parseImageAssetId(url));
    }
  }
  return toUniqueIds(ids);
}

function collectImageAssetIdsFromGeneratorSessions(sessions: GeneratorSession[]) {
  const ids: string[] = [];
  for (const session of sessions) {
    for (const entry of session.entries ?? []) {
      for (const url of entry.imageUrls ?? []) {
        ids.push(parseImageAssetId(url));
      }
    }
  }
  return toUniqueIds(ids);
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = getKey(item).trim();
    if (!key) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function scopeToFilePart(scope: BackupExportScope) {
  if (scope === "all") return "all";
  if (scope === "personas") return "personas";
  if (scope === "all_chats") return "chats";
  if (scope === "chat") return "chat";
  return "generation";
}

function ensureObject(value: unknown, errorMessage: string) {
  if (!value || typeof value !== "object") {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function readArray<T>(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is T => Boolean(item && typeof item === "object"));
}

function buildPayloadMeta(bundle: BackupDataBundle): AppBackupPayload["meta"] {
  return {
    personas: bundle.personas.length,
    chats: bundle.chats.length,
    messages: bundle.messages.length,
    personaStates: bundle.personaStates.length,
    memories: bundle.memories.length,
    generatorSessions: bundle.generatorSessions.length,
    imageAssets: bundle.imageAssets.length,
    includesSettings: Boolean(bundle.settings),
  };
}

export async function buildBackupPayload({
  scope,
  chatId,
}: BuildBackupPayloadOptions): Promise<AppBackupPayload> {
  const [
    allPersonas,
    allChats,
    allMessages,
    allStates,
    allMemories,
    allGeneratorSessions,
    allImageAssets,
    settings,
  ] = await Promise.all([
    dbApi.getPersonas(),
    dbApi.getAllChats(),
    dbApi.getAllMessages(),
    dbApi.getAllPersonaStates(),
    dbApi.getAllMemories(),
    dbApi.getAllGeneratorSessions(),
    dbApi.getAllImageAssets(),
    dbApi.getSettings(),
  ]);

  let personas: Persona[] = [];
  let chats: ChatSession[] = [];
  let messages: ChatMessage[] = [];
  let personaStates: PersonaRuntimeState[] = [];
  let memories: PersonaMemory[] = [];
  let generatorSessions: GeneratorSession[] = [];
  let imageAssets: ImageAsset[] = [];
  let includeSettings = false;

  if (scope === "all") {
    includeSettings = true;
    personas = allPersonas;
    chats = allChats;
    messages = allMessages;
    personaStates = allStates;
    memories = allMemories;
    generatorSessions = allGeneratorSessions;
    imageAssets = allImageAssets;
  } else if (scope === "personas") {
    personas = allPersonas;
  } else if (scope === "all_chats") {
    chats = allChats;
    const chatIdSet = new Set(chats.map((chat) => chat.id));
    messages = allMessages.filter((message) => chatIdSet.has(message.chatId));
    personaStates = allStates.filter((state) => chatIdSet.has(state.chatId));
    memories = allMemories.filter((memory) => chatIdSet.has(memory.chatId));
    const personaIds = toUniqueIds(chats.map((chat) => chat.personaId));
    const personaIdSet = new Set(personaIds);
    personas = allPersonas.filter((persona) => personaIdSet.has(persona.id));
  } else if (scope === "chat") {
    const normalizedChatId = (chatId ?? "").trim();
    if (!normalizedChatId) {
      throw new Error("Для экспорта чата нужно выбрать чат.");
    }
    const selectedChat = allChats.find((chat) => chat.id === normalizedChatId);
    if (!selectedChat) {
      throw new Error("Выбранный чат не найден.");
    }
    chats = [selectedChat];
    messages = allMessages.filter((message) => message.chatId === normalizedChatId);
    personaStates = allStates.filter((state) => state.chatId === normalizedChatId);
    memories = allMemories.filter((memory) => memory.chatId === normalizedChatId);
    personas = allPersonas.filter((persona) => persona.id === selectedChat.personaId);
  } else if (scope === "generation_sessions") {
    generatorSessions = allGeneratorSessions;
    const personaIds = toUniqueIds(
      generatorSessions.map((session) => session.personaId),
    );
    const personaIdSet = new Set(personaIds);
    personas = allPersonas.filter((persona) => personaIdSet.has(persona.id));
  }

  if (scope !== "all") {
    const referencedImageIds = toUniqueIds([
      ...collectImageAssetIdsFromPersonas(personas),
      ...collectImageAssetIdsFromMessages(messages),
      ...collectImageAssetIdsFromGeneratorSessions(generatorSessions),
    ]);
    const imageIdSet = new Set(referencedImageIds);
    imageAssets = allImageAssets.filter((asset) => imageIdSet.has(asset.id));
  }

  const data: BackupDataBundle = {
    settings: includeSettings ? settings : undefined,
    personas: uniqueByKey(personas, (persona) => persona.id),
    chats: uniqueByKey(chats, (chat) => chat.id),
    messages: uniqueByKey(messages, (message) => message.id),
    personaStates: uniqueByKey(personaStates, (state) => state.chatId),
    memories: uniqueByKey(memories, (memory) => memory.id),
    generatorSessions: uniqueByKey(generatorSessions, (session) => session.id),
    imageAssets: uniqueByKey(imageAssets, (asset) => asset.id),
  };

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportScope: scope,
    data,
    meta: buildPayloadMeta(data),
  };
}

export async function exportBackupFile(
  payload: AppBackupPayload,
  format: BackupExportFormat,
): Promise<PreparedBackupFile> {
  const baseName = `tg-gf-export-${scopeToFilePart(payload.exportScope)}-${fileTimestamp()}`;
  const jsonText = JSON.stringify(payload, null, 2);
  if (format === "json") {
    return {
      fileName: `${baseName}.json`,
      blob: new Blob([jsonText], {
        type: "application/json;charset=utf-8",
      }),
    };
  }

  const zip = new JSZip();
  zip.file(BACKUP_JSON_FILE_NAME, jsonText);
  return {
    fileName: `${baseName}.zip`,
    blob: await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  };
}

export async function parseBackupFile(file: File): Promise<AppBackupPayload> {
  const fileName = file.name.toLowerCase();
  let jsonText = "";
  if (fileName.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file);
    const jsonEntry =
      zip.file(BACKUP_JSON_FILE_NAME) ??
      Object.values(zip.files).find((entry) => entry.name.toLowerCase().endsWith(".json"));
    if (!jsonEntry) {
      throw new Error("В ZIP архиве не найден JSON-файл бэкапа.");
    }
    jsonText = await jsonEntry.async("text");
  } else {
    jsonText = await file.text();
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(jsonText);
  } catch {
    throw new Error("Не удалось прочитать JSON из файла бэкапа.");
  }

  const payloadObject = ensureObject(
    rawPayload,
    "Некорректный формат файла бэкапа.",
  );
  const dataObject = ensureObject(
    payloadObject.data,
    "В бэкапе отсутствует секция data.",
  );

  const exportScope = payloadObject.exportScope;
  const normalizedScope: BackupExportScope =
    exportScope === "personas" ||
    exportScope === "all_chats" ||
    exportScope === "chat" ||
    exportScope === "generation_sessions"
      ? exportScope
      : "all";

  const settings =
    dataObject.settings && typeof dataObject.settings === "object"
      ? (dataObject.settings as AppSettings)
      : undefined;

  const normalizedData: BackupDataBundle = {
    settings,
    personas: readArray<Persona>(dataObject.personas),
    chats: readArray<ChatSession>(dataObject.chats),
    messages: readArray<ChatMessage>(dataObject.messages),
    personaStates: readArray<PersonaRuntimeState>(dataObject.personaStates),
    memories: readArray<PersonaMemory>(dataObject.memories),
    generatorSessions: readArray<GeneratorSession>(dataObject.generatorSessions),
    imageAssets: readArray<ImageAsset>(dataObject.imageAssets),
  };

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt:
      typeof payloadObject.exportedAt === "string"
        ? payloadObject.exportedAt
        : new Date().toISOString(),
    exportScope: normalizedScope,
    data: normalizedData,
    meta: buildPayloadMeta(normalizedData),
  };
}

export async function importBackupPayload(
  payload: AppBackupPayload,
  mode: BackupImportMode = "merge",
) {
  const data = payload.data;
  const imageAssets = uniqueByKey(data.imageAssets, (asset) => asset.id);
  const personas = uniqueByKey(data.personas, (persona) => persona.id);
  const chats = uniqueByKey(data.chats, (chat) => chat.id);
  const messages = uniqueByKey(data.messages, (message) => message.id);
  const personaStates = uniqueByKey(data.personaStates, (state) => state.chatId);
  const memories = uniqueByKey(data.memories, (memory) => memory.id);
  const generatorSessions = uniqueByKey(
    data.generatorSessions,
    (session) => session.id,
  );

  if (mode === "replace") {
    await dbApi.clearAllData();
  }

  await Promise.all(imageAssets.map((asset) => dbApi.saveImageAsset(asset)));
  await Promise.all(personas.map((persona) => dbApi.savePersona(persona)));
  await Promise.all(chats.map((chat) => dbApi.saveChat(chat)));
  await Promise.all(messages.map((message) => dbApi.saveMessage(message)));
  await Promise.all(
    personaStates.map((state) => dbApi.savePersonaState(state)),
  );
  await dbApi.saveMemories(memories);
  await Promise.all(
    generatorSessions.map((session) => dbApi.saveGeneratorSession(session)),
  );

  if (data.settings) {
    await dbApi.saveSettings(data.settings);
  }

  return buildPayloadMeta({
    settings: data.settings,
    personas,
    chats,
    messages,
    personaStates,
    memories,
    generatorSessions,
    imageAssets,
  });
}
