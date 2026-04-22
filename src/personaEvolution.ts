import type {
  ChatEvolutionConfig,
  Persona,
  PersonaBehaviorProfile,
  PersonaCoreProfile,
  PersonaEmotionProfile,
  PersonaEvolutionHistoryItem,
  PersonaEvolutionProfile,
  PersonaEvolutionState,
  PersonaMemoryPolicy,
  PersonaSelfGender,
  PersonaVoiceProfile,
} from "./types";

const SELF_GENDER_VALUES = new Set<"auto" | "female" | "male" | "neutral">([
  "auto",
  "female",
  "male",
  "neutral",
]);

export const DEFAULT_CHAT_EVOLUTION_CONFIG: ChatEvolutionConfig = {
  enabled: false,
  applyMode: "manual",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickFirstDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === undefined || value === null) continue;
    return value;
  }
  return undefined;
}

function normalizeSelfGender(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as PersonaSelfGender;
  return SELF_GENDER_VALUES.has(normalized) ? normalized : undefined;
}

function normalizeAppearancePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: NonNullable<PersonaEvolutionProfile["appearance"]> = {};
  const fields = [
    ["faceDescription", ["faceDescription", "face_description"]],
    ["height", ["height"]],
    ["eyes", ["eyes"]],
    ["lips", ["lips"]],
    ["hair", ["hair"]],
    ["ageType", ["ageType", "age_type"]],
    ["bodyType", ["bodyType", "body_type"]],
    ["markers", ["markers"]],
    ["accessories", ["accessories"]],
    ["clothingStyle", ["clothingStyle", "clothing_style"]],
    ["skin", ["skin"]],
  ] as const;
  for (const [field, aliases] of fields) {
    const value = toTrimmedString(pickFirstDefined(input, aliases));
    if (!value) continue;
    next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeCorePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaCoreProfile> = {};
  const textFields = [
    ["archetype", ["archetype"]],
    ["backstory", ["backstory"]],
    ["goals", ["goals"]],
    ["values", ["values"]],
    ["boundaries", ["boundaries"]],
    ["expertise", ["expertise"]],
  ] as const;
  for (const [field, aliases] of textFields) {
    const value = toTrimmedString(pickFirstDefined(input, aliases));
    if (!value) continue;
    next[field] = value;
  }
  const selfGender = normalizeSelfGender(pickFirstDefined(input, ["selfGender", "self_gender"]));
  if (selfGender) next.selfGender = selfGender;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeVoicePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaVoiceProfile> = {};
  const tone = toTrimmedString(pickFirstDefined(input, ["tone"]));
  if (tone) next.tone = tone;
  const lexicalStyle = toTrimmedString(
    pickFirstDefined(input, ["lexicalStyle", "lexical_style"]),
  );
  if (lexicalStyle) next.lexicalStyle = lexicalStyle;
  const sentenceLength = toTrimmedString(
    pickFirstDefined(input, ["sentenceLength", "sentence_length"]),
  );
  if (
    sentenceLength === "short" ||
    sentenceLength === "balanced" ||
    sentenceLength === "long"
  ) {
    next.sentenceLength = sentenceLength;
  }
  const formality = toFiniteNumber(pickFirstDefined(input, ["formality"]));
  if (typeof formality === "number") next.formality = formality;
  const expressiveness = toFiniteNumber(
    pickFirstDefined(input, ["expressiveness"]),
  );
  if (typeof expressiveness === "number") next.expressiveness = expressiveness;
  const emoji = toFiniteNumber(pickFirstDefined(input, ["emoji"]));
  if (typeof emoji === "number") next.emoji = emoji;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeBehaviorPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaBehaviorProfile> = {};
  const fields = [
    ["initiative", ["initiative"]],
    ["empathy", ["empathy"]],
    ["directness", ["directness"]],
    ["curiosity", ["curiosity"]],
    ["challenge", ["challenge"]],
    ["creativity", ["creativity"]],
  ] as const;
  for (const [field, aliases] of fields) {
    const value = toFiniteNumber(pickFirstDefined(input, aliases));
    if (typeof value !== "number") continue;
    next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeEmotionPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaEmotionProfile> = {};
  const baselineMood = toTrimmedString(
    pickFirstDefined(input, ["baselineMood", "baseline_mood"]),
  );
  if (baselineMood) {
    next.baselineMood = baselineMood as PersonaEmotionProfile["baselineMood"];
  }
  const warmth = toFiniteNumber(pickFirstDefined(input, ["warmth"]));
  if (typeof warmth === "number") next.warmth = warmth;
  const stability = toFiniteNumber(pickFirstDefined(input, ["stability"]));
  if (typeof stability === "number") next.stability = stability;
  const positiveTriggers = toTrimmedString(
    pickFirstDefined(input, ["positiveTriggers", "positive_triggers"]),
  );
  if (positiveTriggers) next.positiveTriggers = positiveTriggers;
  const negativeTriggers = toTrimmedString(
    pickFirstDefined(input, ["negativeTriggers", "negative_triggers"]),
  );
  if (negativeTriggers) next.negativeTriggers = negativeTriggers;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeMemoryPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaMemoryPolicy> = {};
  const boolFields = [
    ["rememberFacts", ["rememberFacts", "remember_facts"]],
    ["rememberPreferences", ["rememberPreferences", "remember_preferences"]],
    ["rememberGoals", ["rememberGoals", "remember_goals"]],
    ["rememberEvents", ["rememberEvents", "remember_events"]],
  ] as const;
  for (const [field, aliases] of boolFields) {
    const value = pickFirstDefined(input, aliases);
    if (typeof value !== "boolean") continue;
    next[field] = value;
  }
  const maxMemories = toFiniteNumber(
    pickFirstDefined(input, ["maxMemories", "max_memories"]),
  );
  if (typeof maxMemories === "number") next.maxMemories = maxMemories;
  const decayDays = toFiniteNumber(
    pickFirstDefined(input, ["decayDays", "decay_days"]),
  );
  if (typeof decayDays === "number") next.decayDays = decayDays;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAdvancedPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: NonNullable<PersonaEvolutionProfile["advanced"]> = {};
  const core = normalizeCorePatch(pickFirstDefined(input, ["core"]));
  if (core) next.core = core;
  const voice = normalizeVoicePatch(pickFirstDefined(input, ["voice"]));
  if (voice) next.voice = voice;
  const behavior = normalizeBehaviorPatch(
    pickFirstDefined(input, ["behavior"]),
  );
  if (behavior) next.behavior = behavior;
  const emotion = normalizeEmotionPatch(pickFirstDefined(input, ["emotion"]));
  if (emotion) next.emotion = emotion;
  const memory = normalizeMemoryPatch(pickFirstDefined(input, ["memory"]));
  if (memory) next.memory = memory;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizePersonaEvolutionPatch(
  input: unknown,
): PersonaEvolutionProfile | undefined {
  if (!isRecord(input)) return undefined;
  const patch: PersonaEvolutionProfile = {};
  const personalityPrompt = toTrimmedString(
    pickFirstDefined(input, ["personalityPrompt", "personality_prompt"]),
  );
  if (personalityPrompt) patch.personalityPrompt = personalityPrompt;
  const stylePrompt = toTrimmedString(
    pickFirstDefined(input, ["stylePrompt", "style_prompt"]),
  );
  if (stylePrompt) patch.stylePrompt = stylePrompt;
  const appearance = normalizeAppearancePatch(
    pickFirstDefined(input, ["appearance"]),
  );
  if (appearance) patch.appearance = appearance;
  const advanced = normalizeAdvancedPatch(
    pickFirstDefined(input, ["advanced"]),
  );
  if (advanced) patch.advanced = advanced;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function normalizeChatEvolutionConfig(
  input: unknown,
): ChatEvolutionConfig {
  if (!isRecord(input)) return { ...DEFAULT_CHAT_EVOLUTION_CONFIG };
  const applyMode = input.applyMode === "auto" ? "auto" : "manual";
  return {
    enabled: Boolean(input.enabled),
    applyMode,
  };
}

export function extractPersonaEvolutionBaselineProfile(
  persona: Persona,
): PersonaEvolutionProfile {
  return {
    personalityPrompt: persona.personalityPrompt,
    stylePrompt: persona.stylePrompt,
    appearance: { ...persona.appearance },
    advanced: {
      core: { ...persona.advanced.core },
      voice: { ...persona.advanced.voice },
      behavior: { ...persona.advanced.behavior },
      emotion: { ...persona.advanced.emotion },
      memory: { ...persona.advanced.memory },
    },
  };
}

function mergeAdvancedProfile(
  base: PersonaEvolutionProfile["advanced"],
  patch: PersonaEvolutionProfile["advanced"],
) {
  if (!patch) return base;
  return {
    core: patch.core ? { ...base?.core, ...patch.core } : base?.core,
    voice: patch.voice ? { ...base?.voice, ...patch.voice } : base?.voice,
    behavior: patch.behavior
      ? { ...base?.behavior, ...patch.behavior }
      : base?.behavior,
    emotion: patch.emotion
      ? { ...base?.emotion, ...patch.emotion }
      : base?.emotion,
    memory: patch.memory ? { ...base?.memory, ...patch.memory } : base?.memory,
  };
}

export function applyPersonaEvolutionPatch(
  current: PersonaEvolutionProfile,
  patch: PersonaEvolutionProfile,
): PersonaEvolutionProfile {
  return {
    personalityPrompt: patch.personalityPrompt ?? current.personalityPrompt,
    stylePrompt: patch.stylePrompt ?? current.stylePrompt,
    appearance: patch.appearance
      ? { ...current.appearance, ...patch.appearance }
      : current.appearance,
    advanced: mergeAdvancedProfile(current.advanced, patch.advanced),
  };
}

export function applyPersonaEvolutionProfile(
  persona: Persona,
  profile: PersonaEvolutionProfile | undefined,
): Persona {
  if (!profile) return persona;
  const appearance = profile.appearance
    ? { ...persona.appearance, ...profile.appearance }
    : persona.appearance;
  const advanced = profile.advanced
    ? {
        ...persona.advanced,
        core: profile.advanced.core
          ? { ...persona.advanced.core, ...profile.advanced.core }
          : persona.advanced.core,
        voice: profile.advanced.voice
          ? { ...persona.advanced.voice, ...profile.advanced.voice }
          : persona.advanced.voice,
        behavior: profile.advanced.behavior
          ? { ...persona.advanced.behavior, ...profile.advanced.behavior }
          : persona.advanced.behavior,
        emotion: profile.advanced.emotion
          ? { ...persona.advanced.emotion, ...profile.advanced.emotion }
          : persona.advanced.emotion,
        memory: profile.advanced.memory
          ? { ...persona.advanced.memory, ...profile.advanced.memory }
          : persona.advanced.memory,
      }
    : persona.advanced;
  return {
    ...persona,
    personalityPrompt: profile.personalityPrompt ?? persona.personalityPrompt,
    stylePrompt: profile.stylePrompt ?? persona.stylePrompt,
    appearance,
    advanced,
  };
}

export function createInitialPersonaEvolutionState(
  chatId: string,
  persona: Persona,
  timestamp: string,
): PersonaEvolutionState {
  const baselineProfile = extractPersonaEvolutionBaselineProfile(persona);
  return {
    chatId,
    personaId: persona.id,
    baselineProfile,
    currentProfile: baselineProfile,
    pendingProposals: [],
    history: [],
    updatedAt: timestamp,
  };
}

export function normalizePersonaEvolutionState(
  state: PersonaEvolutionState | undefined,
  chatId: string,
  persona: Persona,
): PersonaEvolutionState {
  if (!state) {
    return createInitialPersonaEvolutionState(chatId, persona, new Date().toISOString());
  }
  const baselineFallback = extractPersonaEvolutionBaselineProfile(persona);
  const baselineProfile = state.baselineProfile || baselineFallback;
  const currentProfile = state.currentProfile || baselineProfile;
  return {
    chatId,
    personaId: persona.id,
    baselineProfile,
    currentProfile,
    pendingProposals: Array.isArray(state.pendingProposals)
      ? state.pendingProposals
      : [],
    history: Array.isArray(state.history) ? state.history : [],
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

function flattenPatchFields(
  patch: PersonaEvolutionProfile,
  prefix = "",
): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      fields.push(...flattenPatchFields(value as PersonaEvolutionProfile, field));
      continue;
    }
    fields.push(field);
  }
  return fields;
}

export function summarizePersonaEvolutionPatchFields(
  patch: PersonaEvolutionProfile,
  maxItems = 12,
): string[] {
  return flattenPatchFields(patch).slice(0, Math.max(1, maxItems));
}

function readProfilePathValue(
  profile: PersonaEvolutionProfile,
  path: string,
): unknown {
  const parts = path.split(".");
  let cursor: unknown = profile;
  for (const part of parts) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function collectProfileLeafPaths(
  profile: PersonaEvolutionProfile,
  prefix = "",
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      paths.push(...collectProfileLeafPaths(value as PersonaEvolutionProfile, field));
      continue;
    }
    paths.push(field);
  }
  return paths;
}

function formatDeltaValue(value: unknown) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") {
    const compact = clipPromptLine(value, 120);
    return compact || '""';
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return clipPromptLine(String(value), 120) || "—";
}

function sameDeltaValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface PersonaEvolutionFieldDelta {
  field: string;
  before: string;
  after: string;
}

const EVOLUTION_FIELD_LABELS: Record<string, string> = {
  personalityPrompt: "Личностный промпт",
  stylePrompt: "Стиль ответа",
  "appearance.faceDescription": "Внешность: лицо",
  "appearance.height": "Внешность: рост",
  "appearance.eyes": "Внешность: глаза",
  "appearance.lips": "Внешность: губы",
  "appearance.hair": "Внешность: волосы",
  "appearance.ageType": "Внешность: возрастной тип",
  "appearance.bodyType": "Внешность: телосложение",
  "appearance.markers": "Внешность: особенности",
  "appearance.accessories": "Внешность: аксессуары",
  "appearance.clothingStyle": "Внешность: стиль одежды",
  "appearance.skin": "Внешность: кожа",
  "advanced.core.archetype": "Ядро: архетип",
  "advanced.core.backstory": "Ядро: история",
  "advanced.core.goals": "Ядро: цели",
  "advanced.core.values": "Ядро: ценности",
  "advanced.core.boundaries": "Ядро: границы",
  "advanced.core.expertise": "Ядро: экспертиза",
  "advanced.core.selfGender": "Ядро: самогендер",
  "advanced.voice.tone": "Голос: тон",
  "advanced.voice.lexicalStyle": "Голос: лексика",
  "advanced.voice.sentenceLength": "Голос: длина фраз",
  "advanced.voice.formality": "Голос: формальность",
  "advanced.voice.expressiveness": "Голос: выразительность",
  "advanced.voice.emoji": "Голос: emoji",
  "advanced.behavior.initiative": "Поведение: инициативность",
  "advanced.behavior.empathy": "Поведение: эмпатия",
  "advanced.behavior.directness": "Поведение: прямота",
  "advanced.behavior.curiosity": "Поведение: любопытство",
  "advanced.behavior.challenge": "Поведение: вызов",
  "advanced.behavior.creativity": "Поведение: креативность",
  "advanced.emotion.baselineMood": "Эмоции: базовое настроение",
  "advanced.emotion.warmth": "Эмоции: теплота",
  "advanced.emotion.stability": "Эмоции: стабильность",
  "advanced.emotion.positiveTriggers": "Эмоции: позитивные триггеры",
  "advanced.emotion.negativeTriggers": "Эмоции: негативные триггеры",
  "advanced.memory.rememberFacts": "Память: факты",
  "advanced.memory.rememberPreferences": "Память: предпочтения",
  "advanced.memory.rememberGoals": "Память: цели",
  "advanced.memory.rememberEvents": "Память: события",
  "advanced.memory.maxMemories": "Память: лимит",
  "advanced.memory.decayDays": "Память: затухание (дни)",
};

