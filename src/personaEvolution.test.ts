import { describe, expect, it } from "vitest";
import {
  applyPersonaEvolutionPatch,
  buildPersonaEvolutionPatchDeltaRows,
  buildPersonaEvolutionProfileDeltaRows,
  formatPersonaEvolutionHistoryForPrompt,
  normalizePersonaEvolutionPatch,
  selectAppliedPersonaEvolutionHistory,
} from "./personaEvolution";
import type { PersonaEvolutionHistoryItem, PersonaEvolutionProfile } from "./types";

describe("personaEvolution", () => {
  it("normalizes evolution patch shape and drops invalid fields", () => {
    const patch = normalizePersonaEvolutionPatch({
      personalityPrompt: "  calmer and more reflective  ",
      stylePrompt: " ",
      appearance: {
        hair: "dark bob",
        unknown: "ignored",
      },
      advanced: {
        core: {
          selfGender: "female",
          unknown: "ignored",
        },
        behavior: {
          initiative: 72,
          empathy: "bad",
        },
      },
    });

    expect(patch).toEqual({
      personalityPrompt: "calmer and more reflective",
      appearance: { hair: "dark bob" },
      advanced: {
        core: { selfGender: "female" },
        behavior: { initiative: 72 },
      },
    });
  });

  it("applies patch over current profile", () => {
    const current: PersonaEvolutionProfile = {
      personalityPrompt: "playful",
      stylePrompt: "short",
      appearance: { hair: "brown", eyes: "green" },
      advanced: {
        voice: { tone: "light", formality: 30 },
      },
    };

    const next = applyPersonaEvolutionPatch(current, {
      stylePrompt: "balanced",
      appearance: { eyes: "hazel" },
      advanced: {
        voice: { tone: "warm" },
      },
    });

    expect(next).toEqual({
      personalityPrompt: "playful",
      stylePrompt: "balanced",
      appearance: { hair: "brown", eyes: "hazel" },
      advanced: {
        voice: { tone: "warm", formality: 30 },
      },
    });
  });

  it("formats only last 10 applied evolution events excluding undone", () => {
    const applied: PersonaEvolutionHistoryItem[] = Array.from(
      { length: 12 },
      (_, index) => ({
        id: `applied-${index}`,
        status: "applied",
        timestamp: `2026-04-21T10:${String(index).padStart(2, "0")}:00.000Z`,
        reason: `reason ${index}`,
        patch: { stylePrompt: `style ${index}` },
      }),
    );

    const history: PersonaEvolutionHistoryItem[] = [
      ...applied,
      {
        id: "undone-1",
        status: "undone",
        targetEventId: "applied-10",
        timestamp: "2026-04-21T11:00:00.000Z",
        reason: "undo",
        patch: {},
      },
    ];

    const selected = selectAppliedPersonaEvolutionHistory(history);
    expect(selected.some((event) => event.id === "applied-10")).toBe(false);

    const promptBlock = formatPersonaEvolutionHistoryForPrompt(history, 10);
    const lines = promptBlock.split("\n").filter(Boolean);

    expect(lines).toHaveLength(10);
    expect(lines.some((line) => line.includes("reason 10"))).toBe(false);
    expect(lines.at(-1)).toContain("reason 11");
  });

  it("builds patch delta rows with before and after values", () => {
    const before: PersonaEvolutionProfile = {
      stylePrompt: "soft and uncertain",
      advanced: {
        behavior: {
          initiative: 42,
        },
      },
    };
    const patch: PersonaEvolutionProfile = {
      stylePrompt: "warmer and steadier",
      advanced: {
        behavior: {
          initiative: 56,
        },
      },
    };

    const rows = buildPersonaEvolutionPatchDeltaRows(before, patch, 10);
    expect(rows).toEqual([
      {
        field: "stylePrompt",
        before: "soft and uncertain",
        after: "warmer and steadier",
      },
      {
        field: "advanced.behavior.initiative",
        before: "42",
        after: "56",
      },
    ]);
  });

  it("builds profile delta rows for undo-like state changes", () => {
    const before: PersonaEvolutionProfile = {
      advanced: {
        emotion: {
          baselineMood: "warm",
          stability: 64,
        },
      },
    };
    const after: PersonaEvolutionProfile = {
      advanced: {
        emotion: {
          baselineMood: "calm",
          stability: 54,
        },
      },
    };

    const rows = buildPersonaEvolutionProfileDeltaRows(before, after, 10);
    expect(rows).toEqual([
      {
        field: "advanced.emotion.baselineMood",
        before: "warm",
        after: "calm",
      },
      {
        field: "advanced.emotion.stability",
        before: "64",
        after: "54",
      },
    ]);
  });
});
