import type {
  GroupMemoryLayer,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupRelationEdge,
} from "./types";

const MEMORY_LAYER_DECAY_PER_DAY: Record<GroupMemoryLayer, number> = {
  short_term: 8,
  episodic: 2.5,
  long_term: 0.8,
};

const RELATION_BASELINES = {
  trust: 50,
  respect: 50,
  affinity: 50,
  tension: 20,
  influence: 40,
  attraction: 20,
} as const;

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTextKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toMs(iso: string) {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function ageDays(fromIso: string, nowMs: number) {
  const from = toMs(fromIso);
  if (!from || nowMs <= from) return 0;
  return (nowMs - from) / (1000 * 60 * 60 * 24);
}

function decaySalience(
  salience: number,
  layer: GroupMemoryLayer,
  ageInDays: number,
) {
  return clamp(Math.round(salience - ageInDays * MEMORY_LAYER_DECAY_PER_DAY[layer]));
}

function driftTowards(value: number, baseline: number, step = 1) {
  if (value === baseline) return value;
  if (value < baseline) return Math.min(baseline, value + step);
  return Math.max(baseline, value - step);
}

function smoothDelta(previous: number, next: number, maxStep = 4) {
  if (next > previous + maxStep) return previous + maxStep;
  if (next < previous - maxStep) return previous - maxStep;
  return next;
}

function scoreSpeechAct(text: string) {
  const content = text.toLowerCase();
  const positiveCues = [
    "спасибо",
    "ценю",
    "класс",
    "отлич",
    "поддерж",
    "соглас",
    "уважа",
    "thanks",
    "great",
    "support",
    "agree",
  ];
  const negativeCues = [
    "не соглас",
    "бред",
    "глуп",
    "раздраж",
    "бесит",
    "ошиб",
    "ненавиж",
    "hate",
    "stupid",
    "annoy",
    "wrong",
  ];
  let score = 0;
  for (const cue of positiveCues) {
    if (content.includes(cue)) score += 1;
  }
  for (const cue of negativeCues) {
    if (content.includes(cue)) score -= 1;
  }
  return Math.max(-2, Math.min(2, score));
}

interface MemoryReconcileResult<T extends { id: string }> {
  kept: T[];
  removedIds: string[];
}

function sortByPriority<T extends { salience: number; updatedAt: string }>(
  items: T[],
) {
  return items.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function reconcileSharedGroupMemories(
  memories: GroupMemoryShared[],
  nowIso: string,
  limit = 120,
): MemoryReconcileResult<GroupMemoryShared> {
  if (memories.length === 0) return { kept: [], removedIds: [] };

  const nowMs = toMs(nowIso);
  const dedup = new Map<string, GroupMemoryShared>();
  for (const memory of memories) {
    const key = `${memory.kind}:${memory.layer}:${normalizeTextKey(memory.content)}`;
    const existing = dedup.get(key);
    if (!existing || existing.updatedAt < memory.updatedAt) {
      dedup.set(key, memory);
    }
  }

  const normalized = Array.from(dedup.values())
    .map((memory) => {
      const age = ageDays(memory.updatedAt || memory.createdAt, nowMs);
      const decayedSalience = decaySalience(memory.salience, memory.layer, age);
      const nextLayer =
        memory.layer === "short_term" && decayedSalience >= 68 && age <= 2
          ? "episodic"
          : memory.layer;
      const shouldDrop =
        decayedSalience <= 8 ||
        (nextLayer === "short_term" && age > 5 && decayedSalience < 35);
      if (shouldDrop) return null;
      return {
        ...memory,
        layer: nextLayer,
        salience: decayedSalience,
        updatedAt:
          decayedSalience !== memory.salience || nextLayer !== memory.layer
            ? nowIso
            : memory.updatedAt,
      };
    })
    .filter((memory): memory is GroupMemoryShared => Boolean(memory));

  const kept = sortByPriority(normalized).slice(0, limit);
  const keptIds = new Set(kept.map((memory) => memory.id));
  const removedIds = memories
    .map((memory) => memory.id)
    .filter((id) => !keptIds.has(id));
  return { kept, removedIds };
}

export function reconcilePrivateGroupMemories(
  memories: GroupMemoryPrivate[],
  nowIso: string,
  perPersonaLimit = 80,
): MemoryReconcileResult<GroupMemoryPrivate> {
  if (memories.length === 0) return { kept: [], removedIds: [] };

  const nowMs = toMs(nowIso);
  const byPersona = new Map<string, GroupMemoryPrivate[]>();
  for (const memory of memories) {
    const bucket = byPersona.get(memory.personaId) ?? [];
    bucket.push(memory);
    byPersona.set(memory.personaId, bucket);
  }

  const kept: GroupMemoryPrivate[] = [];
  for (const personaMemories of byPersona.values()) {
    const dedup = new Map<string, GroupMemoryPrivate>();
    for (const memory of personaMemories) {
      const key = `${memory.kind}:${memory.layer}:${normalizeTextKey(memory.content)}`;
      const existing = dedup.get(key);
      if (!existing || existing.updatedAt < memory.updatedAt) {
        dedup.set(key, memory);
      }
    }

    const normalized = Array.from(dedup.values())
      .map((memory) => {
        const age = ageDays(memory.updatedAt || memory.createdAt, nowMs);
        const decayedSalience = decaySalience(memory.salience, memory.layer, age);
        const nextLayer =
          memory.layer === "short_term" && decayedSalience >= 66 && age <= 2
            ? "episodic"
            : memory.layer;
        const shouldDrop =
          decayedSalience <= 10 ||
          (nextLayer === "short_term" && age > 5 && decayedSalience < 35);
        if (shouldDrop) return null;
        return {
          ...memory,
          layer: nextLayer,
          salience: decayedSalience,
          updatedAt:
            decayedSalience !== memory.salience || nextLayer !== memory.layer
              ? nowIso
              : memory.updatedAt,
        };
      })
      .filter((memory): memory is GroupMemoryPrivate => Boolean(memory));

    kept.push(...sortByPriority(normalized).slice(0, perPersonaLimit));
  }

  const keptIds = new Set(kept.map((memory) => memory.id));
  const removedIds = memories
    .map((memory) => memory.id)
    .filter((id) => !keptIds.has(id));
  return { kept, removedIds };
}

export interface GroupRelationChange {
  fromPersonaId: string;
  toPersonaId: string;
  trust: { from: number; to: number };
  affinity: { from: number; to: number };
  tension: { from: number; to: number };
}

export function applyGroupRelationDynamics(params: {
  edges: GroupRelationEdge[];
  speakerPersonaId: string;
  mentionedPersonaIds: string[];
  speechText: string;
  nowIso: string;
}) {
  const mentionedSet = new Set(params.mentionedPersonaIds);
  const speechScore = scoreSpeechAct(params.speechText);

  const updatedEdges = params.edges.map((edge) => {
    let nextTrust = driftTowards(edge.trust, RELATION_BASELINES.trust, 1);
    let nextRespect = driftTowards(edge.respect, RELATION_BASELINES.respect, 1);
    let nextAffinity = driftTowards(edge.affinity, RELATION_BASELINES.affinity, 1);
    let nextTension = driftTowards(edge.tension, RELATION_BASELINES.tension, 1);
    let nextInfluence = driftTowards(edge.influence, RELATION_BASELINES.influence, 1);
    const nextAttraction = driftTowards(edge.attraction, RELATION_BASELINES.attraction, 1);

    if (
      edge.fromPersonaId === params.speakerPersonaId &&
      mentionedSet.has(edge.toPersonaId)
    ) {
      if (speechScore > 0) {
        nextTrust += 1 + speechScore;
        nextAffinity += 1 + speechScore;
        nextRespect += 1;
        nextTension -= 1;
        nextInfluence += 1;
      } else if (speechScore < 0) {
        const abs = Math.abs(speechScore);
        nextTrust -= 1 + abs;
        nextAffinity -= 1 + abs;
        nextRespect -= 1;
        nextTension += 1 + abs;
      } else {
        nextTrust += 1;
        nextAffinity += 1;
      }
    }

    return {
      ...edge,
      trust: clamp(smoothDelta(edge.trust, nextTrust)),
      respect: clamp(smoothDelta(edge.respect, nextRespect)),
      affinity: clamp(smoothDelta(edge.affinity, nextAffinity)),
      tension: clamp(smoothDelta(edge.tension, nextTension)),
      influence: clamp(smoothDelta(edge.influence, nextInfluence)),
      attraction: clamp(smoothDelta(edge.attraction, nextAttraction)),
      updatedAt: params.nowIso,
    };
  });

  const changes: GroupRelationChange[] = [];
  for (let index = 0; index < updatedEdges.length; index += 1) {
    const previous = params.edges[index];
    const next = updatedEdges[index];
    if (!previous || !next) continue;
    if (
      previous.trust === next.trust &&
      previous.affinity === next.affinity &&
      previous.tension === next.tension
    ) {
      continue;
    }
    changes.push({
      fromPersonaId: next.fromPersonaId,
      toPersonaId: next.toPersonaId,
      trust: { from: previous.trust, to: next.trust },
      affinity: { from: previous.affinity, to: next.affinity },
      tension: { from: previous.tension, to: next.tension },
    });
  }

  return { updatedEdges, changes };
}
