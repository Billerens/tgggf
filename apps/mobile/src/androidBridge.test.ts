import { describe, expect, it } from "vitest";
import { resolveAndroidApiBase } from "./androidBridge.js";

describe("resolveAndroidApiBase", () => {
  it("returns bridge scheme for android wrapper", () => {
    expect(resolveAndroidApiBase()).toBe("bridge://api");
  });
});
