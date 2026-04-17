import type { InfluenceProfile, InfluenceProfileEntry } from "./types";

const MAX_ENTRIES_PER_SECTION = 8;
const MAX_ENTRY_TEXT_LENGTH = 220;
const MAX_FREEFORM_LENGTH = 900;
const DEFAULT_STRENGTH = 50;

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function trimToLength(value: string, maxLength: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeStrength(input: unknown, fallback = DEFAULT_STRENGTH) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return clamp(input, 0, 100);
  }
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) return clamp(parsed, 0, 100);
  }
  return clamp(fallback, 0, 100);
}

function normalizeEntries(
  entries: unknown,
  fallbackStrength = DEFAULT_STRENGTH,
): InfluenceProfileEntry[] {
  if (!Array.isArray(entries)) return [];

  const normalized = entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const text = trimToLength(
        typeof record.text === "string" ? record.text : "",
        MAX_ENTRY_TEXT_LENGTH,
      );
      if (!text) return null;
      return {
        text,
        strength: normalizeStrength(record.strength, fallbackStrength),
      } satisfies InfluenceProfileEntry;
    })
    .filter((entry): entry is InfluenceProfileEntry => Boolean(entry))
    .slice(0, MAX_ENTRIES_PER_SECTION);

  const dedupe = new Set<string>();
  const result: InfluenceProfileEntry[] = [];
  for (const item of normalized) {
    const key = item.text.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    result.push(item);
  }

  return result;
}

export function createEmptyInfluenceProfile(nowIso = new Date().toISOString()): InfluenceProfile {
  return {
    enabled: false,
    thoughts: [],
    desires: [],
    goals: [],
    freeform: "",
    updatedAt: nowIso,
  };
}

export function normalizeInfluenceProfile(
  input: Partial<InfluenceProfile> | null | undefined,
  nowIso = new Date().toISOString(),
): InfluenceProfile {
  if (!input || typeof input !== "object") {
    return createEmptyInfluenceProfile(nowIso);
  }

  return {
    enabled: Boolean(input.enabled),
    thoughts: normalizeEntries(input.thoughts, 45),
    desires: normalizeEntries(input.desires, 60),
    goals: normalizeEntries(input.goals, 70),
    freeform: trimToLength(input.freeform || "", MAX_FREEFORM_LENGTH),
    updatedAt: trimToLength(input.updatedAt || "", 80) || nowIso,
  };
}

export function hasInfluenceSignal(
  profile: InfluenceProfile | null | undefined,
): profile is InfluenceProfile {
  if (!profile || !profile.enabled) return false;
  return (
    profile.thoughts.length > 0 ||
    profile.desires.length > 0 ||
    profile.goals.length > 0 ||
    Boolean(profile.freeform.trim())
  );
}

export function resolveInfluenceCurrentIntent(
  profile: InfluenceProfile | null | undefined,
): string | undefined {
  if (!hasInfluenceSignal(profile)) return undefined;
  const strongestGoal = [...profile.goals].sort((a, b) => b.strength - a.strength)[0];
  if (strongestGoal) return strongestGoal.text;
  if (profile.desires.length > 0) return profile.desires[0].text;
  if (profile.thoughts.length > 0) return profile.thoughts[0].text;
  const freeform = profile.freeform.trim();
  return freeform || undefined;
}

function renderEntries(entries: InfluenceProfileEntry[], maxItems = 4) {
  if (!entries.length) return "none";
  return entries
    .slice(0, maxItems)
    .map((entry) => `${entry.text} [${entry.strength}]`)
    .join("; ");
}

export function formatInfluenceProfileForPrompt(
  profile: InfluenceProfile | null | undefined,
  currentIntent?: string,
) {
  if (!hasInfluenceSignal(profile)) return "none";
  return [
    `enabled=${profile.enabled ? "yes" : "no"}`,
    `thoughts=${renderEntries(profile.thoughts)}`,
    `desires=${renderEntries(profile.desires)}`,
    `goals=${renderEntries(profile.goals)}`,
    `freeform=${profile.freeform.trim() || "none"}`,
    `currentIntent=${currentIntent?.trim() || resolveInfluenceCurrentIntent(profile) || "none"}`,
  ].join("\n");
}
