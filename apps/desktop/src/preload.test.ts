import { describe, expect, it } from "vitest";
import { createDesktopBridge, createDesktopBridgeFromEnv } from "./preload.js";

describe("createDesktopBridgeFromEnv", () => {
  it("uses explicit api base url from env", () => {
    const bridge = createDesktopBridgeFromEnv({
      TG_DESKTOP_API_BASE_URL: "http://127.0.0.1:9999",
    } as NodeJS.ProcessEnv);
    expect(bridge.apiBaseUrl).toBe("http://127.0.0.1:9999");
  });
});

describe("createDesktopBridge.health", () => {
  it("calls desktop local health endpoint", async () => {
    const fetchImpl: typeof fetch = async (input) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, service: "local-api", input }),
      } as Response);

    const bridge = createDesktopBridge("http://127.0.0.1:8787", fetchImpl);
    const payload = await bridge.health();
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("local-api");
  });
});

