import type { PersonaControlPayload } from "./personaDynamics";

const COMFY_UI_PROMPT_BLOCK_REGEX = /<comfyui_prompt\b[^>]*>([\s\S]*?)<\/comfyui_prompt>/gi;
const COMFY_UI_IMAGE_DESCRIPTION_BLOCK_REGEX =
  /<comfyui_image_description\b[^>]*>([\s\S]*?)<\/comfyui_image_description>/gi;
const PERSONA_CONTROL_BLOCK_REGEX = /<persona_control\b[^>]*>([\s\S]*?)<\/persona_control>/gi;

type ControlStateDelta = NonNullable<PersonaControlPayload["state_delta"]>;
type ControlMemoryAddItem = NonNullable<PersonaControlPayload["memory_add"]>[number];
type ControlMemoryRemoveItem = NonNullable<PersonaControlPayload["memory_remove"]>[number];

export interface AssistantContentParts {
  visibleText: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  personaControl?: PersonaControlPayload;
}

const LEAKED_DIAGNOSTIC_KEYS = new Set([
  "mood",
  "trusttouser",
  "energy",
  "engagement",
  "initiative",
  "affectiontouser",
  "tension",
  "addressedtocurrentpersona",
  "mentionedpersonanames",
  "rawmentions",
]);

function isDiagnosticAssignment(value: string) {
  const match = value.match(/^([a-zA-Z][\w]*)\s*=\s*.+$/);
  if (!match) return false;
  return LEAKED_DIAGNOSTIC_KEYS.has(match[1].toLowerCase());
}

