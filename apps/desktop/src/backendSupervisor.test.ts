import { describe, expect, it } from "vitest";
import { resolveApiUrl, shouldRestart, waitForHealth } from "./backendSupervisor.js";

describe("resolveApiUrl", () => {
  it("returns local api url", () => {
    expect(resolveApiUrl(8787)).toBe("http://127.0.0.1:8787");
  });
});

describe("waitForHealth", () => {
  it("resolves when health endpoint returns ok", async () => {
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
      } as Response);

    await expect(
      waitForHealth("http://127.0.0.1:8787/api/health", {
        timeoutMs: 50,
        pollIntervalMs: 10,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws on timeout", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("not ready");
    };

    await expect(
      waitForHealth("http://127.0.0.1:8787/api/health", {
        timeoutMs: 30,
        pollIntervalMs: 10,
        fetchImpl,
      }),
    ).rejects.toThrow("timeout");
  });
});

describe("shouldRestart", () => {
  it("returns true while attempts are below limit within window", () => {
    const now = 1_000;
    expect(shouldRestart([950, 990], now, 3, 200)).toBe(true);
  });

  it("returns false when attempts reach limit within window", () => {
    const now = 1_000;
    expect(shouldRestart([900, 950, 980], now, 3, 200)).toBe(false);
  });

  it("ignores old attempts outside restart window", () => {
    const now = 10_000;
    expect(shouldRestart([1_000, 9_900], now, 2, 200)).toBe(true);
  });
});
