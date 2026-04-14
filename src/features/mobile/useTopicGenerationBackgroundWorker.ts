import { useEffect, useRef } from "react";
import type { GeneratorSession } from "../../types";
import type { TopicGenerationStepResult } from "../generator/useTopicGenerator";
import { dbApi } from "../../db";
import {
  cancelBackgroundJob,
  ensureRecurringBackgroundJob,
} from "./backgroundJobs";
import {
  buildTopicGenerationJobId,
  TOPIC_GENERATION_JOB_TYPE,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";
import { updateForegroundWorkerStatus } from "./foregroundService";

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
  onError?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
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

  const response = await plugin.request({
    method: "PUT",
    path: "/api/raw-snapshot",
    body: {
      mode: "merge",
      stores: {
        settings,
        personas,
        generatorSessions,
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
  generationSession,
  runGenerationStep: _runGenerationStep,
  onError: _onError,
}: UseTopicGenerationBackgroundWorkerParams) {
  const topicGenerationJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAndroidRuntime) {
      const previousJobId = topicGenerationJobIdRef.current;
      topicGenerationJobIdRef.current = null;
      if (previousJobId) {
        void cancelBackgroundJob(previousJobId).catch(() => {
          // Ignore queue mutation errors while switching runtimes.
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
    }

    if (!generationSession) {
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
        return;
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
    };

    void syncNativeTopicJob();
  }, [
    generationSession?.delaySeconds,
    generationSession?.id,
    generationSession?.status,
    isAndroidRuntime,
  ]);
}
