import { getRuntimeContext } from "../../platform/runtimeContext";
import type { ImageAsset } from "../../types";

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

interface BackgroundDeltaRequestOptions {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}

export type BackgroundDeltaKind = "worker_action" | "state_patch" | string;

export interface BackgroundDeltaItem {
  id: number;
  taskType: string;
  scopeId: string;
  kind: BackgroundDeltaKind;
  entityType: string;
  entityId: string | null;
  payload: unknown;
  createdAtMs: number;
}

export interface GetDeltaResponse {
  items: BackgroundDeltaItem[];
  nextSinceId: number;
}

export interface AckDeltaRequest {
  ackedUpToId: number;
  taskType?: string;
}

export interface AckDeltaResponse {
  ackedUpToId: number;
  taskType: string | null;
  deletedCount: number;
}

export interface GetBackgroundImageAssetsResponse {
  items: ImageAsset[];
  missingIds: string[];
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

async function requestBackgroundDelta(
  method: "GET" | "PUT",
  path: string,
  body: unknown,
  options: BackgroundDeltaRequestOptions = {},
) {
  const scope = options.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (plugin) {
    const response = await plugin.request({ method, path, body });
    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }
    const details = extractErrorMessage(response.body) || `HTTP ${response.status}`;
    throw new Error(`Background delta request failed: ${details}`);
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
    throw new Error(`Background delta request failed: ${details}`);
  }
  return responseBody;
}

function parseDeltaItem(raw: unknown): BackgroundDeltaItem | null {
  if (!isRecord(raw)) return null;
  const taskType = toSafeString(raw.taskType).trim();
  const scopeId = toSafeString(raw.scopeId).trim();
  const kind = toSafeString(raw.kind).trim();
  const entityType = toSafeString(raw.entityType).trim();
  if (!taskType || !scopeId || !kind || !entityType) return null;
  return {
    id: toSafeNumber(raw.id, 0),
    taskType,
    scopeId,
    kind,
    entityType,
    entityId:
      typeof raw.entityId === "string" && raw.entityId.trim() ? raw.entityId.trim() : null,
    payload: raw.payload,
    createdAtMs: toSafeNumber(raw.createdAtMs, Date.now()),
  };
}

export async function getBackgroundDelta(
  input: {
    sinceId: number;
    limit?: number;
    taskType?: string;
    scopeIds?: string[];
    includeGlobal?: boolean;
  },
  options: BackgroundDeltaRequestOptions = {},
): Promise<GetDeltaResponse> {
  const params = new URLSearchParams();
  params.set("sinceId", String(Math.max(0, Math.floor(input.sinceId))));
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    params.set("limit", String(Math.max(1, Math.min(1000, Math.floor(input.limit)))));
  }
  if (typeof input.taskType === "string" && input.taskType.trim()) {
    params.set("taskType", input.taskType.trim());
  }
  if (Array.isArray(input.scopeIds) && input.scopeIds.length > 0) {
    const normalized = Array.from(
      new Set(input.scopeIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (normalized.length > 0) {
      params.set("scopeIds", normalized.join(","));
    }
  }
  params.set("includeGlobal", input.includeGlobal === false ? "false" : "true");
  const payload = await requestBackgroundDelta(
    "GET",
    `/api/background-runtime/delta?${params.toString()}`,
    undefined,
    options,
  );
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return { items: [], nextSinceId: Math.max(0, Math.floor(input.sinceId)) };
  }
  const items = payload.items
    .map(parseDeltaItem)
    .filter((row): row is BackgroundDeltaItem => Boolean(row));
  return {
    items,
    nextSinceId: toSafeNumber(payload.nextSinceId, Math.max(0, Math.floor(input.sinceId))),
  };
}

export async function ackBackgroundDelta(
  input: AckDeltaRequest,
  options: BackgroundDeltaRequestOptions = {},
): Promise<AckDeltaResponse> {
  const payload = await requestBackgroundDelta(
    "PUT",
    "/api/background-runtime/delta/ack",
    {
      ackedUpToId: Math.max(0, Math.floor(input.ackedUpToId)),
      taskType: input.taskType?.trim() || undefined,
    },
    options,
  );
  if (!isRecord(payload)) {
    return {
      ackedUpToId: Math.max(0, Math.floor(input.ackedUpToId)),
      taskType: input.taskType?.trim() || null,
      deletedCount: 0,
    };
  }
  return {
    ackedUpToId: toSafeNumber(payload.ackedUpToId, Math.max(0, Math.floor(input.ackedUpToId))),
    taskType:
      typeof payload.taskType === "string" && payload.taskType.trim()
        ? payload.taskType.trim()
        : null,
    deletedCount: toSafeNumber(payload.deletedCount, 0),
  };
}

function parseImageAsset(raw: unknown): ImageAsset | null {
  if (!isRecord(raw)) return null;
  const id = toSafeString(raw.id).trim();
  const dataUrl = toSafeString(raw.dataUrl).trim();
  const createdAt = toSafeString(raw.createdAt).trim();
  if (!id || !dataUrl || !createdAt) return null;
  return {
    id,
    dataUrl,
    createdAt,
    meta: isRecord(raw.meta) ? (raw.meta as ImageAsset["meta"]) : undefined,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    byteSize: typeof raw.byteSize === "number" ? raw.byteSize : undefined,
    storageVersion:
      typeof raw.storageVersion === "number" ? raw.storageVersion : undefined,
  };
}

export async function getBackgroundImageAssets(
  input: {
    ids: string[];
    limit?: number;
  },
  options: BackgroundDeltaRequestOptions = {},
): Promise<GetBackgroundImageAssetsResponse> {
  const normalizedIds = Array.from(
    new Set(input.ids.map((value) => value.trim()).filter(Boolean)),
  );
  if (normalizedIds.length === 0) {
    return { items: [], missingIds: [] };
  }
  const params = new URLSearchParams();
  params.set("ids", normalizedIds.join(","));
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    params.set("limit", String(Math.max(1, Math.min(300, Math.floor(input.limit)))));
  }
  const payload = await requestBackgroundDelta(
    "GET",
    `/api/background-runtime/image-assets?${params.toString()}`,
    undefined,
    options,
  );
  if (!isRecord(payload)) {
    return { items: [], missingIds: normalizedIds };
  }
  const items = Array.isArray(payload.items)
    ? payload.items
        .map(parseImageAsset)
        .filter((row): row is ImageAsset => Boolean(row))
    : [];
  const missingIds = Array.isArray(payload.missingIds)
    ? payload.missingIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];
  return { items, missingIds };
}

export async function triggerBackgroundRuntime(
  reason = "manual",
  options: BackgroundDeltaRequestOptions = {},
) {
  await requestBackgroundDelta(
    "PUT",
    "/api/background-runtime/trigger",
    {
      reason,
    },
    options,
  );
}
