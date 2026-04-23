import JSZip from "jszip";
import { dbApi } from "../../db";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  DiaryEntry,
  GeneratorSession,
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  GroupSnapshot,
  ImageAsset,
  Persona,
  PersonaEvolutionState,
  PersonaMemory,
  PersonaRuntimeState,
} from "../../types";

export type BackupExportScope =
  | "all"
  | "personas"
  | "all_chats"
  | "chat"
  | "generation_sessions"
  | "custom";

export type BackupExportFormat = "json" | "zip" | "raw_json" | "raw_zip";
export type BackupImportMode = "merge" | "replace";

export interface BackupExportSelection {
  includeSettings: boolean;
  includePersonas: boolean;
  includeChats: boolean;
  selectedChatId?: string;
  includeGenerationSessions: boolean;
  includeGroupData: boolean;
  includeImageAssets: boolean;
}

interface BackupDataBundle {
  settings?: AppSettings;
  personas: Persona[];
  chats: ChatSession[];
  diaryEntries: DiaryEntry[];
  messages: ChatMessage[];
  personaStates: PersonaRuntimeState[];
  personaEvolutionStates: PersonaEvolutionState[];
  memories: PersonaMemory[];
  generatorSessions: GeneratorSession[];
  imageAssets: ImageAsset[];
  groupRooms: GroupRoom[];
  groupParticipants: GroupParticipant[];
  groupMessages: GroupMessage[];
  groupEvents: GroupEvent[];
  groupPersonaStates: GroupPersonaState[];
  groupRelationEdges: GroupRelationEdge[];
  groupSharedMemories: GroupMemoryShared[];
  groupPrivateMemories: GroupMemoryPrivate[];
  groupSnapshots: GroupSnapshot[];
}

export interface AppBackupPayload {
  schemaVersion: number;
  exportedAt: string;
  exportScope: BackupExportScope;
  data: BackupDataBundle;
  meta: {
    personas: number;
    chats: number;
    diaryEntries: number;
    messages: number;
    personaStates: number;
    personaEvolutionStates: number;
    memories: number;
    generatorSessions: number;
    imageAssets: number;
    groupRooms: number;
    groupParticipants: number;
    groupMessages: number;
    groupEvents: number;
    groupPersonaStates: number;
    groupRelationEdges: number;
    groupSharedMemories: number;
    groupPrivateMemories: number;
    groupSnapshots: number;
    includesSettings: boolean;
    rawSnapshot: boolean;
  };
}

interface RawSnapshotBackupPayload {
  kind: "idb_raw_snapshot";
  schemaVersion: 1;
  exportedAt: string;
  stores: Record<string, unknown[]>;
}

export type ParsedBackupPayload = AppBackupPayload | RawSnapshotBackupPayload;

interface BuildBackupPayloadOptions {
  scope?: Exclude<BackupExportScope, "custom">;
  chatId?: string;
  selection?: BackupExportSelection;
}

interface ExportBackupFileOptions {
  backupName?: string;
  versionTag?: string;
}

const BACKUP_SCHEMA_VERSION = 2;
const RAW_BACKUP_SCHEMA_VERSION = 1;
const BACKUP_JSON_FILE_NAME = "backup.json";

function isRawSnapshotPayload(
  payload: ParsedBackupPayload,
): payload is RawSnapshotBackupPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    payload.kind === "idb_raw_snapshot"
  );
}

export interface PreparedBackupFile {
  fileName: string;
  blob: Blob;
}

function toUniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sanitizeSettingsSecurityPinFields(settings: AppSettings): AppSettings {
  return {
    ...settings,
    securityPinEnabled: false,
    securityPinHash: "",
    securityPinSalt: "",
    securityLockOnBackground: false,
  };
}

