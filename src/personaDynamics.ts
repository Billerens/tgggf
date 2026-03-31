import type {
  ChatMessage,
  Persona,
  PersonaMemory,
  PersonaMemoryKind,
  PersonaMemoryLayer,
  PersonaRuntimeState,
  RelationshipStage,
  RelationshipType,
} from "./types";

interface LegacyMemoryRecord extends Omit<PersonaMemory, "layer"> {
  layer?: PersonaMemoryLayer;
}

export interface LayeredMemoryContextCard {
  shortTerm: string[];
  episodic: PersonaMemory[];
  longTerm: PersonaMemory[];
}

export interface PersonaControlPayload {
  intents?: string[];
  state_delta?: {
    trust?: number;
    engagement?: number;
    energy?: number;
    lust?: number;
    fear?: number;
    affection?: number;
    tension?: number;
    mood?: PersonaRuntimeState["mood"];
    relationshipType?: RelationshipType;
    relationshipDepth?: number;
    relationshipStage?: RelationshipStage;
    activeTopicsAdd?: string[];
  };
  memory_add?: Array<{
    layer?: PersonaMemoryLayer;
    kind?: PersonaMemoryKind;
    content?: string;
    salience?: number;
  }>;
  memory_remove?: Array<{
    id?: string;
    layer?: PersonaMemoryLayer;
    kind?: PersonaMemoryKind;
    content?: string;
  }>;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeTopics(topics: string[]) {
  const unique = new Set(
    topics
      .map((topic) => topic.trim().toLowerCase())
      .filter((topic) => topic.length >= 3)
      .slice(0, 12),
  );
  return Array.from(unique);
}

function inferTopicsFromMessage(text: string) {
  return normalizeTopics(
    text
      .split(/[,.!?;:\n]/g)
      .map((part) => part.trim())
      .filter((part) => part.length > 4)
      .map((part) => part.split(" ").slice(0, 4).join(" ")),
  );
}

export function relationshipStageFromDepth(depth: number): RelationshipStage {
  if (depth >= 85) return "bonded";
  if (depth >= 65) return "close";
  if (depth >= 45) return "friendly";
  if (depth >= 25) return "acquaintance";
  return "new";
}

function relationshipDepthFromTrust(trust: number) {
  return clamp(Math.round(trust * 0.9), 0, 100);
}

function relationshipDepthRange(stage: RelationshipStage): { min: number; max: number } {
  if (stage === "new") return { min: 0, max: 24 };
  if (stage === "acquaintance") return { min: 25, max: 44 };
  if (stage === "friendly") return { min: 45, max: 64 };
  if (stage === "close") return { min: 65, max: 84 };
  return { min: 85, max: 100 };
}

function alignDepthToStage(depth: number, stage: RelationshipStage) {
  const range = relationshipDepthRange(stage);
  if (depth >= range.min && depth <= range.max) return depth;
  return clamp(Math.round((range.min + range.max) / 2), 0, 100);
}

function isValidMood(value: unknown): value is PersonaRuntimeState["mood"] {
  return (
    value === "calm" ||
    value === "warm" ||
    value === "playful" ||
    value === "focused" ||
    value === "analytical" ||
    value === "inspired" ||
    value === "annoyed" ||
    value === "upset" ||
    value === "angry"
  );
}

function isValidRelationshipStage(value: unknown): value is RelationshipStage {
  return (
    value === "new" ||
    value === "acquaintance" ||
    value === "friendly" ||
    value === "close" ||
    value === "bonded"
  );
}

function isValidRelationshipType(value: unknown): value is RelationshipType {
  return (
    value === "neutral" ||
    value === "friendship" ||
    value === "romantic" ||
    value === "mentor" ||
    value === "playful"
  );
}

function isValidMemoryLayer(value: unknown): value is PersonaMemoryLayer {
  return value === "short_term" || value === "episodic" || value === "long_term";
}

function isValidMemoryKind(value: unknown): value is PersonaMemoryKind {
  return value === "fact" || value === "preference" || value === "goal" || value === "event";
}

function normalizeState(state: PersonaRuntimeState, personaId: string, chatId: string): PersonaRuntimeState {
  const rawType = (state as Partial<PersonaRuntimeState>).relationshipType;
  const rawDepth = (state as Partial<PersonaRuntimeState>).relationshipDepth;
  const relationshipType = isValidRelationshipType(rawType) ? rawType : "neutral";
  const relationshipDepth = Number.isFinite(rawDepth)
    ? clamp(Number(rawDepth), 0, 100)
    : relationshipDepthFromTrust(state.trust);

  return {
    ...state,
    personaId,
    chatId,
    trust: clamp(state.trust, 0, 100),
    energy: clamp(state.energy, 0, 100),
    engagement: clamp(state.engagement, 0, 100),
    lust: clamp(
      Number.isFinite((state as Partial<PersonaRuntimeState>).lust)
        ? Number((state as Partial<PersonaRuntimeState>).lust)
        : 0,
      0,
      100,
    ),
    fear: clamp(
      Number.isFinite((state as Partial<PersonaRuntimeState>).fear)
        ? Number((state as Partial<PersonaRuntimeState>).fear)
        : 5,
      0,
      100,
    ),
    affection: clamp(
      Number.isFinite((state as Partial<PersonaRuntimeState>).affection)
        ? Number((state as Partial<PersonaRuntimeState>).affection)
        : clamp(25 + Math.round(state.trust * 0.25), 10, 80),
      0,
      100,
    ),
    tension: clamp(
      Number.isFinite((state as Partial<PersonaRuntimeState>).tension)
        ? Number((state as Partial<PersonaRuntimeState>).tension)
        : 10,
      0,
      100,
    ),
    relationshipType,
    relationshipDepth,
    activeTopics: normalizeTopics(state.activeTopics),
    relationshipStage: relationshipStageFromDepth(relationshipDepth),
  };
}

export function createInitialPersonaState(persona: Persona, chatId: string): PersonaRuntimeState {
  const base = persona.advanced.emotion;
  const now = new Date().toISOString();
  return {
    chatId,
    personaId: persona.id,
    mood: base.baselineMood,
    trust: clamp(32 + Math.round(base.warmth * 0.2), 20, 65),
    energy: clamp(50 + Math.round(persona.advanced.behavior.initiative * 0.2), 30, 90),
    engagement: clamp(45 + Math.round(persona.advanced.behavior.curiosity * 0.25), 30, 95),
    lust: 0,
    fear: 5,
    affection: clamp(24 + Math.round(base.warmth * 0.18), 10, 75),
    tension: 10,
    relationshipType: "neutral",
    relationshipDepth: 12,
    relationshipStage: "new",
    activeTopics: [],
    updatedAt: now,
  };
}

export function ensurePersonaState(
  state: PersonaRuntimeState | undefined,
  persona: Persona,
  chatId: string,
): PersonaRuntimeState {
  if (!state) return createInitialPersonaState(persona, chatId);
  return normalizeState(state, persona.id, chatId);
}

import { calculateStateEvolution } from "./personaBehaviors";

export function evolvePersonaState(
  prev: PersonaRuntimeState,
  persona: Persona,
  userMessage: string,
  assistantMessage: string,
): PersonaRuntimeState {
  const evolution = calculateStateEvolution(persona, prev, userMessage, assistantMessage);
  
  const topics = normalizeTopics([
    ...prev.activeTopics,
    ...inferTopicsFromMessage(userMessage),
    ...inferTopicsFromMessage(assistantMessage),
  ]);

  return {
    ...prev,
    ...evolution,
    activeTopics: topics.slice(-8),
    updatedAt: new Date().toISOString(),
  };
}

function inferLayerFromKind(kind: PersonaMemory["kind"]): PersonaMemoryLayer {
  if (kind === "event") return "episodic";
  return "long_term";
}

export function normalizeMemoryRecord(memory: LegacyMemoryRecord): PersonaMemory {
  return {
    ...memory,
    layer: memory.layer ?? inferLayerFromKind(memory.kind),
  };
}

function createMemory(
  layer: PersonaMemoryLayer,
  kind: PersonaMemory["kind"],
  chatId: string,
  personaId: string,
  content: string,
  salience: number,
) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    chatId,
    personaId,
    layer,
    kind,
    content: content.trim(),
    salience: Math.max(0.1, Math.min(1, salience)),
    createdAt: now,
    updatedAt: now,
    lastReferencedAt: now,
  } satisfies PersonaMemory;
}

