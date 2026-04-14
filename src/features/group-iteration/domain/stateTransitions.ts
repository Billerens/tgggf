import { applyGroupRelationDynamics } from "../../../groupDynamics";
import type {
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
} from "../../../types";

const clamp = (value: number, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

export function buildUpdatedParticipantsAfterSpeech(params: {
  participants: GroupParticipant[];
  speakerPersonaId: string;
  updatedAt: string;
  nowMs?: number;
}) {
  const { participants, speakerPersonaId, updatedAt, nowMs = Date.now() } = params;
  return participants.map((participant) => {
    if (participant.personaId === speakerPersonaId) {
      return {
        ...participant,
        aliveScore: clamp(participant.aliveScore - 2),
        muteUntil: new Date(
          nowMs + Math.max(0, participant.talkCooldownMs || 0),
        ).toISOString(),
        updatedAt,
      };
    }
    const dormantBoost = participant.aliveScore < 40 ? 2 : 1;
    return {
      ...participant,
      aliveScore: clamp(participant.aliveScore + dormantBoost),
      updatedAt,
    };
  });
}

export function buildSpeechMemoryCandidates(params: {
  idFactory: () => string;
  roomId: string;
  speakerPersonaId: string;
  speakerName: string;
  speechText: string;
  mentionPersonaIds: string[];
  nowIso: string;
}) {
  const {
    idFactory,
    roomId,
    speakerPersonaId,
    speakerName,
    speechText,
    mentionPersonaIds,
    nowIso,
  } = params;
  const privateMemory: GroupMemoryPrivate = {
    id: idFactory(),
    roomId,
    personaId: speakerPersonaId,
    layer: "short_term",
    kind: "event",
    content: speechText.slice(0, 240),
    salience: 52,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const sharedMemory: GroupMemoryShared | null =
    speechText.length >= 80 || mentionPersonaIds.length > 0
      ? {
          id: idFactory(),
          roomId,
          layer: "short_term",
          kind: "event",
          content: `${speakerName}: ${speechText.slice(0, 220)}`,
          salience: mentionPersonaIds.length > 0 ? 58 : 50,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : null;
  return {
    privateMemory,
    sharedMemory,
  };
}

export function buildUpdatedPersonaStatesAfterSpeech(params: {
  states: GroupPersonaState[];
  speakerPersonaId: string;
  updatedAt: string;
}) {
  const { states, speakerPersonaId, updatedAt } = params;
  return states.map((state) => {
    if (state.personaId === speakerPersonaId) {
      return {
        ...state,
        energy: clamp(state.energy - 2),
        engagement: clamp(state.engagement + 3),
        initiative: clamp(state.initiative + 1),
        aliveScore: clamp(state.aliveScore + 1),
        updatedAt,
      };
    }
    return {
      ...state,
      engagement: clamp(state.engagement + 1),
      updatedAt,
    };
  });
}

export function buildRelationDynamicsAfterSpeech(params: {
  edges: GroupRelationEdge[];
  speakerPersonaId: string;
  mentionedPersonaIds: string[];
  speechText: string;
  nowIso: string;
}) {
  const { edges, speakerPersonaId, mentionedPersonaIds, speechText, nowIso } = params;
  return applyGroupRelationDynamics({
    edges,
    speakerPersonaId,
    mentionedPersonaIds,
    speechText,
    nowIso,
  });
}
