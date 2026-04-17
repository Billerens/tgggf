import { useEffect, useRef } from "react";
import type { GeneratorSession, ImageAsset, Persona } from "../../types";
import type { TopicGenerationStepResult } from "../generator/useTopicGenerator";
import { dbApi } from "../../db";
import { cancelBackgroundJob, ensureRecurringBackgroundJob } from "./backgroundJobs";
import {
  buildTopicGenerationJobId,
  TOPIC_GENERATION_JOB_ID_PREFIX,
  TOPIC_GENERATION_JOB_TYPE,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";
import { updateForegroundWorkerStatus } from "./foregroundService";
import { setBackgroundDesiredState } from "./backgroundRuntime";
import {
  ackBackgroundDelta,
  getBackgroundImageAssets,
  getBackgroundDelta,
  triggerBackgroundRuntime,
} from "./backgroundDelta";

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
  generationSession: GeneratorSession | null;
  runGenerationStep: () => Promise<TopicGenerationStepResult>;
  syncGenerationSessionsFromDb?: (preferredSessionId?: string | null) => Promise<void> | void;
  onError?: (message: string) => void;
}

const TOPIC_DELTA_SINCE_ID_KEY = "tg_gf_topic_delta_since_id_v2";
const TOPIC_DELTA_POLL_MS = 1400;
const COMFY_SEED_MAX = 1_125_899_906_842_624;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasEntityId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
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

function collectIdbAssetIdsFromValue(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    const id = parseIdbImageAssetId(value);
    if (id) out.add(id);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectIdbAssetIdsFromValue(item, out);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "imageId" && typeof nested === "string" && nested.trim()) {
      out.add(nested.trim());
    }
    collectIdbAssetIdsFromValue(nested, out);
  }
}

function collectTopicPatchAssetIds(payload: unknown) {
  const ids = new Set<string>();
  if (!isRecord(payload)) return [] as string[];
  if (Array.isArray(payload.assetIds)) {
    for (const value of payload.assetIds) {
      if (typeof value !== "string") continue;
      const normalized = value.trim();
      if (normalized) ids.add(normalized);
    }
  }
  if (isRecord(payload.stores)) {
    collectIdbAssetIdsFromValue(payload.stores, ids);
  }
  return Array.from(ids);
}

async function hydrateMissingImageAssetsByIds(assetIds: string[]) {
  const normalizedIds = Array.from(new Set(assetIds.map((value) => value.trim()).filter(Boolean)));
  if (normalizedIds.length === 0) return;
  const existing = await dbApi.getImageAssets(normalizedIds);
  const existingIds = new Set(existing.map((asset) => asset.id));
  const missing = normalizedIds.filter((id) => !existingIds.has(id));
  if (missing.length === 0) return;
  const chunkSize = 60;
  for (let start = 0; start < missing.length; start += chunkSize) {
    const chunk = missing.slice(start, start + chunkSize);
    const response = await getBackgroundImageAssets({
      ids: chunk,
      limit: chunk.length,
    });
    for (const item of response.items) {
      await dbApi.saveImageAsset(item);
    }
  }
}

function getStoredSinceId() {
  const raw = globalThis.localStorage?.getItem(TOPIC_DELTA_SINCE_ID_KEY) ?? "";
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function setStoredSinceId(value: number) {
  globalThis.localStorage?.setItem(
    TOPIC_DELTA_SINCE_ID_KEY,
    String(Math.max(0, Math.floor(value))),
  );
}

function normalizeStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function normalizeGeneratorSessionStatus(
  value: unknown,
): GeneratorSession["status"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === "running" ||
    normalized === "stopped" ||
    normalized === "completed" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return null;
}

function normalizeGeneratorPromptMode(
  value: unknown,
): GeneratorSession["promptMode"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "theme_llm" || normalized === "direct_prompt") {
    return normalized;
  }
  return null;
}

