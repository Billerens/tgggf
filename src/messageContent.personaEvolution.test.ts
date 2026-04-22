import { describe, expect, it } from "vitest";
import { splitAssistantContent } from "./messageContent";

describe("splitAssistantContent persona_control.evolution", () => {
  it("parses evolution payload from service json", () => {
    const content = [
      "Visible text",
      "```json",
      JSON.stringify({
        persona_control: {
          evolution: {
            shouldEvolve: true,
            reason: "Meaningful shift",
            patch: {
              stylePrompt: "warmer and slower",
              advanced: {
                voice: { tone: "warm" },
              },
            },
          },
        },
      }),
      "```",
    ].join("\n");

    const parsed = splitAssistantContent(content);

    expect(parsed.visibleText).toBe("Visible text");
    expect(parsed.personaControl?.evolution?.shouldEvolve).toBe(true);
    expect(parsed.personaControl?.evolution?.reason).toBe("Meaningful shift");
    expect(parsed.personaControl?.evolution?.patch).toEqual({
      stylePrompt: "warmer and slower",
      advanced: {
        voice: { tone: "warm" },
      },
    });
  });

  it("keeps evolution intent but drops invalid patch payload", () => {
    const content = JSON.stringify({
      persona_control: {
        evolution: {
          shouldEvolve: true,
          reason: "Try",
          patch: {
            unsupportedField: "ignored",
          },
        },
      },
    });

    const parsed = splitAssistantContent(content);

    expect(parsed.personaControl?.evolution?.shouldEvolve).toBe(true);
    expect(parsed.personaControl?.evolution?.reason).toBe("Try");
    expect(parsed.personaControl?.evolution?.patch).toBeUndefined();
  });
});
