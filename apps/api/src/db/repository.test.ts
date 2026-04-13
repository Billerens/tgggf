import { describe, expect, it } from "vitest";
import { createRepository } from "./repository.js";

describe("repository bootstrap", () => {
  it("creates default tables contract", async () => {
    const repo = await createRepository(":memory:");
    const health = await repo.healthcheck();
    expect(health.ok).toBe(true);
    expect(health.schemaVersion).toBe(1);
    await repo.close();
  });
});

