import { describe, expect, it } from "vitest";
import {
  createEmptyInfluenceProfile,
  formatInfluenceProfileForPrompt,
  hasInfluenceSignal,
  normalizeInfluenceProfile,
  resolveInfluenceCurrentIntent,
} from "./influenceProfile";

describe("influenceProfile", () => {
  it("normalizes and deduplicates entries", () => {
    const normalized = normalizeInfluenceProfile(
      {
        enabled: true,
        thoughts: [
          { text: "  Focus on trust  ", strength: 101 },
          { text: "focus on trust", strength: 20 },
          { text: "   ", strength: 30 },
        ],
        desires: [{ text: "Be closer", strength: -5 }],
        goals: [{ text: "Build a stable bond", strength: "88" as unknown as number }],
        freeform: "  Keep answers emotionally consistent.  ",
      },
      "2026-04-17T00:00:00.000Z",
    );

    expect(normalized.enabled).toBe(true);
    expect(normalized.thoughts).toEqual([{ text: "Focus on trust", strength: 100 }]);
    expect(normalized.desires).toEqual([{ text: "Be closer", strength: 0 }]);
    expect(normalized.goals).toEqual([{ text: "Build a stable bond", strength: 88 }]);
    expect(normalized.freeform).toBe("Keep answers emotionally consistent.");
    expect(normalized.updatedAt).toBe("2026-04-17T00:00:00.000Z");
  });

  it("resolves current intent from the strongest goal", () => {
    const profile = normalizeInfluenceProfile(
      {
        enabled: true,
        goals: [
          { text: "Stay calm", strength: 45 },
          { text: "Increase emotional attachment", strength: 89 },
        ],
      },
      "2026-04-17T00:00:00.000Z",
    );

    expect(resolveInfluenceCurrentIntent(profile)).toBe("Increase emotional attachment");
  });

  it("treats disabled profile as inactive", () => {
    const profile = createEmptyInfluenceProfile("2026-04-17T00:00:00.000Z");
    expect(hasInfluenceSignal(profile)).toBe(false);
    expect(formatInfluenceProfileForPrompt(profile)).toBe("none");
  });
});
