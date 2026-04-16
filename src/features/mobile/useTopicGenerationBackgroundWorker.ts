import { useEffect, useRef } from "react";
import type { GeneratorSession, Persona } from "../../types";
import type { TopicGenerationStepResult } from "../generator/useTopicGenerator";
import { dbApi } from "../../db";
import {
  cancelBackgroundJob,
  ensureRecurringBackgroundJob,
} from "./backgroundJobs";
import {
  buildTopicGenerationJobId,
  TOPIC_GENERATION_JOB_ID_PREFIX,
  TOPIC_GENERATION_JOB_TYPE,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";
import { updateForegroundWorkerStatus } from "./foregroundService";
import { setBackgroundDesiredState } from "./backgroundRuntime";

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

interface UseTopicGenerationBackgroundWorkerParams {
  isAndroidRuntime: boolean;
  androidNativeTopicGenerationV1: boolean;
  generationSession: GeneratorSession | null;
  runGenerationStep: () => Promise<TopicGenerationStepResult>;
  syncGenerationSessionsFromDb?: (preferredSessionId?: string | null) => Promise<void> | void;
  onError?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasEntityId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function readStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function castStoreRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows as unknown as T[];
}

function parseIsoMs(value: string | undefined) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function shouldApplyIncomingSession(params: {
  current: GeneratorSession | undefined;
  incoming: GeneratorSession;
}) {
  const { current, incoming } = params;
  if (!current) return true;
  const currentUpdatedAtMs = parseIsoMs(current.updatedAt);
  const incomingUpdatedAtMs = parseIsoMs(incoming.updatedAt);
  if (
    currentUpdatedAtMs !== null &&
    incomingUpdatedAtMs !== null &&
    incomingUpdatedAtMs < currentUpdatedAtMs
  ) {
    return false;
  }
  if (current.status !== "running" && incoming.status === "running") {
    if (
      currentUpdatedAtMs !== null &&
      incomingUpdatedAtMs !== null &&
      incomingUpdatedAtMs <= currentUpdatedAtMs
    ) {
      return false;
    }
  }
  return true;
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
}

function parseIdbImageAssetId(value: string | undefined | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

function collectPersonaImageAssetIds(personas: Persona[]) {
  const ids = new Set<string>();
  const addDirectId = (value: string | undefined | null) => {
    const normalized = typeof value === "string" ? value.trim() : "";
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

async function syncTopicGenerationContextToNative(sessionId: string) {
  const scope = globalThis as unknown as CapacitorLikeScope;
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) return;

  const [settings, personas, generatorSessions] = await Promise.all([
    dbApi.getSettings(),
    dbApi.getPersonas(),
    dbApi.getAllGeneratorSessions(),
  ]);
  const activeSession = generatorSessions.find((session) => session.id === sessionId) ?? null;
  const personasForImageSync =
    activeSession !== null
      ? personas.filter((persona) => persona.id === activeSession.personaId)
      : personas;
  const imageAssetIds = collectPersonaImageAssetIds(personasForImageSync);
  const imageAssets =
    imageAssetIds.length > 0 ? await dbApi.getImageAssets(imageAssetIds) : [];

  const response = await plugin.request({
    method: "PUT",
    path: "/api/raw-snapshot",
    body: {
      mode: "merge",
      stores: {
        settings,
        personas,
        generatorSessions,
        imageAssets,
      },
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`native_context_sync_http_${response.status}`);
  }

  if (isRecord(response.body) && response.body.ok === false) {
    const error = typeof response.body.error === "string" ? response.body.error : "";
    throw new Error(error || "native_context_sync_failed");
  }

  const hasSession = generatorSessions.some((session) => session.id === sessionId);
  if (!hasSession) {
    throw new Error("native_context_sync_session_missing");
  }
}

export function useTopicGenerationBackgroundWorker({
  isAndroidRuntime,
  androidNativeTopicGenerationV1,
  generationSession,
  runGenerationStep: _runGenerationStep,
  syncGenerationSessionsFromDb,
  onError: _onError,
}: UseTopicGenerationBackgroundWorkerParams) {
  const topicGenerationJobIdRef = useRef<string | null>(null);
  const lastNativePullAtRef = useRef<number>(0);
  const pullInFlightRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isAndroidRuntime || !androidNativeTopicGenerationV1) {
      const previousJobId = topicGenerationJobIdRef.current;
      topicGenerationJobIdRef.current = null;
      if (previousJobId) {
        void cancelBackgroundJob(previousJobId).catch(() => {
          // Ignore queue mutation errors while switching runtimes.
        });
      }
      const previousSessionId = previousJobId?.startsWith(TOPIC_GENERATION_JOB_ID_PREFIX)
        ? previousJobId.slice(TOPIC_GENERATION_JOB_ID_PREFIX.length).trim()
        : "";
      if (previousSessionId) {
        void setBackgroundDesiredState({
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeId: previousSessionId,
          enabled: false,
          payload: {
            sessionId: previousSessionId,
            delayMs: 0,
          },
        }).catch(() => {
          // Ignore desired-state cleanup errors while switching execution mode.
        });
      }
      if (isAndroidRuntime && generationSession) {
        void updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: generationSession.status === "running" ? "running" : "idle",
          scopeId: generationSession.id,
          detail: "web_delegate",
        }).catch(() => {
          // Ignore status bridge failures.
        });
      }
      topicGenerationJobIdRef.current = null;
      return;
    }

    const nextJobId = generationSession
      ? buildTopicGenerationJobId(generationSession.id)
      : null;
    const previousJobId = topicGenerationJobIdRef.current;
    topicGenerationJobIdRef.current = nextJobId;

    if (previousJobId && previousJobId !== nextJobId) {
      void cancelBackgroundJob(previousJobId).catch(() => {
        // Ignore queue mutation errors while switching sessions.
      });
      const previousSessionId = previousJobId.startsWith(TOPIC_GENERATION_JOB_ID_PREFIX)
        ? previousJobId.slice(TOPIC_GENERATION_JOB_ID_PREFIX.length).trim()
        : "";
      if (previousSessionId) {
        void setBackgroundDesiredState({
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeId: previousSessionId,
          enabled: false,
          payload: {
            sessionId: previousSessionId,
            delayMs: 0,
          },
        }).catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : "desired_state_sync_failed";
          pushSystemLog({
            level: "warn",
            eventType: "topic_generation.desired_state_sync_failed",
            message: "Failed to disable desired-state for previous topic session",
            details: {
              sessionId: previousSessionId,
              error: errorMessage,
            },
          });
        });
      }
    }

    const pullNativeTopicContextIntoWeb = (
      preferredSessionId: string | null,
      reason: string,
    ) => {
      if (!isAndroidRuntime || !androidNativeTopicGenerationV1) return;
      if (pullInFlightRef.current) return;
      const now = Date.now();
      const minPullIntervalMs = reason === "session_not_running" ? 800 : 4_500;
      if (now - lastNativePullAtRef.current < minPullIntervalMs) return;
      const plugin = resolveLocalApiPlugin(globalThis as unknown as CapacitorLikeScope);
      if (!plugin) return;

      pullInFlightRef.current = true;
      lastNativePullAtRef.current = now;

      void (async () => {
        try {
          const response = await plugin.request({
            method: "GET",
            path: "/api/raw-snapshot?stores=generatorSessions",
          });
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`native_topic_context_pull_http_${response.status}`);
          }

          const body = isRecord(response.body) ? response.body : {};
          const stores = isRecord(body.stores) ? body.stores : {};
          const existingSessions = await dbApi.getAllGeneratorSessions();
          const existingSessionById = new Map(
            existingSessions.map((session) => [session.id, session]),
          );

          const sessions = castStoreRows<GeneratorSession>(
            readStoreRows(stores, "generatorSessions").filter(hasEntityId),
          );
          let appliedAnySession = false;
          for (const session of sessions) {
            const current = existingSessionById.get(session.id);
            if (!shouldApplyIncomingSession({ current, incoming: session })) {
              continue;
            }
            await dbApi.saveGeneratorSession(session);
            existingSessionById.set(session.id, session);
            appliedAnySession = true;
          }

          if (appliedAnySession) {
            await syncGenerationSessionsFromDb?.(preferredSessionId);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "native_topic_context_pull_failed";
          pushSystemLog({
            level: "warn",
            eventType: "topic_generation.native_context_pull_failed",
            message: "Failed to pull topic generation context into web storage",
            details: {
              sessionId: preferredSessionId,
              reason,
              error: errorMessage,
            },
          });
        } finally {
          pullInFlightRef.current = false;
        }
      })();
    };

    if (!generationSession) {
      pullNativeTopicContextIntoWeb(null, "no_session");
      void updateForegroundWorkerStatus({
        worker: "topic_generation",
        state: "idle",
        scopeId: "",
        detail: "no_session",
      }).catch(() => {
        // Ignore status bridge failures.
      });
      return;
    }

    const sessionId = generationSession.id;
    const delayMs = Math.max(0, Math.floor((generationSession.delaySeconds || 0) * 1000));
    const sessionCanRun = generationSession.status === "running";

    const syncNativeTopicJob = async () => {
      if (!sessionCanRun) {
        void setBackgroundDesiredState({
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeId: sessionId,
          enabled: false,
          payload: {
            sessionId,
            delayMs,
          },
        }).catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : "desired_state_sync_failed";
          pushSystemLog({
            level: "warn",
            eventType: "topic_generation.desired_state_sync_failed",
            message: "Failed to disable topic desired-state",
            details: {
              sessionId,
              error: errorMessage,
            },
          });
        });
        try {
          await cancelBackgroundJob(nextJobId ?? buildTopicGenerationJobId(sessionId));
        } catch {
          // Ignore queue mutation errors when session is not running.
        }
        void updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: "idle",
          scopeId: sessionId,
          detail: `session_${generationSession.status}`,
        }).catch(() => {
          // Ignore status bridge failures.
        });
        try {
          await syncTopicGenerationContextToNative(sessionId);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "native_context_sync_failed";
          pushSystemLog({
            level: "warn",
            eventType: "topic_generation.native_context_sync_failed",
            message: "Failed to sync stopped topic session to native store",
            details: {
              sessionId,
              error: errorMessage,
            },
          });
        }
        pullNativeTopicContextIntoWeb(sessionId, "session_not_running");
        return;
      }

      try {
        await setBackgroundDesiredState({
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeId: sessionId,
          enabled: true,
          payload: {
            sessionId,
            delayMs,
          },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "desired_state_sync_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.desired_state_sync_failed",
          message: "Failed to enable topic desired-state",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      }

      try {
        await syncTopicGenerationContextToNative(sessionId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "native_context_sync_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.native_context_sync_failed",
          message: "Failed to sync topic generation context to native store",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
        void updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: "blocked",
          scopeId: sessionId,
          detail: "native_context_sync_failed",
          lastError: errorMessage,
        }).catch(() => {
          // Ignore status bridge failures.
        });
        return;
      }

      try {
        await ensureRecurringBackgroundJob({
          id: nextJobId ?? buildTopicGenerationJobId(sessionId),
          type: TOPIC_GENERATION_JOB_TYPE,
          payload: {
            sessionId,
            delayMs,
          },
          runAtMs: Date.now(),
          maxAttempts: 0,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "background_job_ensure_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.ensure_failed",
          message: "Failed to ensure recurring topic generation job (native delegate)",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
        void updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: "blocked",
          scopeId: sessionId,
          detail: "queue_ensure_failed",
          lastError: errorMessage,
        }).catch(() => {
          // Ignore status bridge failures.
        });
        return;
      }

      void updateForegroundWorkerStatus({
        worker: "topic_generation",
        state: "running",
        scopeId: sessionId,
        detail: "native_delegate",
      }).catch(() => {
        // Ignore status bridge failures.
      });
      pullNativeTopicContextIntoWeb(sessionId, "native_delegate_ready");
    };

    void syncNativeTopicJob();
  }, [
    androidNativeTopicGenerationV1,
    generationSession?.delaySeconds,
    generationSession?.id,
    generationSession?.status,
    isAndroidRuntime,
    syncGenerationSessionsFromDb,
  ]);
}
