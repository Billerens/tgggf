import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ startScheduler: false });
});

afterAll(async () => {
  await app.close();
});

describe("api health", () => {
  it("returns ok payload", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("local-api");
  });
});

