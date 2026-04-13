import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveApiUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

export function resolveApiHealthUrl(port: number) {
  return `${resolveApiUrl(port)}/api/health`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForHealth(
  healthUrl: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 300;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchImpl(healthUrl);
      if (response.ok) return;
      lastError = new Error(`Healthcheck returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  const details =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Backend healthcheck timeout (${timeoutMs} ms).${details}`);
}

function resolveDefaultBackendEntryPath() {
  const filePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(filePath);
  // dist/backendSupervisor.js -> ../../api/dist/server.js
  return path.resolve(currentDir, "../../api/dist/server.js");
}

export interface BackendSupervisorConfig {
  apiPort: number;
  apiHost?: string;
  apiHealthPath?: string;
  backendEntryPath?: string;
  nodeBinary?: string;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface BackendSupervisor {
  apiUrl: string;
  start(): Promise<void>;
  waitUntilReady(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createBackendSupervisor(config: BackendSupervisorConfig): BackendSupervisor {
  const apiHost = config.apiHost || "127.0.0.1";
  const apiPort = config.apiPort;
  const apiHealthPath = config.apiHealthPath || "/api/health";
  const nodeBinary = config.nodeBinary || process.execPath;
  const backendEntryPath =
    config.backendEntryPath || resolveDefaultBackendEntryPath();
  const startTimeoutMs = config.startTimeoutMs ?? 20_000;
  const pollIntervalMs = config.pollIntervalMs ?? 300;
  const apiUrl = `http://${apiHost}:${apiPort}`;
  const healthUrl = `${apiUrl}${apiHealthPath}`;

  let child: ChildProcessWithoutNullStreams | null = null;

  return {
    apiUrl,

    async start() {
      if (child && !child.killed) return;
      if (!existsSync(backendEntryPath)) {
        throw new Error(
          `Backend entry not found: ${backendEntryPath}. Run build:api before desktop start.`,
        );
      }

      child = spawn(nodeBinary, [backendEntryPath], {
        stdio: "pipe",
        env: {
          ...process.env,
          API_PORT: String(apiPort),
        },
      });

      child.stdout.on("data", (chunk) => {
        process.stdout.write(`[desktop->api] ${String(chunk)}`);
      });
      child.stderr.on("data", (chunk) => {
        process.stderr.write(`[desktop->api] ${String(chunk)}`);
      });
    },

    async waitUntilReady() {
      await waitForHealth(healthUrl, {
        timeoutMs: startTimeoutMs,
        pollIntervalMs,
      });
    },

    async stop() {
      if (!child) return;
      if (!child.killed) {
        child.kill();
      }
      child = null;
    },

    isRunning() {
      return Boolean(child && !child.killed);
    },
  };
}
