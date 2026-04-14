import { create } from "zustand";

export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: SystemLogLevel;
  eventType: string;
  message: string;
  details?: string;
}

export interface AppendSystemLogInput {
  level: SystemLogLevel;
  eventType: string;
  message: string;
  details?: unknown;
  timestamp?: string;
}

interface SystemLogState {
  entries: SystemLogEntry[];
  append: (input: AppendSystemLogInput) => void;
  clear: () => void;
}

const MAX_SYSTEM_LOG_ENTRIES = 600;
const MAX_DETAILS_LENGTH = 16_000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEventType(value: string) {
  const next = value.trim().toLowerCase();
  return next || "unknown";
}

function trimMessage(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || "—";
}

function serializeDetails(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, MAX_DETAILS_LENGTH);
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (!serialized) return undefined;
    return serialized.slice(0, MAX_DETAILS_LENGTH);
  } catch {
    const fallback = String(value);
    const trimmed = fallback.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, MAX_DETAILS_LENGTH);
  }
}

function nextId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

export const useSystemLogStore = create<SystemLogState>((set) => ({
  entries: [],
  append: (input) =>
    set((state) => {
      const nextEntry: SystemLogEntry = {
        id: nextId(),
        timestamp: input.timestamp ?? nowIso(),
        level: input.level,
        eventType: normalizeEventType(input.eventType),
        message: trimMessage(input.message),
        details: serializeDetails(input.details),
      };
      const nextEntries = [...state.entries, nextEntry];
      if (nextEntries.length <= MAX_SYSTEM_LOG_ENTRIES) {
        return { entries: nextEntries };
      }
      return {
        entries: nextEntries.slice(nextEntries.length - MAX_SYSTEM_LOG_ENTRIES),
      };
    }),
  clear: () => set({ entries: [] }),
}));

export function pushSystemLog(input: AppendSystemLogInput) {
  useSystemLogStore.getState().append(input);
}

export function clearSystemLogs() {
  useSystemLogStore.getState().clear();
}

