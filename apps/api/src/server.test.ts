import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ApiServer } from "./server.js";

let app: ApiServer;
let apiBaseUrl = "";

beforeAll(async () => {
  app = await buildServer({ startScheduler: false });
  const port = await app.listen({ host: "127.0.0.1", port: 0 });
  apiBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

describe("api health", () => {
  it("returns ok payload", async () => {
    const response = await fetch(`${apiBaseUrl}/api/health`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      service?: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("local-api");
  });
});

