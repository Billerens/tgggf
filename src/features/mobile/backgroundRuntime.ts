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

interface BackgroundRuntimeRequestOptions {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}

export interface BackgroundDesiredStateRecord {
  taskType: string;
  scopeId: string;
  enabled: boolean;
  payload: unknown;
  updatedAtMs: number;
}

export interface BackgroundRuntimeEventRecord {
  id: number;
  taskType: string;
  scopeId: string;
  jobId: string | null;
  stage: string;
  level: string;
  message: string;
  details: unknown;
  createdAtMs: number;
}

export interface SetBackgroundDesiredStateInput {
  taskType: string;
  scopeId: string;
  enabled: boolean;
  payload?: unknown;
}

export interface AppendBackgroundRuntimeEventInput {
  taskType: string;
  scopeId: string;
  stage: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error" | string;
  jobId?: string | null;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSafeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toSafeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
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

async function requestBackgroundRuntime(
  method: "GET" | "PUT",
  path: string,
  body: unknown,
  options: BackgroundRuntimeRequestOptions = {},
) {
  const scope = options.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (plugin) {
    const response = await plugin.request({ method, path, body });
    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }
    const details = extractErrorMessage(response.body) || `HTTP ${response.status}`;
    throw new Error(`Background runtime request failed: ${details}`);
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
    throw new Error(`Background runtime request failed: ${details}`);
  }
  return responseBody;
}

function parseDesiredStateRecord(raw: unknown): BackgroundDesiredStateRecord | null {
  if (!isRecord(raw)) return null;
  const taskType = toSafeString(raw.taskType).trim();
  const scopeId = toSafeString(raw.scopeId).trim();
  if (!taskType || !scopeId) return null;
  return {
    taskType,
    scopeId,
    enabled: raw.enabled === true,
    payload: raw.payload,
    updatedAtMs: toSafeNumber(raw.updatedAtMs, Date.now()),
  };
}

function parseRuntimeEventRecord(raw: unknown): BackgroundRuntimeEventRecord | null {
  if (!isRecord(raw)) return null;
  const taskType = toSafeString(raw.taskType).trim();
  const scopeId = toSafeString(raw.scopeId).trim();
  const stage = toSafeString(raw.stage).trim();
  const message = toSafeString(raw.message).trim();
  if (!taskType || !scopeId || !stage || !message) return null;
  return {
    id: toSafeNumber(raw.id, 0),
    taskType,
    scopeId,
    jobId: typeof raw.jobId === "string" && raw.jobId.trim() ? raw.jobId.trim() : null,
    stage,
    level: toSafeString(raw.level, "info"),
    message,
    details: raw.details,
    createdAtMs: toSafeNumber(raw.createdAtMs, Date.now()),
  };
}

export async function setBackgroundDesiredState(
  input: SetBackgroundDesiredStateInput,
  options: BackgroundRuntimeRequestOptions = {},
) {
  const payload = await requestBackgroundRuntime(
    "PUT",
    "/api/background-runtime/desired-state",
    {
      taskType: input.taskType,
      scopeId: input.scopeId,
      enabled: input.enabled,
      payload: input.payload ?? {},
    },
    options,
  );
  if (!isRecord(payload)) return null;
  return parseDesiredStateRecord(payload.state);
}

export async function listBackgroundDesiredStates(
  taskType?: string,
  scopeId?: string,
  options: BackgroundRuntimeRequestOptions = {},
) {
  const queryParts: string[] = [];
  if (typeof taskType === "string" && taskType.trim()) {
    queryParts.push(`taskType=${encodeURIComponent(taskType.trim())}`);
  }
  if (typeof scopeId === "string" && scopeId.trim()) {
    queryParts.push(`scopeId=${encodeURIComponent(scopeId.trim())}`);
  }
  const path =
    queryParts.length > 0
      ? `/api/background-runtime/desired-state?${queryParts.join("&")}`
      : "/api/background-runtime/desired-state";
  const payload = await requestBackgroundRuntime("GET", path, undefined, options);
  if (!isRecord(payload) || !Array.isArray(payload.states)) return [] as BackgroundDesiredStateRecord[];
  return payload.states
    .map(parseDesiredStateRecord)
    .filter((row): row is BackgroundDesiredStateRecord => Boolean(row));
}

export async function appendBackgroundRuntimeEvent(
  input: AppendBackgroundRuntimeEventInput,
  options: BackgroundRuntimeRequestOptions = {},
) {
  const payload = await requestBackgroundRuntime(
    "PUT",
    "/api/background-runtime/events",
    {
      taskType: input.taskType,
      scopeId: input.scopeId,
      stage: input.stage,
      level: input.level ?? "info",
      message: input.message,
      jobId: input.jobId ?? null,
      details: input.details ?? {},
    },
    options,
  );
  if (!isRecord(payload)) return null;
  return parseRuntimeEventRecord(payload.event);
}

export async function listBackgroundRuntimeEvents(
  input: {
    taskType?: string;
    scopeId?: string;
    limit?: number;
  } = {},
  options: BackgroundRuntimeRequestOptions = {},
) {
  const queryParts: string[] = [];
  if (typeof input.taskType === "string" && input.taskType.trim()) {
    queryParts.push(`taskType=${encodeURIComponent(input.taskType.trim())}`);
  }
  if (typeof input.scopeId === "string" && input.scopeId.trim()) {
    queryParts.push(`scopeId=${encodeURIComponent(input.scopeId.trim())}`);
  }
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    queryParts.push(`limit=${Math.max(1, Math.min(500, Math.floor(input.limit)))}`);
  }
  const path =
    queryParts.length > 0
      ? `/api/background-runtime/events?${queryParts.join("&")}`
      : "/api/background-runtime/events";
  const payload = await requestBackgroundRuntime("GET", path, undefined, options);
  if (!isRecord(payload) || !Array.isArray(payload.events)) return [] as BackgroundRuntimeEventRecord[];
  return payload.events
    .map(parseRuntimeEventRecord)
    .filter((row): row is BackgroundRuntimeEventRecord => Boolean(row));
}
