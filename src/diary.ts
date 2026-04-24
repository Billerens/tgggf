import type { DiaryEntry, DiaryTag, DiaryTagPrefix } from "./types";

export const DIARY_IDLE_MS = 10 * 60 * 1000;
export const DIARY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const DIARY_RECENT_MESSAGE_LIMIT = 30;
export const DIARY_MIN_MESSAGE_COUNT = 12;
export const DIARY_MIN_CHAR_COUNT = 8000;
export const DIARY_GENERATION_MAX_ENTRIES = 64;
export const DIARY_EXISTING_TAGS_LIMIT = 200;
export const DIARY_GENERATED_ENTRY_MIN_NON_DATE_TAGS = 1;
const DIARY_MAX_TAGS = 256;

export const DIARY_TAG_PREFIXES: readonly DiaryTagPrefix[] = [
  "date",
  "topic",
  "event",
  "person",
  "place",
  "emotion",
  "decision",
  "followup",
];
const DIARY_MAX_RETRIEVAL_TAGS = 256;

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
    input.newMessageCount < DIARY_MIN_MESSAGE_COUNT ||
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
    const compact = normalized.replace(/\s+/g, " ");
    const boundedTag =
      compact.length > 120 ? `${compact.slice(0, 119).trimEnd()}…` : compact;
    const tag = boundedTag as DiaryTag;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= maxItems) break;
  }
  return result;
}

export interface DiaryGeneratedEntryDraft {
  markdown: string;
  tags: string[];
}

export interface DiaryGeneratedEntryNormalized {
  markdown: string;
  tags: DiaryTag[];
}

export function isDiaryDateTag(tag: string) {
  return tag.trim().toLowerCase().startsWith("date:");
}

export function normalizeGeneratedDiaryEntries(
  entries: DiaryGeneratedEntryDraft[],
  dateTag: DiaryTag,
  maxEntries = DIARY_GENERATION_MAX_ENTRIES,
): DiaryGeneratedEntryNormalized[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const result: DiaryGeneratedEntryNormalized[] = [];
  for (const entry of entries.slice(0, Math.max(1, Math.floor(maxEntries)))) {
    const markdown = (entry?.markdown ?? "").trim();
    if (!markdown) continue;
    const normalizedTags = normalizeDiaryTags(entry?.tags ?? []);
    const nonDateTags = normalizedTags.filter((tag) => !isDiaryDateTag(tag));
    if (nonDateTags.length < DIARY_GENERATED_ENTRY_MIN_NON_DATE_TAGS) continue;
    result.push({
      markdown,
      tags: normalizeDiaryTags([dateTag, ...nonDateTags]),
    });
  }
  return result;
}

export function buildDiaryExistingTagsCatalog(
  entries: DiaryEntry[],
  nowMs = Date.now(),
  maxItems = DIARY_EXISTING_TAGS_LIMIT,
): DiaryTag[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const stats = new Map<string, { count: number; lastCreatedAtMs: number }>();
  for (const entry of entries) {
    const createdAtMs = Date.parse(entry.createdAt);
    const safeCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : 0;
    const normalizedTags = normalizeDiaryTags(entry.tags);
    for (const tag of normalizedTags) {
      if (isDiaryDateTag(tag)) continue;
      const current = stats.get(tag);
      if (!current) {
        stats.set(tag, { count: 1, lastCreatedAtMs: safeCreatedAtMs });
        continue;
      }
      current.count += 1;
      if (safeCreatedAtMs > current.lastCreatedAtMs) {
        current.lastCreatedAtMs = safeCreatedAtMs;
      }
    }
  }
  const scored = Array.from(stats.entries())
    .map(([tag, item]) => {
      const ageHours = Math.max(0, (nowMs - item.lastCreatedAtMs) / 3_600_000);
      const recencyBoost = 1 / (1 + ageHours / 12);
      const score = item.count * 10 + recencyBoost;
      return { tag: tag as DiaryTag, score, lastCreatedAtMs: item.lastCreatedAtMs };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.lastCreatedAtMs !== a.lastCreatedAtMs) {
        return b.lastCreatedAtMs - a.lastCreatedAtMs;
      }
      return a.tag.localeCompare(b.tag);
    });
  return scored.slice(0, Math.max(1, Math.floor(maxItems))).map((item) => item.tag);
}

export function refineDiaryTagsForRetrieval(
  tags: DiaryTag[],
  maxItems = DIARY_MAX_RETRIEVAL_TAGS,
): DiaryTag[] {
  return normalizeDiaryTags(tags, maxItems);
}

export function toDiarySnippet(markdown: string, maxChars = 220) {
  const compact = markdown.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}
