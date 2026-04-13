import { describe, expect, it } from "vitest";
import { detectRuntimeMode } from "./runtimeMode";

describe("detectRuntimeMode", () => {
  it("returns web by default", () => {
    expect(detectRuntimeMode({})).toBe("web");
  });

  it("returns desktop when wrapper flag is present", () => {
    expect(detectRuntimeMode({ __TG_WRAPPER__: "desktop" })).toBe("desktop");
  });

  it("returns android when wrapper flag is present", () => {
    expect(detectRuntimeMode({ __TG_WRAPPER__: "android" })).toBe("android");
  });

  it("returns android when Capacitor platform is android", () => {
    expect(
      detectRuntimeMode({
        Capacitor: {
          getPlatform: () => "android",
        },
      }),
    ).toBe("android");
  });

  it("returns web when Capacitor platform is web", () => {
    expect(
      detectRuntimeMode({
        Capacitor: {
          getPlatform: () => "web",
        },
      }),
    ).toBe("web");
  });
});
