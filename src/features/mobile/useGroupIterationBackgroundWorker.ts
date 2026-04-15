import { useEffect, useRef } from "react";
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
} from "../../types";
import { dbApi } from "../../db";
import {
  cancelBackgroundJob,
  ensureRecurringBackgroundJob,
  rescheduleBackgroundJob,
} from "./backgroundJobs";
import { subscribeBackgroundTick } from "./backgroundTick";
import { subscribeGroupIterationRunRequest } from "./groupIterationRunRequest";
import {
  buildGroupIterationJobId,
  GROUP_ITERATION_INTERVAL_MS,
  GROUP_ITERATION_JOB_TYPE,
  GROUP_ITERATION_MIN_TRIGGER_GAP_MS,
  GROUP_ITERATION_RETRY_DELAY_MS,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";
import { updateForegroundWorkerStatus } from "./foregroundService";
import {
  appendBackgroundRuntimeEvent,
  setBackgroundDesiredState,
} from "./backgroundRuntime";

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

interface UseGroupIterationBackgroundWorkerParams {
  activeGroupRoom: GroupRoom | null;
  isAndroidRuntime: boolean;
  androidNativeGroupIterationV1: boolean;
  personas: Persona[];
  settings: AppSettings;
  syncGroupStateFromDb: (preferredRoomId?: string | null) => Promise<void>;
  runActiveGroupIteration: (
    personas: Persona[],
    settings: AppSettings,
    userName: string,
  ) => Promise<void> | void;
}

type GroupIterationExecutionMode =
  | "web_interval"
  | "android_bridge_legacy"
  | "android_bridge_v1";

function resolveGroupIterationExecutionMode(
  isAndroidRuntime: boolean,
  androidNativeGroupIterationV1: boolean,
): GroupIterationExecutionMode {
  if (!isAndroidRuntime) return "web_interval";
  return androidNativeGroupIterationV1
    ? "android_bridge_v1"
    : "android_bridge_legacy";
}

function canRunRoom(room: GroupRoom | null) {
  if (!room) return false;
  if (room.status !== "active") return false;
  if (room.mode === "personas_plus_user" && room.waitingForUser) return false;
  return true;
}

function shouldEnableDesiredState(room: GroupRoom | null) {
  if (!room) return false;
  return room.status === "active";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasEntityId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function hasRoomRef(value: unknown): value is { roomId: string } {
  return isRecord(value) && typeof value.roomId === "string" && value.roomId.trim().length > 0;
}

function matchesRoom(value: unknown, roomId: string | null) {
  if (!hasRoomRef(value)) return false;
  return roomId ? value.roomId.trim() === roomId : true;
}

function readStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function castStoreRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows as unknown as T[];
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
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

  const response = await plugin.request({
    method: "PUT",
    path: "/api/raw-snapshot",
    body: {
      mode: "merge",
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
      },
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`native_group_context_sync_http_${response.status}`);
  }

  if (isRecord(response.body) && response.body.ok === false) {
    const error = typeof response.body.error === "string" ? response.body.error : "";
    throw new Error(error || "native_group_context_sync_failed");
  }
}

export function useGroupIterationBackgroundWorker({
  activeGroupRoom,
  isAndroidRuntime,
  androidNativeGroupIterationV1,
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
  const desiredStateFingerprintRef = useRef<string>("");
  const desiredStatePendingFingerprintRef = useRef<string>("");
  const lastNativeSyncAtRef = useRef<number>(0);
  const lastNativePullAtRef = useRef<number>(0);
  const syncInFlightRef = useRef<boolean>(false);
  const pullInFlightRef = useRef<boolean>(false);
  const executionModeLogFingerprintRef = useRef<string>("");

  useEffect(() => {
    const previousRoomId = previousRoomIdRef.current;
    const nextRoomId = activeGroupRoom?.id ?? null;
    const executionMode = resolveGroupIterationExecutionMode(
      isAndroidRuntime,
      androidNativeGroupIterationV1,
    );
    previousRoomIdRef.current = nextRoomId;
    const executionModeScopeId = nextRoomId ?? "none";
    const executionModeFingerprint = `${executionModeScopeId}|${executionMode}`;
    if (executionModeLogFingerprintRef.current !== executionModeFingerprint) {
      executionModeLogFingerprintRef.current = executionModeFingerprint;
      pushSystemLog({
        level: "info",
        eventType: "group_iteration.execution_mode",
        message: `Group iteration mode: ${executionMode}`,
        details: {
          roomId: nextRoomId,
          executionMode,
          androidNativeGroupIterationV1,
        },
      });
      if (isAndroidRuntime && nextRoomId) {
        void appendBackgroundRuntimeEvent({
          taskType: GROUP_ITERATION_JOB_TYPE,
          scopeId: nextRoomId,
          stage: "worker_mode_selected",
          level: "info",
          message: "Group iteration execution mode selected",
          details: {
            executionMode,
            androidNativeGroupIterationV1,
          },
        }).catch(() => {
          // Ignore runtime event logging errors.
        });
      }
    }

    const syncDesiredState = (roomId: string, enabled: boolean) => {
      if (!isAndroidRuntime) return;
      const fingerprint = `${roomId}|${enabled ? "1" : "0"}`;
      if (desiredStateFingerprintRef.current === fingerprint) return;
      if (desiredStatePendingFingerprintRef.current === fingerprint) return;
      desiredStatePendingFingerprintRef.current = fingerprint;
      void setBackgroundDesiredState({
        taskType: GROUP_ITERATION_JOB_TYPE,
        scopeId: roomId,
        enabled,
        payload: {
          roomId,
          intervalMs: GROUP_ITERATION_INTERVAL_MS,
        },
      })
        .then(() => {
          desiredStateFingerprintRef.current = fingerprint;
        })
        .catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : "desired_state_sync_failed";
          pushSystemLog({
            level: "warn",
            eventType: "group_iteration.desired_state_sync_failed",
            message: "Failed to sync desired-state for group iteration",
            details: {
              roomId,
              enabled,
              error: errorMessage,
            },
          });
        })
        .finally(() => {
          if (desiredStatePendingFingerprintRef.current === fingerprint) {
            desiredStatePendingFingerprintRef.current = "";
          }
        });
    };

    const pullNativeContextIntoWeb = (roomId: string | null, reason: string) => {
      if (!isAndroidRuntime || !androidNativeGroupIterationV1) return;
      if (pullInFlightRef.current) return;
      const now = Date.now();
      if (now - lastNativePullAtRef.current < 1_500) return;
      const plugin = resolveLocalApiPlugin(globalThis as unknown as CapacitorLikeScope);
      if (!plugin) return;

      pullInFlightRef.current = true;
      lastNativePullAtRef.current = now;

      void (async () => {
        try {
          const response = await plugin.request({
            method: "GET",
            path: "/api/raw-snapshot",
          });
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`native_group_context_pull_http_${response.status}`);
          }
          const body = isRecord(response.body) ? response.body : {};
          const stores = isRecord(body.stores) ? body.stores : {};

          const rooms = castStoreRows<GroupRoom>(
            readStoreRows(stores, "groupRooms").filter(hasEntityId),
          );
          for (const room of rooms) {
            await dbApi.saveGroupRoom(room);
          }

          const participants = castStoreRows<GroupParticipant>(
            readStoreRows(stores, "groupParticipants").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (participants.length > 0) {
            await dbApi.saveGroupParticipants(participants);
          }

          const messages = castStoreRows<GroupMessage>(
            readStoreRows(stores, "groupMessages").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          for (const message of messages) {
            await dbApi.saveGroupMessage(message);
          }

          const events = castStoreRows<GroupEvent>(
            readStoreRows(stores, "groupEvents").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (events.length > 0) {
            await dbApi.appendGroupEvents(events);
          }

          const personaStates = castStoreRows<GroupPersonaState>(
            readStoreRows(stores, "groupPersonaStates").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (personaStates.length > 0) {
            await dbApi.saveGroupPersonaStates(personaStates);
          }

          const relationEdges = castStoreRows<GroupRelationEdge>(
            readStoreRows(stores, "groupRelationEdges").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (relationEdges.length > 0) {
            await dbApi.saveGroupRelationEdges(relationEdges);
          }

          const sharedMemories = castStoreRows<GroupMemoryShared>(
            readStoreRows(stores, "groupSharedMemories").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (sharedMemories.length > 0) {
            await dbApi.saveGroupSharedMemories(sharedMemories);
          }

          const privateMemories = castStoreRows<GroupMemoryPrivate>(
            readStoreRows(stores, "groupPrivateMemories").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          if (privateMemories.length > 0) {
            await dbApi.saveGroupPrivateMemories(privateMemories);
          }

          const snapshots = castStoreRows<GroupSnapshot>(
            readStoreRows(stores, "groupSnapshots").filter(
              (row): row is Record<string, unknown> => hasEntityId(row) && matchesRoom(row, roomId),
            ),
          );
          for (const snapshot of snapshots) {
            await dbApi.saveGroupSnapshot(snapshot);
          }

          await syncGroupStateFromDb(roomId);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "native_group_context_pull_failed";
          pushSystemLog({
            level: "warn",
            eventType: "group_iteration.native_context_pull_failed",
            message: "Failed to pull native group context into web storage",
            details: {
              roomId,
              reason,
              error: errorMessage,
            },
          });
        } finally {
          pullInFlightRef.current = false;
        }
      })();
    };

    if (isAndroidRuntime && previousRoomId && previousRoomId !== nextRoomId) {
      syncDesiredState(previousRoomId, false);
      void cancelBackgroundJob(buildGroupIterationJobId(previousRoomId)).catch(() => {
        // Ignore queue mutation errors while switching rooms.
      });
    }

    if (!activeGroupRoom) {
      if (isAndroidRuntime) {
        pullNativeContextIntoWeb(null, "no_active_room");
        if (previousRoomId) {
          syncDesiredState(previousRoomId, false);
          void cancelBackgroundJob(buildGroupIterationJobId(previousRoomId)).catch(() => {
            // Ignore queue mutation errors while clearing active room.
          });
        }
        void updateForegroundWorkerStatus({
          worker: "group_iteration",
          state: "idle",
          scopeId: "",
          detail: "no_active_room",
        }).catch(() => {
          // Ignore status bridge failures.
        });
      }
      return;
    }
    const roomId = activeGroupRoom.id;
    const jobId = buildGroupIterationJobId(roomId);
    syncDesiredState(roomId, shouldEnableDesiredState(activeGroupRoom));
    if (isAndroidRuntime) {
      const now = Date.now();
      if (!syncInFlightRef.current && now - lastNativeSyncAtRef.current > 2_000) {
        syncInFlightRef.current = true;
        void syncGroupContextToNative(roomId)
          .then(() => {
            lastNativeSyncAtRef.current = Date.now();
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : "native_group_context_sync_failed";
            pushSystemLog({
              level: "warn",
              eventType: "group_iteration.native_context_sync_failed",
              message: "Failed to sync group context to native store",
              details: {
                roomId,
                error: errorMessage,
              },
            });
          })
          .finally(() => {
            syncInFlightRef.current = false;
          });
      }
      pullNativeContextIntoWeb(roomId, "effect_enter");
    }
    let lastStatusFingerprint = "";
    let lastStatusAt = 0;

    const reportWorkerStatus = (params: {
      state: "idle" | "running" | "blocked" | "error";
      detail: string;
      claimed?: boolean;
      progress?: boolean;
      lastError?: string;
    }) => {
      const scopeId = activeGroupRoomRef.current?.id ?? roomId;
      const fingerprint = [
        params.state,
        params.detail,
        params.claimed ? "1" : "0",
        params.progress ? "1" : "0",
        params.lastError || "",
        scopeId,
      ].join("|");
      const now = Date.now();
      if (
        fingerprint === lastStatusFingerprint &&
        now - lastStatusAt < GROUP_ITERATION_MIN_TRIGGER_GAP_MS
      ) {
        return;
      }
      lastStatusFingerprint = fingerprint;
      lastStatusAt = now;
      void updateForegroundWorkerStatus({
        worker: "group_iteration",
        state: params.state,
        scopeId,
        detail: params.detail,
        claimed: params.claimed,
        progress: params.progress,
        lastError: params.lastError,
      }).catch(() => {
        // Ignore status bridge failures.
      });
    };

    if (!isAndroidRuntime) {
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
            error instanceof Error ? error.message : "group_iteration_failed";
          pushSystemLog({
            level: "warn",
            eventType: "group_iteration.web_failed",
            message: `Group iteration failed for room ${roomId}`,
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

    let disposed = false;
    let iterationInFlight = false;
    let ensureInFlight = false;

    const ensureNativeQueueJob = async () => {
      if (disposed || ensureInFlight) return;
      const currentRoom = activeGroupRoomRef.current;
      if (!currentRoom || currentRoom.id !== roomId || !canRunRoom(currentRoom)) {
        return;
      }
      ensureInFlight = true;
      try {
        await ensureRecurringBackgroundJob({
          id: jobId,
          type: GROUP_ITERATION_JOB_TYPE,
          payload: {
            roomId,
            intervalMs: GROUP_ITERATION_INTERVAL_MS,
          },
          runAtMs: Date.now(),
          maxAttempts: 0,
        });
        reportWorkerStatus({
          state: "running",
          detail: "native_queue_ready",
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "background_job_ensure_failed";
        reportWorkerStatus({
          state: "blocked",
          detail: "native_queue_ensure_failed",
          lastError: errorMessage,
        });
        pushSystemLog({
          level: "warn",
          eventType: "group_iteration.ensure_failed",
          message: "Failed to ensure native-dispatched group iteration job",
          details: {
            roomId,
            executionMode,
            error: errorMessage,
          },
        });
      } finally {
        ensureInFlight = false;
      }
    };

    void ensureNativeQueueJob();

    const unsubscribeRunRequest = subscribeGroupIterationRunRequest((payload) => {
      if (disposed) return;
      if (payload.roomId !== roomId) return;
      if (!payload.jobId) return;
      const nextRunAtMs = Date.now() + Math.max(1_000, payload.intervalMs);

      const currentRoom = activeGroupRoomRef.current;
      const roomCanRun =
        currentRoom !== null &&
        currentRoom.id === roomId &&
        canRunRoom(currentRoom);
      if (!roomCanRun) {
        void rescheduleBackgroundJob({
          id: payload.jobId,
          runAtMs: nextRunAtMs,
          incrementAttempts: false,
        }).catch(() => {
          // Ignore queue mutation errors during room transitions.
        });
        void appendBackgroundRuntimeEvent({
          taskType: GROUP_ITERATION_JOB_TYPE,
          scopeId: roomId,
          jobId: payload.jobId,
          stage: "iteration_deferred",
          level: "info",
          message: "Deferred group iteration because room is blocked",
          details: {
            reason: "room_blocked",
            intervalMs: payload.intervalMs,
            executionMode,
          },
        }).catch(() => {
          // Ignore runtime event logging errors.
        });
        reportWorkerStatus({
          state: "idle",
          detail: "room_blocked",
        });
        return;
      }

      if (!syncInFlightRef.current && Date.now() - lastNativeSyncAtRef.current > 2_000) {
        syncInFlightRef.current = true;
        void syncGroupContextToNative(roomId)
          .then(() => {
            lastNativeSyncAtRef.current = Date.now();
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : "native_group_context_sync_failed";
            pushSystemLog({
              level: "warn",
              eventType: "group_iteration.native_context_sync_failed",
              message: "Failed to sync group context to native store",
              details: {
                roomId,
                error: errorMessage,
              },
            });
          })
          .finally(() => {
            syncInFlightRef.current = false;
          });
      }

      if (iterationInFlight) {
        void rescheduleBackgroundJob({
          id: payload.jobId,
          runAtMs: Date.now() + 1_200,
          incrementAttempts: false,
        }).catch(() => {
          // Ignore queue mutation errors while current iteration is still in-flight.
        });
        void appendBackgroundRuntimeEvent({
          taskType: GROUP_ITERATION_JOB_TYPE,
          scopeId: roomId,
          jobId: payload.jobId,
          stage: "iteration_deferred",
          level: "info",
          message: "Deferred group iteration because previous iteration is still running",
          details: {
            reason: "bridge_busy",
            executionMode,
          },
        }).catch(() => {
          // Ignore runtime event logging errors.
        });
        reportWorkerStatus({
          state: "running",
          detail: "bridge_busy",
        });
        return;
      }

      iterationInFlight = true;
      reportWorkerStatus({
        state: "running",
        detail: `claimed_${payload.jobId.slice(0, 8)}`,
        claimed: true,
      });

      void (async () => {
        try {
          const currentPersonas = personasRef.current;
          const currentSettings = settingsRef.current;
          await runActiveGroupIterationRef.current(
            currentPersonas,
            currentSettings,
            currentSettings.userName,
          );
          await rescheduleBackgroundJob({
            id: payload.jobId,
            runAtMs: nextRunAtMs,
            incrementAttempts: false,
          });
          void appendBackgroundRuntimeEvent({
            taskType: GROUP_ITERATION_JOB_TYPE,
            scopeId: roomId,
            jobId: payload.jobId,
            stage: "iteration_completed",
            level: "info",
            message: "Group iteration completed in background",
            details: {
              intervalMs: payload.intervalMs,
              requestedAtMs: payload.requestedAtMs,
              executionMode,
            },
          }).catch(() => {
            // Ignore runtime event logging errors.
          });
          reportWorkerStatus({
            state: "running",
            detail: `progress_${payload.jobId.slice(0, 8)}`,
            progress: true,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "group_iteration_failed";
          reportWorkerStatus({
            state: "error",
            detail: `job_failed_${payload.jobId.slice(0, 8)}`,
            lastError: errorMessage,
          });
          pushSystemLog({
            level: "warn",
            eventType: "group_iteration.job_failed",
            message: `Group iteration job failed for room ${roomId}`,
            details: {
              roomId,
              jobId: payload.jobId,
              executionMode,
              error: errorMessage,
            },
          });
          void appendBackgroundRuntimeEvent({
            taskType: GROUP_ITERATION_JOB_TYPE,
            scopeId: roomId,
            jobId: payload.jobId,
            stage: "iteration_failed",
            level: "error",
            message: "Group iteration failed in background",
            details: {
              executionMode,
              error: errorMessage,
            },
          }).catch(() => {
            // Ignore runtime event logging errors.
          });
          try {
            await rescheduleBackgroundJob({
              id: payload.jobId,
              runAtMs: Date.now() + GROUP_ITERATION_RETRY_DELAY_MS,
              incrementAttempts: true,
              lastError: errorMessage,
            });
          } catch {
            // Ignore queue mutation errors; native dispatcher will retry after lease expiry.
          }
        } finally {
          iterationInFlight = false;
        }
      })();
    });

    const unsubscribeBackgroundTick = subscribeBackgroundTick((payload) => {
      if (!payload.enabled || !payload.running) return;
      const currentRoom = activeGroupRoomRef.current;
      if (currentRoom && currentRoom.id === roomId) {
        syncDesiredState(roomId, shouldEnableDesiredState(currentRoom));
        pullNativeContextIntoWeb(roomId, "background_tick");
      }
      void ensureNativeQueueJob();
    });

    return () => {
      disposed = true;
      unsubscribeRunRequest();
      unsubscribeBackgroundTick();
      reportWorkerStatus({
        state: "idle",
        detail: "worker_disposed",
      });
    };
  }, [
    activeGroupRoom?.id,
    activeGroupRoom?.status,
    isAndroidRuntime,
    androidNativeGroupIterationV1,
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
