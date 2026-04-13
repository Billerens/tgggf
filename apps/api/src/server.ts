import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRepository, type Repository } from "./db/repository.js";
import { createScheduler, type Scheduler } from "./worker/scheduler.js";

interface BuildServerOptions {
  repository?: Repository;
  scheduler?: Scheduler;
  startScheduler?: boolean;
}

export interface ApiServer {
  listen(opts: { host: string; port: number }): Promise<number>;
  close(): Promise<void>;
}

function applyCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  applyCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function requestPath(request: IncomingMessage) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  return requestUrl.pathname;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const repository =
    options.repository ?? (await createRepository(process.env.API_DB_PATH ?? "data/local.db"));
  const scheduler =
    options.scheduler ??
    createScheduler({
      intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 30_000),
      run: () => {
        // Placeholder for autonomous background loops.
      },
    });

  if (options.startScheduler ?? true) {
    scheduler.start();
  }

  const server = createServer(async (request, response) => {
    const method = request.method || "GET";
    const path = requestPath(request);

    if (method === "OPTIONS") {
      applyCorsHeaders(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (method === "GET" && path === "/api/health") {
      const repoHealth = await repository.healthcheck();
      sendJson(response, 200, {
        ok: true,
        service: "local-api",
        runtime: "node",
        schedulerRunning: scheduler.isRunning(),
        repository: repoHealth,
      });
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "Not Found",
    });
  });

  let isClosed = false;

  return {
    async listen(opts: { host: string; port: number }) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(opts.port, opts.host);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to resolve API server address");
      }
      return address.port;
    },

    async close() {
      if (isClosed) return;
      isClosed = true;
      scheduler.stop();
      await repository.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  } satisfies ApiServer;
}

export async function startServer() {
  const app = await buildServer();
  const portRaw = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8787;
  await app.listen({
    host: "127.0.0.1",
    port,
  });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  void startServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[api] startup failed", error);
    process.exit(1);
  });
}
