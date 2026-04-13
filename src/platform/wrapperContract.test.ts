import { describe, expect, it } from "vitest";
import { getWrapperBridge } from "./wrapperContract";

describe("getWrapperBridge", () => {
  it("returns bridge when valid desktop payload is present", () => {
    const bridge = getWrapperBridge({
      tgWrapper: {
        mode: "desktop",
        apiBaseUrl: "http://127.0.0.1:8787",
      },
    });
    expect(bridge?.mode).toBe("desktop");
  });

  it("returns null for invalid shape", () => {
    const bridge = getWrapperBridge({
      tgWrapper: {
        mode: "desktop",
      },
    });
    expect(bridge).toBeNull();
  });
});

