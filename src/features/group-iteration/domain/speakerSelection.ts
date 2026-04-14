import type { GroupOrchestratorTickDecision } from "../../../groupOrchestrator";
import type { GroupEvent, GroupParticipant, GroupRoomMode } from "../../../types";

type OrchestrationSource = "llm" | "deterministic";

function collectRecentSpeakerIds(
  events: GroupEvent[],
  participantsCount: number,
) {
  return events
    .filter((event) => event.type === "speaker_selected")
    .map((event) =>
      typeof event.payload?.personaId === "string" ? event.payload.personaId : "",
    )
    .filter(Boolean)
    .slice(-Math.max(8, participantsCount * 3));
}

function countRecentSpeaks(recentSpeakerIds: string[], personaId: string) {
  return recentSpeakerIds.filter((id) => id === personaId).length;
}

export interface MergeSpeakerDecisionInput {
  deterministicDecision: GroupOrchestratorTickDecision;
  llmDecision: Partial<GroupOrchestratorTickDecision> | null;
  roomMode: GroupRoomMode;
  events: GroupEvent[];
  participants: GroupParticipant[];
}

export interface MergeSpeakerDecisionOutput {
  decision: GroupOrchestratorTickDecision;
  orchestrationSource: OrchestrationSource;
  llmDecisionStatus?: string;
}

export function mergeSpeakerDecision({
  deterministicDecision,
  llmDecision,
  roomMode,
  events,
  participants,
}: MergeSpeakerDecisionInput): MergeSpeakerDecisionOutput {
  let decision: GroupOrchestratorTickDecision;
  let orchestrationSource: OrchestrationSource;
  const llmDecisionStatus = llmDecision?.status;

  if (llmDecision) {
    decision = {
      ...deterministicDecision,
      ...llmDecision,
      debug: {
        ...deterministicDecision.debug,
        llmDecision,
      },
    };
    orchestrationSource = "llm";
  } else {
    decision = deterministicDecision;
    orchestrationSource = "deterministic";
  }

  const forceDeterministicSpeaker =
    deterministicDecision.status === "spoke" &&
    Boolean(deterministicDecision.speakerPersonaId) &&
    (decision.status !== "spoke" || !decision.speakerPersonaId);
  if (forceDeterministicSpeaker) {
    decision = {
      ...deterministicDecision,
      debug: {
        ...deterministicDecision.debug,
        llmDecisionStatus,
        llmOverriddenByDeterministic: true,
      },
    };
    orchestrationSource = "deterministic";
  }

  const mentionDrivenPersonaId =
    typeof deterministicDecision.debug?.mentionDrivenPersonaId === "string"
      ? deterministicDecision.debug.mentionDrivenPersonaId
      : "";
  if (
    decision.status === "spoke" &&
    decision.speakerPersonaId &&
    deterministicDecision.status === "spoke" &&
    deterministicDecision.speakerPersonaId &&
    decision.speakerPersonaId !== deterministicDecision.speakerPersonaId &&
    (!mentionDrivenPersonaId ||
      mentionDrivenPersonaId !== decision.speakerPersonaId)
  ) {
    const recentSpeakerIds = collectRecentSpeakerIds(events, participants.length);
    const llmCount = countRecentSpeaks(recentSpeakerIds, decision.speakerPersonaId);
    const deterministicCount = countRecentSpeaks(
      recentSpeakerIds,
      deterministicDecision.speakerPersonaId,
    );
    const dominantCountThreshold = Math.max(
      3,
      Math.ceil(recentSpeakerIds.length * 0.45),
    );
    if (
      recentSpeakerIds.length >= 6 &&
      llmCount >= dominantCountThreshold &&
      deterministicCount < llmCount
    ) {
      decision = {
        ...deterministicDecision,
        debug: {
          ...deterministicDecision.debug,
          llmDecisionStatus,
          llmOverriddenByDiversity: true,
          llmSpeakerPersonaId: decision.speakerPersonaId,
          llmRecentCount: llmCount,
          deterministicRecentCount: deterministicCount,
          dominantCountThreshold,
        },
      };
      orchestrationSource = "deterministic";
    }
  }

  if (roomMode === "personas_only") {
    const originalStatus = decision.status;
    const normalizedStatus =
      originalStatus === "waiting"
        ? deterministicDecision.status === "spoke" &&
          deterministicDecision.speakerPersonaId
          ? "spoke"
          : "skipped"
        : originalStatus;
    decision = {
      ...decision,
      status: normalizedStatus,
      speakerPersonaId:
        normalizedStatus === "spoke"
          ? decision.speakerPersonaId ||
            deterministicDecision.speakerPersonaId
          : undefined,
      waitForUser: false,
      waitReason: undefined,
      debug: {
        ...decision.debug,
        personasOnlyGuard: true,
        originalStatus,
      },
    };
  }

  return {
    decision,
    orchestrationSource,
    llmDecisionStatus,
  };
}
