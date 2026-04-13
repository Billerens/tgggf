import { describe, expect, it } from "vitest";
import { resolveApiUrl, waitForHealth } from "./backendSupervisor.js";

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
