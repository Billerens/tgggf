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

export interface BackgroundJobRecord {
  id: string;
  type: string;
  payload: unknown;
  status: "pending" | "leased" | "completed" | "failed";
  runAtMs: number;
  leaseUntilMs: number | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface EnsureRecurringBackgroundJobInput {
  id: string;
  type: string;
  payload?: unknown;
  runAtMs: number;
  maxAttempts?: number;
}

export interface RescheduleBackgroundJobInput {
  id: string;
  runAtMs: number;
  incrementAttempts?: boolean;
  lastError?: string | null;
}

export interface BackgroundJobRequestOptions {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSafeString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toSafeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toSafeNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBackgroundJobRecord(raw: unknown): BackgroundJobRecord | null {
  if (!isRecord(raw)) return null;
  const id = toSafeString(raw.id).trim();
  const type = toSafeString(raw.type).trim();
  const status = toSafeString(raw.status).trim();
  if (!id || !type) return null;
  if (status !== "pending" && status !== "leased" && status !== "completed" && status !== "failed") {
    return null;
  }
  return {
    id,
    type,
    payload: raw.payload,
    status,
    runAtMs: toSafeNumber(raw.runAtMs, Date.now()),
    leaseUntilMs: toSafeNullableNumber(raw.leaseUntilMs),
    attempts: toSafeNumber(raw.attempts, 0),
    maxAttempts: toSafeNumber(raw.maxAttempts, 0),
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError.trim() : null,
    createdAtMs: toSafeNumber(raw.createdAtMs, Date.now()),
    updatedAtMs: toSafeNumber(raw.updatedAtMs, Date.now()),
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

async function requestBackgroundJobApi(
  method: "GET" | "PUT",
  path: string,
  body: unknown,
  options: BackgroundJobRequestOptions,
) {
  const scope = options.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (plugin) {
    const response = await plugin.request({ method, path, body });
    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }
    const details = extractErrorMessage(response.body) || `HTTP ${response.status}`;
    throw new Error(`Background job request failed: ${details}`);
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
    throw new Error(`Background job request failed: ${details}`);
  }
  return responseBody;
}

function parseJobsEnvelope(payload: unknown) {
  if (!isRecord(payload)) return [];
  const jobsRaw = payload.jobs;
  if (!Array.isArray(jobsRaw)) return [];
  return jobsRaw.map(parseBackgroundJobRecord).filter((row): row is BackgroundJobRecord => Boolean(row));
}

export async function claimBackgroundJobs(
  limit = 4,
  leaseMs = 12_000,
  type?: string,
  options: BackgroundJobRequestOptions = {},
) {
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const normalizedLeaseMs = Math.max(1_000, Math.min(120_000, Math.floor(leaseMs)));
  const normalizedType = typeof type === "string" ? type.trim() : "";
  const typeQuery = normalizedType ? `&type=${encodeURIComponent(normalizedType)}` : "";
  const payload = await requestBackgroundJobApi(
    "GET",
    `/api/background-jobs/claim?limit=${normalizedLimit}&leaseMs=${normalizedLeaseMs}${typeQuery}`,
    undefined,
    options,
  );
  return parseJobsEnvelope(payload);
}

export async function listBackgroundJobs(
  status?: "pending" | "leased" | "completed" | "failed",
  limit = 50,
  options: BackgroundJobRequestOptions = {},
) {
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const query = status ? `status=${encodeURIComponent(status)}&` : "";
  const payload = await requestBackgroundJobApi(
    "GET",
    `/api/background-jobs?${query}limit=${normalizedLimit}`,
    undefined,
    options,
  );
  return parseJobsEnvelope(payload);
}

export async function ensureRecurringBackgroundJob(
  input: EnsureRecurringBackgroundJobInput,
  options: BackgroundJobRequestOptions = {},
) {
  const payload = await requestBackgroundJobApi(
    "PUT",
    "/api/background-jobs/ensure-recurring",
    {
      id: input.id,
      type: input.type,
      payload: input.payload,
      runAtMs: input.runAtMs,
      maxAttempts: input.maxAttempts ?? 0,
    },
    options,
  );
  if (!isRecord(payload)) return null;
  return parseBackgroundJobRecord(payload.job);
}

async function mutateBackgroundJob(
  path: string,
  body: unknown,
  options: BackgroundJobRequestOptions = {},
) {
  const payload = await requestBackgroundJobApi("PUT", path, body, options);
  if (!isRecord(payload)) return false;
  return payload.ok !== false;
}

export function completeBackgroundJob(
  id: string,
  options: BackgroundJobRequestOptions = {},
) {
  return mutateBackgroundJob("/api/background-jobs/complete", { id }, options);
}

export function cancelBackgroundJob(
  id: string,
  options: BackgroundJobRequestOptions = {},
) {
  return mutateBackgroundJob("/api/background-jobs/cancel", { id }, options);
}

export function rescheduleBackgroundJob(
  input: RescheduleBackgroundJobInput,
  options: BackgroundJobRequestOptions = {},
) {
  return mutateBackgroundJob(
    "/api/background-jobs/reschedule",
    {
      id: input.id,
      runAtMs: input.runAtMs,
      incrementAttempts: input.incrementAttempts ?? false,
      lastError: input.lastError ?? null,
    },
    options,
  );
}
