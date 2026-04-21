import type { DiaryTag } from "./types";

export const DIARY_IDLE_MS = 10 * 60 * 1000;
export const DIARY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const DIARY_RECENT_MESSAGE_LIMIT = 30;
export const DIARY_MIN_MESSAGE_COUNT = 4;
export const DIARY_MIN_CHAR_COUNT = 240;
const DIARY_MAX_TAGS = 64;

const ALLOWED_TAG_PREFIXES = new Set([
  "date",
  "topic",
  "event",
  "person",
  "place",
  "emotion",
  "decision",
  "followup",
]);

export interface DiaryGenerationGateInput {
  enabled: boolean;
  nowMs: number;
  lastActivityAtMs?: number;
  lastGeneratedAtMs?: number;
  lastCheckedAtMs?: number;
  hasNewSource: boolean;
  newMessageCount: number;
  newCharCount: number;
}

export interface DiaryGenerationGateResult {
  eligible: boolean;
  reason:
    | "disabled"
    | "no_activity"
    | "chat_not_idle"
    | "check_interval_not_elapsed"
    | "no_new_source"
    | "insufficient_content"
    | "ok";
}

export function evaluateDiaryGenerationGate(
  input: DiaryGenerationGateInput,
): DiaryGenerationGateResult {
  if (!input.enabled) return { eligible: false, reason: "disabled" };
  if (!Number.isFinite(input.lastActivityAtMs)) {
    return { eligible: false, reason: "no_activity" };
  }
  if (input.nowMs - (input.lastActivityAtMs ?? 0) < DIARY_IDLE_MS) {
    return { eligible: false, reason: "chat_not_idle" };
  }
  const lastCheckMs = Math.max(
    Number.isFinite(input.lastGeneratedAtMs) ? input.lastGeneratedAtMs ?? 0 : 0,
    Number.isFinite(input.lastCheckedAtMs) ? input.lastCheckedAtMs ?? 0 : 0,
  );
  if (lastCheckMs > 0 && input.nowMs - lastCheckMs < DIARY_CHECK_INTERVAL_MS) {
    return { eligible: false, reason: "check_interval_not_elapsed" };
  }
  if (!input.hasNewSource) {
    return { eligible: false, reason: "no_new_source" };
  }
  if (
    input.newMessageCount < DIARY_MIN_MESSAGE_COUNT &&
    input.newCharCount < DIARY_MIN_CHAR_COUNT
  ) {
    return { eligible: false, reason: "insufficient_content" };
  }
  return { eligible: true, reason: "ok" };
}

export function normalizeDiaryTags(input: unknown, maxItems = DIARY_MAX_TAGS): DiaryTag[] {
  if (!Array.isArray(input)) return [];
  const result: DiaryTag[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) continue;
    const separator = normalized.indexOf(":");
    if (separator <= 0 || separator >= normalized.length - 1) continue;
    const prefix = normalized.slice(0, separator).trim().toLowerCase();
    if (!ALLOWED_TAG_PREFIXES.has(prefix)) continue;
    const suffix = normalized.slice(separator + 1).trim().replace(/\s+/g, " ");
    if (!suffix) continue;
    const boundedSuffix =
      suffix.length > 80 ? `${suffix.slice(0, 79).trimEnd()}…` : suffix;
    const tag = `${prefix}:${boundedSuffix}` as DiaryTag;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function toDiarySnippet(markdown: string, maxChars = 220) {
  const compact = markdown.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}
