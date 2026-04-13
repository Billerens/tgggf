import { describe, expect, it } from "vitest";
import {
  createAndroidWrapperBridge,
  installAndroidWrapperBridge,
  resolveAndroidApiBase,
} from "./androidBridge.js";

describe("resolveAndroidApiBase", () => {
  it("returns bridge scheme for android wrapper", () => {
    expect(resolveAndroidApiBase()).toBe("bridge://api");
  });
});

describe("createAndroidWrapperBridge", () => {
  it("creates bridge with mode and health function", async () => {
    const bridge = createAndroidWrapperBridge(async () => ({
      ok: true,
      service: "android-local-api",
    }));
    expect(bridge.mode).toBe("android");
    expect(bridge.apiBaseUrl).toBe("bridge://api");
    await expect(bridge.health()).resolves.toEqual({
      ok: true,
      service: "android-local-api",
    });
  });
});

describe("installAndroidWrapperBridge", () => {
  it("installs tgWrapper onto target object", () => {
    const target: Record<string, unknown> = {};
    installAndroidWrapperBridge(target, async () => ({
      ok: true,
      service: "android-local-api",
    }));
    expect(target.tgWrapper).toBeTruthy();
  });
});
