import type { GroupEvent } from "../../../types";
import type { GroupOrchestratorTickDecision } from "../../../groupOrchestrator";

function hasWaitingReasonChanged(
  previousReason: string | undefined,
  nextReason: string | undefined,
) {
  return (previousReason || "") !== (nextReason || "");
}

export function buildTickStartedEvent(params: {
  idFactory: () => string;
  createdAt: string;
  roomId: string;
  turnId: string;
  roomMode: string;
  model: string;
  source: "llm" | "deterministic";
  decision: GroupOrchestratorTickDecision;
  userContextAction: "keep" | "clear";
}) {
  const {
    idFactory,
    createdAt,
    roomId,
    turnId,
    roomMode,
    model,
    source,
    decision,
    userContextAction,
  } = params;
  return {
    id: idFactory(),
    roomId,
    turnId,
    type: "orchestrator_tick_started" as const,
    payload: {
      roomMode,
      model,
      source,
      reason: decision.reason,
      status: decision.status,
      userContextAction,
      debug: decision.debug,
    },
    createdAt,
  } satisfies GroupEvent;
}

export function buildWaitingTransitionEvents(params: {
  idFactory: () => string;
  createdAtFactory: () => string;
  roomId: string;
  turnId: string;
  roomIsActive: boolean;
  latestWaitingForUser: boolean;
  latestWaitingReason?: string;
  decisionWaitForUser: boolean;
  decisionWaitReason?: string;
  userName: string;
  resumeReason: string;
}) {
  const {
    idFactory,
    createdAtFactory,
    roomId,
    turnId,
    roomIsActive,
    latestWaitingForUser,
    latestWaitingReason,
    decisionWaitForUser,
    decisionWaitReason,
    userName,
    resumeReason,
  } = params;
  const waitingEvents: GroupEvent[] = [];
  if (
    roomIsActive &&
    decisionWaitForUser &&
    (!latestWaitingForUser ||
      hasWaitingReasonChanged(latestWaitingReason, decisionWaitReason))
  ) {
    waitingEvents.push({
      id: idFactory(),
      roomId,
      turnId,
      type: "room_waiting_user",
      payload: {
        userName,
        reason: decisionWaitReason,
      },
      createdAt: createdAtFactory(),
    });
  }
  if (roomIsActive && !decisionWaitForUser && latestWaitingForUser) {
    waitingEvents.push({
      id: idFactory(),
      roomId,
      turnId,
      type: "room_resumed",
      payload: {
        reason: resumeReason,
      },
      createdAt: createdAtFactory(),
    });
  }
  return waitingEvents;
}

export function buildSpeakerSelectedEvent(params: {
  idFactory: () => string;
  createdAt: string;
  roomId: string;
  turnId: string;
  personaId: string;
  personaName: string;
}) {
  const { idFactory, createdAt, roomId, turnId, personaId, personaName } = params;
  return {
    id: idFactory(),
    roomId,
    turnId,
    type: "speaker_selected" as const,
    payload: {
      personaId,
      personaName,
    },
    createdAt,
  } satisfies GroupEvent;
}
