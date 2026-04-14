import { useEffect, useRef } from "react";
import type { GeneratorSession } from "../../types";
import type { TopicGenerationStepResult } from "../generator/useTopicGenerator";
import {
  cancelBackgroundJob,
  claimBackgroundJobs,
  ensureRecurringBackgroundJob,
  rescheduleBackgroundJob,
} from "./backgroundJobs";
import { subscribeBackgroundTick } from "./backgroundTick";
import {
  buildTopicGenerationJobId,
  readTopicGenerationSessionId,
  TOPIC_GENERATION_JOB_TYPE,
  TOPIC_GENERATION_LEASE_MS,
  TOPIC_GENERATION_MIN_TRIGGER_GAP_MS,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";

interface UseTopicGenerationBackgroundWorkerParams {
  isAndroidRuntime: boolean;
  generationSession: GeneratorSession | null;
  runGenerationStep: () => Promise<TopicGenerationStepResult>;
  onError?: (message: string) => void;
}

export function useTopicGenerationBackgroundWorker({
  isAndroidRuntime,
  generationSession,
  runGenerationStep,
  onError,
}: UseTopicGenerationBackgroundWorkerParams) {
  const topicGenerationJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAndroidRuntime) {
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

    if (!generationSession) return;

    const sessionId = generationSession.id;
    const delayMs = Math.max(
      0,
      Math.floor((generationSession.delaySeconds || 0) * 1000),
    );
    const runIntervalMs = Math.max(
      TOPIC_GENERATION_MIN_TRIGGER_GAP_MS,
      Math.min(Math.max(delayMs, TOPIC_GENERATION_MIN_TRIGGER_GAP_MS), 5000),
    );
    const sessionCanRun = generationSession.status === "running";
    const jobId = buildTopicGenerationJobId(sessionId);

    let disposed = false;
    let claimInFlight = false;
    let lastTriggeredAt = 0;

    const processClaimedJobs = async () => {
      if (disposed || !sessionCanRun || claimInFlight) return;
      const now = Date.now();
      if (now - lastTriggeredAt < TOPIC_GENERATION_MIN_TRIGGER_GAP_MS) return;
      claimInFlight = true;
      lastTriggeredAt = now;

      try {
        const claimedJobs = await claimBackgroundJobs(
          1,
          TOPIC_GENERATION_LEASE_MS,
          TOPIC_GENERATION_JOB_TYPE,
        );
        for (const job of claimedJobs) {
          if (disposed) break;

          const jobSessionId = readTopicGenerationSessionId(job);
          if (!jobSessionId || jobSessionId !== sessionId || !sessionCanRun) {
            try {
              await cancelBackgroundJob(job.id);
            } catch {
              // Ignore queue mutation errors; worker will retry on next pump.
            }
            continue;
          }

          try {
            const result = await runGenerationStep();
            if (result === "progress") {
              await rescheduleBackgroundJob({
                id: job.id,
                runAtMs: Date.now() + delayMs,
                incrementAttempts: false,
              });
            } else {
              await cancelBackgroundJob(job.id);
            }
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "topic_generation_failed";
            onError?.(errorMessage);
            pushSystemLog({
              level: "warn",
              eventType: "topic_generation.job_failed",
              message: `Topic generation job failed for session ${jobSessionId}`,
              details: {
                sessionId: jobSessionId,
                error: errorMessage,
              },
            });
            try {
              await cancelBackgroundJob(job.id);
            } catch {
              // Ignore queue mutation errors; worker will retry on next pump.
            }
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "background_job_claim_failed";
        pushSystemLog({
          level: "warn",
          eventType: "topic_generation.claim_failed",
          message: "Failed to claim background jobs for topic generation",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      } finally {
        claimInFlight = false;
      }
    };

    void (async () => {
      if (!sessionCanRun) {
        try {
          await cancelBackgroundJob(jobId);
        } catch {
          // Ignore queue mutation errors when session is not running.
        }
        return;
      }

      try {
        await ensureRecurringBackgroundJob({
          id: jobId,
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
          message: "Failed to ensure recurring topic generation job",
          details: {
            sessionId,
            error: errorMessage,
          },
        });
      }

      await processClaimedJobs();
    })();

    const timerId = window.setInterval(() => {
      void processClaimedJobs();
    }, runIntervalMs);

    const unsubscribeBackgroundTick = subscribeBackgroundTick((payload) => {
      if (!payload.enabled || !payload.running) return;
      void processClaimedJobs();
    });

    return () => {
      disposed = true;
      window.clearInterval(timerId);
      unsubscribeBackgroundTick();
    };
  }, [
    generationSession?.delaySeconds,
    generationSession?.id,
    generationSession?.status,
    isAndroidRuntime,
    onError,
    runGenerationStep,
  ]);
}
