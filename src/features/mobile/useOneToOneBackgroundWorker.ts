import { useEffect, useRef } from "react";
import type { ChatSession } from "../../types";
import { dbApi } from "../../db";
import { pushSystemLog } from "../system-logs/systemLogStore";
import {
  ackBackgroundDelta,
  getBackgroundDelta,
  getBackgroundImageAssets,
} from "./backgroundDelta";
import { ONE_TO_ONE_CHAT_JOB_TYPE } from "./backgroundJobKeys";
import { applyOneToOneStatePatch } from "./oneToOneNativeRuntime";
import { useAppStore } from "../../store";

interface UseOneToOneBackgroundWorkerParams {
  activeChat: ChatSession | null;
  isAndroidRuntime: boolean;
  syncOneToOneStateFromDb: (preferredChatId?: string | null) => Promise<void> | void;
}

const ONE_TO_ONE_DELTA_SINCE_ID_KEY = "tg_gf_one_to_one_delta_since_id_v1";
const ONE_TO_ONE_DELTA_POLL_MS = 1400;

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

function getStoredSinceId() {
  const raw = globalThis.localStorage?.getItem(ONE_TO_ONE_DELTA_SINCE_ID_KEY) ?? "";
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function setStoredSinceId(value: number) {
  globalThis.localStorage?.setItem(
    ONE_TO_ONE_DELTA_SINCE_ID_KEY,
    String(Math.max(0, Math.floor(value))),
  );
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
  activeChat,
  isAndroidRuntime,
  syncOneToOneStateFromDb,
}: UseOneToOneBackgroundWorkerParams) {
  const activeChatRef = useEffectRef(activeChat);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
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

    if (!isAndroidRuntime) return;

    const pullOneToOneDeltaIntoWeb = async (reason: string) => {
      if (pollInFlightRef.current) return;
      if (!visibleRef.current) return;
      pollInFlightRef.current = true;
      try {
        const preferredChatId = activeChatRef.current?.id ?? null;
        const sinceId = getStoredSinceId();
        const response = await getBackgroundDelta({
          sinceId,
          limit: 300,
          taskType: ONE_TO_ONE_CHAT_JOB_TYPE,
          scopeIds: preferredChatId ? [preferredChatId] : [],
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
            taskType: ONE_TO_ONE_CHAT_JOB_TYPE,
          });
          setStoredSinceId(maxAppliedId);
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

    void pullOneToOneDeltaIntoWeb("effect_enter");
    pollTimerRef.current = window.setInterval(() => {
      if (!visibleRef.current) return;
      void pullOneToOneDeltaIntoWeb("poll");
    }, ONE_TO_ONE_DELTA_POLL_MS);

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [activeChat?.id, isAndroidRuntime, syncOneToOneStateFromDb]);
}

function useEffectRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
