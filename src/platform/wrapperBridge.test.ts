import { describe, expect, it } from "vitest";
import { getWrapperInfo } from "./wrapperBridge";

describe("wrapper bridge", () => {
  it("returns desktop mode when bridge exists", () => {
    const info = getWrapperInfo({
      tgWrapper: { mode: "desktop", apiBaseUrl: "http://127.0.0.1:8787" },
    });
    expect(info.mode).toBe("desktop");
    expect(info.apiBaseUrl).toBe("http://127.0.0.1:8787");
  });

  it("returns android mode when bridge exists", () => {
    const info = getWrapperInfo({
      tgWrapper: { mode: "android", apiBaseUrl: "bridge://api" },
    });
    expect(info.mode).toBe("android");
    expect(info.apiBaseUrl).toBe("bridge://api");
  });

  it("returns web mode by default", () => {
    const info = getWrapperInfo({});
    expect(info.mode).toBe("web");
  });
});