function normalizeComfySeedValue(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    return Math.max(1, Math.min(COMFY_SEED_MAX, Math.floor(value)));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.max(1, Math.min(COMFY_SEED_MAX, Math.floor(parsed)));
  }
  return null;
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
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
    path: "/api/background-runtime/context",
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
}

async function applyTopicStatePatch(
  stores: Record<string, unknown>,
  preferredSessionId: string | null,
  syncGenerationSessionsFromDb?: (preferredSessionId?: string | null) => Promise<void> | void,
) {
  const existingSessions = await dbApi.getAllGeneratorSessions();
  const existingSessionById = new Map(existingSessions.map((session) => [session.id, session]));
  let appliedAnySession = false;

  const sessionPatches = normalizeStoreRows(stores, "generatorSessionPatches").filter(
    hasEntityId,
  );
  for (const patchRow of sessionPatches) {
    const patch = patchRow as Record<string, unknown>;
    const patchId = patchRow.id.trim();
    const current = existingSessionById.get(patchId);
    if (!current) {
      continue;
    }

    const next: GeneratorSession = {
      ...current,
      entries: Array.isArray(current.entries) ? [...current.entries] : [],
    };
    let changed = false;

    const nextStatus = normalizeGeneratorSessionStatus(patch.status);
    if (nextStatus && nextStatus !== next.status) {
      next.status = nextStatus;
      changed = true;
    }

    const nextCompletedCount = toFiniteInt(patch.completedCount);
    if (
      nextCompletedCount !== null &&
      nextCompletedCount >= 0 &&
      nextCompletedCount !== next.completedCount
    ) {
      next.completedCount = nextCompletedCount;
      changed = true;
    }

    if (typeof patch.updatedAt === "string" && patch.updatedAt.trim()) {
      const normalizedUpdatedAt = patch.updatedAt.trim();
      if (normalizedUpdatedAt !== next.updatedAt) {
        next.updatedAt = normalizedUpdatedAt;
        changed = true;
      }
    }

    const nextPromptMode = normalizeGeneratorPromptMode(patch.promptMode);
    if (nextPromptMode && nextPromptMode !== next.promptMode) {
      next.promptMode = nextPromptMode;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "directPromptSeed")) {
      const nextDirectPromptSeed = normalizeComfySeedValue(patch.directPromptSeed);
      if (nextDirectPromptSeed !== next.directPromptSeed) {
        next.directPromptSeed = nextDirectPromptSeed;
        changed = true;
      }
    }

    if (typeof patch.directPromptSeedArmed === "boolean") {
      const normalizedArmed =
        patch.directPromptSeedArmed && next.directPromptSeed !== null;
      if (normalizedArmed !== next.directPromptSeedArmed) {
        next.directPromptSeedArmed = normalizedArmed;
        changed = true;
      }
    }

    if (typeof patch.singleRunRequested === "boolean") {
      if (patch.singleRunRequested !== next.singleRunRequested) {
        next.singleRunRequested = patch.singleRunRequested;
        changed = true;
      }
    }

    const appendEntriesRaw = patch.appendEntries;
    if (Array.isArray(appendEntriesRaw) && appendEntriesRaw.length > 0) {
      const existingEntryIds = new Set(next.entries.map((entry) => entry.id));
      for (const appendEntry of appendEntriesRaw) {
        if (!isRecord(appendEntry) || !hasEntityId(appendEntry)) continue;
        const typedEntry = appendEntry as unknown as GeneratorSession["entries"][number];
        if (existingEntryIds.has(typedEntry.id)) continue;
        next.entries.push(typedEntry);
        existingEntryIds.add(typedEntry.id);
        changed = true;
      }
    }

    if (!changed) {
      continue;
    }
    if (!shouldApplyIncomingSession({ current, incoming: next })) {
      continue;
    }
    await dbApi.saveGeneratorSession(next);
    existingSessionById.set(next.id, next);
    appliedAnySession = true;
  }

  const sessions = normalizeStoreRows(stores, "generatorSessions")
    .filter(hasEntityId) as unknown as GeneratorSession[];
  for (const session of sessions) {
    const current = existingSessionById.get(session.id);
    if (!shouldApplyIncomingSession({ current, incoming: session })) {
      continue;
    }
    await dbApi.saveGeneratorSession(session);
    existingSessionById.set(session.id, session);
    appliedAnySession = true;
  }

  const imageAssets = normalizeStoreRows(stores, "imageAssets")
    .filter(hasEntityId) as unknown as ImageAsset[];
  for (const imageAsset of imageAssets) {
    await dbApi.saveImageAsset(imageAsset);
  }

  if (appliedAnySession) {
    await syncGenerationSessionsFromDb?.(preferredSessionId);
  }
}

