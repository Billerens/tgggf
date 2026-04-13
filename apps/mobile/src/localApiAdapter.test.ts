import { describe, expect, it } from "vitest";
import { mapBridgeHealthPayload } from "./localApiAdapter.js";

describe("mapBridgeHealthPayload", () => {
  it("maps native payload to shared health contract", () => {
    const result = mapBridgeHealthPayload({ ok: true, service: "android-local-api" });
    expect(result.ok).toBe(true);
    expect(result.service).toBe("android-local-api");
  });
});

