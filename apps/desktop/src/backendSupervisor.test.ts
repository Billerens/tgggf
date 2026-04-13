import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./backendSupervisor.js";

describe("resolveApiUrl", () => {
  it("returns local api url", () => {
    expect(resolveApiUrl(8787)).toBe("http://127.0.0.1:8787");
  });
});