function sanitizeRawSnapshotSettingsEntries(rows: unknown[]) {
  return rows.map((row) => {
    const typedRow =
      row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    if (!typedRow) return row;
    if ("value" in typedRow && typedRow.value && typeof typedRow.value === "object") {
      return {
        ...typedRow,
        value: sanitizeSettingsSecurityPinFields(
          typedRow.value as unknown as AppSettings,
        ) as unknown,
      };
    }
    return sanitizeSettingsSecurityPinFields(
      typedRow as unknown as AppSettings,
    ) as unknown;
  });
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

function collectImageAssetIdsFromGroupMessages(messages: GroupMessage[]) {
  const ids: string[] = [];
  for (const message of messages) {
    for (const attachment of message.imageAttachments ?? []) {
      ids.push(attachment.imageId || "", parseImageAssetId(attachment.url || ""));
    }
    const metaByUrl = message.imageMetaByUrl ?? {};
    for (const url of Object.keys(metaByUrl)) {
      ids.push(parseImageAssetId(url));
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

function sanitizeFilePart(value: string) {
  return value
    .trim()
    .replace(/[\u0000-\u001F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function createBackupVersionTag(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function normalizeVersionTag(value: string | undefined) {
  const normalized = (value || "").trim();
  if (!normalized) return "";
  const safe = normalized
    .replace(/[^0-9A-Za-z_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.slice(0, 40);
}

function scopeToFilePart(scope: BackupExportScope) {
  if (scope === "all") return "all";
  if (scope === "personas") return "personas";
  if (scope === "all_chats") return "chats";
  if (scope === "chat") return "chat";
  if (scope === "generation_sessions") return "generation";
  return "custom";
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
    diaryEntries: bundle.diaryEntries.length,
    messages: bundle.messages.length,
    personaStates: bundle.personaStates.length,
    personaEvolutionStates: bundle.personaEvolutionStates.length,
    memories: bundle.memories.length,
    generatorSessions: bundle.generatorSessions.length,
    imageAssets: bundle.imageAssets.length,
    groupRooms: bundle.groupRooms.length,
    groupParticipants: bundle.groupParticipants.length,
    groupMessages: bundle.groupMessages.length,
    groupEvents: bundle.groupEvents.length,
    groupPersonaStates: bundle.groupPersonaStates.length,
    groupRelationEdges: bundle.groupRelationEdges.length,
    groupSharedMemories: bundle.groupSharedMemories.length,
    groupPrivateMemories: bundle.groupPrivateMemories.length,
    groupSnapshots: bundle.groupSnapshots.length,
    includesSettings: Boolean(bundle.settings),
    rawSnapshot: false,
  };
}

function buildRawMeta(stores: Record<string, unknown[]>): AppBackupPayload["meta"] {
  const count = (name: string) =>
    Array.isArray(stores[name]) ? stores[name].length : 0;

  return {
    personas: count("personas"),
    chats: count("chats"),
    diaryEntries: count("diaryEntries"),
    messages: count("messages"),
    personaStates: count("personaStates"),
    personaEvolutionStates: count("personaEvolutionStates"),
    memories: count("memories"),
    generatorSessions: count("generatorSessions"),
    imageAssets: count("imageAssets"),
    groupRooms: count("groupRooms"),
    groupParticipants: count("groupParticipants"),
    groupMessages: count("groupMessages"),
    groupEvents: count("groupEvents"),
    groupPersonaStates: count("groupPersonaStates"),
    groupRelationEdges: count("groupRelationEdges"),
    groupSharedMemories: count("groupSharedMemories"),
    groupPrivateMemories: count("groupPrivateMemories"),
    groupSnapshots: count("groupSnapshots"),
    includesSettings: count("settings") > 0,
    rawSnapshot: true,
  };
}

export async function buildBackupPayload({
  scope,
  chatId,
  selection,
}: BuildBackupPayloadOptions): Promise<AppBackupPayload> {
  const [
    allPersonas,
    allChats,
    allDiaryEntries,
    allMessages,
    allStates,
    allEvolutionStates,
    allMemories,
    allGeneratorSessions,
    allImageAssets,
    allGroupRooms,
    settings,
  ] = await Promise.all([
    dbApi.getPersonas(),
    dbApi.getAllChats(),
    dbApi.getAllDiaryEntries(),
    dbApi.getAllMessages(),
    dbApi.getAllPersonaStates(),
    dbApi.getAllPersonaEvolutionStates(),
    dbApi.getAllMemories(),
    dbApi.getAllGeneratorSessions(),
    dbApi.getAllImageAssets(),
    dbApi.getGroupRooms(),
    dbApi.getSettings(),
  ]);

  let personas: Persona[] = [];
  let chats: ChatSession[] = [];
  let diaryEntries: DiaryEntry[] = [];
  let messages: ChatMessage[] = [];
  let personaStates: PersonaRuntimeState[] = [];
  let personaEvolutionStates: PersonaEvolutionState[] = [];
  let memories: PersonaMemory[] = [];
  let generatorSessions: GeneratorSession[] = [];
  let imageAssets: ImageAsset[] = [];
  let groupRooms: GroupRoom[] = [];
  let groupParticipants: GroupParticipant[] = [];
  let groupMessages: GroupMessage[] = [];
  let groupEvents: GroupEvent[] = [];
  let groupPersonaStates: GroupPersonaState[] = [];
  let groupRelationEdges: GroupRelationEdge[] = [];
  let groupSharedMemories: GroupMemoryShared[] = [];
  let groupPrivateMemories: GroupMemoryPrivate[] = [];
  let groupSnapshots: GroupSnapshot[] = [];
  let includeSettings = false;
  let exportScope: BackupExportScope = "all";

  const loadGroupArtifacts = async (rooms: GroupRoom[]) => {
    if (rooms.length === 0) {
      return {
        participants: [] as GroupParticipant[],
        roomMessages: [] as GroupMessage[],
        events: [] as GroupEvent[],
        states: [] as GroupPersonaState[],
        relationEdges: [] as GroupRelationEdge[],
        sharedMemories: [] as GroupMemoryShared[],
        privateMemories: [] as GroupMemoryPrivate[],
        snapshots: [] as GroupSnapshot[],
      };
    }
    const roomArtifacts = await Promise.all(
      rooms.map(async (room) => {
        const roomId = room.id;
        const [
          participants,
          roomMessages,
          events,
          states,
          relationEdges,
          sharedMemories,
          privateMemories,
          snapshots,
        ] = await Promise.all([
          dbApi.getGroupParticipants(roomId),
          dbApi.getGroupMessages(roomId),
          dbApi.getGroupEvents(roomId),
          dbApi.getGroupPersonaStates(roomId),
          dbApi.getGroupRelationEdges(roomId),
          dbApi.getGroupSharedMemories(roomId),
          dbApi.getGroupPrivateMemories(roomId),
          dbApi.getGroupSnapshots(roomId),
        ]);
        return {
          participants,
          roomMessages,
          events,
          states,
          relationEdges,
          sharedMemories,
          privateMemories,
          snapshots,
        };
      }),
    );
    return {
      participants: roomArtifacts.flatMap((item) => item.participants),
      roomMessages: roomArtifacts.flatMap((item) => item.roomMessages),
      events: roomArtifacts.flatMap((item) => item.events),
      states: roomArtifacts.flatMap((item) => item.states),
      relationEdges: roomArtifacts.flatMap((item) => item.relationEdges),
      sharedMemories: roomArtifacts.flatMap((item) => item.sharedMemories),
      privateMemories: roomArtifacts.flatMap((item) => item.privateMemories),
      snapshots: roomArtifacts.flatMap((item) => item.snapshots),
    };
  };

  if (selection) {
    exportScope = "custom";
    includeSettings = Boolean(selection.includeSettings);
    const linkedPersonaIds = new Set<string>();

    if (selection.includePersonas) {
      personas = allPersonas;
    }

    if (selection.includeChats) {
      const normalizedChatId = (selection.selectedChatId ?? "").trim();
      if (normalizedChatId) {
        const selectedChat = allChats.find((chat) => chat.id === normalizedChatId);
        if (!selectedChat) {
          throw new Error("Выбранный чат не найден.");
        }
        chats = [selectedChat];
      } else {
        chats = allChats;
      }
      const chatIdSet = new Set(chats.map((chat) => chat.id));
      diaryEntries = allDiaryEntries.filter((entry) => chatIdSet.has(entry.chatId));
      messages = allMessages.filter((message) => chatIdSet.has(message.chatId));
      personaStates = allStates.filter((state) => chatIdSet.has(state.chatId));
      personaEvolutionStates = allEvolutionStates.filter((state) =>
        chatIdSet.has(state.chatId),
      );
      memories = allMemories.filter((memory) => chatIdSet.has(memory.chatId));
      for (const chat of chats) {
        linkedPersonaIds.add(chat.personaId);
      }
    }

    if (selection.includeGenerationSessions) {
      generatorSessions = allGeneratorSessions;
      for (const session of generatorSessions) {
        linkedPersonaIds.add(session.personaId);
      }
    }

    if (selection.includeGroupData) {
      groupRooms = allGroupRooms;
      const groupArtifacts = await loadGroupArtifacts(groupRooms);
      groupParticipants = groupArtifacts.participants;
      groupMessages = groupArtifacts.roomMessages;
      groupEvents = groupArtifacts.events;
      groupPersonaStates = groupArtifacts.states;
      groupRelationEdges = groupArtifacts.relationEdges;
      groupSharedMemories = groupArtifacts.sharedMemories;
      groupPrivateMemories = groupArtifacts.privateMemories;
      groupSnapshots = groupArtifacts.snapshots;
      for (const participant of groupParticipants) {
        linkedPersonaIds.add(participant.personaId);
      }
    }

    if (linkedPersonaIds.size > 0) {
      const linkedPersonas = allPersonas.filter((persona) =>
        linkedPersonaIds.has(persona.id),
      );
      personas = selection.includePersonas
        ? uniqueByKey([...personas, ...linkedPersonas], (persona) => persona.id)
        : linkedPersonas;
    }

    if (selection.includeImageAssets) {
      const hasStructuredSelection =
        selection.includePersonas ||
        selection.includeChats ||
        selection.includeGenerationSessions ||
        selection.includeGroupData;
      if (!hasStructuredSelection) {
        imageAssets = allImageAssets;
      } else {
        const referencedImageIds = toUniqueIds([
          ...collectImageAssetIdsFromPersonas(personas),
          ...collectImageAssetIdsFromMessages(messages),
          ...collectImageAssetIdsFromGeneratorSessions(generatorSessions),
          ...collectImageAssetIdsFromGroupMessages(groupMessages),
        ]);
        const imageIdSet = new Set(referencedImageIds);
        imageAssets = allImageAssets.filter((asset) => imageIdSet.has(asset.id));
      }
    }
  } else {
    const legacyScope: Exclude<BackupExportScope, "custom"> = scope ?? "all";
    exportScope = legacyScope;

    if (legacyScope === "all") {
      includeSettings = true;
      personas = allPersonas;
      chats = allChats;
      diaryEntries = allDiaryEntries;
      messages = allMessages;
      personaStates = allStates;
      personaEvolutionStates = allEvolutionStates;
      memories = allMemories;
      generatorSessions = allGeneratorSessions;
      imageAssets = allImageAssets;
      groupRooms = allGroupRooms;
      const groupArtifacts = await loadGroupArtifacts(groupRooms);
      groupParticipants = groupArtifacts.participants;
      groupMessages = groupArtifacts.roomMessages;
      groupEvents = groupArtifacts.events;
      groupPersonaStates = groupArtifacts.states;
      groupRelationEdges = groupArtifacts.relationEdges;
      groupSharedMemories = groupArtifacts.sharedMemories;
      groupPrivateMemories = groupArtifacts.privateMemories;
      groupSnapshots = groupArtifacts.snapshots;
    } else if (legacyScope === "personas") {
      personas = allPersonas;
    } else if (legacyScope === "all_chats") {
      chats = allChats;
      const chatIdSet = new Set(chats.map((chat) => chat.id));
      diaryEntries = allDiaryEntries.filter((entry) => chatIdSet.has(entry.chatId));
      messages = allMessages.filter((message) => chatIdSet.has(message.chatId));
      personaStates = allStates.filter((state) => chatIdSet.has(state.chatId));
      personaEvolutionStates = allEvolutionStates.filter((state) =>
        chatIdSet.has(state.chatId),
      );
      memories = allMemories.filter((memory) => chatIdSet.has(memory.chatId));
      const personaIds = toUniqueIds(chats.map((chat) => chat.personaId));
      const personaIdSet = new Set(personaIds);
      personas = allPersonas.filter((persona) => personaIdSet.has(persona.id));
    } else if (legacyScope === "chat") {
      const normalizedChatId = (chatId ?? "").trim();
      if (!normalizedChatId) {
        throw new Error("Для экспорта чата нужно выбрать чат.");
      }
      const selectedChat = allChats.find((chat) => chat.id === normalizedChatId);
      if (!selectedChat) {
        throw new Error("Выбранный чат не найден.");
      }
      chats = [selectedChat];
      diaryEntries = allDiaryEntries.filter((entry) => entry.chatId === normalizedChatId);
      messages = allMessages.filter((message) => message.chatId === normalizedChatId);
      personaStates = allStates.filter((state) => state.chatId === normalizedChatId);
      personaEvolutionStates = allEvolutionStates.filter(
        (state) => state.chatId === normalizedChatId,
      );
      memories = allMemories.filter((memory) => memory.chatId === normalizedChatId);
      personas = allPersonas.filter((persona) => persona.id === selectedChat.personaId);
    } else if (legacyScope === "generation_sessions") {
      generatorSessions = allGeneratorSessions;
      const personaIds = toUniqueIds(
        generatorSessions.map((session) => session.personaId),
      );
      const personaIdSet = new Set(personaIds);
      personas = allPersonas.filter((persona) => personaIdSet.has(persona.id));
    }

    if (legacyScope !== "all") {
      const referencedImageIds = toUniqueIds([
        ...collectImageAssetIdsFromPersonas(personas),
        ...collectImageAssetIdsFromMessages(messages),
        ...collectImageAssetIdsFromGeneratorSessions(generatorSessions),
      ]);
      const imageIdSet = new Set(referencedImageIds);
      imageAssets = allImageAssets.filter((asset) => imageIdSet.has(asset.id));
    }
  }

  const data: BackupDataBundle = {
    settings:
      includeSettings && settings
        ? sanitizeSettingsSecurityPinFields(settings)
        : undefined,
    personas: uniqueByKey(personas, (persona) => persona.id),
    chats: uniqueByKey(chats, (chat) => chat.id),
    diaryEntries: uniqueByKey(diaryEntries, (entry) => entry.id),
    messages: uniqueByKey(messages, (message) => message.id),
    personaStates: uniqueByKey(personaStates, (state) => state.chatId),
    personaEvolutionStates: uniqueByKey(
      personaEvolutionStates,
      (state) => state.chatId,
    ),
    memories: uniqueByKey(memories, (memory) => memory.id),
    generatorSessions: uniqueByKey(generatorSessions, (session) => session.id),
    imageAssets: uniqueByKey(imageAssets, (asset) => asset.id),
    groupRooms: uniqueByKey(groupRooms, (room) => room.id),
    groupParticipants: uniqueByKey(groupParticipants, (participant) => participant.id),
    groupMessages: uniqueByKey(groupMessages, (message) => message.id),
    groupEvents: uniqueByKey(groupEvents, (event) => event.id),
    groupPersonaStates: uniqueByKey(groupPersonaStates, (state) => state.id),
    groupRelationEdges: uniqueByKey(groupRelationEdges, (edge) => edge.id),
    groupSharedMemories: uniqueByKey(groupSharedMemories, (memory) => memory.id),
    groupPrivateMemories: uniqueByKey(groupPrivateMemories, (memory) => memory.id),
    groupSnapshots: uniqueByKey(groupSnapshots, (snapshot) => snapshot.id),
  };

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportScope,
    data,
    meta: buildPayloadMeta(data),
  };
}

export async function exportBackupFile(
  payload: AppBackupPayload,
  format: Extract<BackupExportFormat, "json" | "zip">,
  options?: ExportBackupFileOptions,
): Promise<PreparedBackupFile> {
  const safeVersion =
    normalizeVersionTag(options?.versionTag) || createBackupVersionTag();
  const safeBackupName = sanitizeFilePart(options?.backupName || "");
  const baseParts = [
    "tg-gf-export",
    scopeToFilePart(payload.exportScope),
    `v${safeVersion}`,
  ];
  if (safeBackupName) {
    baseParts.push(safeBackupName);
  }
  const baseName = baseParts.join("-");
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

export async function exportRawBackupFile(
  format: Extract<BackupExportFormat, "raw_json" | "raw_zip">,
): Promise<PreparedBackupFile> {
  const stores = await dbApi.exportRawSnapshot();
  if (Array.isArray(stores.settings)) {
    stores.settings = sanitizeRawSnapshotSettingsEntries(
      stores.settings,
    ) as typeof stores.settings;
  }
  const payload: RawSnapshotBackupPayload = {
    kind: "idb_raw_snapshot",
    schemaVersion: RAW_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
  const baseName = `tg-gf-raw-idb-v${createBackupVersionTag()}`;
  const jsonText = JSON.stringify(payload, null, 2);

  if (format === "raw_json") {
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

export async function parseBackupFile(file: File): Promise<ParsedBackupPayload> {
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
  if (payloadObject.kind === "idb_raw_snapshot") {
    const storesRaw =
      payloadObject.stores && typeof payloadObject.stores === "object"
        ? (payloadObject.stores as Record<string, unknown>)
        : {};
    const stores: Record<string, unknown[]> = {};
    for (const [storeName, value] of Object.entries(storesRaw)) {
      stores[storeName] = Array.isArray(value) ? value : [];
    }
    if (Array.isArray(stores.settings)) {
      stores.settings = sanitizeRawSnapshotSettingsEntries(stores.settings);
    }
    return {
      kind: "idb_raw_snapshot",
      schemaVersion: RAW_BACKUP_SCHEMA_VERSION,
      exportedAt:
        typeof payloadObject.exportedAt === "string"
          ? payloadObject.exportedAt
          : new Date().toISOString(),
      stores,
    };
  }

  const dataObject = ensureObject(payloadObject.data, "В бэкапе отсутствует секция data.");

  const exportScope = payloadObject.exportScope;
  const normalizedScope: BackupExportScope =
    exportScope === "personas" ||
    exportScope === "all_chats" ||
    exportScope === "chat" ||
    exportScope === "generation_sessions" ||
    exportScope === "custom"
      ? exportScope
      : "all";

  const settings =
    dataObject.settings && typeof dataObject.settings === "object"
      ? sanitizeSettingsSecurityPinFields(dataObject.settings as AppSettings)
      : undefined;

  const normalizedData: BackupDataBundle = {
    settings,
    personas: readArray<Persona>(dataObject.personas),
    chats: readArray<ChatSession>(dataObject.chats),
    diaryEntries: readArray<DiaryEntry>(dataObject.diaryEntries),
    messages: readArray<ChatMessage>(dataObject.messages),
    personaStates: readArray<PersonaRuntimeState>(dataObject.personaStates),
    personaEvolutionStates: readArray<PersonaEvolutionState>(
      dataObject.personaEvolutionStates,
    ),
    memories: readArray<PersonaMemory>(dataObject.memories),
    generatorSessions: readArray<GeneratorSession>(dataObject.generatorSessions),
    imageAssets: readArray<ImageAsset>(dataObject.imageAssets),
    groupRooms: readArray<GroupRoom>(dataObject.groupRooms),
    groupParticipants: readArray<GroupParticipant>(dataObject.groupParticipants),
    groupMessages: readArray<GroupMessage>(dataObject.groupMessages),
    groupEvents: readArray<GroupEvent>(dataObject.groupEvents),
    groupPersonaStates: readArray<GroupPersonaState>(dataObject.groupPersonaStates),
    groupRelationEdges: readArray<GroupRelationEdge>(dataObject.groupRelationEdges),
    groupSharedMemories: readArray<GroupMemoryShared>(dataObject.groupSharedMemories),
    groupPrivateMemories: readArray<GroupMemoryPrivate>(dataObject.groupPrivateMemories),
    groupSnapshots: readArray<GroupSnapshot>(dataObject.groupSnapshots),
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
  payload: ParsedBackupPayload,
  mode: BackupImportMode = "merge",
) {
  let stage = "start";
  const payloadType = isRawSnapshotPayload(payload)
    ? "idb_raw_snapshot"
    : "app_backup";
  let rawSnapshotStoreNames: string[] = [];
  let payloadStats: Record<string, number> | null = null;

  try {
    if (isRawSnapshotPayload(payload)) {
      rawSnapshotStoreNames = Object.keys(payload.stores).sort((a, b) =>
        a.localeCompare(b),
      );
      stage = "import_raw_snapshot";
      await dbApi.importRawSnapshot(payload.stores, mode);
      return buildRawMeta(payload.stores);
    }

    stage = "normalize_payload";
    const data = payload.data;
    const imageAssets = uniqueByKey(data.imageAssets, (asset) => asset.id);
    const personas = uniqueByKey(data.personas, (persona) => persona.id);
    const chats = uniqueByKey(data.chats, (chat) => chat.id);
    const diaryEntries = uniqueByKey(data.diaryEntries, (entry) => entry.id);
    const messages = uniqueByKey(data.messages, (message) => message.id);
    const personaStates = uniqueByKey(data.personaStates, (state) => state.chatId);
    const personaEvolutionStates = uniqueByKey(
      data.personaEvolutionStates,
      (state) => state.chatId,
    );
    const memories = uniqueByKey(data.memories, (memory) => memory.id);
    const generatorSessions = uniqueByKey(
      data.generatorSessions,
      (session) => session.id,
    );
    const groupRooms = uniqueByKey(data.groupRooms, (room) => room.id);
    const groupParticipants = uniqueByKey(
      data.groupParticipants,
      (participant) => participant.id,
    );
    const groupMessages = uniqueByKey(data.groupMessages, (message) => message.id);
    const groupEvents = uniqueByKey(data.groupEvents, (event) => event.id);
    const groupPersonaStates = uniqueByKey(
      data.groupPersonaStates,
      (state) => state.id,
    );
    const groupRelationEdges = uniqueByKey(
      data.groupRelationEdges,
      (edge) => edge.id,
    );
    const groupSharedMemories = uniqueByKey(
      data.groupSharedMemories,
      (memory) => memory.id,
    );
    const groupPrivateMemories = uniqueByKey(
      data.groupPrivateMemories,
      (memory) => memory.id,
    );
    const groupSnapshots = uniqueByKey(
      data.groupSnapshots,
      (snapshot) => snapshot.id,
    );

    payloadStats = {
      personas: personas.length,
      chats: chats.length,
      diaryEntries: diaryEntries.length,
      messages: messages.length,
      personaStates: personaStates.length,
      personaEvolutionStates: personaEvolutionStates.length,
      memories: memories.length,
      generatorSessions: generatorSessions.length,
      imageAssets: imageAssets.length,
      groupRooms: groupRooms.length,
      groupParticipants: groupParticipants.length,
      groupMessages: groupMessages.length,
      groupEvents: groupEvents.length,
      groupPersonaStates: groupPersonaStates.length,
      groupRelationEdges: groupRelationEdges.length,
      groupSharedMemories: groupSharedMemories.length,
      groupPrivateMemories: groupPrivateMemories.length,
      groupSnapshots: groupSnapshots.length,
      settings: data.settings ? 1 : 0,
    };

    if (mode === "replace") {
      stage = "clear_all_data";
      await dbApi.clearAllData();
    }

    stage = "save_image_assets";
    await Promise.all(imageAssets.map((asset) => dbApi.saveImageAsset(asset)));
    stage = "save_personas";
    await Promise.all(personas.map((persona) => dbApi.savePersona(persona)));
    stage = "save_chats";
    await Promise.all(chats.map((chat) => dbApi.saveChat(chat)));
    stage = "save_diary_entries";
    await dbApi.saveDiaryEntries(diaryEntries);
    stage = "save_messages";
    await Promise.all(messages.map((message) => dbApi.saveMessage(message)));
    stage = "save_persona_states";
    await Promise.all(
      personaStates.map((state) => dbApi.savePersonaState(state)),
    );
    stage = "save_persona_evolution_states";
    await Promise.all(
      personaEvolutionStates.map((state) =>
        dbApi.savePersonaEvolutionState(state),
      ),
    );
    stage = "save_memories";
    await dbApi.saveMemories(memories);
    stage = "save_generator_sessions";
    await Promise.all(
      generatorSessions.map((session) => dbApi.saveGeneratorSession(session)),
    );
    stage = "save_group_rooms";
    await Promise.all(groupRooms.map((room) => dbApi.saveGroupRoom(room)));
    stage = "save_group_participants";
    await dbApi.saveGroupParticipants(groupParticipants);
    stage = "save_group_messages";
    await Promise.all(groupMessages.map((message) => dbApi.saveGroupMessage(message)));
    stage = "save_group_events";
    await dbApi.appendGroupEvents(groupEvents);
    stage = "save_group_persona_states";
    await dbApi.saveGroupPersonaStates(groupPersonaStates);
    stage = "save_group_relation_edges";
    await dbApi.saveGroupRelationEdges(groupRelationEdges);
    stage = "save_group_shared_memories";
    await dbApi.saveGroupSharedMemories(groupSharedMemories);
    stage = "save_group_private_memories";
    await dbApi.saveGroupPrivateMemories(groupPrivateMemories);
    stage = "save_group_snapshots";
    await Promise.all(
      groupSnapshots.map((snapshot) => dbApi.saveGroupSnapshot(snapshot)),
    );

    if (data.settings) {
      stage = "save_settings";
      await dbApi.saveSettings(data.settings);
    }

    return buildPayloadMeta({
      settings: data.settings,
      personas,
      chats,
      diaryEntries,
      messages,
      personaStates,
      personaEvolutionStates,
      memories,
      generatorSessions,
      imageAssets,
      groupRooms,
      groupParticipants,
      groupMessages,
      groupEvents,
      groupPersonaStates,
      groupRelationEdges,
      groupSharedMemories,
      groupPrivateMemories,
      groupSnapshots,
    });
  } catch (error) {
    const causeMessage =
      error instanceof Error ? error.message : String(error);
    const dbStoreNames = await dbApi.getStoreNames().catch(() => []);
    const payloadSummary = rawSnapshotStoreNames.length
      ? `rawStores=${rawSnapshotStoreNames.join(",")}`
      : payloadStats
        ? Object.entries(payloadStats)
            .map(([key, value]) => `${key}=${value}`)
            .join(",")
        : "payloadStats=unavailable";

    console.error("[backup/import] failed", {
      mode,
      payloadType,
      stage,
      payloadSummary,
      dbStoreNames,
      error,
    });

    throw new Error(
      [
        "Импорт бэкапа завершился ошибкой.",
        `mode=${mode}`,
        `payloadType=${payloadType}`,
        `stage=${stage}`,
        payloadSummary,
        `dbStores=${dbStoreNames.join(",") || "(unavailable)"}`,
        `cause=${causeMessage}`,
      ].join(" "),
    );
  }
}
