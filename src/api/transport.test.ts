import { describe, expect, it } from "vitest";
import { createApiBaseUrl } from "./transport";

describe("createApiBaseUrl", () => {
  it("uses relative /api in desktop mode", () => {
    expect(createApiBaseUrl("desktop", undefined)).toBe("/api");
  });

  it("uses bridge://api in android mode", () => {
    expect(createApiBaseUrl("android", undefined)).toBe("bridge://api");
  });

  it("uses provided backend url in web mode", () => {
    expect(createApiBaseUrl("web", "https://api.example.com")).toBe("https://api.example.com");
  });
});