function stripLeakedDiagnosticLines(value: string) {
  const lines = value.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push("");
      continue;
    }
    if (isDiagnosticAssignment(trimmed)) {
      continue;
    }
    const parts = trimmed.split(/\s*,\s*/g).filter(Boolean);
    if (parts.length > 1 && parts.every(isDiagnosticAssignment)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tryParseJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const softened = trimmed
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)([a-zA-Z_][\w-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    try {
      return JSON.parse(softened) as unknown;
    } catch {
      // Continue with brace slice fallback.
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function pickRecord(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  return undefined;
}

function pickArray(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (Array.isArray(rec.items)) return rec.items;
      if (Array.isArray(rec.add)) return rec.add;
      if (Array.isArray(rec.list)) return rec.list;
      return [rec];
    }
  }
  return undefined;
}

function pickString(rec: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(rec: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function asStringArray(input: unknown, max: number) {
  if (typeof input === "string") return [input.trim()].filter(Boolean).slice(0, max);
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeMemoryLayer(value: unknown): ControlMemoryAddItem["layer"] {
  if (typeof value !== "string") return undefined;
  const token = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (token === "short_term" || token === "short" || token === "stm") return "short_term";
  if (token === "episodic" || token === "episode") return "episodic";
  if (token === "long_term" || token === "long" || token === "ltm") return "long_term";
  return undefined;
}

function normalizeMemoryKind(value: unknown): ControlMemoryAddItem["kind"] {
  if (typeof value !== "string") return undefined;
  const token = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (token === "fact" || token === "facts" || token === "profile") return "fact";
  if (token === "preference" || token === "preferences" || token === "like" || token === "dislike")
    return "preference";
  if (token === "goal" || token === "goals" || token === "objective") return "goal";
  if (token === "event" || token === "events" || token === "episode") return "event";
  return undefined;
}

function normalizeSalience(raw: number | undefined) {
  if (!Number.isFinite(raw)) return undefined;
  if ((raw ?? 0) > 1) return Math.max(0.1, Math.min(1, (raw ?? 0) / 100));
  return Math.max(0.1, Math.min(1, raw ?? 0));
}

function normalizeRelationshipStage(value: unknown): ControlStateDelta["relationshipStage"] {
  if (typeof value !== "string") return undefined;
  const token = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (token === "new") return "new";
  if (token === "acquaintance" || token === "acquainted" || token === "familiar") return "acquaintance";
  if (token === "friendly" || token === "friend") return "friendly";
  if (token === "close" || token === "trusted") return "close";
  if (token === "bonded" || token === "deep") return "bonded";
  return undefined;
}

function normalizeRelationshipType(value: unknown): ControlStateDelta["relationshipType"] {
  if (typeof value !== "string") return undefined;
  const token = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (token === "neutral") return "neutral";
  if (token === "friendship" || token === "friend") return "friendship";
  if (token === "romantic" || token === "romance") return "romantic";
  if (token === "mentor" || token === "coaching") return "mentor";
  if (token === "playful" || token === "banter") return "playful";
  return undefined;
}

function normalizeStateDelta(obj: Record<string, unknown>) {
  const deltaRaw = pickRecord(obj, ["state_delta", "stateDelta", "state", "state_change", "stateChange"]);
  if (!deltaRaw) return undefined;

  const stateDelta: ControlStateDelta = {};
  const trust = pickNumber(deltaRaw, ["trust", "trust_delta", "trustDelta"]);
  const engagement = pickNumber(deltaRaw, ["engagement", "engagement_delta", "engagementDelta"]);
  const energy = pickNumber(deltaRaw, ["energy", "energy_delta", "energyDelta"]);
  const lust = pickNumber(deltaRaw, ["lust", "lust_delta", "lustDelta", "arousal", "arousal_delta", "arousalDelta"]);
  const fear = pickNumber(deltaRaw, ["fear", "fear_delta", "fearDelta", "anxiety", "anxiety_delta", "anxietyDelta"]);
  const affection = pickNumber(deltaRaw, [
    "affection",
    "affection_delta",
    "affectionDelta",
    "closeness_affect",
    "closenessAffect",
  ]);
  const tension = pickNumber(deltaRaw, [
    "tension",
    "tension_delta",
    "tensionDelta",
    "stress",
    "stress_delta",
    "stressDelta",
  ]);
  const mood = pickString(deltaRaw, ["mood", "emotion"]);
  const relationshipStage = normalizeRelationshipStage(
    pickString(deltaRaw, ["relationshipStage", "relationship_stage", "stage", "relationship"]),
  );
  const relationshipType = normalizeRelationshipType(
    pickString(deltaRaw, ["relationshipType", "relationship_type", "relationType", "relation_type"]),
  );
  const relationshipDepth = pickNumber(deltaRaw, [
    "relationshipDepth",
    "relationship_depth",
    "depth",
    "closeness",
    "intimacy",
  ]);

  if (typeof trust === "number") stateDelta.trust = trust;
  if (typeof engagement === "number") stateDelta.engagement = engagement;
  if (typeof energy === "number") stateDelta.energy = energy;
  if (typeof lust === "number") stateDelta.lust = lust;
  if (typeof fear === "number") stateDelta.fear = fear;
  if (typeof affection === "number") stateDelta.affection = affection;
  if (typeof tension === "number") stateDelta.tension = tension;
  if (mood) stateDelta.mood = mood as ControlStateDelta["mood"];
  if (relationshipStage) stateDelta.relationshipStage = relationshipStage;
  if (relationshipType) stateDelta.relationshipType = relationshipType;
  if (typeof relationshipDepth === "number") stateDelta.relationshipDepth = relationshipDepth;

  const topics = asStringArray(
    (deltaRaw.activeTopicsAdd ??
      deltaRaw.active_topics_add ??
      deltaRaw.topicsAdd ??
      deltaRaw.topics_add ??
      deltaRaw.topics) as unknown,
    10,
  );
  if (topics.length > 0) {
    stateDelta.activeTopicsAdd = topics;
  }

  return Object.keys(stateDelta).length > 0 ? stateDelta : undefined;
}

function normalizeMemoryAdd(obj: Record<string, unknown>) {
  const source = pickArray(obj, ["memory_add", "memoryAdd", "memories_add", "memory", "memories"]);
  if (!source) return undefined;

  const normalized = source
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .slice(0, 20)
    .map((item): ControlMemoryAddItem => {
      const layer = normalizeMemoryLayer(
        item.layer ?? item.scope ?? item.tier ?? item.memory_layer ?? item.memoryLayer,
      );
      const kind = normalizeMemoryKind(item.kind ?? item.type ?? item.category ?? item.memory_kind);
      const content = pickString(item, [
        "content",
        "text",
        "value",
        "memory",
        "fact",
        "preference",
        "goal",
        "event",
      ]);
      const salience = normalizeSalience(
        pickNumber(item, ["salience", "importance", "weight", "score", "confidence"]),
      );

      return { layer, kind, content, salience };
    })
    .filter((item) => Boolean(item.content));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMemoryRemove(obj: Record<string, unknown>) {
  const source = pickArray(obj, ["memory_remove", "memoryRemove", "forget", "remove_memories", "memory_delete"]);
  if (!source) return undefined;

  const normalized = source
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .slice(0, 20)
    .map((item): ControlMemoryRemoveItem => ({
      id: pickString(item, ["id", "memory_id", "memoryId"]),
      layer: normalizeMemoryLayer(item.layer ?? item.scope ?? item.tier),
      kind: normalizeMemoryKind(item.kind ?? item.type ?? item.category),
      content: pickString(item, ["content", "text", "value", "memory"]),
    }))
    .filter((item) => Boolean(item.id || item.content || item.layer || item.kind));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIntents(obj: Record<string, unknown>) {
  const fromIntents = asStringArray(obj.intents, 24);
  if (fromIntents.length > 0) return fromIntents;
  return asStringArray(obj.intent ?? obj.actions ?? obj.labels, 24);
}

function normalizePersonaControl(input: unknown): PersonaControlPayload | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const control: PersonaControlPayload = {};

  const intents = normalizeIntents(obj);
  if (intents.length > 0) control.intents = intents;

  const stateDelta = normalizeStateDelta(obj);
  if (stateDelta) control.state_delta = stateDelta;

  const memoryAdd = normalizeMemoryAdd(obj);
  if (memoryAdd) control.memory_add = memoryAdd;

  const memoryRemove = normalizeMemoryRemove(obj);
  if (memoryRemove) control.memory_remove = memoryRemove;

  if (!control.intents && !control.state_delta && !control.memory_add && !control.memory_remove) return undefined;
  return control;
}

export function splitAssistantContent(rawContent: string): AssistantContentParts {
  const comfyPrompts: string[] = [];
  const comfyImageDescriptions: string[] = [];
  let personaControl: PersonaControlPayload | undefined;
  const visibleText = stripLeakedDiagnosticLines(
    rawContent
    .replace(COMFY_UI_PROMPT_BLOCK_REGEX, (_, inner: string) => {
      const candidate = inner.trim();
      if (candidate) {
        comfyPrompts.push(candidate);
      }
      return "";
    })
    .replace(COMFY_UI_IMAGE_DESCRIPTION_BLOCK_REGEX, (_, inner: string) => {
      const candidate = inner.trim();
      if (candidate) {
        comfyImageDescriptions.push(candidate);
      }
      return "";
    })
    .replace(PERSONA_CONTROL_BLOCK_REGEX, (_, inner: string) => {
      const parsed = normalizePersonaControl(tryParseJsonObject(inner));
      if (!personaControl && parsed) {
        personaControl = parsed;
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim(),
  );

  return {
    visibleText,
    comfyPrompt: comfyPrompts[0],
    comfyPrompts: comfyPrompts.length > 0 ? comfyPrompts : undefined,
    comfyImageDescription: comfyImageDescriptions[0],
    comfyImageDescriptions:
      comfyImageDescriptions.length > 0 ? comfyImageDescriptions : undefined,
    personaControl,
  };
}
