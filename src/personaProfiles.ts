import type {
  MoodId,
  Persona,
  PersonaAdvancedProfile,
  PersonaBehaviorProfile,
  PersonaCoreProfile,
  PersonaEmotionProfile,
  PersonaMemoryPolicy,
  PersonaVoiceProfile,
} from "./types";

const DEFAULT_CORE: PersonaCoreProfile = {
  archetype: "Поддерживающий собеседник",
  backstory: "",
  goals: "Помогать пользователю продвигаться к целям и сохранять ясность.",
  values: "Уважение, честность, практичность.",
  boundaries: "Не придумывает факты и прямо говорит о неопределенности.",
  expertise: "Коммуникация, структурирование задач, повседневная помощь.",
  selfGender: "auto",
};

const DEFAULT_VOICE: PersonaVoiceProfile = {
  tone: "Доброжелательный и спокойный",
  lexicalStyle: "Понятные формулировки без канцелярита",
  sentenceLength: "balanced",
  formality: 45,
  expressiveness: 50,
  emoji: 5,
};

const DEFAULT_BEHAVIOR: PersonaBehaviorProfile = {
  initiative: 50,
  empathy: 65,
  directness: 55,
  curiosity: 50,
  challenge: 30,
  creativity: 45,
};

const DEFAULT_EMOTION: PersonaEmotionProfile = {
  baselineMood: "warm",
  warmth: 65,
  stability: 60,
  positiveTriggers: "Прогресс в задаче, вежливый тон, конкретные вопросы.",
  negativeTriggers: "Агрессия, токсичность, повторение без новой информации.",
};

const DEFAULT_MEMORY: PersonaMemoryPolicy = {
  rememberFacts: true,
  rememberPreferences: true,
  rememberGoals: true,
  rememberEvents: true,
  maxMemories: 24,
  decayDays: 30,
};

const MOOD_LABELS: Record<MoodId, string> = {
  calm: "спокойное",
  warm: "теплое",
  playful: "игривое",
  focused: "сфокусированное",
  analytical: "аналитичное",
  inspired: "вдохновленное",
  annoyed: "раздраженное",
  upset: "расстроенное",
  angry: "злое",
};