interface ApplyPersonaControlInput {
  control: PersonaControlPayload;
  baseState: PersonaRuntimeState;
  persona: Persona;
  chatId: string;
  userMessage: string;
}

interface ApplyPersonaControlResult {
  state: PersonaRuntimeState;
  memoryCandidates: PersonaMemory[];
  memoryRemovals: Array<{
    id?: string;
    layer?: PersonaMemoryLayer;
    kind?: PersonaMemoryKind;
    content?: string;
  }>;
  intents: string[];
}

function clampDelta(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeTopicList(topics: unknown) {
  if (!Array.isArray(topics)) return [];
  return topics.filter((item): item is string => typeof item === "string").slice(0, 8);
}

function normalizeMemoryTextForCompare(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”«»"'`]/g, "")
    .trim();
}

function looksLikeVerbatimUserMessage(content: string, userMessage: string) {
  const contentNorm = normalizeMemoryTextForCompare(content);
  const userNorm = normalizeMemoryTextForCompare(userMessage);
  if (contentNorm.length < 36 || userNorm.length < 36) return false;
  return userNorm.includes(contentNorm) || contentNorm.includes(userNorm);
}

function cleanMemoryContent(raw: string) {
  return raw
    .replace(/^\s*(пользователь|user|сообщение|message)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOversizedLongTermMemory(content: string) {
  const words = content.split(/\s+/).filter(Boolean).length;
  const multiSentence = /[.!?…].+[.!?…]/.test(content);
  return content.length > 170 || words > 28 || multiSentence;
}

export function applyPersonaControlProposal({
  control,
  baseState,
  persona,
  chatId,
  userMessage,
}: ApplyPersonaControlInput): ApplyPersonaControlResult {
  const stateDelta = control.state_delta ?? {};
  const intents = Array.isArray(control.intents)
    ? control.intents.filter((intent): intent is string => typeof intent === "string").slice(0, 12)
    : [];
  const trustDelta = clampDelta(stateDelta.trust ?? 0, -8, 6);
  const engagementDelta = clampDelta(stateDelta.engagement ?? 0, -8, 8);
  const energyDelta = clampDelta(stateDelta.energy ?? 0, -10, 10);
  const lustDelta = clampDelta(stateDelta.lust ?? 0, -8, 8);
  const fearDelta = clampDelta(stateDelta.fear ?? 0, -10, 10);
  const affectionDelta = clampDelta(stateDelta.affection ?? 0, -8, 8);
  const tensionDelta = clampDelta(stateDelta.tension ?? 0, -10, 10);
  const relationshipDepthDelta = clampDelta(stateDelta.relationshipDepth ?? 0, -6, 6);

  const nextTrust = clamp(
    baseState.trust + trustDelta,
    0,
    100,
  );
  const nextEngagement = clamp(
    baseState.engagement + engagementDelta,
    0,
    100,
  );
  const nextEnergy = clamp(
    baseState.energy + energyDelta,
    0,
    100,
  );
  const nextLust = clamp(
    baseState.lust + lustDelta,
    0,
    100,
  );
  const nextFear = clamp(
    baseState.fear + fearDelta,
    0,
    100,
  );
  const nextAffection = clamp(
    baseState.affection + affectionDelta,
    0,
    100,
  );
  const nextTension = clamp(
    baseState.tension + tensionDelta,
    0,
    100,
  );
  let nextRelationshipDepth = clamp(
    baseState.relationshipDepth + relationshipDepthDelta,
    0,
    100,
  );

  const proposedMood = stateDelta.mood;
  const mood = (isValidMood(proposedMood) ? proposedMood : undefined) ?? baseState.mood;
  const proposedStage = stateDelta.relationshipStage;
  if (isValidRelationshipStage(proposedStage)) {
    nextRelationshipDepth = alignDepthToStage(nextRelationshipDepth, proposedStage);
  }
  const relationshipStage = isValidRelationshipStage(proposedStage)
    ? proposedStage
    : relationshipStageFromDepth(nextRelationshipDepth);
  const relationshipType = isValidRelationshipType(stateDelta.relationshipType)
    ? stateDelta.relationshipType
    : baseState.relationshipType;

  const addTopics = sanitizeTopicList(stateDelta.activeTopicsAdd);
  const activeTopics = normalizeTopics([...baseState.activeTopics, ...addTopics]).slice(-8);

  const state: PersonaRuntimeState = {
    ...baseState,
    trust: nextTrust,
    engagement: nextEngagement,
    energy: nextEnergy,
    lust: nextLust,
    fear: nextFear,
    affection: nextAffection,
    tension: nextTension,
    relationshipType,
    relationshipDepth: nextRelationshipDepth,
    mood,
    relationshipStage,
    activeTopics,
    updatedAt: new Date().toISOString(),
  };

  const memoryCandidates: PersonaMemory[] = [];
  const memoryAdd = Array.isArray(control.memory_add) ? control.memory_add : [];
  for (const candidate of memoryAdd.slice(0, 10)) {
    if (!candidate || typeof candidate !== "object") continue;
    const rawContent = typeof candidate.content === "string" ? candidate.content : "";
    let content = cleanMemoryContent(rawContent);
    if (!content) continue;

    let layer = isValidMemoryLayer(candidate.layer)
      ? candidate.layer
      : candidate.kind === "event"
        ? "episodic"
        : "long_term";
    if (layer === "short_term") continue;
    let kind = isValidMemoryKind(candidate.kind)
      ? candidate.kind
      : layer === "episodic"
        ? "event"
        : "fact";

    if (layer === "long_term") {
      const verbatim = looksLikeVerbatimUserMessage(content, userMessage);
      const oversized = isOversizedLongTermMemory(content);
      if (verbatim || oversized) {
        // Long-term should keep only compact semantic facts, not full user replicas.
        continue;
      }
    } else {
      if (content.length > 240) {
        content = `${content.slice(0, 239)}…`;
      }
      if (kind !== "event" && kind !== "fact" && kind !== "preference" && kind !== "goal") {
        kind = "event";
      }
    }

    const salience = Number.isFinite(candidate.salience) ? Number(candidate.salience) : 0.72;
    memoryCandidates.push(createMemory(layer, kind, chatId, persona.id, content, salience));
  }

  const memoryRemovals = Array.isArray(control.memory_remove)
    ? control.memory_remove
        .slice(0, 12)
        .map((candidate) => {
          if (!candidate || typeof candidate !== "object") return null;
          const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
          const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
          const layer = isValidMemoryLayer(candidate.layer) ? candidate.layer : undefined;
          const kind = isValidMemoryKind(candidate.kind) ? candidate.kind : undefined;
          if (!id && !content && !layer && !kind) return null;
          return {
            id: id || undefined,
            content: content || undefined,
            layer,
            kind,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  return { state, memoryCandidates, memoryRemovals, intents };
}

interface MemoryCandidate {
  content: string;
  salience: number;
}

function cleanCapture(value: string) {
  return value
    .trim()
    .replace(/^[\s"'`«»]+|[\s"'`«»]+$/g, "")
    .replace(/[.;,:!?]+$/g, "")
    .trim();
}

function addCandidateUnique(bucket: MemoryCandidate[], content: string, salience: number) {
  const cleaned = cleanCapture(content);
  if (!cleaned) return;
  const key = cleaned.toLowerCase().replace(/\s+/g, " ");
  const existing = bucket.find((item) => item.content.toLowerCase().replace(/\s+/g, " ") === key);
  if (existing) {
    existing.salience = Math.max(existing.salience, salience);
    return;
  }
  bucket.push({ content: cleaned, salience });
}

function extractFactCandidates(text: string) {
  const bucket: MemoryCandidate[] = [];

  const singlePatterns: Array<{ regex: RegExp; format: (match: RegExpMatchArray) => string; salience: number }> = [
    {
      regex: /(?:меня зовут|мо[её] имя|можно звать)\s+([a-zа-я0-9\-_ ]{2,40})/i,
      format: (match) => `Имя пользователя: ${match[1]}`,
      salience: 0.95,
    },
    {
      regex: /(?:мне|я)\s*(\d{1,2})\s*лет\b/i,
      format: (match) => `Возраст пользователя: ${match[1]}`,
      salience: 0.88,
    },
    {
      regex: /\b(?:живу в|я из|нахожусь в|переехал(?:а)? в)\s+([^.!?\n]{2,90})/i,
      format: (match) => `Локация пользователя: ${match[1]}`,
      salience: 0.84,
    },
    {
      regex: /\b(?:работаю(?: сейчас)?|я работаю)\s+(?:как|в|на позиции)\s+([^.!?\n]{2,100})/i,
      format: (match) => `Работа пользователя: ${match[1]}`,
      salience: 0.8,
    },
    {
      regex: /\b(?:учусь(?: сейчас)?|изучаю|обучаюсь)\s+([^.!?\n]{2,100})/i,
      format: (match) => `Обучение пользователя: ${match[1]}`,
      salience: 0.76,
    },
    {
      regex: /\b(?:говорю на|языки?:)\s+([^.!?\n]{2,100})/i,
      format: (match) => `Языки пользователя: ${match[1]}`,
      salience: 0.79,
    },
    {
      regex: /\b(?:мой часовой пояс|часовой пояс|timezone|utc|gmt)\s*[:\-]?\s*([a-zа-я0-9_\/+\-:]{2,40})/i,
      format: (match) => `Часовой пояс пользователя: ${match[1]}`,
      salience: 0.74,
    },
    {
      regex: /\b(?:у меня есть)\s+([^.!?\n]{3,120})/i,
      format: (match) => `Личный контекст: ${match[1]}`,
      salience: 0.7,
    },
    {
      regex: /\b(?:у меня аллергия на|мне нельзя|я не могу)\s+([^.!?\n]{3,120})/i,
      format: (match) => `Ограничение пользователя: ${match[1]}`,
      salience: 0.86,
    },
    {
      regex: /\b(?:использую|работаю с|обычно работаю в)\s+([^.!?\n]{3,120})/i,
      format: (match) => `Инструменты пользователя: ${match[1]}`,
      salience: 0.72,
    },
  ];

  for (const pattern of singlePatterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    addCandidateUnique(bucket, pattern.format(match), pattern.salience);
  }

  return bucket.slice(0, 6);
}

function extractPreferenceCandidates(text: string) {
  const bucket: MemoryCandidate[] = [];
  const positivePatterns = [
    /(?:я люблю|мне нравится|предпочитаю|обожаю)\s+([^.!?\n]{3,120})/i,
    /(?:мне комфортно|мне подходит)\s+([^.!?\n]{3,120})/i,
  ];
  const negativePatterns = [
    /(?:не люблю|терпеть не могу|ненавижу)\s+([^.!?\n]{3,120})/i,
    /(?:мне не нравится|мне не подходит)\s+([^.!?\n]{3,120})/i,
  ];

  for (const pattern of positivePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) addCandidateUnique(bucket, `Предпочтение: ${match[1]}`, 0.82);
  }
  for (const pattern of negativePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) addCandidateUnique(bucket, `Антипредпочтение: ${match[1]}`, 0.8);
  }

  return bucket.slice(0, 4);
}

function extractGoalCandidates(text: string) {
  const bucket: MemoryCandidate[] = [];
  const patterns = [
    /(?:моя цель|цель сейчас|ключевая цель)\s+([^.!?\n]{4,140})/i,
    /(?:я хочу|хочу)\s+([^.!?\n]{4,140})/i,
    /(?:планирую|собираюсь|намерен(?:а)?)\s+([^.!?\n]{4,140})/i,
    /(?:мне нужно|моя задача)\s+([^.!?\n]{4,140})/i,
    /(?:к \d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\s+хочу)\s+([^.!?\n]{4,120})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    addCandidateUnique(bucket, `Цель пользователя: ${match[1]}`, 0.9);
  }

  return bucket.slice(0, 4);
}

export function derivePersistentMemoriesFromUserMessage(persona: Persona, chatId: string, text: string) {
  const candidates: PersonaMemory[] = [];
  const policy = persona.advanced.memory;

  if (policy.rememberFacts) {
    const facts = extractFactCandidates(text);
    for (const fact of facts) {
      candidates.push(createMemory("long_term", "fact", chatId, persona.id, fact.content, fact.salience));
    }
  }

  if (policy.rememberPreferences) {
    const preferences = extractPreferenceCandidates(text);
    for (const preference of preferences) {
      candidates.push(
        createMemory("long_term", "preference", chatId, persona.id, preference.content, preference.salience),
      );
    }
  }

  if (policy.rememberGoals) {
    const goals = extractGoalCandidates(text);
    for (const goal of goals) {
      candidates.push(createMemory("long_term", "goal", chatId, persona.id, goal.content, goal.salience));
    }
  }

  if (policy.rememberEvents && text.trim().length >= 70) {
    const eventText = text.trim().replace(/\s+/g, " ").slice(0, 220);
    candidates.push(
      createMemory("episodic", "event", chatId, persona.id, `Событие диалога: ${eventText}`, 0.55),
    );
  }

  return candidates;
}

function canonical(memory: PersonaMemory) {
  return `${memory.layer}::${memory.kind}::${memory.content.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function rankByFreshness(memory: PersonaMemory, nowMs: number, decayDays: number) {
  const ageMs = Math.max(0, nowMs - Date.parse(memory.updatedAt));
  const decayWindow = Math.max(1, decayDays) * 24 * 60 * 60 * 1000;
  const freshness = Math.max(0.15, 1 - ageMs / decayWindow);
  return memory.salience * 0.72 + freshness * 0.28;
}

function dedupeAndSortLayer(memories: PersonaMemory[], decayDays: number) {
  const nowMs = Date.now();
  const map = new Map<string, PersonaMemory>();

  for (const memory of memories) {
    const normalized = normalizeMemoryRecord(memory);
    const key = canonical(normalized);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    map.set(key, {
      ...existing,
      salience: Math.max(existing.salience, normalized.salience),
      updatedAt: existing.updatedAt > normalized.updatedAt ? existing.updatedAt : normalized.updatedAt,
      lastReferencedAt: new Date().toISOString(),
    });
  }

  return Array.from(map.values()).sort(
    (a, b) => rankByFreshness(b, nowMs, decayDays) - rankByFreshness(a, nowMs, decayDays),
  );
}

export function reconcilePersistentMemories(
  existing: PersonaMemory[],
  candidates: PersonaMemory[],
  maxMemories: number,
  decayDays: number,
) {
  const persistentExisting = existing
    .map((memory) => normalizeMemoryRecord(memory))
    .filter((memory) => memory.layer !== "short_term");
  const persistentCandidates = candidates.map((memory) => normalizeMemoryRecord(memory));
  const merged = [...persistentExisting, ...persistentCandidates];

  const episodicPool = dedupeAndSortLayer(
    merged.filter((memory) => memory.layer === "episodic"),
    decayDays,
  );
  const longTermPool = dedupeAndSortLayer(
    merged.filter((memory) => memory.layer === "long_term"),
    decayDays,
  );

  const safeMax = Math.max(6, maxMemories);
  const longTermBudget = Math.max(4, Math.round(safeMax * 0.68));
  const episodicBudget = Math.max(2, safeMax - longTermBudget);
  const kept = [...longTermPool.slice(0, longTermBudget), ...episodicPool.slice(0, episodicBudget)];
  const keepIds = new Set(kept.map((memory) => memory.id));
  const removedIds = merged.filter((memory) => !keepIds.has(memory.id)).map((memory) => memory.id);

  return { kept, removedIds };
}

function buildShortTermSection(messages: Array<{ role: "user" | "assistant"; content: string }>, limit: number) {
  return messages
    .slice(-limit)
    .map((message) => `${message.role === "user" ? "Пользователь" : "Персона"}: ${message.content.slice(0, 220)}`);
}

export function buildLayeredMemoryContextCard(
  memories: PersonaMemory[],
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>,
  decayDays: number,
) {
  const normalized = memories.map((memory) => normalizeMemoryRecord(memory));
  const episodic = dedupeAndSortLayer(
    normalized.filter((memory) => memory.layer === "episodic"),
    decayDays,
  ).slice(0, 5);
  const longTerm = dedupeAndSortLayer(
    normalized.filter((memory) => memory.layer === "long_term"),
    decayDays,
  ).slice(0, 6);

  return {
    shortTerm: buildShortTermSection(recentMessages, 5),
    episodic,
    longTerm,
  } satisfies LayeredMemoryContextCard;
}

export function buildRecentMessages(messages: ChatMessage[], limit = 6) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-limit)
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}
