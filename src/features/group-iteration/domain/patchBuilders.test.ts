import { describe, expect, it } from "vitest";
import {
  buildSpeakerSelectedEvent,
  buildTickStartedEvent,
  buildWaitingTransitionEvents,
} from "./patchBuilders";

describe("patchBuilders", () => {
  it("builds orchestrator_tick_started payload", () => {
    const event = buildTickStartedEvent({
      idFactory: () => "evt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      roomId: "room-1",
      turnId: "turn-1",
      roomMode: "personas_plus_user",
      model: "local-model",
      source: "deterministic",
      decision: {
        status: "spoke",
        reason: "speaker_selected",
        speakerPersonaId: "p1",
        waitForUser: false,
        debug: { source: "test" },
      },
      userContextAction: "keep",
    });

    expect(event.type).toBe("orchestrator_tick_started");
    expect(event.payload.status).toBe("spoke");
    expect(event.payload.userContextAction).toBe("keep");
  });

  it("builds waiting and resumed transition events", () => {
    const waiting = buildWaitingTransitionEvents({
      idFactory: () => "evt-wait",
      createdAtFactory: () => "2026-01-01T00:00:00.000Z",
      roomId: "room-1",
      turnId: "turn-1",
      roomIsActive: true,
      latestWaitingForUser: false,
      latestWaitingReason: undefined,
      decisionWaitForUser: true,
      decisionWaitReason: "need_user_input",
      userName: "User",
      resumeReason: "orchestrator_resumed",
    });
    expect(waiting).toHaveLength(1);
    expect(waiting[0].type).toBe("room_waiting_user");

    const resumed = buildWaitingTransitionEvents({
      idFactory: () => "evt-resume",
      createdAtFactory: () => "2026-01-01T00:00:00.000Z",
      roomId: "room-1",
      turnId: "turn-2",
      roomIsActive: true,
      latestWaitingForUser: true,
      latestWaitingReason: "need_user_input",
      decisionWaitForUser: false,
      decisionWaitReason: undefined,
      userName: "User",
      resumeReason: "orchestrator_resumed",
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].type).toBe("room_resumed");
  });

  it("builds speaker_selected event", () => {
    const event = buildSpeakerSelectedEvent({
      idFactory: () => "evt-speaker",
      createdAt: "2026-01-01T00:00:00.000Z",
      roomId: "room-1",
      turnId: "turn-1",
      personaId: "persona-1",
      personaName: "Alice",
    });
    expect(event.type).toBe("speaker_selected");
    expect(event.payload.personaId).toBe("persona-1");
  });
});
