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

function normalizeSelfGender(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as PersonaSelfGender;
  return SELF_GENDER_VALUES.has(normalized) ? normalized : undefined;
}

function normalizeAppearancePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: NonNullable<PersonaEvolutionProfile["appearance"]> = {};
  const fields = [
    "faceDescription",
    "height",
    "eyes",
    "lips",
    "hair",
    "ageType",
    "bodyType",
    "markers",
    "accessories",
    "clothingStyle",
    "skin",
  ] as const;
  for (const field of fields) {
    const value = toTrimmedString(input[field]);
    if (!value) continue;
    next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeCorePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaCoreProfile> = {};
  const textFields = [
    "archetype",
    "backstory",
    "goals",
    "values",
    "boundaries",
    "expertise",
  ] as const;
  for (const field of textFields) {
    const value = toTrimmedString(input[field]);
    if (!value) continue;
    next[field] = value;
  }
  const selfGender = normalizeSelfGender(input.selfGender);
  if (selfGender) next.selfGender = selfGender;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeVoicePatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaVoiceProfile> = {};
  const tone = toTrimmedString(input.tone);
  if (tone) next.tone = tone;
  const lexicalStyle = toTrimmedString(input.lexicalStyle);
  if (lexicalStyle) next.lexicalStyle = lexicalStyle;
  const sentenceLength = toTrimmedString(input.sentenceLength);
  if (
    sentenceLength === "short" ||
    sentenceLength === "balanced" ||
    sentenceLength === "long"
  ) {
    next.sentenceLength = sentenceLength;
  }
  const formality = toFiniteNumber(input.formality);
  if (typeof formality === "number") next.formality = formality;
  const expressiveness = toFiniteNumber(input.expressiveness);
  if (typeof expressiveness === "number") next.expressiveness = expressiveness;
  const emoji = toFiniteNumber(input.emoji);
  if (typeof emoji === "number") next.emoji = emoji;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeBehaviorPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaBehaviorProfile> = {};
  const fields = [
    "initiative",
    "empathy",
    "directness",
    "curiosity",
    "challenge",
    "creativity",
  ] as const;
  for (const field of fields) {
    const value = toFiniteNumber(input[field]);
    if (typeof value !== "number") continue;
    next[field] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeEmotionPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaEmotionProfile> = {};
  const baselineMood = toTrimmedString(input.baselineMood);
  if (baselineMood) {
    next.baselineMood = baselineMood as PersonaEmotionProfile["baselineMood"];
  }
  const warmth = toFiniteNumber(input.warmth);
  if (typeof warmth === "number") next.warmth = warmth;
  const stability = toFiniteNumber(input.stability);
  if (typeof stability === "number") next.stability = stability;
  const positiveTriggers = toTrimmedString(input.positiveTriggers);
  if (positiveTriggers) next.positiveTriggers = positiveTriggers;
  const negativeTriggers = toTrimmedString(input.negativeTriggers);
  if (negativeTriggers) next.negativeTriggers = negativeTriggers;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeMemoryPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: Partial<PersonaMemoryPolicy> = {};
  const boolFields = [
    "rememberFacts",
    "rememberPreferences",
    "rememberGoals",
    "rememberEvents",
  ] as const;
  for (const field of boolFields) {
    if (typeof input[field] !== "boolean") continue;
    next[field] = input[field];
  }
  const maxMemories = toFiniteNumber(input.maxMemories);
  if (typeof maxMemories === "number") next.maxMemories = maxMemories;
  const decayDays = toFiniteNumber(input.decayDays);
  if (typeof decayDays === "number") next.decayDays = decayDays;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAdvancedPatch(input: unknown) {
  if (!isRecord(input)) return undefined;
  const next: NonNullable<PersonaEvolutionProfile["advanced"]> = {};
  const core = normalizeCorePatch(input.core);
  if (core) next.core = core;
  const voice = normalizeVoicePatch(input.voice);
  if (voice) next.voice = voice;
  const behavior = normalizeBehaviorPatch(input.behavior);
  if (behavior) next.behavior = behavior;
  const emotion = normalizeEmotionPatch(input.emotion);
  if (emotion) next.emotion = emotion;
  const memory = normalizeMemoryPatch(input.memory);
  if (memory) next.memory = memory;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizePersonaEvolutionPatch(
  input: unknown,
): PersonaEvolutionProfile | undefined {
  if (!isRecord(input)) return undefined;
  const patch: PersonaEvolutionProfile = {};
  const personalityPrompt = toTrimmedString(input.personalityPrompt);
  if (personalityPrompt) patch.personalityPrompt = personalityPrompt;
  const stylePrompt = toTrimmedString(input.stylePrompt);
  if (stylePrompt) patch.stylePrompt = stylePrompt;
  const appearance = normalizeAppearancePatch(input.appearance);
  if (appearance) patch.appearance = appearance;
  const advanced = normalizeAdvancedPatch(input.advanced);
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
