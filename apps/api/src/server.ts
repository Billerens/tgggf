import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { createRepository, type Repository } from "./db/repository.js";
import { createScheduler, type Scheduler } from "./worker/scheduler.js";

interface BuildServerOptions {
  repository?: Repository;
  scheduler?: Scheduler;
  startScheduler?: boolean;
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

  const app = Fastify();
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  app.get("/api/health", async () => {
    const repoHealth = await repository.healthcheck();
    return {
      ok: true,
      service: "local-api",
      runtime: "node",
      schedulerRunning: scheduler.isRunning(),
      repository: repoHealth,
    };
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
    await repository.close();
  });

  return app;
}

export async function startServer() {
  const app = await buildServer();
  const portRaw = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8787;
  await app.listen({ host: "127.0.0.1", port });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