function humanizePathSegment(segment: string) {
  const withSpaces = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  if (!withSpaces) return segment;
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

export function formatPersonaEvolutionFieldLabel(fieldPath: string) {
  if (!fieldPath) return "Поле";
  const mapped = EVOLUTION_FIELD_LABELS[fieldPath];
  if (mapped) return mapped;
  return fieldPath.split(".").map(humanizePathSegment).join(" -> ");
}

export function buildPersonaEvolutionProfileDeltaRows(
  before: PersonaEvolutionProfile,
  after: PersonaEvolutionProfile,
  maxItems = 12,
  fieldOrder?: string[],
): PersonaEvolutionFieldDelta[] {
  const limit = Math.max(1, maxItems);
  const orderedFields = fieldOrder
    ? fieldOrder
    : Array.from(
        new Set([
          ...collectProfileLeafPaths(before),
          ...collectProfileLeafPaths(after),
        ]),
      );
  const deltas: PersonaEvolutionFieldDelta[] = [];
  for (const field of orderedFields) {
    const beforeValue = readProfilePathValue(before, field);
    const afterValue = readProfilePathValue(after, field);
    if (sameDeltaValue(beforeValue, afterValue)) continue;
    deltas.push({
      field,
      before: formatDeltaValue(beforeValue),
      after: formatDeltaValue(afterValue),
    });
    if (deltas.length >= limit) break;
  }
  return deltas;
}

export function buildPersonaEvolutionPatchDeltaRows(
  before: PersonaEvolutionProfile,
  patch: PersonaEvolutionProfile,
  maxItems = 12,
): PersonaEvolutionFieldDelta[] {
  const nextProfile = applyPersonaEvolutionPatch(before, patch);
  const fields = summarizePersonaEvolutionPatchFields(patch, Math.max(1, maxItems) * 2);
  return buildPersonaEvolutionProfileDeltaRows(
    before,
    nextProfile,
    maxItems,
    fields,
  );
}

export function selectAppliedPersonaEvolutionHistory(
  history: PersonaEvolutionHistoryItem[],
) {
  const undoneEventIds = new Set(
    history
      .filter((event) => event.status === "undone")
      .map((event) => event.targetEventId)
      .filter((value): value is string => Boolean(value)),
  );
  return history.filter(
    (event) => event.status === "applied" && !undoneEventIds.has(event.id),
  );
}

function clipPromptLine(value: string, max = 220) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatPersonaEvolutionHistoryForPrompt(
  history: PersonaEvolutionHistoryItem[],
  limit = 10,
) {
  const applied = selectAppliedPersonaEvolutionHistory(history).slice(
    -Math.max(1, limit),
  );
  if (applied.length === 0) return "none";
  return applied
    .map((event) => {
      const reason = clipPromptLine(event.reason || "-", 180) || "-";
      const changedFields = summarizePersonaEvolutionPatchFields(event.patch, 10);
      const changedLabel =
        changedFields.length > 0 ? changedFields.join(", ") : "patch";
      return `- ${event.timestamp}: reason=${reason}; changed=${changedLabel}`;
    })
    .join("\n");
}