export function useTopicGenerationBackgroundWorker({
  isAndroidRuntime,
  generationSession,
  runGenerationStep: _runGenerationStep,
  syncGenerationSessionsFromDb,
  onError: _onError,
}: UseTopicGenerationBackgroundWorkerParams) {
  const topicGenerationJobIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const visibleRef = useRef<boolean>(typeof document === "undefined" ? true : !document.hidden);
  const activeSessionIdRef = useRef<string | null>(generationSession?.id ?? null);
  const syncSignatureRef = useRef<string>("");

  useEffect(() => {
    activeSessionIdRef.current = generationSession?.id ?? null;
  }, [generationSession?.id]);

  useEffect(() => {
    const onVisibilityChange = () => {
      visibleRef.current = !document.hidden;
      if (visibleRef.current) {
        void triggerBackgroundRuntime("topic_visibility");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!isAndroidRuntime) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    const pullTopicDeltaIntoWeb = async (reason: string) => {
      if (pollInFlightRef.current) return;
      if (!visibleRef.current) return;
      pollInFlightRef.current = true;
      try {
        const preferredSessionId = activeSessionIdRef.current;
        const sinceId = getStoredSinceId();
        const response = await getBackgroundDelta({
          sinceId,
          limit: 300,
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeIds: preferredSessionId ? [preferredSessionId] : [],
          includeGlobal: true,
        });
        if (response.items.length === 0) {
          return;
        }

        let maxAppliedId = sinceId;
        const pendingAssetIds = new Set<string>();
        const storePatches: Array<Record<string, unknown>> = [];
        for (const item of response.items) {
          if (item.kind === "state_patch" && isRecord(item.payload) && isRecord(item.payload.stores)) {
            storePatches.push(item.payload.stores);
            for (const assetId of collectTopicPatchAssetIds(item.payload)) {
              pendingAssetIds.add(assetId);
            }
          }
          if (item.id > maxAppliedId) {
            maxAppliedId = item.id;
          }
        }
        if (maxAppliedId > sinceId) {
          if (pendingAssetIds.size > 0) {
            try {
              await hydrateMissingImageAssetsByIds(Array.from(pendingAssetIds));
            } catch (error) {
              const errorMessage =
                error instanceof Error
                  ? error.message
                  : "native_topic_delta_asset_hydrate_failed";
              pushSystemLog({
                level: "warn",
                eventType: "topic_generation.native_asset_hydrate_failed",
                message: "Failed to hydrate topic image assets before state patch apply",
                details: {
                  reason,
                  sessionId: preferredSessionId,
                  assetCount: pendingAssetIds.size,
                  error: errorMessage,
                },
              });
            }
          }
          for (const stores of storePatches) {
            await applyTopicStatePatch(
              stores,
              preferredSessionId,
              syncGenerationSessionsFromDb,
            );
          }
          await ackBackgroundDelta({
            ackedUpToId: maxAppliedId,
            taskType: TOPIC_GENERATION_JOB_TYPE,
          });
          setStoredSinceId(maxAppliedId);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "native_topic_delta_pull_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.native_delta_pull_failed",
          message: "Failed to pull topic delta into web storage",
          details: {
            reason,
            sessionId: activeSessionIdRef.current,
            error: errorMessage,
          },
        });
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const syncDesiredStateAndJob = async () => {
      const signature = generationSession
        ? `${generationSession.id}|${generationSession.status}|${Math.max(
            0,
            Math.floor((generationSession.delaySeconds || 0) * 1000),
          )}`
        : "none";
      if (syncSignatureRef.current === signature) {
        return;
      }
      syncSignatureRef.current = signature;

      const nextJobId = generationSession
        ? buildTopicGenerationJobId(generationSession.id)
        : null;
      const previousJobId = topicGenerationJobIdRef.current;
      topicGenerationJobIdRef.current = nextJobId;

      if (previousJobId && previousJobId !== nextJobId) {
        await cancelBackgroundJob(previousJobId).catch(() => {});
        const previousSessionId = previousJobId.startsWith(TOPIC_GENERATION_JOB_ID_PREFIX)
          ? previousJobId.slice(TOPIC_GENERATION_JOB_ID_PREFIX.length).trim()
          : "";
        if (previousSessionId) {
          await setBackgroundDesiredState({
            taskType: TOPIC_GENERATION_JOB_TYPE,
            scopeId: previousSessionId,
            enabled: false,
            payload: {
              sessionId: previousSessionId,
              delayMs: 0,
            },
          }).catch(() => {});
        }
      }

      if (!generationSession) {
        if (previousJobId) {
          await cancelBackgroundJob(previousJobId).catch(() => {});
        }
        await updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: "idle",
          scopeId: "",
          detail: "no_session",
        }).catch(() => {});
        await triggerBackgroundRuntime("topic_no_session").catch(() => {});
        return;
      }

      const sessionId = generationSession.id;
      const delayMs = Math.max(0, Math.floor((generationSession.delaySeconds || 0) * 1000));
      const sessionCanRun = generationSession.status === "running";
      if (!sessionCanRun) {
        await setBackgroundDesiredState({
          taskType: TOPIC_GENERATION_JOB_TYPE,
          scopeId: sessionId,
          enabled: false,
          payload: {
            sessionId,
            delayMs,
          },
        }).catch(() => {});
        await cancelBackgroundJob(nextJobId ?? buildTopicGenerationJobId(sessionId)).catch(() => {});
        await updateForegroundWorkerStatus({
          worker: "topic_generation",
          state: "idle",
          scopeId: sessionId,
          detail: `session_${generationSession.status}`,
        }).catch(() => {});
        await triggerBackgroundRuntime("topic_disable").catch(() => {});
        return;
      }

      try {
        await syncTopicGenerationContextToNative(sessionId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "native_context_sync_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.native_context_sync_failed",
          message: "Failed to sync topic generation context to native store",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      }

      await setBackgroundDesiredState({
        taskType: TOPIC_GENERATION_JOB_TYPE,
        scopeId: sessionId,
        enabled: true,
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
          message: "Failed to enable topic desired-state",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      });

      await ensureRecurringBackgroundJob({
        id: nextJobId ?? buildTopicGenerationJobId(sessionId),
        type: TOPIC_GENERATION_JOB_TYPE,
        payload: {
          sessionId,
          delayMs,
        },
        runAtMs: Date.now(),
        maxAttempts: 0,
      }).catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "background_job_ensure_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.ensure_failed",
          message: "Failed to ensure recurring topic generation job",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      });
      await updateForegroundWorkerStatus({
        worker: "topic_generation",
        state: "running",
        scopeId: sessionId,
        detail: "native_delegate",
      }).catch(() => {});
      await triggerBackgroundRuntime("topic_enable").catch(() => {});
    };

    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    void syncDesiredStateAndJob().finally(() => {
      void pullTopicDeltaIntoWeb("effect_enter");
      pollTimerRef.current = window.setInterval(() => {
        if (!visibleRef.current) return;
        void pullTopicDeltaIntoWeb("poll");
      }, TOPIC_DELTA_POLL_MS);
    });

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [
    isAndroidRuntime,
    generationSession?.id,
    generationSession?.status,
    generationSession?.delaySeconds,
    syncGenerationSessionsFromDb,
  ]);
}
