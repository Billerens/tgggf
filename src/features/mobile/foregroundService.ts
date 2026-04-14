import { getRuntimeContext } from "../../platform/runtimeContext";

interface LocalApiPluginRequestInput {
  method: "GET" | "PUT";
  path: string;
  body?: unknown;
}

interface LocalApiPluginRequestOutput {
  status: number;
  body: unknown;
}

interface LocalApiPlugin {
  request(input: LocalApiPluginRequestInput): Promise<LocalApiPluginRequestOutput>;
}

interface CapacitorLikeScope {
  Capacitor?: {
    Plugins?: {
      LocalApi?: LocalApiPlugin;
    };
  };
}

export interface ForegroundServiceStatus {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  health: ForegroundServiceHealth;
  staleWorkers: number;
  staleJobs: number;
  hasWorkerErrors: boolean;
  lastError: string | null;
  collectedAtMs: number;
  queue: ForegroundQueueMetrics;
  activeScopes: ForegroundActiveScopeMetrics;
  workers: ForegroundWorkerStatusSnapshot[];
}

export interface ForegroundServiceRequestOptions {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}

export type ForegroundWorkerType = "topic_generation" | "group_iteration";

export type ForegroundServiceHealth = "active" | "degraded" | "fallback";

export interface ForegroundQueueMetrics {
  pending: number;
  leased: number;
  staleLeased: number;
  totalDepth: number;
}

export interface ForegroundActiveScopeMetrics {
  topicGeneration: number;
  groupIteration: number;
  total: number;
}

export interface ForegroundWorkerStatusSnapshot {
  worker: ForegroundWorkerType | string;
  state: string;
  scopeId: string | null;
  detail: string | null;
  heartbeatAtMs: number;
  progressAtMs: number | null;
  claimAtMs: number | null;
  lastError: string | null;
  stale: boolean;
}

