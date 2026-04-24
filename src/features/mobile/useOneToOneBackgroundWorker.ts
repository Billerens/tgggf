import { useEffect, useRef } from "react";
import type { ChatSession } from "../../types";
import { dbApi } from "../../db";
import { pushSystemLog } from "../system-logs/systemLogStore";
import {
  ackBackgroundDelta,
  getBackgroundDelta,
  getBackgroundImageAssets,
  triggerBackgroundRuntime,
} from "./backgroundDelta";
import {
  ONE_TO_ONE_CHAT_JOB_TYPE,
  ONE_TO_ONE_PROACTIVE_DEFAULT_MAX_DELAY_MINUTES,
  ONE_TO_ONE_PROACTIVE_DEFAULT_MIN_DELAY_MINUTES,
  ONE_TO_ONE_PROACTIVE_JOB_TYPE,
} from "./backgroundJobKeys";
import { setBackgroundDesiredState } from "./backgroundRuntime";
import {
  applyOneToOneStatePatch,
  syncOneToOneContextToNative,
} from "./oneToOneNativeRuntime";
import { useAppStore } from "../../store";

interface UseOneToOneBackgroundWorkerParams {
  chats: ChatSession[];
  activeChat: ChatSession | null;
  isAndroidRuntime: boolean;
  syncOneToOneStateFromDb: (preferredChatId?: string | null) => Promise<void> | void;
}

const ONE_TO_ONE_DELTA_SINCE_ID_CHAT_KEY = "tg_gf_one_to_one_delta_since_id_chat_v1";
const ONE_TO_ONE_DELTA_SINCE_ID_PROACTIVE_KEY =
  "tg_gf_one_to_one_delta_since_id_proactive_v1";
const ONE_TO_ONE_DELTA_POLL_MS = 1400;
const ONE_TO_ONE_PROACTIVITY_DESIRED_STATE_VERSION = 1;
const ONE_TO_ONE_PROACTIVE_RESUME_AFTER_ENGAGEMENT_MINUTES = 15;

