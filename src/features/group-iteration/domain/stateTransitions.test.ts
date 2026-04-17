import { describe, expect, it } from "vitest";
import {
  buildRelationDynamicsAfterSpeech,
  buildSpeechMemoryCandidates,
  buildUpdatedParticipantsAfterSpeech,
  buildUpdatedPersonaStatesAfterSpeech,
} from "./stateTransitions";

describe("stateTransitions", () => {
  it("updates participants after speaker message", () => {
    const updated = buildUpdatedParticipantsAfterSpeech({
      participants: [
        {
          id: "part-1",
          roomId: "room-1",
          personaId: "p1",
          role: "member",
          initiativeBias: 50,
          talkCooldownMs: 2000,
          aliveScore: 60,
          joinedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "part-2",
          roomId: "room-1",
          personaId: "p2",
          role: "member",
          initiativeBias: 50,
          talkCooldownMs: 2000,
          aliveScore: 35,
          joinedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      speakerPersonaId: "p1",
      updatedAt: "2026-01-02T00:00:00.000Z",
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
    });

    expect(updated[0].aliveScore).toBe(58);
    expect(updated[0].muteUntil).toBe("2026-01-02T00:00:02.000Z");
    expect(updated[1].aliveScore).toBe(37);
  });

  it("builds private and shared speech memories", () => {
    const { privateMemory, sharedMemory } = buildSpeechMemoryCandidates({
      idFactory: (() => {
        let index = 0;
        return () => `id-${index++}`;
      })(),
      roomId: "room-1",
      speakerPersonaId: "p1",
      speakerName: "Alice",
      speechText:
        "Это очень длинный текст сообщения, который должен попасть в shared memory, потому что превышает порог длины.",
      mentionPersonaIds: ["p2"],
      nowIso: "2026-01-01T00:00:00.000Z",
    });

    expect(privateMemory.personaId).toBe("p1");
    expect(privateMemory.kind).toBe("event");
    expect(sharedMemory).not.toBeNull();
    expect(sharedMemory?.content.startsWith("Alice:")).toBe(true);
  });

  it("updates persona states and relation dynamics", () => {
    const updatedStates = buildUpdatedPersonaStatesAfterSpeech({
      states: [
        {
          id: "state-1",
          roomId: "room-1",
          personaId: "p1",
          mood: "calm",
          trustToUser: 50,
          energy: 50,
          engagement: 50,
          initiative: 50,
          affectionToUser: 50,
          tension: 20,
          activeTopics: [],
          currentIntent: "Укрепить связь",
          influenceProfile: {
            enabled: true,
            thoughts: [{ text: "Сохранять эмпатию", strength: 52 }],
            desires: [{ text: "Больше доверия", strength: 66 }],
            goals: [{ text: "Укрепить связь", strength: 78 }],
            freeform: "Вести к более глубокой эмоциональной связи",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          aliveScore: 50,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "state-2",
          roomId: "room-1",
          personaId: "p2",
          mood: "calm",
          trustToUser: 50,
          energy: 50,
          engagement: 40,
          initiative: 40,
          affectionToUser: 50,
          tension: 20,
          activeTopics: [],
          aliveScore: 50,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      speakerPersonaId: "p1",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(updatedStates[0].energy).toBe(48);
    expect(updatedStates[0].engagement).toBe(53);
    expect(updatedStates[0].currentIntent).toBe("Укрепить связь");
    expect(updatedStates[0].influenceProfile?.goals[0]?.text).toBe(
      "Укрепить связь",
    );
    expect(updatedStates[1].engagement).toBe(41);

    const relation = buildRelationDynamicsAfterSpeech({
      edges: [
        {
          id: "edge-1",
          roomId: "room-1",
          fromPersonaId: "p1",
          toPersonaId: "p2",
          trust: 50,
          respect: 50,
          affinity: 50,
          tension: 50,
          influence: 50,
          attraction: 50,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      speakerPersonaId: "p1",
      mentionedPersonaIds: ["p2"],
      speechText: "@p2 спасибо за помощь!",
      nowIso: "2026-01-02T00:00:00.000Z",
    });

    expect(relation.updatedEdges[0].updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(relation.changes.length).toBeGreaterThan(0);
  });
});
