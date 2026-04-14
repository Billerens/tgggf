import { describe, expect, it } from "vitest";
import { mergeSpeakerDecision } from "./speakerSelection";
import type { GroupEvent } from "../../../types";

function speakerEvent(personaId: string): GroupEvent {
  return {
    id: `${personaId}-${Math.random()}`,
    roomId: "r1",
    turnId: "t1",
    type: "speaker_selected",
    payload: { personaId },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mergeSpeakerDecision", () => {
  it("falls back to deterministic speaker when llm removed speaker", () => {
    const deterministicDecision = {
      status: "spoke" as const,
      reason: "deterministic_pick",
      speakerPersonaId: "p1",
      waitForUser: false,
      debug: {},
    };
    const result = mergeSpeakerDecision({
      deterministicDecision,
      llmDecision: {
        status: "skipped",
        reason: "llm_skip",
      },
      roomMode: "personas_plus_user",
      events: [],
      participants: [],
    });

    expect(result.orchestrationSource).toBe("deterministic");
    expect(result.decision.status).toBe("spoke");
    expect(result.decision.speakerPersonaId).toBe("p1");
    expect(result.decision.debug.llmOverriddenByDeterministic).toBe(true);
  });

  it("applies diversity guard when llm over-focuses same speaker", () => {
    const deterministicDecision = {
      status: "spoke" as const,
      reason: "deterministic_pick",
      speakerPersonaId: "p1",
      waitForUser: false,
      debug: {},
    };
    const events = [
      speakerEvent("p2"),
      speakerEvent("p2"),
      speakerEvent("p2"),
      speakerEvent("p2"),
      speakerEvent("p2"),
      speakerEvent("p2"),
      speakerEvent("p1"),
    ];
    const result = mergeSpeakerDecision({
      deterministicDecision,
      llmDecision: {
        status: "spoke",
        speakerPersonaId: "p2",
        reason: "llm_pick",
      },
      roomMode: "personas_plus_user",
      events,
      participants: [
        {
          id: "part1",
          roomId: "r1",
          personaId: "p1",
          role: "member",
          initiativeBias: 50,
          talkCooldownMs: 1000,
          aliveScore: 50,
          joinedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "part2",
          roomId: "r1",
          personaId: "p2",
          role: "member",
          initiativeBias: 50,
          talkCooldownMs: 1000,
          aliveScore: 50,
          joinedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(result.orchestrationSource).toBe("deterministic");
    expect(result.decision.speakerPersonaId).toBe("p1");
    expect(result.decision.debug.llmOverriddenByDiversity).toBe(true);
  });

  it("normalizes waiting status in personas_only rooms", () => {
    const deterministicDecision = {
      status: "skipped" as const,
      reason: "no_active_participants",
      waitForUser: false,
      debug: {},
    };
    const result = mergeSpeakerDecision({
      deterministicDecision,
      llmDecision: {
        status: "waiting",
        reason: "llm_waiting",
        waitForUser: true,
        waitReason: "need_user",
      },
      roomMode: "personas_only",
      events: [],
      participants: [],
    });

    expect(result.decision.status).toBe("skipped");
    expect(result.decision.waitForUser).toBe(false);
    expect(result.decision.waitReason).toBeUndefined();
    expect(result.decision.debug.personasOnlyGuard).toBe(true);
  });
});
