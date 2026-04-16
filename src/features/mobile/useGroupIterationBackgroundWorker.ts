import { useEffect, useRef } from 'react';
import type {
  AppSettings,
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  GroupSnapshot,
  Persona,
} from '../../types';
import { dbApi } from '../../db';
import { cancelBackgroundJob, ensureRecurringBackgroundJob } from './backgroundJobs';
import {
  buildGroupIterationJobId,
  GROUP_ITERATION_INTERVAL_MS,
  GROUP_ITERATION_JOB_TYPE,
} from './backgroundJobKeys';
import { pushSystemLog } from '../system-logs/systemLogStore';
import { updateForegroundWorkerStatus } from './foregroundService';
import { setBackgroundDesiredState } from './backgroundRuntime';
import {
  ackBackgroundDelta,
  getBackgroundDelta,
  triggerBackgroundRuntime,
} from './backgroundDelta';

interface LocalApiPluginRequestInput {
  method: 'GET' | 'PUT';
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

interface UseGroupIterationBackgroundWorkerParams {
  activeGroupRoom: GroupRoom | null;
  isAndroidRuntime: boolean;
  personas: Persona[];
  settings: AppSettings;
  syncGroupStateFromDb: (preferredRoomId?: string | null) => Promise<void>;
  runActiveGroupIteration: (
    personas: Persona[],
    settings: AppSettings,
    userName: string,
  ) => Promise<void> | void;
}

const GROUP_DELTA_SINCE_ID_KEY = 'tg_gf_group_delta_since_id_v2';
const GROUP_DELTA_POLL_MS = 1400;
const GROUP_CONTEXT_SYNC_THROTTLE_MS = 2_000;

function canRunRoom(room: GroupRoom | null) {
  if (!room) return false;
  if (room.status !== 'active') return false;
  if (room.mode === 'personas_plus_user' && room.waitingForUser) return false;
  return true;
}

function shouldEnableDesiredState(room: GroupRoom | null) {
  if (!room) return false;
  return room.status === 'active';
}

function parseIsoMs(value: string | undefined) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function shouldApplyIncomingRoomUpdate(params: {
  current: GroupRoom | undefined;
  incoming: GroupRoom;
}) {
  const { current, incoming } = params;
  if (!current) return true;
  if (current.status === 'paused' && incoming.status === 'active') {
    return false;
  }
  const currentUpdatedAtMs = parseIsoMs(current.updatedAt);
  const incomingUpdatedAtMs = parseIsoMs(incoming.updatedAt);
  if (
    currentUpdatedAtMs !== null &&
    incomingUpdatedAtMs !== null &&
    incomingUpdatedAtMs < currentUpdatedAtMs
  ) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasEntityId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0;
}

function hasRoomRef(value: unknown): value is { roomId: string } {
  return isRecord(value) && typeof value.roomId === 'string' && value.roomId.trim().length > 0;
}

function matchesRoom(value: unknown, roomId: string | null) {
  if (!hasRoomRef(value)) return false;
  return roomId ? value.roomId.trim() === roomId : true;
}

function normalizeStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== 'function') return null;
  return plugin;
}

function parseIdbImageAssetId(value: string | undefined | null) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized.startsWith('idb://')) return '';
  return normalized.slice('idb://'.length).trim();
}

function collectPersonaImageAssetIds(personas: Persona[]) {
  const ids = new Set<string>();
  const addDirectId = (value: string | undefined | null) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) ids.add(normalized);
  };
  const addFromUrl = (value: string | undefined | null) => {
    const id = parseIdbImageAssetId(value);
    if (id) ids.add(id);
  };

  for (const persona of personas) {
    addDirectId(persona.avatarImageId);
    addDirectId(persona.fullBodyImageId);
    addDirectId(persona.fullBodySideImageId);
    addDirectId(persona.fullBodyBackImageId);
    addFromUrl(persona.avatarUrl);
    addFromUrl(persona.fullBodyUrl);
    addFromUrl(persona.fullBodySideUrl);
    addFromUrl(persona.fullBodyBackUrl);
  }

  return Array.from(ids);
}

