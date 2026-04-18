import { describe, expect, it } from "vitest";
import {
  compactAppearanceLocksFromAppearance,
  parseComfyImageDescriptionContract,
} from "./comfyImageDescriptionContract";

describe("comfyImageDescriptionContract", () => {
  it("parses strict person contract", () => {
    const parsed = parseComfyImageDescriptionContract(
      [
        "type: person",
        "subject_mode: persona_self",
        "participants: persona:self",
        "participant_aliases: persona:self=Me",
        "subject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=silver hoop",
        "Waist-up selfie near a rainy neon window, soft rim light, natural skin texture.",
      ].join("\n"),
    );

    expect(parsed.type).toBe("person");
    expect(parsed.participants).toEqual(["persona:self"]);
    expect(parsed.participantAliases["persona:self"]).toBe("Me");
    expect(parsed.subjectLocks["persona:self"]).toContain("hair=dark bob");
  });

  it("rejects legacy format without required fields", () => {
    expect(() =>
      parseComfyImageDescriptionContract(
        "type: person\nparticipants: persona:self\nSimple portrait by the window.",
      ),
    ).toThrow(/contract_invalid/i);
  });

  it("enforces no_person none contract", () => {
    const parsed = parseComfyImageDescriptionContract(
      [
        "type: no_person",
        "subject_mode: no_person",
        "participants: none",
        "participant_aliases: none",
        "subject_locks: none",
        "Empty wooden desk with a ceramic mug and morning sunlight.",
      ].join("\n"),
    );

    expect(parsed.type).toBe("no_person");
    expect(parsed.participants).toEqual([]);
  });

  it("normalizes external slug tokens", () => {
    const parsed = parseComfyImageDescriptionContract(
      [
        "type: other_person",
        "subject_mode: other_person",
        "participants: external:John Doe",
        "participant_aliases: external:John Doe=Guest",
        "subject_locks: external:John Doe=hair=short black, eyes=brown, face=stubble, body=athletic, outfit=denim jacket, markers=none",
        "Street portrait at night with wet asphalt reflections.",
      ].join("\n"),
    );

    expect(parsed.participants).toEqual(["external:john_doe"]);
    expect(parsed.participantAliases["external:john_doe"]).toBe("Guest");
  });

  it("parses comma-separated participant pairs and normalizes output delimiter to pipe", () => {
    const parsed = parseComfyImageDescriptionContract(
      [
        "type: group",
        "subject_mode: group",
        "participants: persona:self, persona:abc",
        "participant_aliases: persona:self=Me, persona:abc=Friend",
        "subject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=silver hoop, persona:abc=hair=silver braid, eyes=blue, face=soft features, body=slender, outfit=linen dress, markers=small mole",
        "Two friends in a garden drinking tea on a wooden bench.",
      ].join("\n"),
    );

    expect(parsed.participantAliases["persona:self"]).toBe("Me");
    expect(parsed.participantAliases["persona:abc"]).toBe("Friend");
    expect(parsed.subjectLocks["persona:abc"]).toContain("hair=silver braid");
    expect(parsed.normalizedDescription).toContain(
      "participant_aliases: persona:self=Me | persona:abc=Friend",
    );
  });

  it("builds compact appearance locks", () => {
    const locks = compactAppearanceLocksFromAppearance({
      faceDescription: "soft jawline",
      height: "",
      eyes: "green",
      lips: "",
      hair: "dark bob",
      ageType: "",
      bodyType: "slim",
      markers: "silver hoop",
      accessories: "",
      clothingStyle: "white hoodie",
      skin: "",
    });

    expect(locks.hair).toBe("dark bob");
    expect(locks.eyes).toBe("green");
    expect(locks.face).toBe("soft jawline");
    expect(locks.outfit).toBe("white hoodie");
  });
});
