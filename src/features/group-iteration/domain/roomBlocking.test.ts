import { describe, expect, it } from "vitest";
import { evaluateRoomBlocking } from "./roomBlocking";

describe("evaluateRoomBlocking", () => {
  it("marks strict waiting lock for personas_plus_user rooms", () => {
    const result = evaluateRoomBlocking({
      roomMode: "personas_plus_user",
      roomWaitingForUser: true,
      deterministicDecision: {
        status: "waiting",
        reason: "waiting_for_user",
        waitForUser: true,
        waitReason: "user_turn",
        debug: {},
      },
    });

    expect(result.isStrictWaitingLock).toBe(true);
    expect(result.isDeterministicHardBlock).toBe(true);
  });

  it("does not mark hard block when deterministic tick decided to speak", () => {
    const result = evaluateRoomBlocking({
      roomMode: "personas_plus_user",
      roomWaitingForUser: false,
      deterministicDecision: {
        status: "spoke",
        reason: "speaker_selected",
        speakerPersonaId: "p1",
        waitForUser: false,
        debug: {},
      },
    });

    expect(result.isStrictWaitingLock).toBe(false);
    expect(result.isDeterministicHardBlock).toBe(false);
  });
});
