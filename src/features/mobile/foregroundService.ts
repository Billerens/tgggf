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
}

export interface ForegroundServiceRequestOptions {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStatusPayload(payload: unknown): ForegroundServiceStatus {
  const source = isRecord(payload) ? payload : {};
  return {
    ok: source.ok !== false,
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    running: typeof source.running === "boolean" ? source.running : false,
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