export const ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS = [
  {
    taskType: ONE_TO_ONE_CHAT_JOB_TYPE,
    sinceIdStorageKey: ONE_TO_ONE_DELTA_SINCE_ID_CHAT_KEY,
  },
  {
    taskType: ONE_TO_ONE_PROACTIVE_JOB_TYPE,
    sinceIdStorageKey: ONE_TO_ONE_DELTA_SINCE_ID_PROACTIVE_KEY,
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStoreRows(stores: Record<string, unknown>, storeName: string) {
  const raw = stores[storeName];
  if (!Array.isArray(raw)) return [] as Record<string, unknown>[];
  return raw.filter(isRecord);
}

function parseIdbImageAssetId(value: string | undefined | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
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

function collectOneToOnePatchAssetIds(payload: unknown) {
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

function getStoredSinceId(storageKey: string) {
  const raw = globalThis.localStorage?.getItem(storageKey) ?? "";
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function setStoredSinceId(storageKey: string, value: number) {
  globalThis.localStorage?.setItem(storageKey, String(Math.max(0, Math.floor(value))));
}

function resolveTerminalFailureMessage(payload: unknown) {
  if (!isRecord(payload)) return "Native 1:1 job failed";
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  if (isRecord(payload.details) && typeof payload.details.error === "string") {
    const error = payload.details.error.trim();
    if (error) return error;
  }
  return "Native 1:1 job failed";
}

export function useOneToOneBackgroundWorker({
  chats,
  activeChat,
  isAndroidRuntime,
  syncOneToOneStateFromDb,
}: UseOneToOneBackgroundWorkerParams) {
  const activeChatRef = useEffectRef(activeChat);
  const chatsRef = useEffectRef(chats);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const desiredStateSyncSignatureRef = useRef<string>("");
  const proactiveEnabledIdsRef = useRef<Set<string>>(new Set());
  const proactivityDesiredStateInitializedRef = useRef<boolean>(false);
  const visibleRef = useRef<boolean>(typeof document === "undefined" ? true : !document.hidden);

  useEffect(() => {
    const onVisibilityChange = () => {
      visibleRef.current = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!isAndroidRuntime) {
      proactiveEnabledIdsRef.current = new Set();
      desiredStateSyncSignatureRef.current = "";
      proactivityDesiredStateInitializedRef.current = false;
      return;
    }

    const resolveScopeIdsForTaskType = (
      taskType: string,
      preferredChatId: string | null,
    ) => {
      const chatIds = chatsRef.current.map((chat) => chat.id.trim()).filter(Boolean);
      if (taskType === ONE_TO_ONE_CHAT_JOB_TYPE) {
        if (preferredChatId) {
          return [preferredChatId];
        }
        return Array.from(new Set(chatIds));
      }
      if (taskType === ONE_TO_ONE_PROACTIVE_JOB_TYPE) {
        const proactiveEnabledChatIds = chatsRef.current
          .filter((chat) => chat.proactivityConfig?.enabled === true)
          .map((chat) => chat.id.trim())
          .filter(Boolean);
        if (proactiveEnabledChatIds.length > 0) {
          return Array.from(new Set(proactiveEnabledChatIds));
        }
        return Array.from(new Set(chatIds));
      }
      if (preferredChatId) {
        return [preferredChatId];
      }
      return Array.from(new Set(chatIds));
    };

    const pullOneToOneDeltaByTaskType = async (
      reason: string,
      taskType: string,
      sinceIdStorageKey: string,
    ) => {
      const preferredChatId = activeChatRef.current?.id ?? null;
      const scopeIds = resolveScopeIdsForTaskType(taskType, preferredChatId);
      const sinceId = getStoredSinceId(sinceIdStorageKey);
      const response = await getBackgroundDelta({
        sinceId,
        limit: 300,
        taskType,
        scopeIds,
        includeGlobal: true,
      });
      if (response.items.length === 0) return;

      const statePatches: Array<{
        scopeId: string;
        stores: Record<string, unknown>;
      }> = [];
      const pendingAssetIds = new Set<string>();
      let maxAppliedId = sinceId;
      let shouldClearLoading = false;
      let terminalError: string | null = null;

      for (const item of response.items) {
        if (item.id > maxAppliedId) {
          maxAppliedId = item.id;
        }
        if (item.kind === "state_patch" && isRecord(item.payload) && isRecord(item.payload.stores)) {
          for (const assetId of collectOneToOnePatchAssetIds(item.payload)) {
            pendingAssetIds.add(assetId);
          }
          const patchedMessages = normalizeStoreRows(item.payload.stores, "messages");
          statePatches.push({
            scopeId: item.scopeId,
            stores: item.payload.stores,
          });
          if (!preferredChatId || item.scopeId === preferredChatId) {
            if (patchedMessages.length > 0) {
              shouldClearLoading = true;
            }
          }
          continue;
        }
        if (item.kind === "worker_action" && (!preferredChatId || item.scopeId === preferredChatId)) {
          if (item.entityType === "job_completed") {
            shouldClearLoading = true;
          }
          if (item.entityType === "job_failed_terminal") {
            shouldClearLoading = true;
            terminalError = resolveTerminalFailureMessage(item.payload);
          }
        }
      }

      if (pendingAssetIds.size > 0) {
        try {
          await hydrateMissingImageAssetsByIds(Array.from(pendingAssetIds));
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "native_one_to_one_delta_asset_hydrate_failed";
          pushSystemLog({
            level: "warn",
            eventType: "one_to_one.native_asset_hydrate_failed",
            message: "Failed to hydrate 1:1 image assets before state patch apply",
            details: {
              reason,
              chatId: preferredChatId,
              taskType,
              assetCount: pendingAssetIds.size,
              error: errorMessage,
            },
          });
        }
      }

      for (const patch of statePatches) {
        await applyOneToOneStatePatch(
          patch.stores,
          preferredChatId,
          syncOneToOneStateFromDb,
        );
        if (!preferredChatId || patch.scopeId === preferredChatId) {
          shouldClearLoading = true;
        }
      }

      if (maxAppliedId > sinceId) {
        await ackBackgroundDelta({
          ackedUpToId: maxAppliedId,
          taskType,
        });
        setStoredSinceId(sinceIdStorageKey, maxAppliedId);
      }

      if (shouldClearLoading) {
        if (terminalError) {
          useAppStore.setState({
            isLoading: false,
            error: terminalError,
          });
        } else {
          useAppStore.setState({ isLoading: false });
        }
      }
    };

    const pullOneToOneDeltaIntoWeb = async (reason: string) => {
      if (pollInFlightRef.current) return;
      if (!visibleRef.current) return;
      pollInFlightRef.current = true;
      try {
        for (const config of ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS) {
          await pullOneToOneDeltaByTaskType(
            reason,
            config.taskType,
            config.sinceIdStorageKey,
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "native_one_to_one_delta_pull_failed";
        pushSystemLog({
          level: "warn",
          eventType: "one_to_one.native_delta_pull_failed",
          message: "Failed to pull 1:1 delta into web storage",
          details: {
            reason,
            chatId: activeChatRef.current?.id ?? null,
            error: errorMessage,
          },
        });
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const syncProactivityDesiredState = async () => {
      const enabledChats = chatsRef.current.filter(
        (chat) => chat.proactivityConfig?.enabled === true,
      );
      const enabledIds = new Set(enabledChats.map((chat) => chat.id));
      const sortedEnabled = Array.from(enabledIds).sort((a, b) => a.localeCompare(b));
      const activeChatId = activeChatRef.current?.id?.trim() ?? "";
      const signature = `${sortedEnabled.join("|")}::active=${activeChatId}`;
      const isInitialSync = !proactivityDesiredStateInitializedRef.current;
      if (
        desiredStateSyncSignatureRef.current === signature &&
        proactivityDesiredStateInitializedRef.current
      ) {
        return;
      }

      const previousEnabled = proactiveEnabledIdsRef.current;
      const toDisable = Array.from(previousEnabled).filter((chatId) => !enabledIds.has(chatId));
      for (const chatId of toDisable) {
        await setBackgroundDesiredState({
          taskType: ONE_TO_ONE_PROACTIVE_JOB_TYPE,
          scopeId: chatId,
          enabled: false,
          payload: {
            chatId,
          },
        }).catch(() => {});
      }

      for (const chat of enabledChats) {
        const runImmediately = !isInitialSync && !previousEnabled.has(chat.id);
        const resumeRunAtMs =
          activeChatId && activeChatId === chat.id
            ? Date.now() + ONE_TO_ONE_PROACTIVE_RESUME_AFTER_ENGAGEMENT_MINUTES * 60_000
            : undefined;
        await syncOneToOneContextToNative({
          chatId: chat.id,
          personaId: chat.personaId,
        }).catch(() => {});
        await setBackgroundDesiredState({
          taskType: ONE_TO_ONE_PROACTIVE_JOB_TYPE,
          scopeId: chat.id,
          enabled: true,
          payload: {
            version: ONE_TO_ONE_PROACTIVITY_DESIRED_STATE_VERSION,
            chatId: chat.id,
            firstRunAfterInactivityMinutes: 15,
            minDelayMinutes: ONE_TO_ONE_PROACTIVE_DEFAULT_MIN_DELAY_MINUTES,
            maxDelayMinutes: ONE_TO_ONE_PROACTIVE_DEFAULT_MAX_DELAY_MINUTES,
            maxActionsPerTick: 3,
            runImmediately,
            resumeRunAtMs,
          },
        }).catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : "desired_state_sync_failed";
          pushSystemLog({
            level: "warn",
            eventType: "one_to_one.proactivity_desired_state_sync_failed",
            message: "Failed to sync one-to-one proactive desired-state",
            details: {
              chatId: chat.id,
              error: errorMessage,
            },
          });
        });
      }

      proactiveEnabledIdsRef.current = enabledIds;
      desiredStateSyncSignatureRef.current = signature;
      proactivityDesiredStateInitializedRef.current = true;
      await triggerBackgroundRuntime("one_to_one_proactivity_desired_state").catch(() => {});
    };

    void syncProactivityDesiredState().finally(() => {
      void pullOneToOneDeltaIntoWeb("effect_enter");
      pollTimerRef.current = window.setInterval(() => {
        if (!visibleRef.current) return;
        void pullOneToOneDeltaIntoWeb("poll");
      }, ONE_TO_ONE_DELTA_POLL_MS);
    });

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [activeChat?.id, chats, isAndroidRuntime, syncOneToOneStateFromDb]);
}

function useEffectRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
