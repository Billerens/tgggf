import { describe, expect, it } from "vitest";
import { evaluateDiaryGenerationGate, normalizeDiaryTags } from "./diary";

describe("diary gate", () => {
  it("blocks when feature disabled", () => {
    const result = evaluateDiaryGenerationGate({
      enabled: false,
      nowMs: 10_000,
      lastActivityAtMs: 0,
      hasNewSource: true,
      newMessageCount: 10,
      newCharCount: 500,
    });
    expect(result).toEqual({ eligible: false, reason: "disabled" });
  });

  it("requires idle and interval and enough content", () => {
    const nowMs = 1_000_000;
    const result = evaluateDiaryGenerationGate({
      enabled: true,
      nowMs,
      lastActivityAtMs: nowMs - 11 * 60 * 1000,
      lastCheckedAtMs: nowMs - 16 * 60 * 1000,
      lastGeneratedAtMs: nowMs - 16 * 60 * 1000,
      hasNewSource: true,
      newMessageCount: 5,
      newCharCount: 300,
    });
    expect(result).toEqual({ eligible: true, reason: "ok" });
  });

  it("blocks when interval has not elapsed", () => {
    const nowMs = 2_000_000;
    const result = evaluateDiaryGenerationGate({
      enabled: true,
      nowMs,
      lastActivityAtMs: nowMs - 11 * 60 * 1000,
      lastCheckedAtMs: nowMs - 3 * 60 * 1000,
      hasNewSource: true,
      newMessageCount: 10,
      newCharCount: 800,
    });
    expect(result).toEqual({
      eligible: false,
      reason: "check_interval_not_elapsed",
    });
  });
});

describe("normalizeDiaryTags", () => {
  it("keeps only concrete prefixed tags", () => {
    const tags = normalizeDiaryTags([
      "topic:conflict about vacation",
      "emotion:frustrated",
      "abstract:maybe",
      "date:2026-04-20",
      "topic:conflict about vacation",
      "   ",
    ]);
    expect(tags).toEqual([
      "topic:conflict about vacation",
      "emotion:frustrated",
      "date:2026-04-20",
    ]);
  });
});
