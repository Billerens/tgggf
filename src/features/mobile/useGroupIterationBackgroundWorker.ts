import { useEffect, useRef } from "react";
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
import { updateForegroundWorkerStatus } from "./foregroundService";

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

function canRunRoom(room: GroupRoom | null) {
  if (!room) return false;
  if (room.status !== "active") return false;
  if (room.mode === "personas_plus_user" && room.waitingForUser) return false;
  return true;
}

export function useGroupIterationBackgroundWorker({
  activeGroupRoom,
  isAndroidRuntime,
  personas,
  settings,
  runActiveGroupIteration,
}: UseGroupIterationBackgroundWorkerParams) {
  const activeGroupRoomRef = useEffectRef(activeGroupRoom);
  const personasRef = useEffectRef(personas);
  const settingsRef = useEffectRef(settings);
  const runActiveGroupIterationRef = useEffectRef(runActiveGroupIteration);

  useEffect(() => {
    if (!activeGroupRoom) {
      if (isAndroidRuntime) {
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
    let claimInFlight = false;
    let ensureInFlight = false;
    let lastTriggeredAt = 0;
    let isJobEnsured = false;
    let lastProgressAt = Date.now();
    let lastWatchdogRepairAt = 0;

    const processClaimedJobs = async () => {
      if (disposed || claimInFlight) return;

      const currentRoom = activeGroupRoomRef.current;
      if (!currentRoom || currentRoom.id !== roomId) return;
      const roomCanRun = canRunRoom(currentRoom);

      if (!roomCanRun) {
        try {
          await cancelBackgroundJob(jobId);
        } catch {
          // Ignore queue mutation errors; worker will retry on next room change.
        }
        isJobEnsured = false;
        reportWorkerStatus({
          state: "idle",
          detail: `room_${currentRoom.status}`,
        });
        return;
      }

      if (!ensureInFlight && !isJobEnsured) {
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
          isJobEnsured = true;
          reportWorkerStatus({
            state: "running",
            detail: "queue_ensured",
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "background_job_ensure_failed";
          reportWorkerStatus({
            state: "blocked",
            detail: "queue_ensure_failed",
            lastError: errorMessage,
          });
          pushSystemLog({
            level: "warn",
            eventType: "group_iteration.ensure_failed",
            message: "Failed to ensure recurring group iteration job",
            details: {
              roomId,
              error: errorMessage,
            },
          });
        } finally {
          ensureInFlight = false;
        }
      }

      const watchdogNow = Date.now();
      if (watchdogNow - lastProgressAt > GROUP_ITERATION_LEASE_MS) {
        if (watchdogNow - lastWatchdogRepairAt >= 15_000) {
          lastWatchdogRepairAt = watchdogNow;
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
              state: "blocked",
              detail: "watchdog_repair",
            });
            pushSystemLog({
              level: "warn",
              eventType: "group_iteration.watchdog_repair",
              message: `Watchdog re-ensured group iteration job for room ${roomId}`,
              details: {
                roomId,
                jobId,
                lastProgressAgeMs: watchdogNow - lastProgressAt,
              },
            });
          } catch {
            // Ignore transient watchdog repair errors.
          }
        }
      }

      const now = Date.now();
      if (now - lastTriggeredAt < GROUP_ITERATION_MIN_TRIGGER_GAP_MS) return;
      claimInFlight = true;
      lastTriggeredAt = now;
      reportWorkerStatus({
        state: "running",
        detail: "claiming",
      });

      try {
        const claimedJobs = await claimBackgroundJobs(
          4,
          GROUP_ITERATION_LEASE_MS,
          GROUP_ITERATION_JOB_TYPE,
        );
        if (claimedJobs.length === 0) {
          reportWorkerStatus({
            state: "running",
            detail: "awaiting_due_job",
          });
        }
        for (const job of claimedJobs) {
          if (disposed) break;

          const latestRoom = activeGroupRoomRef.current;
          const latestRoomCanRun =
            latestRoom !== null &&
            latestRoom.id === roomId &&
            canRunRoom(latestRoom);
          const jobRoomId = readGroupIterationRoomId(job);
          if (!jobRoomId || jobRoomId !== roomId || !latestRoomCanRun) {
            try {
              await cancelBackgroundJob(job.id);
            } catch {
              // Ignore queue mutation errors; worker will retry on next pump.
            }
            continue;
          }

          try {
            reportWorkerStatus({
              state: "running",
              detail: `claimed_${job.id.slice(0, 8)}`,
              claimed: true,
            });
            const currentPersonas = personasRef.current;
            const currentSettings = settingsRef.current;
            await runActiveGroupIterationRef.current(
              currentPersonas,
              currentSettings,
              currentSettings.userName,
            );
            lastProgressAt = Date.now();
            await rescheduleBackgroundJob({
              id: job.id,
              runAtMs: Date.now() + GROUP_ITERATION_INTERVAL_MS,
              incrementAttempts: false,
            });
            reportWorkerStatus({
              state: "running",
              detail: `progress_${job.id.slice(0, 8)}`,
              progress: true,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "group_iteration_failed";
            reportWorkerStatus({
              state: "error",
              detail: `job_failed_${job.id.slice(0, 8)}`,
              lastError: errorMessage,
            });
            pushSystemLog({
              level: "warn",
              eventType: "group_iteration.job_failed",
              message: `Group iteration job failed for room ${jobRoomId}`,
              details: {
                roomId: jobRoomId,
                jobId: job.id,
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
        reportWorkerStatus({
          state: "blocked",
          detail: "claim_failed",
          lastError: errorMessage,
        });
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

    void processClaimedJobs();

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
      reportWorkerStatus({
        state: "idle",
        detail: "worker_disposed",
      });
    };
  }, [
    activeGroupRoom?.id,
    isAndroidRuntime,
  ]);
}

function useEffectRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
