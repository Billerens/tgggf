export type MessageScrollStreamType = "group" | "chat";

export interface MessageScrollEntry {
  scrollTop: number;
  updatedAt: number;
}

export interface MessageScrollState {
  version: 1;
  group: Record<string, MessageScrollEntry>;
  chat: Record<string, MessageScrollEntry>;
}

export const MESSAGE_SCROLL_STORAGE_KEY = "tg_gf_message_scroll_v1";

const MAX_ENTRIES_PER_STREAM = 250;

function emptyState(): MessageScrollState {
  return {
    version: 1,
    group: {},
    chat: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeEntry(value: unknown): MessageScrollEntry | null {
  if (!isRecord(value)) return null;
  const scrollTopRaw = value.scrollTop;
  const updatedAtRaw = value.updatedAt;
  if (!Number.isFinite(scrollTopRaw) || !Number.isFinite(updatedAtRaw)) {
    return null;
  }
  const scrollTop = Math.max(0, Number(scrollTopRaw));
  const updatedAt = Math.max(0, Number(updatedAtRaw));
  return { scrollTop, updatedAt };
}

function normalizeBucket(value: unknown) {
  if (!isRecord(value)) return {} as Record<string, MessageScrollEntry>;
  const next: Record<string, MessageScrollEntry> = {};
  for (const [streamId, entry] of Object.entries(value)) {
    if (typeof streamId !== "string" || streamId.trim().length === 0) continue;
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    next[streamId] = normalized;
  }
  return next;
}

function pruneBucket(bucket: Record<string, MessageScrollEntry>) {
  const pairs = Object.entries(bucket);
  if (pairs.length <= MAX_ENTRIES_PER_STREAM) return bucket;
  pairs.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(pairs.slice(0, MAX_ENTRIES_PER_STREAM));
}

export function parseMessageScrollState(raw: string | null | undefined): MessageScrollState {
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyState();
    return {
      version: 1,
      group: normalizeBucket(parsed.group),
      chat: normalizeBucket(parsed.chat),
    };
  } catch {
    return emptyState();
  }
}

function resolveStorage(storage: Storage | null | undefined) {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

export function readMessageScrollState(storage?: Storage | null): MessageScrollState {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return emptyState();
  try {
    return parseMessageScrollState(
      resolvedStorage.getItem(MESSAGE_SCROLL_STORAGE_KEY),
    );
  } catch {
    return emptyState();
  }
}

export function writeMessageScrollState(
  state: MessageScrollState,
  storage?: Storage | null,
) {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return;
  try {
    resolvedStorage.setItem(MESSAGE_SCROLL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota/storage errors.
  }
}

export function getStoredMessageScrollTop(
  streamType: MessageScrollStreamType,
  streamId: string,
  storage?: Storage | null,
): number | null {
  const id = streamId.trim();
  if (!id) return null;
  const state = readMessageScrollState(storage);
  const entry = state[streamType][id];
  if (!entry) return null;
  return Math.max(0, entry.scrollTop);
}

export function setStoredMessageScrollTop(params: {
  streamType: MessageScrollStreamType;
  streamId: string;
  scrollTop: number;
  updatedAt?: number;
  storage?: Storage | null;
}) {
  const { streamType, streamId, scrollTop, updatedAt, storage } = params;
  const id = streamId.trim();
  if (!id) return;
  if (!Number.isFinite(scrollTop)) return;
  const state = readMessageScrollState(storage);
  const nextBucket = {
    ...state[streamType],
    [id]: {
      scrollTop: Math.max(0, scrollTop),
      updatedAt:
        updatedAt && Number.isFinite(updatedAt)
          ? Math.max(0, updatedAt)
          : Date.now(),
    },
  };
  state[streamType] = pruneBucket(nextBucket);
  writeMessageScrollState(state, storage);
}

export function getNewMessageIds(previousIds: string[], nextIds: string[]) {
  if (!Array.isArray(previousIds) || !Array.isArray(nextIds)) return [];
  if (previousIds.length === 0 || nextIds.length === 0) return [];
  const previousSet = new Set(previousIds);
  const newIds: string[] = [];
  for (const messageId of nextIds) {
    if (!previousSet.has(messageId)) {
      newIds.push(messageId);
    }
  }
  return newIds;
}

export function isNearBottom(params: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  thresholdPx?: number;
}) {
  const { scrollTop, scrollHeight, clientHeight, thresholdPx = 80 } = params;
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight)
  ) {
    return true;
  }
  const distanceToBottom = Math.max(0, scrollHeight - (scrollTop + clientHeight));
  return distanceToBottom <= Math.max(0, thresholdPx);
}

