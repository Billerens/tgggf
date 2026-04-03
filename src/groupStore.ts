import { create } from "zustand";
import { dbApi } from "./db";
import { generateComfyPromptFromImageDescription } from "./lmstudio";
import { generateComfyImages, readComfyImageGenerationMeta } from "./comfy";
import { localizeImageUrls } from "./imageStorage";
import {
  applyGroupRelationDynamics,
  reconcilePrivateGroupMemories,
  reconcileSharedGroupMemories,
} from "./groupDynamics";
import {
  requestLlmOrchestratorDecision,
  requestLlmPersonaMessage,
  runGroupOrchestratorTick,
  validatePersonaSpeaksOnlyForSelf,
} from "./groupOrchestrator";
import type {
  AppSettings,
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupMessageMention,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  GroupRoomMode,
  GroupRoomStatus,
  ImageGenerationMeta,
  Persona,
} from "./types";

interface GroupStoreState {
  groupRooms: GroupRoom[];
  groupParticipants: GroupParticipant[];
  groupMessages: GroupMessage[];
  groupEvents: GroupEvent[];
  groupPersonaStates: GroupPersonaState[];
  groupRelationEdges: GroupRelationEdge[];
  groupSharedMemories: GroupMemoryShared[];
  groupPrivateMemories: GroupMemoryPrivate[];
  activeGroupRoomId: string | null;
  initialized: boolean;
  isLoading: boolean;
  isOrchestratorTicking: boolean;
  error: string | null;
  initializeGroup: (personas: Persona[]) => Promise<void>;
  createGroupRoom: (
    personas: Persona[],
    options?: { title?: string; mode?: GroupRoomMode; participantPersonaIds?: string[] },
  ) => Promise<void>;
  deleteGroupRoom: (roomId: string) => Promise<void>;
  selectGroupRoom: (roomId: string) => Promise<void>;
  sendUserGroupMessage: (content: string, userName: string, personas: Persona[]) => Promise<void>;
  savePersonaGroupMessage: (
    roomId: string,
    persona: Persona,
    content: string,
    personas: Persona[],
    userName: string,
    turnIdOverride?: string,
    options?: {
      comfyPrompt?: string;
      comfyPrompts?: string[];
      comfyImageDescription?: string;
      comfyImageDescriptions?: string[];
      personaControlRaw?: string;
      imageGenerationPending?: boolean;
      imageGenerationExpected?: number;
      imageGenerationCompleted?: number;
      imageAttachments?: GroupMessage["imageAttachments"];
      imageMetaByUrl?: Record<string, ImageGenerationMeta>;
    },
  ) => Promise<GroupMessage | null>;
  setActiveGroupRoomStatus: (status: GroupRoomStatus) => Promise<void>;
  runActiveGroupIteration: (
    personas: Persona[],
    settings: AppSettings,
    userName: string,
  ) => Promise<void>;
  refreshActiveGroupEventLog: () => Promise<void>;
  clearError: () => void;
}

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const clamp = (value: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));
const randomSeed = () => {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return (values[0] ^ (values[1] << 1)) >>> 0;
};

function normalizeMessageForDedup(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:()[\]{}"'`~@#$%^&*_+=<>/\\|-]+/g, "");
}

function normalizeToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "");
}