function clamp0to100(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampPositiveInt(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeCore(input: Partial<PersonaCoreProfile> | undefined): PersonaCoreProfile {
  const selfGender = input?.selfGender;
  return {
    archetype: cleanText(input?.archetype, DEFAULT_CORE.archetype),
    backstory: cleanText(input?.backstory, DEFAULT_CORE.backstory),
    goals: cleanText(input?.goals, DEFAULT_CORE.goals),
    values: cleanText(input?.values, DEFAULT_CORE.values),
    boundaries: cleanText(input?.boundaries, DEFAULT_CORE.boundaries),
    expertise: cleanText(input?.expertise, DEFAULT_CORE.expertise),
    selfGender:
      selfGender === "auto" || selfGender === "female" || selfGender === "male" || selfGender === "neutral"
        ? selfGender
        : DEFAULT_CORE.selfGender,
  };
}

function normalizeVoice(input: Partial<PersonaVoiceProfile> | undefined): PersonaVoiceProfile {
  const sentenceLength = input?.sentenceLength;
  return {
    tone: cleanText(input?.tone, DEFAULT_VOICE.tone),
    lexicalStyle: cleanText(input?.lexicalStyle, DEFAULT_VOICE.lexicalStyle),
    sentenceLength:
      sentenceLength === "short" || sentenceLength === "balanced" || sentenceLength === "long"
        ? sentenceLength
        : DEFAULT_VOICE.sentenceLength,
    formality: clamp0to100(input?.formality ?? DEFAULT_VOICE.formality, DEFAULT_VOICE.formality),
    expressiveness: clamp0to100(
      input?.expressiveness ?? DEFAULT_VOICE.expressiveness,
      DEFAULT_VOICE.expressiveness,
    ),
    emoji: clamp0to100(input?.emoji ?? DEFAULT_VOICE.emoji, DEFAULT_VOICE.emoji),
  };
}

function normalizeBehavior(
  input: Partial<PersonaBehaviorProfile> | undefined,
): PersonaBehaviorProfile {
  return {
    initiative: clamp0to100(input?.initiative ?? DEFAULT_BEHAVIOR.initiative, DEFAULT_BEHAVIOR.initiative),
    empathy: clamp0to100(input?.empathy ?? DEFAULT_BEHAVIOR.empathy, DEFAULT_BEHAVIOR.empathy),
    directness: clamp0to100(input?.directness ?? DEFAULT_BEHAVIOR.directness, DEFAULT_BEHAVIOR.directness),
    curiosity: clamp0to100(input?.curiosity ?? DEFAULT_BEHAVIOR.curiosity, DEFAULT_BEHAVIOR.curiosity),
    challenge: clamp0to100(input?.challenge ?? DEFAULT_BEHAVIOR.challenge, DEFAULT_BEHAVIOR.challenge),
    creativity: clamp0to100(input?.creativity ?? DEFAULT_BEHAVIOR.creativity, DEFAULT_BEHAVIOR.creativity),
  };
}

function normalizeEmotion(input: Partial<PersonaEmotionProfile> | undefined): PersonaEmotionProfile {
  const baselineMood = input?.baselineMood;
  const mood: MoodId =
    baselineMood === "calm" ||
    baselineMood === "warm" ||
    baselineMood === "playful" ||
    baselineMood === "focused" ||
    baselineMood === "analytical" ||
    baselineMood === "inspired" ||
    baselineMood === "annoyed" ||
    baselineMood === "upset" ||
    baselineMood === "angry"
      ? baselineMood
      : DEFAULT_EMOTION.baselineMood;

  return {
    baselineMood: mood,
    warmth: clamp0to100(input?.warmth ?? DEFAULT_EMOTION.warmth, DEFAULT_EMOTION.warmth),
    stability: clamp0to100(input?.stability ?? DEFAULT_EMOTION.stability, DEFAULT_EMOTION.stability),
    positiveTriggers: cleanText(input?.positiveTriggers, DEFAULT_EMOTION.positiveTriggers),
    negativeTriggers: cleanText(input?.negativeTriggers, DEFAULT_EMOTION.negativeTriggers),
  };
}

function normalizeMemory(input: Partial<PersonaMemoryPolicy> | undefined): PersonaMemoryPolicy {
  return {
    rememberFacts: typeof input?.rememberFacts === "boolean" ? input.rememberFacts : DEFAULT_MEMORY.rememberFacts,
    rememberPreferences:
      typeof input?.rememberPreferences === "boolean"
        ? input.rememberPreferences
        : DEFAULT_MEMORY.rememberPreferences,
    rememberGoals: typeof input?.rememberGoals === "boolean" ? input.rememberGoals : DEFAULT_MEMORY.rememberGoals,
    rememberEvents:
      typeof input?.rememberEvents === "boolean" ? input.rememberEvents : DEFAULT_MEMORY.rememberEvents,
    maxMemories: clampPositiveInt(input?.maxMemories ?? DEFAULT_MEMORY.maxMemories, DEFAULT_MEMORY.maxMemories, 4, 120),
    decayDays: clampPositiveInt(input?.decayDays ?? DEFAULT_MEMORY.decayDays, DEFAULT_MEMORY.decayDays, 1, 365),
  };
}

export function createDefaultAdvancedProfile(): PersonaAdvancedProfile {
  return {
    core: { ...DEFAULT_CORE },
    voice: { ...DEFAULT_VOICE },
    behavior: { ...DEFAULT_BEHAVIOR },
    emotion: { ...DEFAULT_EMOTION },
    memory: { ...DEFAULT_MEMORY },
  };
}

export function normalizeAdvancedProfile(
  input: Partial<PersonaAdvancedProfile> | undefined,
): PersonaAdvancedProfile {
  return {
    core: normalizeCore(input?.core),
    voice: normalizeVoice(input?.voice),
    behavior: normalizeBehavior(input?.behavior),
    emotion: normalizeEmotion(input?.emotion),
    memory: normalizeMemory(input?.memory),
  };
}

export function buildAdvancedProfileFromLegacy(persona: Pick<Persona, "personalityPrompt" | "stylePrompt">) {
  const defaults = createDefaultAdvancedProfile();
  const style = persona.stylePrompt.trim();
  const character = persona.personalityPrompt.trim();

  if (style) {
    defaults.voice.tone = style;
    defaults.voice.lexicalStyle = style;
  }

  if (character) {
    defaults.core.archetype = character.slice(0, 96);
    defaults.core.values = character;
  }

  return defaults;
}

type LegacyPersonaRecord = Omit<
  Persona,
  "advanced" | "fullBodyUrl" | "fullBodySideUrl" | "fullBodyBackUrl" | "imageCheckpoint"
> & {
  advanced?: Partial<PersonaAdvancedProfile>;
  fullBodyUrl?: string;
  fullBodySideUrl?: string;
  fullBodyBackUrl?: string;
  imageCheckpoint?: string;
};

export function normalizePersonaRecord(persona: LegacyPersonaRecord): Persona {
  return {
    ...persona,
    imageCheckpoint: cleanText(persona.imageCheckpoint),
    fullBodyUrl: cleanText(persona.fullBodyUrl),
    fullBodySideUrl: cleanText(persona.fullBodySideUrl),
    fullBodyBackUrl: cleanText(persona.fullBodyBackUrl),
    advanced: normalizeAdvancedProfile(persona.advanced ?? buildAdvancedProfileFromLegacy(persona)),
  };
}

export function getMoodLabel(mood: MoodId) {
  return MOOD_LABELS[mood];
}