function getStoredSinceId() {
  const raw = globalThis.localStorage?.getItem(GROUP_DELTA_SINCE_ID_KEY) ?? '';
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function setStoredSinceId(value: number) {
  globalThis.localStorage?.setItem(
    GROUP_DELTA_SINCE_ID_KEY,
    String(Math.max(0, Math.floor(value))),
  );
}

async function syncGroupContextToNative(roomId: string) {
  const scope = globalThis as unknown as CapacitorLikeScope;
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) return;

  const [
    settings,
    personas,
    groupRooms,
    groupParticipants,
    groupMessages,
    groupEvents,
    groupPersonaStates,
    groupRelationEdges,
    groupSharedMemories,
    groupPrivateMemories,
    groupSnapshots,
  ] = await Promise.all([
    dbApi.getSettings(),
    dbApi.getPersonas(),
    dbApi.getGroupRooms(),
    dbApi.getGroupParticipants(roomId),
    dbApi.getGroupMessages(roomId),
    dbApi.getGroupEvents(roomId),
    dbApi.getGroupPersonaStates(roomId),
    dbApi.getGroupRelationEdges(roomId),
    dbApi.getGroupSharedMemories(roomId),
    dbApi.getGroupPrivateMemories(roomId),
    dbApi.getGroupSnapshots(roomId),
  ]);

  const participantPersonaIds = new Set(
    groupParticipants
      .map((participant) => participant.personaId.trim())
      .filter(Boolean),
  );
  const personasForImageSync =
    participantPersonaIds.size > 0
      ? personas.filter((persona) => participantPersonaIds.has(persona.id.trim()))
      : personas;
  const imageAssetIds = collectPersonaImageAssetIds(personasForImageSync);
  const imageAssets =
    imageAssetIds.length > 0 ? await dbApi.getImageAssets(imageAssetIds) : [];

  const response = await plugin.request({
    method: 'PUT',
    path: '/api/background-runtime/context',
    body: {
      mode: 'merge',
      stores: {
        settings,
        personas,
        groupRooms,
        groupParticipants,
        groupMessages,
        groupEvents,
        groupPersonaStates,
        groupRelationEdges,
        groupSharedMemories,
        groupPrivateMemories,
        groupSnapshots,
        imageAssets,
      },
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error('native_group_context_sync_http_' + response.status);
  }
}

async function applyGroupStatePatch(
  stores: Record<string, unknown>,
  preferredRoomId: string | null,
  syncGroupStateFromDb: (preferredRoomId?: string | null) => Promise<void>,
) {
  let touched = false;

  const existingRooms = await dbApi.getGroupRooms();
  const existingRoomById = new Map(existingRooms.map((room) => [room.id, room]));
  const rooms = normalizeStoreRows(stores, 'groupRooms').filter(hasEntityId) as unknown as GroupRoom[];
  for (const room of rooms) {
    const current = existingRoomById.get(room.id);
    if (!shouldApplyIncomingRoomUpdate({ current, incoming: room })) continue;
    await dbApi.saveGroupRoom(room);
    existingRoomById.set(room.id, room);
    touched = true;
  }

  const participants = normalizeStoreRows(stores, 'groupParticipants').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupParticipant[];
  if (participants.length > 0) {
    await dbApi.saveGroupParticipants(participants);
    touched = true;
  }

  const messages = normalizeStoreRows(stores, 'groupMessages').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupMessage[];
  for (const message of messages) {
    await dbApi.saveGroupMessage(message);
    touched = true;
  }

  const events = normalizeStoreRows(stores, 'groupEvents').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupEvent[];
  if (events.length > 0) {
    await dbApi.appendGroupEvents(events);
    touched = true;
  }

  const personaStates = normalizeStoreRows(stores, 'groupPersonaStates').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupPersonaState[];
  if (personaStates.length > 0) {
    await dbApi.saveGroupPersonaStates(personaStates);
    touched = true;
  }

  const relationEdges = normalizeStoreRows(stores, 'groupRelationEdges').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupRelationEdge[];
  if (relationEdges.length > 0) {
    await dbApi.saveGroupRelationEdges(relationEdges);
    touched = true;
  }

  const sharedMemories = normalizeStoreRows(stores, 'groupSharedMemories').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupMemoryShared[];
  if (sharedMemories.length > 0) {
    await dbApi.saveGroupSharedMemories(sharedMemories);
    touched = true;
  }

  const privateMemories = normalizeStoreRows(stores, 'groupPrivateMemories').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupMemoryPrivate[];
  if (privateMemories.length > 0) {
    await dbApi.saveGroupPrivateMemories(privateMemories);
    touched = true;
  }

  const snapshots = normalizeStoreRows(stores, 'groupSnapshots').filter(
    (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, preferredRoomId),
  ) as unknown as GroupSnapshot[];
  for (const snapshot of snapshots) {
    await dbApi.saveGroupSnapshot(snapshot);
    touched = true;
  }

  if (touched) {
    await syncGroupStateFromDb(preferredRoomId);
  }
}

export function useGroupIterationBackgroundWorker({
  activeGroupRoom,
  isAndroidRuntime,
  personas,
  settings,
  syncGroupStateFromDb,
  runActiveGroupIteration,
}: UseGroupIterationBackgroundWorkerParams) {
  const activeGroupRoomRef = useEffectRef(activeGroupRoom);
  const personasRef = useEffectRef(personas);
  const settingsRef = useEffectRef(settings);
  const runActiveGroupIterationRef = useEffectRef(runActiveGroupIteration);
  const previousRoomIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const visibleRef = useRef<boolean>(typeof document === 'undefined' ? true : !document.hidden);
  const syncInFlightRef = useRef<boolean>(false);
  const lastNativeSyncAtRef = useRef<number>(0);

  useEffect(() => {
    const onVisibilityChange = () => {
      visibleRef.current = !document.hidden;
      if (visibleRef.current) {
        void triggerBackgroundRuntime('group_visibility');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!isAndroidRuntime) return;
    if (!activeGroupRoom) return;
    const roomId = activeGroupRoom.id;
    const now = Date.now();
    if (syncInFlightRef.current) return;
    if (now - lastNativeSyncAtRef.current <= GROUP_CONTEXT_SYNC_THROTTLE_MS) return;
    syncInFlightRef.current = true;
    void syncGroupContextToNative(roomId)
      .then(() => {
        lastNativeSyncAtRef.current = Date.now();
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : 'native_group_context_sync_failed';
        pushSystemLog({
          level: 'warn',
          eventType: 'group_iteration.native_context_sync_failed',
          message: 'Failed to sync group context to native store',
          details: {
            roomId,
            error: errorMessage,
          },
        });
      })
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, [
    activeGroupRoom?.id,
    activeGroupRoom?.updatedAt,
    isAndroidRuntime,
    personas,
    settings,
  ]);

  useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!isAndroidRuntime) {
      const roomId = activeGroupRoom?.id ?? null;
      previousRoomIdRef.current = roomId;
      if (!activeGroupRoom) return;
      let disposed = false;
      let iterationInFlight = false;
      const runWebIteration = async () => {
        if (disposed || iterationInFlight) return;
        const currentRoom = activeGroupRoomRef.current;
        if (!currentRoom || currentRoom.id !== roomId || !canRunRoom(currentRoom)) {
          return;
        }
        iterationInFlight = true;
        try {
          const currentPersonas = personasRef.current;
          const currentSettings = settingsRef.current;
          await runActiveGroupIterationRef.current(
            currentPersonas,
            currentSettings,
            currentSettings.userName,
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'group_iteration_failed';
          pushSystemLog({
            level: 'warn',
            eventType: 'group_iteration.web_failed',
            message: 'Group iteration failed for room ' + roomId,
            details: {
              roomId,
              error: errorMessage,
            },
          });
        } finally {
          iterationInFlight = false;
        }
      };

      void runWebIteration();
      const timerId = window.setInterval(() => {
        void runWebIteration();
      }, GROUP_ITERATION_INTERVAL_MS);

      return () => {
        disposed = true;
        window.clearInterval(timerId);
      };
    }

    const pullGroupDeltaIntoWeb = async (reason: string) => {
      if (pollInFlightRef.current) return;
      if (!visibleRef.current) return;
      pollInFlightRef.current = true;
      try {
        const preferredRoomId = activeGroupRoomRef.current?.id ?? null;
        const sinceId = getStoredSinceId();
        const response = await getBackgroundDelta({
          sinceId,
          limit: 300,
          taskType: GROUP_ITERATION_JOB_TYPE,
          scopeIds: preferredRoomId ? [preferredRoomId] : [],
          includeGlobal: true,
        });
        if (response.items.length === 0) {
          return;
        }

        let maxAppliedId = sinceId;
        for (const item of response.items) {
          if (item.kind === 'state_patch' && isRecord(item.payload) && isRecord(item.payload.stores)) {
            await applyGroupStatePatch(item.payload.stores, preferredRoomId, syncGroupStateFromDb);
          }
          if (item.id > maxAppliedId) {
            maxAppliedId = item.id;
          }
        }
        if (maxAppliedId > sinceId) {
          await ackBackgroundDelta({
            ackedUpToId: maxAppliedId,
            taskType: GROUP_ITERATION_JOB_TYPE,
          });
          setStoredSinceId(maxAppliedId);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'native_group_delta_pull_failed';
        pushSystemLog({
          level: 'warn',
          eventType: 'group_iteration.native_delta_pull_failed',
          message: 'Failed to pull group delta into web storage',
          details: {
            reason,
            roomId: activeGroupRoomRef.current?.id ?? null,
            error: errorMessage,
          },
        });
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const syncDesiredStateAndJob = async () => {
      const nextRoomId = activeGroupRoom?.id ?? null;
      const previousRoomId = previousRoomIdRef.current;
      previousRoomIdRef.current = nextRoomId;

      if (previousRoomId && previousRoomId !== nextRoomId) {
        await setBackgroundDesiredState({
          taskType: GROUP_ITERATION_JOB_TYPE,
          scopeId: previousRoomId,
          enabled: false,
          payload: {
            roomId: previousRoomId,
            intervalMs: GROUP_ITERATION_INTERVAL_MS,
          },
        }).catch(() => {});
        await cancelBackgroundJob(buildGroupIterationJobId(previousRoomId)).catch(() => {});
      }

      if (!activeGroupRoom) {
        await updateForegroundWorkerStatus({
          worker: 'group_iteration',
          state: 'idle',
          scopeId: '',
          detail: 'no_active_room',
        }).catch(() => {});
        await triggerBackgroundRuntime('group_no_room').catch(() => {});
        return;
      }

      const roomId = activeGroupRoom.id;
      const roomCanRun = shouldEnableDesiredState(activeGroupRoom);
      await setBackgroundDesiredState({
        taskType: GROUP_ITERATION_JOB_TYPE,
        scopeId: roomId,
        enabled: roomCanRun,
        payload: {
          roomId,
          intervalMs: GROUP_ITERATION_INTERVAL_MS,
        },
      }).catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : 'desired_state_sync_failed';
        pushSystemLog({
          level: 'warn',
          eventType: 'group_iteration.desired_state_sync_failed',
          message: 'Failed to sync desired-state for group iteration',
          details: {
            roomId,
            enabled: roomCanRun,
            error: errorMessage,
          },
        });
      });

      if (!roomCanRun) {
        await cancelBackgroundJob(buildGroupIterationJobId(roomId)).catch(() => {});
        await updateForegroundWorkerStatus({
          worker: 'group_iteration',
          state: 'idle',
          scopeId: roomId,
          detail: 'room_' + activeGroupRoom.status,
        }).catch(() => {});
        await triggerBackgroundRuntime('group_disable').catch(() => {});
        return;
      }

      await ensureRecurringBackgroundJob({
        id: buildGroupIterationJobId(roomId),
        type: GROUP_ITERATION_JOB_TYPE,
        payload: {
          roomId,
          intervalMs: GROUP_ITERATION_INTERVAL_MS,
        },
        runAtMs: Date.now(),
        maxAttempts: 0,
      }).catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : 'background_job_ensure_failed';
        pushSystemLog({
          level: 'warn',
          eventType: 'group_iteration.ensure_failed',
          message: 'Failed to ensure native group iteration job',
          details: {
            roomId,
            error: errorMessage,
          },
        });
      });
      await updateForegroundWorkerStatus({
        worker: 'group_iteration',
        state: 'running',
        scopeId: roomId,
        detail: 'native_delegate',
      }).catch(() => {});
      await triggerBackgroundRuntime('group_enable').catch(() => {});
    };

    void syncDesiredStateAndJob().finally(() => {
      void pullGroupDeltaIntoWeb('effect_enter');
      pollTimerRef.current = window.setInterval(() => {
        if (!visibleRef.current) return;
        void pullGroupDeltaIntoWeb('poll');
      }, GROUP_DELTA_POLL_MS);
    });

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [
    activeGroupRoom?.id,
    activeGroupRoom?.status,
    isAndroidRuntime,
    syncGroupStateFromDb,
  ]);
}

function useEffectRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