export interface ForegroundWorkerStatusUpdate {
  worker: ForegroundWorkerType;
  state: "idle" | "running" | "blocked" | "error";
  scopeId?: string;
  detail?: string;
  progress?: boolean;
  claimed?: boolean;
  lastError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readHealth(value: unknown): ForegroundServiceHealth | null {
  if (value === "active" || value === "degraded" || value === "fallback") {
    return value;
  }
  return null;
}

function resolveFallbackHealth(params: {
  enabled: boolean;
  running: boolean;
  staleWorkers: number;
  staleJobs: number;
  hasWorkerErrors: boolean;
}): ForegroundServiceHealth {
  if (!params.enabled) return "fallback";
  if (!params.running) return "degraded";
  if (params.staleWorkers > 0) return "degraded";
  if (params.staleJobs > 0) return "degraded";
  if (params.hasWorkerErrors) return "degraded";
  return "active";
}

function parseStatusPayload(payload: unknown): ForegroundServiceStatus {
  const source = isRecord(payload) ? payload : {};
  const workersRaw = Array.isArray(source.workers) ? source.workers : [];
  const workers: ForegroundWorkerStatusSnapshot[] = [];
  for (const value of workersRaw) {
    if (!isRecord(value)) continue;
    workers.push({
      worker: typeof value.worker === "string" ? value.worker : "unknown",
      state: typeof value.state === "string" ? value.state : "idle",
      scopeId: typeof value.scopeId === "string" ? value.scopeId : null,
      detail: typeof value.detail === "string" ? value.detail : null,
      heartbeatAtMs:
        typeof value.heartbeatAtMs === "number" && Number.isFinite(value.heartbeatAtMs)
          ? value.heartbeatAtMs
          : 0,
      progressAtMs:
        typeof value.progressAtMs === "number" && Number.isFinite(value.progressAtMs)
          ? value.progressAtMs
          : null,
      claimAtMs:
        typeof value.claimAtMs === "number" && Number.isFinite(value.claimAtMs)
          ? value.claimAtMs
          : null,
      lastError: typeof value.lastError === "string" ? value.lastError : null,
      stale: Boolean(value.stale),
    });
  }
  const queueSource = isRecord(source.queue) ? source.queue : {};
  const queuePending = readFiniteNumber(queueSource.pending, 0);
  const queueLeased = readFiniteNumber(queueSource.leased, 0);
  const queueStaleLeased = readFiniteNumber(queueSource.staleLeased, 0);
  const queueTotalDepth = readFiniteNumber(
    queueSource.totalDepth,
    queuePending + queueLeased,
  );
  const activeScopesSource = isRecord(source.activeScopes) ? source.activeScopes : {};
  const activeTopicGeneration = readFiniteNumber(activeScopesSource.topicGeneration, 0);
  const activeGroupIteration = readFiniteNumber(activeScopesSource.groupIteration, 0);
  const activeTotal = readFiniteNumber(
    activeScopesSource.total,
    activeTopicGeneration + activeGroupIteration,
  );
  const staleWorkers = readFiniteNumber(source.staleWorkers, 0);
  const staleJobs = readFiniteNumber(source.staleJobs, queueStaleLeased);
  const lastError =
    typeof source.lastError === "string" && source.lastError.trim()
      ? source.lastError.trim()
      : null;
  const hasWorkerErrors =
    typeof source.hasWorkerErrors === "boolean"
      ? source.hasWorkerErrors
      : workers.some(
          (worker) =>
            worker.state.toLowerCase() === "error" ||
            (typeof worker.lastError === "string" && worker.lastError.trim().length > 0),
        );
  const enabled = typeof source.enabled === "boolean" ? source.enabled : true;
  const running = typeof source.running === "boolean" ? source.running : false;
  const health =
    readHealth(source.health) ??
    resolveFallbackHealth({
      enabled,
      running,
      staleWorkers,
      staleJobs,
      hasWorkerErrors,
    });
  return {
    ok: source.ok !== false,
    enabled,
    running,
    health,
    staleWorkers,
    staleJobs,
    hasWorkerErrors,
    lastError,
    collectedAtMs: readFiniteNumber(source.collectedAtMs, 0),
    queue: {
      pending: queuePending,
      leased: queueLeased,
      staleLeased: queueStaleLeased,
      totalDepth: queueTotalDepth,
    },
    activeScopes: {
      topicGeneration: activeTopicGeneration,
      groupIteration: activeGroupIteration,
      total: activeTotal,
    },
    workers,
  };
}

function extractErrorMessage(body: unknown) {
  if (!isRecord(body)) return null;
  const value = body.error;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function resolveApiUrl(path: string) {
  const runtime = getRuntimeContext();
  const base = runtime.apiBaseUrl.trim().replace(/\/+$/g, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
}

async function requestForegroundService(
  method: "GET" | "PUT",
  path: string,
  body: unknown,
  options: ForegroundServiceRequestOptions,
) {
  const scope = options.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (plugin) {
    const response = await plugin.request({
      method,
      path,
      body,
    });
    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }
    const details = extractErrorMessage(response.body) || `HTTP ${response.status}`;
    throw new Error(`Foreground service request failed: ${details}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(resolveApiUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  if (!response.ok) {
    const details = extractErrorMessage(responseBody) || `HTTP ${response.status}`;
    throw new Error(`Foreground service request failed: ${details}`);
  }
  return responseBody;
}

export async function getForegroundServiceStatus(
  options: ForegroundServiceRequestOptions = {},
) {
  const payload = await requestForegroundService(
    "GET",
    "/api/foreground-service",
    undefined,
    options,
  );
  return parseStatusPayload(payload);
}

export async function setForegroundServiceEnabled(
  enabled: boolean,
  options: ForegroundServiceRequestOptions = {},
) {
  const payload = await requestForegroundService(
    "PUT",
    "/api/foreground-service",
    { enabled },
    options,
  );
  return parseStatusPayload(payload);
}

export async function updateForegroundWorkerStatus(
  update: ForegroundWorkerStatusUpdate,
  options: ForegroundServiceRequestOptions = {},
) {
  const payload = await requestForegroundService(
    "PUT",
    "/api/foreground-service/worker-status",
    {
      worker: update.worker,
      state: update.state,
      scopeId: update.scopeId ?? "",
      detail: update.detail ?? "",
      progress: Boolean(update.progress),
      claimed: Boolean(update.claimed),
      lastError: update.lastError ?? "",
    },
    options,
  );
  return parseStatusPayload(payload);
}