function buildRussianNameForms(token: string) {
  const normalized = normalizeToken(token);
  if (!normalized) return [] as string[];

  const forms = new Set<string>([normalized]);

  if (normalized.endsWith("ия") && normalized.length > 3) {
    const stem = normalized.slice(0, -2);
    ["ия", "ии", "ию", "ией", "ие"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }

  if (normalized.endsWith("а") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["а", "ы", "е", "у", "ой", "ою"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }

  if (normalized.endsWith("я") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["я", "и", "е", "ю", "ей", "ею"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }

  if (normalized.endsWith("й") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["й", "я", "ю", "ем", "е"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }

  if (/[бвгджзклмнпрстфхцчшщ]$/u.test(normalized)) {
    ["а", "у", "ом", "е"].forEach((ending) =>
      forms.add(`${normalized}${ending}`),
    );
  }

  return Array.from(forms);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMentionToken(value: string) {
  const normalized = value.trim().split(/[\s_-]+/g)[0]?.trim() ?? "";
  return normalized.replace(/[.,!?;:()[\]{}"'`~@#$%^&*+=<>/\\|-]+/g, "");
}

function replaceDirectAddressToken(
  content: string,
  token: string,
  replacement: string,
) {
  if (!token) return content;
  const escaped = escapeRegExp(token);
  const pattern = new RegExp(
    `(^|[\\n.!?]\\s*|,\\s*)(${escaped})(?=[:!,?.\\s]|$)`,
    "giu",
  );
  return content.replace(pattern, (_full, prefix: string) => `${prefix}${replacement}`);
}

function normalizePersonaSpeechMentions(
  content: string,
  speakerPersonaId: string,
  personas: Persona[],
  userName: string,
) {
  let next = content;

  const userToken = toMentionToken(userName);
  if (userToken) {
    next = next.replace(/@(?:user|пользователь)\b/giu, `@${userToken}`);
    for (const form of buildRussianNameForms(userToken)) {
      next = replaceDirectAddressToken(next, form, `@${userToken}`);
    }
  }
  const hasNamedUserMention = Boolean(
    userToken &&
      new RegExp(`@${escapeRegExp(userToken)}\\b`, "iu").test(next),
  );
  if (userToken && !hasNamedUserMention) {
    next = replaceDirectAddressToken(next, userToken, `@${userToken}`);
  }

  for (const persona of personas) {
    if (persona.id === speakerPersonaId) continue;
    const token = toMentionToken(persona.name);
    if (!token) continue;
    const mentionPattern = new RegExp(`@${escapeRegExp(token)}\\b`, "iu");
    if (mentionPattern.test(next)) continue;
    for (const form of buildRussianNameForms(token)) {
      next = replaceDirectAddressToken(next, form, `@${token}`);
    }
  }

  // Keep mention style consistent with chat format.
  next = next.replace(/(^|\s)@([^\s@.,!?;:]+):(?=\s|$)/gu, "$1@$2,");

  return next;
}

function ensureReplyMentionFallback(
  content: string,
  roomMode: GroupRoomMode,
  roomMessages: GroupMessage[],
  speakerPersonaId: string,
  personas: Persona[],
  userName: string,
) {
  if (parseMentions(content, personas, userName).length > 0) return content;
  if (/^\s*@\S+/u.test(content)) return content;
  if (roomMode !== "personas_plus_user") return content;

  const latestMessage = [...roomMessages].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )[roomMessages.length - 1];
  if (!latestMessage) return content;
  const userToken = toMentionToken(userName);
  const userMention = userToken ? `@${userToken}` : "@user";

  if (latestMessage.authorType === "user") {
    return `${userMention}, ${content}`;
  }

  if (
    latestMessage.authorType === "persona" &&
    latestMessage.authorPersonaId &&
    latestMessage.authorPersonaId !== speakerPersonaId
  ) {
    const targetPersona = personas.find(
      (persona) => persona.id === latestMessage.authorPersonaId,
    );
    const token = toMentionToken(targetPersona?.name || "");
    if (!token) return content;
    return `@${token}, ${content}`;
  }

  return content;
}

function buildPersonaMentionAliasMap(personas: Persona[]) {
  const buckets = new Map<string, Persona[]>();
  const pushAlias = (alias: string, persona: Persona) => {
    if (!alias) return;
    const current = buckets.get(alias);
    if (current) {
      current.push(persona);
      return;
    }
    buckets.set(alias, [persona]);
  };

  for (const persona of personas) {
    const normalizedName = normalizeToken(persona.name);
    if (!normalizedName) continue;

    for (const form of buildRussianNameForms(normalizedName)) {
      pushAlias(form, persona);
    }
    pushAlias(normalizedName.replace(/[\s_-]+/g, ""), persona);

    const parts = normalizedName
      .split(/[\s_-]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2);
    for (const part of parts) {
      for (const form of buildRussianNameForms(part)) {
        pushAlias(form, persona);
      }
    }
  }

  const aliasMap = new Map<string, Persona>();
  for (const [alias, owners] of buckets.entries()) {
    if (owners.length === 1) {
      aliasMap.set(alias, owners[0]);
    }
  }
  return aliasMap;
}

function parseMentions(content: string, personas: Persona[], userName: string) {
  const mentions: GroupMessageMention[] = [];
  const rx = /@([^\s@.,!?;:]+)/g;
  let match: RegExpExecArray | null;
  const aliasMap = buildPersonaMentionAliasMap(personas);
  const userAliases = new Set<string>(["user", "пользователь"]);
  for (const form of buildRussianNameForms(userName)) {
    userAliases.add(form);
  }

  while ((match = rx.exec(content))) {
    const rawLabel = match[1]?.trim() ?? "";
    if (!rawLabel) continue;

    const labelToken = normalizeToken(rawLabel);
    const start = match.index;
    const end = match.index + match[0].length;

    if (userAliases.has(labelToken)) {
      mentions.push({
        targetType: "user",
        targetId: "user",
        label: rawLabel,
        start,
        end,
      });
      continue;
    }

    if (
      labelToken === "all" ||
      labelToken === "everyone" ||
      labelToken === "все"
    ) {
      mentions.push({
        targetType: "group",
        targetId: "all",
        label: rawLabel,
        start,
        end,
      });
      continue;
    }

    const persona = aliasMap.get(labelToken);
    if (!persona) continue;

    mentions.push({
      targetType: "persona",
      targetId: persona.id,
      label: rawLabel,
      start,
      end,
    });
  }

  return mentions;
}

function buildMentionResolvedEvent(
  roomId: string,
  turnId: string,
  mentions: GroupMessageMention[],
  actor: { authorType: GroupMessage["authorType"]; authorDisplayName: string },
) {
  if (mentions.length === 0) return null;
  return {
    id: newId(),
    roomId,
    turnId,
    type: "mention_resolved" as const,
    payload: {
      authorType: actor.authorType,
      authorDisplayName: actor.authorDisplayName,
      mentionCount: mentions.length,
      mentions: mentions.slice(0, 8).map((mention) => ({
        label: mention.label,
        targetType: mention.targetType,
        targetId: mention.targetId,
      })),
    },
    createdAt: nowIso(),
  };
}

function hasWaitingReasonChanged(room: GroupRoom, nextReason: string | undefined) {
  return (room.waitingReason || "") !== (nextReason || "");
}

function ensureRoomState(room: GroupRoom): GroupRoom {
  if (room.state?.phase) return room;
  const phase =
    room.status === "paused"
      ? "paused"
      : room.waitingForUser
        ? "waiting_user"
        : "idle";
  return {
    ...room,
    state: {
      phase,
      updatedAt: room.updatedAt,
      reason: room.waitingReason,
    },
  };
}

function ensureRoomsState(rooms: GroupRoom[]) {
  return rooms.map((room) => ensureRoomState(room));
}

function pauseRoomsOnBootstrap(rooms: GroupRoom[]) {
  const activeRooms = rooms.filter((room) => room.status === "active");
  if (activeRooms.length === 0) {
    return {
      rooms,
      changed: false,
    };
  }

  const now = nowIso();
  const pausedRooms = rooms.map((room) => {
    if (room.status !== "active") return room;

    const pausedRoom: GroupRoom = {
      ...room,
      status: "paused" as const,
      state: {
        ...room.state,
        phase: "paused",
        updatedAt: now,
        reason: "bootstrap_pause",
      },
      updatedAt: now,
    };

    return pausedRoom;
  });

  return {
    rooms: pausedRooms,
    changed: true,
  };
}

function buildDefaultGroupRoom(title: string, mode: GroupRoomMode): GroupRoom {
  const now = nowIso();
  const status: GroupRoomStatus = "active";
  return {
    id: newId(),
    title,
    mode,
    status,
    state: {
      phase: "idle",
      updatedAt: now,
    },
    waitingForUser: false,
    orchestratorVersion: "v0",
    createdAt: now,
    updatedAt: now,
  };
}

function buildDefaultParticipants(roomId: string, personas: Persona[]) {
  const now = nowIso();
  return personas.map(
    (persona): GroupParticipant => ({
      id: newId(),
      roomId,
      personaId: persona.id,
      role: "member",
      initiativeBias: persona.advanced.behavior.initiative,
      talkCooldownMs: 12000,
      aliveScore: 55,
      joinedAt: now,
      updatedAt: now,
    }),
  );
}

function buildInitialGroupPersonaState(
  roomId: string,
  participant: GroupParticipant,
  persona: Persona,
): GroupPersonaState {
  return {
    id: newId(),
    roomId,
    personaId: participant.personaId,
    mood: persona.advanced.emotion.baselineMood,
    trustToUser: clamp(Math.round(persona.advanced.behavior.empathy * 0.7)),
    energy: clamp(Math.round(50 + (persona.advanced.behavior.initiative - 50) * 0.4)),
    engagement: clamp(Math.round(50 + (persona.advanced.behavior.curiosity - 50) * 0.4)),
    initiative: clamp(persona.advanced.behavior.initiative),
    affectionToUser: clamp(Math.round(persona.advanced.emotion.warmth * 0.65)),
    tension: clamp(Math.round(40 - (persona.advanced.emotion.stability - 50) * 0.3)),
    activeTopics: [],
    currentIntent: undefined,
    aliveScore: participant.aliveScore,
    updatedAt: nowIso(),
  };
}

function buildInitialRelationEdges(
  roomId: string,
  participants: GroupParticipant[],
): GroupRelationEdge[] {
  const edges: GroupRelationEdge[] = [];
  const now = nowIso();

  for (const from of participants) {
    for (const to of participants) {
      if (from.personaId === to.personaId) continue;
      edges.push({
        id: newId(),
        roomId,
        fromPersonaId: from.personaId,
        toPersonaId: to.personaId,
        trust: 50,
        respect: 50,
        affinity: 50,
        tension: 20,
        influence: 40,
        attraction: 20,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return edges;
}

async function loadRoomArtifacts(roomId: string | null) {
  if (!roomId) {
    return {
      participants: [] as GroupParticipant[],
      messages: [] as GroupMessage[],
      events: [] as GroupEvent[],
      personaStates: [] as GroupPersonaState[],
      relationEdges: [] as GroupRelationEdge[],
      sharedMemories: [] as GroupMemoryShared[],
      privateMemories: [] as GroupMemoryPrivate[],
    };
  }

  const [participants, messages, events, personaStates, relationEdges, sharedMemories, privateMemories] = await Promise.all([
    dbApi.getGroupParticipants(roomId),
    dbApi.getGroupMessages(roomId),
    dbApi.getGroupEvents(roomId),
    dbApi.getGroupPersonaStates(roomId),
    dbApi.getGroupRelationEdges(roomId),
    dbApi.getGroupSharedMemories(roomId),
    dbApi.getGroupPrivateMemories(roomId),
  ]);

  return {
    participants,
    messages,
    events,
    personaStates,
    relationEdges,
    sharedMemories,
    privateMemories,
  };
}

export const useGroupStore = create<GroupStoreState>((set, get) => ({
  groupRooms: [],
  groupParticipants: [],
  groupMessages: [],
  groupEvents: [],
  groupPersonaStates: [],
  groupRelationEdges: [],
  groupSharedMemories: [],
  groupPrivateMemories: [],
  activeGroupRoomId: null,
  initialized: false,
  isLoading: false,
  isOrchestratorTicking: false,
  error: null,

  clearError: () => set({ error: null }),

  refreshActiveGroupEventLog: async () => {
    const roomId = get().activeGroupRoomId;
    if (!roomId) {
      set({ groupEvents: [] });
      return;
    }
    const events = await dbApi.getGroupEvents(roomId);
    if (get().activeGroupRoomId === roomId) {
      set({ groupEvents: events });
    }
  },

  initializeGroup: async (personas) => {
    if (get().initialized) return;

    set({ isLoading: true, error: null });
    try {
      let rooms = ensureRoomsState(await dbApi.getGroupRooms());

      if (rooms.length === 0 && personas.length > 0) {
        const room = buildDefaultGroupRoom("Групповой чат", "personas_only");
        await dbApi.saveGroupRoom(room);
        const participants = buildDefaultParticipants(room.id, personas);
        await dbApi.saveGroupParticipants(participants);
        const initialStates = participants
          .map((participant) => {
            const persona = personas.find((item) => item.id === participant.personaId);
            if (!persona) return null;
            return buildInitialGroupPersonaState(room.id, participant, persona);
          })
          .filter((item): item is GroupPersonaState => Boolean(item));
        const initialEdges = buildInitialRelationEdges(room.id, participants);
        await dbApi.saveGroupPersonaStates(initialStates);
        await dbApi.saveGroupRelationEdges(initialEdges);
        const createdAt = nowIso();
        const createdEvents: GroupEvent[] = [
          {
            id: newId(),
            roomId: room.id,
            type: "room_created",
            payload: {
              mode: room.mode,
              title: room.title,
              participantCount: participants.length,
            },
            createdAt,
          },
          {
            id: newId(),
            roomId: room.id,
            type: "room_mode_changed",
            payload: {
              fromMode: null,
              toMode: room.mode,
            },
            createdAt,
          },
          ...participants.map((participant) => ({
            id: newId(),
            roomId: room.id,
            type: "participant_added" as const,
            payload: {
              participantId: participant.id,
              personaId: participant.personaId,
            },
            createdAt,
          })),
        ];
        await dbApi.appendGroupEvents(createdEvents);
        rooms = [room];
      }
      const bootstrapPause = pauseRoomsOnBootstrap(rooms);
      rooms = ensureRoomsState(bootstrapPause.rooms);
      if (bootstrapPause.changed) {
        await Promise.all(rooms.map((room) => dbApi.saveGroupRoom(room)));
      }

      const activeGroupRoomId = rooms[0]?.id ?? null;
      const artifacts = await loadRoomArtifacts(activeGroupRoomId);

      set({
        groupRooms: rooms,
        activeGroupRoomId,
        groupParticipants: artifacts.participants,
        groupMessages: artifacts.messages,
        groupEvents: artifacts.events,
        groupPersonaStates: artifacts.personaStates,
        groupRelationEdges: artifacts.relationEdges,
        groupSharedMemories: artifacts.sharedMemories,
        groupPrivateMemories: artifacts.privateMemories,
        initialized: true,
        isLoading: false,
      });
    } catch (error) {
      set({
        initialized: true,
        isLoading: false,
        error: (error as Error).message,
      });
    }
  },

  createGroupRoom: async (personas, options) => {
    set({ isLoading: true, error: null });
    try {
      const title = options?.title?.trim() || "Новая группа";
      const mode = options?.mode ?? "personas_only";
      const room = buildDefaultGroupRoom(title, mode);
      await dbApi.saveGroupRoom(room);

      const allowedPersonaIds = new Set(
        (options?.participantPersonaIds ?? personas.map((persona) => persona.id))
          .map((value) => value.trim())
          .filter(Boolean),
      );
      const selectedPersonas = personas.filter((persona) => allowedPersonaIds.has(persona.id));
      const participants = buildDefaultParticipants(room.id, selectedPersonas);
      await dbApi.saveGroupParticipants(participants);
      const initialStates = participants
        .map((participant) => {
          const persona = personas.find((item) => item.id === participant.personaId);
          if (!persona) return null;
          return buildInitialGroupPersonaState(room.id, participant, persona);
        })
        .filter((item): item is GroupPersonaState => Boolean(item));
      const initialEdges = buildInitialRelationEdges(room.id, participants);
      await dbApi.saveGroupPersonaStates(initialStates);
      await dbApi.saveGroupRelationEdges(initialEdges);
      const createdAt = nowIso();
      const events: GroupEvent[] = [
        {
          id: newId(),
          roomId: room.id,
          type: "room_created",
          payload: {
            mode: room.mode,
            title: room.title,
            participantCount: participants.length,
          },
          createdAt,
        },
        {
          id: newId(),
          roomId: room.id,
          type: "room_mode_changed",
          payload: {
            fromMode: null,
            toMode: room.mode,
          },
          createdAt,
        },
        ...participants.map((participant) => ({
          id: newId(),
          roomId: room.id,
          type: "participant_added" as const,
          payload: {
            participantId: participant.id,
            personaId: participant.personaId,
          },
          createdAt,
        })),
      ];
      await dbApi.appendGroupEvents(events);

      const rooms = ensureRoomsState(await dbApi.getGroupRooms());
      set({
        groupRooms: rooms,
        activeGroupRoomId: room.id,
        groupParticipants: participants,
        groupMessages: [],
        groupEvents: events,
        groupPersonaStates: initialStates,
        groupRelationEdges: initialEdges,
        groupSharedMemories: [],
        groupPrivateMemories: [],
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  deleteGroupRoom: async (roomId) => {
    set({ isLoading: true, error: null });
    try {
      const wasActive = get().activeGroupRoomId === roomId;
      await dbApi.deleteGroupRoom(roomId);
      const rooms = ensureRoomsState(await dbApi.getGroupRooms());
      const nextActiveGroupRoomId = wasActive
        ? rooms[0]?.id ?? null
        : get().activeGroupRoomId;

      if (!nextActiveGroupRoomId) {
        set({
          groupRooms: rooms,
          activeGroupRoomId: null,
          groupParticipants: [],
          groupMessages: [],
          groupEvents: [],
          groupPersonaStates: [],
          groupRelationEdges: [],
          groupSharedMemories: [],
          groupPrivateMemories: [],
          isLoading: false,
        });
        return;
      }

      if (!wasActive) {
        set({
          groupRooms: rooms,
          isLoading: false,
        });
        return;
      }

      const artifacts = await loadRoomArtifacts(nextActiveGroupRoomId);
      set({
        groupRooms: rooms,
        activeGroupRoomId: nextActiveGroupRoomId,
        groupParticipants: artifacts.participants,
        groupMessages: artifacts.messages,
        groupEvents: artifacts.events,
        groupPersonaStates: artifacts.personaStates,
        groupRelationEdges: artifacts.relationEdges,
        groupSharedMemories: artifacts.sharedMemories,
        groupPrivateMemories: artifacts.privateMemories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  selectGroupRoom: async (roomId) => {
    set({ isLoading: true, error: null });
    try {
      const artifacts = await loadRoomArtifacts(roomId);
      set({
        activeGroupRoomId: roomId,
        groupParticipants: artifacts.participants,
        groupMessages: artifacts.messages,
        groupEvents: artifacts.events,
        groupPersonaStates: artifacts.personaStates,
        groupRelationEdges: artifacts.relationEdges,
        groupSharedMemories: artifacts.sharedMemories,
        groupPrivateMemories: artifacts.privateMemories,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message });
    }
  },

  sendUserGroupMessage: async (content, userName, personas) => {
    const roomId = get().activeGroupRoomId;
    if (!roomId) return;

    const text = content.trim();
    if (!text) return;

    const mentions = parseMentions(text, personas, userName);
    const turnId = newId();
    const message: GroupMessage = {
      id: newId(),
      roomId,
      turnId,
      authorType: "user",
      authorDisplayName: userName.trim() || "Пользователь",
      content: text,
      mentions: mentions.length > 0 ? mentions : undefined,
      createdAt: nowIso(),
    };

    set((state) => ({
      groupMessages: [...state.groupMessages, message],
    }));

    try {
      await dbApi.saveGroupMessage(message);
      const room = get().groupRooms.find((item) => item.id === roomId);
      const memoryNow = nowIso();
      const memoryEntry: GroupMemoryShared = {
        id: newId(),
        roomId,
        layer: "short_term",
        kind: "event",
        content: `Пользователь ${userName.trim() || "Пользователь"}: ${text.slice(0, 220)}`,
        salience: 55,
        createdAt: memoryNow,
        updatedAt: memoryNow,
      };
      const sharedMemoriesInRoom = get().groupSharedMemories.filter(
        (memory) => memory.roomId === roomId,
      );
      const sharedReconcile = reconcileSharedGroupMemories(
        [...sharedMemoriesInRoom, memoryEntry],
        memoryNow,
      );
      await dbApi.saveGroupSharedMemories(sharedReconcile.kept);
      if (sharedReconcile.removedIds.length > 0) {
        await dbApi.deleteGroupSharedMemories(sharedReconcile.removedIds);
      }
      const persistedMemory =
        sharedReconcile.kept.find((memory) => memory.id === memoryEntry.id) ||
        memoryEntry;
      const memoryWrittenEvent: GroupEvent = {
        id: newId(),
        roomId,
        turnId,
        type: "memory_shared_written",
        payload: {
          layer: persistedMemory.layer,
          kind: persistedMemory.kind,
          salience: persistedMemory.salience,
          source: "user_injected",
          removedCount: sharedReconcile.removedIds.length,
        },
        createdAt: memoryNow,
      };

      const updatedStates = get().groupPersonaStates
        .filter((state) => state.roomId === roomId)
        .map((state) => ({
          ...state,
          engagement: clamp(state.engagement + 2),
          trustToUser: clamp(state.trustToUser + 1),
          updatedAt: nowIso(),
        }));
      if (updatedStates.length > 0) {
        await dbApi.saveGroupPersonaStates(updatedStates);
      }

      const injectedEvent: GroupEvent = {
        id: newId(),
        roomId,
        turnId,
        type: "user_injected",
        payload: {
          by: userName.trim() || "Пользователь",
          messagePreview: text.slice(0, 180),
          mentionCount: mentions.length,
        },
        createdAt: nowIso(),
      };
      const mentionResolvedEvent = buildMentionResolvedEvent(
        roomId,
        turnId,
        mentions,
        {
          authorType: "user",
          authorDisplayName: userName.trim() || "Пользователь",
        },
      );
      const appendedEvents: GroupEvent[] = [injectedEvent, memoryWrittenEvent];
      if (mentionResolvedEvent) {
        appendedEvents.push(mentionResolvedEvent);
      }
      if (room) {
        if (room.mode === "personas_plus_user" && room.waitingForUser) {
          appendedEvents.push({
            id: newId(),
            roomId,
            turnId,
            type: "room_resumed",
            payload: {
              reason: "user_replied",
              by: userName.trim() || "Пользователь",
            },
            createdAt: nowIso(),
          });
        }
        await dbApi.appendGroupEvents(appendedEvents);
        const updatedRoom: GroupRoom = {
          ...room,
          state: {
            phase: "idle",
            updatedAt: nowIso(),
            reason: "user_message",
          },
          waitingForUser: false,
          waitingReason: undefined,
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupRoom(updatedRoom);
        const rooms = ensureRoomsState(await dbApi.getGroupRooms());
        set((state) => ({
          groupRooms: rooms,
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, ...appendedEvents]
              : state.groupEvents,
          groupSharedMemories:
            state.activeGroupRoomId === roomId
              ? sharedReconcile.kept
              : state.groupSharedMemories,
          groupPersonaStates:
            state.activeGroupRoomId === roomId
              ? updatedStates
              : state.groupPersonaStates,
        }));
      } else {
        await dbApi.appendGroupEvents(appendedEvents);
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  savePersonaGroupMessage: async (
    roomId,
    persona,
    content,
    personas,
    userName,
    turnIdOverride,
    options,
  ) => {
    const text = content.trim();
    if (!text) return null;

    const mentions = parseMentions(text, personas, userName);
    const rawAvatarUrl = persona.avatarUrl.trim();
    const authorAvatarUrl =
      rawAvatarUrl && !rawAvatarUrl.startsWith("idb://") ? rawAvatarUrl : undefined;

    const message: GroupMessage = {
      id: newId(),
      roomId,
      turnId: turnIdOverride || newId(),
      authorType: "persona",
      authorPersonaId: persona.id,
      authorDisplayName: persona.name,
      authorAvatarUrl,
      content: text,
      mentions: mentions.length > 0 ? mentions : undefined,
      imageAttachments: options?.imageAttachments,
      comfyPrompt: options?.comfyPrompt,
      comfyPrompts: options?.comfyPrompts,
      comfyImageDescription: options?.comfyImageDescription,
      comfyImageDescriptions: options?.comfyImageDescriptions,
      personaControlRaw: options?.personaControlRaw,
      imageGenerationPending: options?.imageGenerationPending,
      imageGenerationExpected: options?.imageGenerationExpected,
      imageGenerationCompleted: options?.imageGenerationCompleted,
      imageMetaByUrl: options?.imageMetaByUrl,
      createdAt: nowIso(),
    };

    await dbApi.saveGroupMessage(message);

    const mentionResolvedEvent = buildMentionResolvedEvent(
      roomId,
      message.turnId,
      mentions,
      {
        authorType: "persona",
        authorDisplayName: persona.name,
      },
    );
    if (mentionResolvedEvent) {
      await dbApi.saveGroupEvent(mentionResolvedEvent);
    }

    if (get().activeGroupRoomId === roomId) {
      set((state) => ({
        groupMessages: [...state.groupMessages, message],
        groupEvents: mentionResolvedEvent
          ? [...state.groupEvents, mentionResolvedEvent]
          : state.groupEvents,
      }));
    }

    return message;
  },

  setActiveGroupRoomStatus: async (status) => {
    const roomId = get().activeGroupRoomId;
    if (!roomId) return;

    const room = get().groupRooms.find((item) => item.id === roomId);
    if (!room) return;

    const now = nowIso();
    const nextRoom: GroupRoom = {
      ...room,
      status,
      state: {
        phase: status === "paused" ? "paused" : "idle",
        updatedAt: now,
        reason: status === "paused" ? "manual_pause" : "manual_resume",
      },
      waitingForUser: status === "paused" ? room.waitingForUser : false,
      waitingReason: status === "paused" ? room.waitingReason : undefined,
      updatedAt: now,
    };
    await dbApi.saveGroupRoom(nextRoom);

    const event: GroupEvent = {
      id: newId(),
      roomId,
      type: status === "paused" ? "room_paused" : "room_resumed",
      payload: { status },
      createdAt: now,
    };
    await dbApi.saveGroupEvent(event);

    const rooms = ensureRoomsState(await dbApi.getGroupRooms());
    set((state) => ({
      groupRooms: rooms,
      groupEvents:
        state.activeGroupRoomId === roomId
          ? [...state.groupEvents, event]
          : state.groupEvents,
    }));
  },

  runActiveGroupIteration: async (personas, settings, userName) => {
    if (get().isOrchestratorTicking) return;
    const roomId = get().activeGroupRoomId;
    if (!roomId) return;
    set({ isOrchestratorTicking: true });

    try {
      const foundRoom = get().groupRooms.find((item) => item.id === roomId);
      if (!foundRoom) return;
      const room = ensureRoomState(foundRoom);
      const tickNow = nowIso();
      const roomAtTickStart: GroupRoom = {
        ...room,
        state: {
          phase: "orchestrating",
          updatedAt: tickNow,
          reason: "tick_started",
        },
        updatedAt: tickNow,
      };
      await dbApi.saveGroupRoom(roomAtTickStart);
      set((state) => ({
        groupRooms: state.groupRooms.map((item) =>
          item.id === roomId ? roomAtTickStart : item,
        ),
      }));

      const participants = get().groupParticipants.filter(
        (participant) => participant.roomId === roomId,
      );
      const messages = get().groupMessages.filter(
        (message) => message.roomId === roomId,
      );
      const events = get().groupEvents.filter((event) => event.roomId === roomId);

      const deterministicDecision = runGroupOrchestratorTick({
        room,
        participants,
        messages,
        events,
        personas,
        settings,
        userName,
      });
      let decision = deterministicDecision;
      let orchestrationSource: "llm" | "deterministic" = "deterministic";
      let llmDecisionStatus: string | undefined;
      const isStrictWaitingLock =
        room.mode === "personas_plus_user" &&
        room.waitingForUser &&
        deterministicDecision.status === "waiting" &&
        deterministicDecision.waitForUser;
      const isDeterministicHardBlock =
        deterministicDecision.status !== "spoke" &&
        [
          "room_not_active",
          "waiting_for_user",
          "no_active_participants",
          "typing_delay",
          "pending_image_generation",
        ].includes(deterministicDecision.reason);

      if (!isStrictWaitingLock && !isDeterministicHardBlock) {
        try {
          const llmDecision = await requestLlmOrchestratorDecision({
            room,
            participants,
            messages,
            events,
            personas,
            settings,
            userName,
          });
          if (llmDecision) {
            llmDecisionStatus = llmDecision.status;
            decision = {
              ...deterministicDecision,
              ...llmDecision,
              debug: {
                ...deterministicDecision.debug,
                llmDecision: llmDecision,
              },
            };
            orchestrationSource = "llm";
          }
        } catch {
          orchestrationSource = "deterministic";
        }
      } else {
        decision = {
          ...deterministicDecision,
          debug: {
            ...deterministicDecision.debug,
            waitingLock: true,
          },
        };
      }

      const forceDeterministicSpeaker =
        deterministicDecision.status === "spoke" &&
        Boolean(deterministicDecision.speakerPersonaId) &&
        (decision.status !== "spoke" || !decision.speakerPersonaId);
      if (forceDeterministicSpeaker) {
        decision = {
          ...deterministicDecision,
          debug: {
            ...deterministicDecision.debug,
            llmDecisionStatus,
            llmOverriddenByDeterministic: true,
          },
        };
        orchestrationSource = "deterministic";
      }

      if (room.mode === "personas_only") {
        const originalStatus = decision.status;
        const normalizedStatus =
          originalStatus === "waiting"
            ? deterministicDecision.status === "spoke" &&
              deterministicDecision.speakerPersonaId
              ? "spoke"
              : "skipped"
            : originalStatus;
        decision = {
          ...decision,
          status: normalizedStatus,
          speakerPersonaId:
            normalizedStatus === "spoke"
              ? decision.speakerPersonaId ||
                deterministicDecision.speakerPersonaId
              : undefined,
          waitForUser: false,
          waitReason: undefined,
          debug: {
            ...decision.debug,
            personasOnlyGuard: true,
            originalStatus,
          },
        };
      }

      const now = nowIso();
      const turnId = newId();
      const tickStartedEvent: GroupEvent = {
        id: newId(),
        roomId,
        turnId,
        type: "orchestrator_tick_started",
        payload: {
          roomMode: room.mode,
          model: settings.model,
          source: orchestrationSource,
          reason: decision.reason,
          status: decision.status,
          debug: decision.debug,
        },
        createdAt: now,
      };
      await dbApi.saveGroupEvent(tickStartedEvent);
      set((state) => ({
        groupEvents:
          state.activeGroupRoomId === roomId
            ? [...state.groupEvents, tickStartedEvent]
            : state.groupEvents,
      }));

      if (
        decision.status !== "spoke" ||
        !decision.speakerPersonaId
      ) {
        const latestRoom = get().groupRooms.find((item) => item.id === roomId) || room;
        const roomIsActive = latestRoom.status === "active";
        const nextRoom: GroupRoom = {
          ...latestRoom,
          state: {
            phase:
              roomIsActive && decision.waitForUser
                ? "waiting_user"
                : latestRoom.status === "paused"
                  ? "paused"
                  : "idle",
            updatedAt: now,
            turnId,
            reason: decision.reason,
          },
          waitingForUser: roomIsActive
            ? decision.waitForUser
            : latestRoom.waitingForUser,
          waitingReason: roomIsActive
            ? decision.waitReason
            : latestRoom.waitingReason,
          lastTickAt: now,
          updatedAt: now,
        };
        await dbApi.saveGroupRoom(nextRoom);

        const waitingEvents: GroupEvent[] = [];
        if (
          roomIsActive &&
          decision.waitForUser &&
          (!latestRoom.waitingForUser ||
            hasWaitingReasonChanged(latestRoom, decision.waitReason))
        ) {
          waitingEvents.push({
            id: newId(),
            roomId,
            turnId,
            type: "room_waiting_user",
            payload: {
              userName,
              reason: decision.waitReason,
            },
            createdAt: nowIso(),
          });
        }
        if (roomIsActive && !decision.waitForUser && latestRoom.waitingForUser) {
          waitingEvents.push({
            id: newId(),
            roomId,
            turnId,
            type: "room_resumed",
            payload: {
              reason: decision.reason || "orchestrator_resumed",
            },
            createdAt: nowIso(),
          });
        }
        if (waitingEvents.length > 0) {
          await dbApi.appendGroupEvents(waitingEvents);
        }

        const rooms = ensureRoomsState(await dbApi.getGroupRooms());
        set((state) => ({
          groupRooms: rooms,
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, ...waitingEvents]
              : state.groupEvents,
        }));
        return;
      }

      const speaker = personas.find(
        (persona) => persona.id === decision.speakerPersonaId,
      );
      if (!speaker) return;

      const participantNames = participants
        .map((participant) => {
          const persona = personas.find(
            (item) => item.id === participant.personaId,
          );
          return persona?.name || "";
        })
        .filter(Boolean);
      const participantNameById = Object.fromEntries(
        participants
          .map((participant) => {
            const persona = personas.find(
              (item) => item.id === participant.personaId,
            );
            if (!persona) return null;
            return [participant.personaId, persona.name];
          })
          .filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) && entry.length === 2,
          ),
      );
      const recentUserName =
        [...messages]
          .reverse()
          .find((message) => message.authorType === "user")
          ?.authorDisplayName?.trim() || "";
      const mentionUserName = recentUserName || userName;
      let speechText = "";
      let speechComfyPrompt: string | undefined;
      let speechComfyPrompts: string[] | undefined;
      let speechComfyImageDescription: string | undefined;
      let speechComfyImageDescriptions: string[] | undefined;
      let speechPersonaControlRaw: string | undefined;
      let speechResponseId: string | undefined;
      let rawSpeechText = "";
      const speechSource: "llm" = "llm";
      const roomForSpeechRequest =
        get().groupRooms.find((item) => item.id === roomId) || room;
      const previousResponseIdForSpeech = roomForSpeechRequest.lastResponseId;
      const generatingRoom: GroupRoom = {
        ...roomForSpeechRequest,
        state: {
          phase: "generating",
          updatedAt: nowIso(),
          turnId,
          speakerPersonaId: speaker.id,
          reason: "speaker_selected",
        },
        updatedAt: nowIso(),
      };
      await dbApi.saveGroupRoom(generatingRoom);
      set((state) => ({
        groupRooms: state.groupRooms.map((item) =>
          item.id === roomId ? generatingRoom : item,
        ),
      }));
      const currentSpeakerState =
        get().groupPersonaStates.find(
          (state) => state.roomId === roomId && state.personaId === speaker.id,
        ) || null;
      try {
        const llmSpeech = await requestLlmPersonaMessage({
          room: roomForSpeechRequest,
          speaker,
          userName: mentionUserName,
          participantNames,
          messages,
          personaState: currentSpeakerState,
          relationEdges: get().groupRelationEdges.filter(
            (edge) =>
              edge.roomId === roomId &&
              edge.fromPersonaId === speaker.id,
          ),
          participantNameById,
          sharedMemories: get().groupSharedMemories
            .filter((memory) => memory.roomId === roomId)
            .slice(-5),
          privateMemories: get().groupPrivateMemories
            .filter(
              (memory) =>
                memory.roomId === roomId && memory.personaId === speaker.id,
            )
            .slice(-5),
          recentEvents: get().groupEvents
            .filter((event) => event.roomId === roomId)
            .slice(-6),
          settings,
          previousResponseId: previousResponseIdForSpeech,
        });
        rawSpeechText = llmSpeech.visibleText.trim();
        speechText = normalizePersonaSpeechMentions(
          rawSpeechText,
          speaker.id,
          personas,
          mentionUserName,
        );
        speechText = ensureReplyMentionFallback(
          speechText,
          room.mode,
          messages,
          speaker.id,
          personas,
          mentionUserName,
        );
        speechResponseId = llmSpeech.responseId;
        speechComfyPrompt = llmSpeech.comfyPrompt;
        speechComfyPrompts = llmSpeech.comfyPrompts;
        speechComfyImageDescription = llmSpeech.comfyImageDescription;
        speechComfyImageDescriptions = llmSpeech.comfyImageDescriptions;
        speechPersonaControlRaw = llmSpeech.personaControl
          ? JSON.stringify(llmSpeech.personaControl)
          : undefined;
      } catch (error) {
        const blockedEvent: GroupEvent = {
          id: newId(),
          roomId,
          turnId,
          type: "orchestrator_invariant_blocked",
          payload: {
            speakerPersonaId: speaker.id,
            reason: "llm_generation_failed",
            error: error instanceof Error ? error.message : "unknown_error",
          },
          createdAt: nowIso(),
        };
        const erroredRoom: GroupRoom = {
          ...generatingRoom,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            turnId,
            speakerPersonaId: speaker.id,
            reason: "llm_generation_failed",
            error:
              error instanceof Error ? error.message : "unknown_error",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupEvent(blockedEvent);
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, blockedEvent]
              : state.groupEvents,
        }));
        return;
      }
      if (!speechText) {
        const blockedEvent: GroupEvent = {
          id: newId(),
          roomId,
          turnId,
          type: "orchestrator_invariant_blocked",
          payload: {
            speakerPersonaId: speaker.id,
            reason: "empty_llm_speech",
          },
          createdAt: nowIso(),
        };
        const erroredRoom: GroupRoom = {
          ...generatingRoom,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            turnId,
            speakerPersonaId: speaker.id,
            reason: "empty_llm_speech",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupEvent(blockedEvent);
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, blockedEvent]
              : state.groupEvents,
        }));
        return;
      }
      const rawValidation = validatePersonaSpeaksOnlyForSelf(
        speaker,
        rawSpeechText || speechText,
        personas,
      );
      if (!rawValidation.valid) {
        const blockedEvent: GroupEvent = {
          id: newId(),
          roomId,
          turnId,
          type: "orchestrator_invariant_blocked",
          payload: {
            speakerPersonaId: speaker.id,
            reason: rawValidation.reason || "invalid_raw_speaker_pattern",
            messagePreview: (rawSpeechText || speechText).slice(0, 180),
          },
          createdAt: nowIso(),
        };
        const erroredRoom: GroupRoom = {
          ...generatingRoom,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            turnId,
            speakerPersonaId: speaker.id,
            reason: rawValidation.reason || "invalid_raw_speaker_pattern",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupEvent(blockedEvent);
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, blockedEvent]
              : state.groupEvents,
        }));
        return;
      }
      const lastSpeakerMessage = [...messages]
        .filter(
          (message) =>
            message.roomId === roomId &&
            message.authorType === "persona" &&
            message.authorPersonaId === speaker.id,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (
        lastSpeakerMessage &&
        normalizeMessageForDedup(lastSpeakerMessage.content) ===
          normalizeMessageForDedup(speechText)
      ) {
        const blockedEvent: GroupEvent = {
          id: newId(),
          roomId,
          turnId,
          type: "orchestrator_invariant_blocked",
          payload: {
            speakerPersonaId: speaker.id,
            reason: "duplicate_llm_speech",
            messagePreview: speechText.slice(0, 180),
          },
          createdAt: nowIso(),
        };
        const erroredRoom: GroupRoom = {
          ...generatingRoom,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            turnId,
            speakerPersonaId: speaker.id,
            reason: "duplicate_llm_speech",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupEvent(blockedEvent);
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, blockedEvent]
              : state.groupEvents,
        }));
        return;
      }

      const validation = validatePersonaSpeaksOnlyForSelf(
        speaker,
        speechText,
        personas,
      );
      if (!validation.valid) {
        const blockedEvent: GroupEvent = {
          id: newId(),
          roomId,
          turnId,
          type: "orchestrator_invariant_blocked",
          payload: {
            speakerPersonaId: speaker.id,
            reason: validation.reason || "unknown",
            messagePreview: speechText.slice(0, 180),
          },
          createdAt: nowIso(),
        };
        const erroredRoom: GroupRoom = {
          ...generatingRoom,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            turnId,
            speakerPersonaId: speaker.id,
            reason: validation.reason || "unknown",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupEvent(blockedEvent);
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          groupEvents:
            state.activeGroupRoomId === roomId
              ? [...state.groupEvents, blockedEvent]
              : state.groupEvents,
        }));
        return;
      }

      const speakerSelectedEvent: GroupEvent = {
        id: newId(),
        roomId,
        turnId,
        type: "speaker_selected",
        payload: {
          personaId: speaker.id,
          personaName: speaker.name,
        },
        createdAt: nowIso(),
      };
      await dbApi.saveGroupEvent(speakerSelectedEvent);
      set((state) => ({
        groupEvents:
          state.activeGroupRoomId === roomId
            ? [...state.groupEvents, speakerSelectedEvent]
            : state.groupEvents,
      }));
      const committingRoom: GroupRoom = {
        ...generatingRoom,
        state: {
          phase: "committing",
          updatedAt: nowIso(),
          turnId,
          speakerPersonaId: speaker.id,
          reason: "speaker_selected",
        },
        updatedAt: nowIso(),
      };
      await dbApi.saveGroupRoom(committingRoom);
      set((state) => ({
        groupRooms: state.groupRooms.map((item) =>
          item.id === roomId ? committingRoom : item,
        ),
      }));

      const comfyPromptBlocks =
        speechComfyPrompts ??
        (speechComfyPrompt ? [speechComfyPrompt] : []);
      const imageDescriptionBlocks =
        speechComfyImageDescriptions ??
        (speechComfyImageDescription ? [speechComfyImageDescription] : []);
      const requestedImageCount =
        imageDescriptionBlocks.length > 0
          ? imageDescriptionBlocks.length
          : comfyPromptBlocks.length;

      const personaMessage = await get().savePersonaGroupMessage(
        roomId,
        speaker,
        speechText,
        personas,
        mentionUserName,
        turnId,
        {
          comfyPrompt: speechComfyPrompt,
          comfyPrompts: speechComfyPrompts,
          comfyImageDescription: speechComfyImageDescription,
          comfyImageDescriptions: speechComfyImageDescriptions,
          personaControlRaw: speechPersonaControlRaw,
          imageGenerationPending: requestedImageCount > 0,
          imageGenerationExpected:
            requestedImageCount > 0 ? requestedImageCount : undefined,
          imageGenerationCompleted:
            requestedImageCount > 0 ? 0 : undefined,
        },
      );
      if (!personaMessage) return;

      const participantUpdateNow = nowIso();
      const updatedParticipants = participants.map((participant) => {
        if (participant.personaId === speaker.id) {
          return {
            ...participant,
            aliveScore: clamp(participant.aliveScore - 2),
            muteUntil: new Date(
              Date.now() + Math.max(0, participant.talkCooldownMs || 0),
            ).toISOString(),
            updatedAt: participantUpdateNow,
          };
        }
        const dormantBoost = participant.aliveScore < 40 ? 2 : 1;
        return {
          ...participant,
          aliveScore: clamp(participant.aliveScore + dormantBoost),
          updatedAt: participantUpdateNow,
        };
      });
      await dbApi.saveGroupParticipants(updatedParticipants);

      const mentionPersonaIds = Array.from(
        new Set(
          (parseMentions(speechText, personas, mentionUserName) || [])
            .filter((mention) => mention.targetType === "persona")
            .map((mention) => mention.targetId),
        ),
      );
      if (requestedImageCount > 0) {
        void (async () => {
          let messageRef: GroupMessage = personaMessage;
          const patchMessage = async (patch: Partial<GroupMessage>) => {
            messageRef = {
              ...messageRef,
              ...patch,
            };
            await dbApi.saveGroupMessage(messageRef);
            set((state) => ({
              groupMessages: state.groupMessages.map((message) =>
                message.id === messageRef.id ? messageRef : message,
              ),
            }));
          };
          const appendImageEvent = async (payload: Record<string, unknown>) => {
            const imageEvent: GroupEvent = {
              id: newId(),
              roomId,
              turnId,
              type: "message_image_generated",
              payload,
              createdAt: nowIso(),
            };
            await dbApi.saveGroupEvent(imageEvent);
            set((state) => ({
              groupEvents:
                state.activeGroupRoomId === roomId
                  ? [...state.groupEvents, imageEvent]
                  : state.groupEvents,
            }));
          };

          const styleReferenceImage =
            speaker.avatarUrl.trim() || speaker.fullBodyUrl.trim() || undefined;
          const chatStyleStrength = settings.chatStyleStrength;
          const initialPromptBlocks = comfyPromptBlocks
            .map((value) => value.trim())
            .filter(Boolean);
          let promptsForGeneration = [...initialPromptBlocks];
          let expectedGenerationCount = requestedImageCount;

          try {
            if (imageDescriptionBlocks.length > 0) {
              const generatedPrompts = await Promise.all(
                imageDescriptionBlocks.map((description, index) =>
                  generateComfyPromptFromImageDescription(
                    settings,
                    speaker,
                    description,
                    index + 1,
                  ),
                ),
              );
              promptsForGeneration = generatedPrompts
                .map((value) => value.trim())
                .filter(Boolean);
              expectedGenerationCount = promptsForGeneration.length;
              await patchMessage({
                comfyPrompt: promptsForGeneration[0],
                comfyPrompts:
                  promptsForGeneration.length > 0
                    ? promptsForGeneration
                    : undefined,
                imageGenerationPending: promptsForGeneration.length > 0,
                imageGenerationExpected:
                  promptsForGeneration.length > 0
                    ? promptsForGeneration.length
                    : undefined,
                imageGenerationCompleted: 0,
              });
            }
          } catch {
            await patchMessage({
              imageGenerationPending: false,
              imageGenerationExpected: requestedImageCount,
              imageGenerationCompleted: 0,
            });
            await appendImageEvent({
              messageId: messageRef.id,
              personaId: speaker.id,
              status: "prompt_generation_failed",
              expected: requestedImageCount,
              completed: 0,
            });
            return;
          }

          if (promptsForGeneration.length === 0) {
            await patchMessage({
              imageGenerationPending: false,
              imageGenerationExpected: requestedImageCount,
              imageGenerationCompleted: 0,
            });
            await appendImageEvent({
              messageId: messageRef.id,
              personaId: speaker.id,
              status: "no_prompts",
              expected: requestedImageCount,
              completed: 0,
            });
            return;
          }

          const comfyItems = promptsForGeneration.map((prompt) => ({
            flow: "base" as const,
            prompt,
            checkpointName: speaker.imageCheckpoint || undefined,
            seed: randomSeed(),
            styleReferenceImage,
            styleStrength: styleReferenceImage ? chatStyleStrength : undefined,
            compositionStrength: 0,
            saveComfyOutputs: settings.saveComfyOutputs,
          }));

          const aggregatedAttachments: NonNullable<GroupMessage["imageAttachments"]> = [];
          const aggregatedMetaByUrl: Record<string, ImageGenerationMeta> = {};
          let completedCount = 0;

          try {
            await generateComfyImages(
              comfyItems,
              settings.comfyBaseUrl,
              settings.comfyAuth,
              async (promptImageUrls, index) => {
                completedCount += 1;
                const localizedChunk = await localizeImageUrls(promptImageUrls);
                const item = comfyItems[index];
                const extractedMeta =
                  promptImageUrls[0]
                    ? await readComfyImageGenerationMeta(
                        promptImageUrls[0],
                        settings.comfyBaseUrl,
                        settings.comfyAuth,
                      )
                    : null;
                const meta: ImageGenerationMeta = {
                  seed: extractedMeta?.seed ?? item.seed,
                  prompt: extractedMeta?.prompt ?? item.prompt,
                  model: extractedMeta?.model ?? item.checkpointName,
                  flow: extractedMeta?.flow ?? item.flow,
                };

                for (const localized of localizedChunk) {
                  if (
                    !aggregatedAttachments.some(
                      (attachment) => attachment.url === localized,
                    )
                  ) {
                    aggregatedAttachments.push({
                      url: localized,
                      meta,
                    });
                  }
                  aggregatedMetaByUrl[localized] = meta;
                }
                for (const original of promptImageUrls) {
                  if (original?.trim()) {
                    aggregatedMetaByUrl[original] = meta;
                  }
                }

                await patchMessage({
                  imageAttachments: [...aggregatedAttachments],
                  imageMetaByUrl: { ...aggregatedMetaByUrl },
                  imageGenerationPending:
                    completedCount < expectedGenerationCount,
                  imageGenerationExpected: expectedGenerationCount,
                  imageGenerationCompleted: completedCount,
                });
                await appendImageEvent({
                  messageId: messageRef.id,
                  personaId: speaker.id,
                  status:
                    completedCount >= expectedGenerationCount
                      ? "completed"
                      : "progress",
                  expected: expectedGenerationCount,
                  completed: completedCount,
                  generatedCount: localizedChunk.length,
                });
              },
            );
            await patchMessage({
              imageAttachments: [...aggregatedAttachments],
              imageMetaByUrl: { ...aggregatedMetaByUrl },
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: expectedGenerationCount,
            });
          } catch {
            await patchMessage({
              imageGenerationPending: false,
              imageGenerationExpected: expectedGenerationCount,
              imageGenerationCompleted: completedCount,
            });
            await appendImageEvent({
              messageId: messageRef.id,
              personaId: speaker.id,
              status: "generation_failed",
              expected: expectedGenerationCount,
              completed: completedCount,
            });
          }
        })();
      }
      const speechNow = nowIso();
      const speechMemory: GroupMemoryPrivate = {
        id: newId(),
        roomId,
        personaId: speaker.id,
        layer: "short_term",
        kind: "event",
        content: speechText.slice(0, 240),
        salience: 52,
        createdAt: speechNow,
        updatedAt: speechNow,
      };
      const privateMemoriesInRoom = get().groupPrivateMemories.filter(
        (memory) => memory.roomId === roomId,
      );
      const privateReconcile = reconcilePrivateGroupMemories(
        [...privateMemoriesInRoom, speechMemory],
        speechNow,
      );
      await dbApi.saveGroupPrivateMemories(privateReconcile.kept);
      if (privateReconcile.removedIds.length > 0) {
        await dbApi.deleteGroupPrivateMemories(privateReconcile.removedIds);
      }
      const persistedPrivateMemory =
        privateReconcile.kept.find((memory) => memory.id === speechMemory.id) ||
        speechMemory;

      const speechSharedMemory: GroupMemoryShared | null =
        speechText.length >= 80 || mentionPersonaIds.length > 0
          ? {
              id: newId(),
              roomId,
              layer: "short_term",
              kind: "event",
              content: `${speaker.name}: ${speechText.slice(0, 220)}`,
              salience: mentionPersonaIds.length > 0 ? 58 : 50,
              createdAt: speechNow,
              updatedAt: speechNow,
            }
          : null;
      const sharedMemoriesInRoom = get().groupSharedMemories.filter(
        (memory) => memory.roomId === roomId,
      );
      const sharedReconcile = reconcileSharedGroupMemories(
        speechSharedMemory
          ? [...sharedMemoriesInRoom, speechSharedMemory]
          : sharedMemoriesInRoom,
        speechNow,
      );
      await dbApi.saveGroupSharedMemories(sharedReconcile.kept);
      if (sharedReconcile.removedIds.length > 0) {
        await dbApi.deleteGroupSharedMemories(sharedReconcile.removedIds);
      }

      const memoryPrivateWrittenEvent: GroupEvent = {
        id: newId(),
        roomId,
        turnId,
        type: "memory_private_written",
        payload: {
          personaId: speaker.id,
          layer: persistedPrivateMemory.layer,
          kind: persistedPrivateMemory.kind,
          salience: persistedPrivateMemory.salience,
          removedCount: privateReconcile.removedIds.length,
        },
        createdAt: speechNow,
      };
      const persistedSharedMemory = speechSharedMemory
        ? sharedReconcile.kept.find((memory) => memory.id === speechSharedMemory.id)
        : null;

      const currentStates = get().groupPersonaStates.filter(
        (state) => state.roomId === roomId,
      );
      const updatedStates = currentStates.map((state) => {
        if (state.personaId === speaker.id) {
          return {
            ...state,
            energy: clamp(state.energy - 2),
            engagement: clamp(state.engagement + 3),
            initiative: clamp(state.initiative + 1),
            aliveScore: clamp(state.aliveScore + 1),
            updatedAt: nowIso(),
          };
        }
        return {
          ...state,
          engagement: clamp(state.engagement + 1),
          updatedAt: nowIso(),
        };
      });
      if (updatedStates.length > 0) {
        await dbApi.saveGroupPersonaStates(updatedStates);
      }

      const currentEdges = get().groupRelationEdges.filter(
        (edge) => edge.roomId === roomId,
      );
      const relationDynamics = applyGroupRelationDynamics({
        edges: currentEdges,
        speakerPersonaId: speaker.id,
        mentionedPersonaIds: mentionPersonaIds,
        speechText,
        nowIso: speechNow,
      });
      const updatedEdges = relationDynamics.updatedEdges;
      if (updatedEdges.length > 0) {
        await dbApi.saveGroupRelationEdges(updatedEdges);
      }
      const relationChanges = relationDynamics.changes;

      const postEvents: GroupEvent[] = [
        {
          id: newId(),
          roomId,
          turnId,
          type: "persona_spoke",
          payload: {
            personaId: speaker.id,
            messagePreview: speechText.slice(0, 180),
            source: speechSource,
            previousResponseId: previousResponseIdForSpeech,
            responseId: speechResponseId,
          },
          createdAt: nowIso(),
        },
        memoryPrivateWrittenEvent,
      ];
      if (requestedImageCount > 0) {
        postEvents.push({
          id: newId(),
          roomId,
          turnId,
          type: "message_image_requested",
          payload: {
            messageId: personaMessage.id,
            personaId: speaker.id,
            expected: requestedImageCount,
            fromDescriptions: imageDescriptionBlocks.length > 0,
          },
          createdAt: nowIso(),
        });
      }
      if (persistedSharedMemory) {
        postEvents.push({
          id: newId(),
          roomId,
          turnId,
          type: "memory_shared_written",
          payload: {
            layer: persistedSharedMemory.layer,
            kind: persistedSharedMemory.kind,
            salience: persistedSharedMemory.salience,
            source: "persona_spoke",
            removedCount: sharedReconcile.removedIds.length,
          },
          createdAt: speechNow,
        });
      }
      if (relationChanges.length > 0) {
        postEvents.push({
          id: newId(),
          roomId,
          turnId,
          type: "relation_changed",
          payload: {
            count: relationChanges.length,
            changes: relationChanges.slice(0, 6),
          },
          createdAt: nowIso(),
        });
      }
      const latestRoomBeforeFinalize =
        get().groupRooms.find((item) => item.id === roomId) || room;
      const roomIsStillActive = latestRoomBeforeFinalize.status === "active";
      if (roomIsStillActive && decision.waitForUser) {
        if (
          !latestRoomBeforeFinalize.waitingForUser ||
          hasWaitingReasonChanged(latestRoomBeforeFinalize, decision.waitReason)
        ) {
          postEvents.push({
            id: newId(),
            roomId,
            turnId,
            type: "room_waiting_user",
            payload: {
              userName,
              reason: decision.waitReason,
            },
            createdAt: nowIso(),
          });
        }
      } else if (roomIsStillActive && latestRoomBeforeFinalize.waitingForUser) {
        postEvents.push({
          id: newId(),
          roomId,
          turnId,
          type: "room_resumed",
          payload: {
            reason: "orchestrator_resumed",
          },
          createdAt: nowIso(),
        });
      }
      await dbApi.appendGroupEvents(postEvents);

      const nextRoom: GroupRoom = {
        ...latestRoomBeforeFinalize,
        state: {
          phase:
            roomIsStillActive && decision.waitForUser
              ? "waiting_user"
              : latestRoomBeforeFinalize.status === "paused"
                ? "paused"
                : "idle",
          updatedAt: nowIso(),
          turnId,
          speakerPersonaId: speaker.id,
          reason: decision.reason,
        },
        waitingForUser: roomIsStillActive
          ? decision.waitForUser
          : latestRoomBeforeFinalize.waitingForUser,
        waitingReason: roomIsStillActive
          ? decision.waitReason
          : latestRoomBeforeFinalize.waitingReason,
        lastResponseId: speechResponseId || latestRoomBeforeFinalize.lastResponseId,
        lastTickAt: nowIso(),
        updatedAt: nowIso(),
      };
      await dbApi.saveGroupRoom(nextRoom);

      const rooms = ensureRoomsState(await dbApi.getGroupRooms());
      set((state) => ({
        groupRooms: rooms,
        groupEvents:
          state.activeGroupRoomId === roomId
            ? [...state.groupEvents, ...postEvents]
            : state.groupEvents,
        groupParticipants:
          state.activeGroupRoomId === roomId
            ? updatedParticipants
            : state.groupParticipants,
        groupSharedMemories:
          state.activeGroupRoomId === roomId
            ? sharedReconcile.kept
            : state.groupSharedMemories,
        groupPrivateMemories:
          state.activeGroupRoomId === roomId
            ? privateReconcile.kept
            : state.groupPrivateMemories,
        groupPersonaStates:
          state.activeGroupRoomId === roomId
            ? updatedStates
            : state.groupPersonaStates,
        groupRelationEdges:
          state.activeGroupRoomId === roomId
            ? updatedEdges
            : state.groupRelationEdges,
      }));
    } catch (error) {
      const room = get().groupRooms.find((item) => item.id === roomId);
      if (room) {
        const erroredRoom: GroupRoom = {
          ...room,
          state: {
            phase: "error",
            updatedAt: nowIso(),
            reason: "tick_exception",
            error: error instanceof Error ? error.message : "unknown_error",
          },
          updatedAt: nowIso(),
        };
        await dbApi.saveGroupRoom(erroredRoom);
        set((state) => ({
          groupRooms: state.groupRooms.map((item) =>
            item.id === roomId ? erroredRoom : item,
          ),
          error: error instanceof Error ? error.message : "unknown_error",
        }));
      } else {
        set({ error: (error as Error).message });
      }
    } finally {
      set({ isOrchestratorTicking: false });
    }
  },
}));
