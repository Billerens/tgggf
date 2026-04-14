import { useEffect } from "react";
import type { AppSettings, GroupRoom, Persona } from "../../types";
import {
  cancelBackgroundJob,
  claimBackgroundJobs,
  ensureRecurringBackgroundJob,
  rescheduleBackgroundJob,
} from "./backgroundJobs";
import { subscribeBackgroundTick } from "./backgroundTick";
import {
  buildGroupIterationJobId,
  GROUP_ITERATION_INTERVAL_MS,
  GROUP_ITERATION_JOB_TYPE,
  GROUP_ITERATION_LEASE_MS,
  GROUP_ITERATION_MIN_TRIGGER_GAP_MS,
  GROUP_ITERATION_RETRY_DELAY_MS,
  readGroupIterationRoomId,
} from "./backgroundJobKeys";
import { pushSystemLog } from "../system-logs/systemLogStore";

interface UseGroupIterationBackgroundWorkerParams {
  activeGroupRoom: GroupRoom | null;
  isAndroidRuntime: boolean;
  personas: Persona[];
  settings: AppSettings;
  runActiveGroupIteration: (
    personas: Persona[],
    settings: AppSettings,
    userName: string,
  ) => Promise<void> | void;
}

export function useGroupIterationBackgroundWorker({
  activeGroupRoom,
  isAndroidRuntime,
  personas,
  settings,
  runActiveGroupIteration,
}: UseGroupIterationBackgroundWorkerParams) {
  useEffect(() => {
    if (!activeGroupRoom) return;
    const roomId = activeGroupRoom.id;
    const roomCanRun =
      activeGroupRoom.status === "active" &&
      !(
        activeGroupRoom.mode === "personas_plus_user" &&
        activeGroupRoom.waitingForUser
      );

    if (!isAndroidRuntime) {
      if (!roomCanRun) return;

      let disposed = false;
      let iterationInFlight = false;
      const runWebIteration = async () => {
        if (disposed || iterationInFlight) return;
        iterationInFlight = true;
        try {
          await runActiveGroupIteration(personas, settings, settings.userName);
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
    let claimInFlight = false;
    let lastTriggeredAt = 0;
    const jobId = buildGroupIterationJobId(roomId);

    const processClaimedJobs = async () => {
      if (disposed || !roomCanRun || claimInFlight) return;
      const now = Date.now();
      if (now - lastTriggeredAt < GROUP_ITERATION_MIN_TRIGGER_GAP_MS) return;
      claimInFlight = true;
      lastTriggeredAt = now;

      try {
        const claimedJobs = await claimBackgroundJobs(
          4,
          GROUP_ITERATION_LEASE_MS,
          GROUP_ITERATION_JOB_TYPE,
        );
        for (const job of claimedJobs) {
          if (disposed) break;

          const jobRoomId = readGroupIterationRoomId(job);
          if (!jobRoomId || jobRoomId !== roomId || !roomCanRun) {
            try {
              await cancelBackgroundJob(job.id);
            } catch {
              // Ignore queue mutation errors; worker will retry on next pump.
            }
            continue;
          }

          try {
            await runActiveGroupIteration(personas, settings, settings.userName);
            await rescheduleBackgroundJob({
              id: job.id,
              runAtMs: Date.now() + GROUP_ITERATION_INTERVAL_MS,
              incrementAttempts: false,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "group_iteration_failed";
            pushSystemLog({
              level: "warn",
              eventType: "group_iteration.job_failed",
              message: `Group iteration job failed for room ${jobRoomId}`,
              details: {
                roomId: jobRoomId,
                error: errorMessage,
              },
            });
            try {
              await rescheduleBackgroundJob({
                id: job.id,
                runAtMs: Date.now() + GROUP_ITERATION_RETRY_DELAY_MS,
                incrementAttempts: true,
                lastError: errorMessage,
              });
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
          eventType: "group_iteration.claim_failed",
          message: "Failed to claim background jobs for group iteration",
          details: {
            roomId,
            error: errorMessage,
          },
        });
      } finally {
        claimInFlight = false;
      }
    };

    void (async () => {
      if (!roomCanRun) {
        try {
          await cancelBackgroundJob(jobId);
        } catch {
          // Ignore queue mutation errors; worker will retry on next room change.
        }
        return;
      }

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
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "background_job_ensure_failed";
        pushSystemLog({
          level: "warn",
          eventType: "group_iteration.ensure_failed",
          message: "Failed to ensure recurring group iteration job",
          details: {
            roomId,
            error: errorMessage,
          },
        });
      }

      await processClaimedJobs();
    })();

    const timerId = window.setInterval(() => {
      void processClaimedJobs();
    }, GROUP_ITERATION_INTERVAL_MS);

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
    activeGroupRoom?.id,
    activeGroupRoom?.mode,
    activeGroupRoom?.status,
    activeGroupRoom?.waitingForUser,
    isAndroidRuntime,
    personas,
    runActiveGroupIteration,
    settings,
  ]);
}
