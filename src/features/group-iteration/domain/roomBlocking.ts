import type { GroupOrchestratorTickDecision } from "../../../groupOrchestrator";
import type { GroupRoomMode } from "../../../types";

const DETERMINISTIC_HARD_BLOCK_REASONS = new Set([
  "room_not_active",
  "waiting_for_user",
  "no_active_participants",
  "typing_delay",
  "pending_image_generation",
]);

export function evaluateRoomBlocking(params: {
  roomMode: GroupRoomMode;
  roomWaitingForUser: boolean;
  deterministicDecision: GroupOrchestratorTickDecision;
}) {
  const { roomMode, roomWaitingForUser, deterministicDecision } = params;
  const isStrictWaitingLock =
    roomMode === "personas_plus_user" &&
    roomWaitingForUser &&
    deterministicDecision.status === "waiting" &&
    deterministicDecision.waitForUser;
  const isDeterministicHardBlock =
    deterministicDecision.status !== "spoke" &&
    DETERMINISTIC_HARD_BLOCK_REASONS.has(deterministicDecision.reason);

  return {
    isStrictWaitingLock,
    isDeterministicHardBlock,
  };
}
