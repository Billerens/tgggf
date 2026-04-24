import { getRuntimeContext } from "../../platform/runtimeContext";

interface LocalApiPluginRequestInput {
  method: "GET";
  path: string;
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

export type NotificationLaunchTargetType = "chat" | "group";

export interface NotificationLaunchTarget {
  targetType: NotificationLaunchTargetType;
  targetId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function parseLaunchTarget(body: unknown): NotificationLaunchTarget | null {
  if (!isRecord(body)) return null;
  const typeRaw =
    typeof body.targetType === "string"
      ? body.targetType
      : isRecord(body.target) && typeof body.target.targetType === "string"
        ? body.target.targetType
        : "";
  const idRaw =
    typeof body.targetId === "string"
      ? body.targetId
      : isRecord(body.target) && typeof body.target.targetId === "string"
        ? body.target.targetId
        : "";
  const targetType = typeRaw.trim().toLowerCase();
  const targetId = idRaw.trim();
  if (!targetId) return null;
  if (targetType !== "chat" && targetType !== "group") return null;
  return {
    targetType,
    targetId,
  };
}

export async function consumeNotificationLaunchTarget(options?: {
  scope?: CapacitorLikeScope;
  fetchImpl?: typeof fetch;
}): Promise<NotificationLaunchTarget | null> {
  const runtime = getRuntimeContext();
  if (runtime.mode !== "android") return null;

  const scope = options?.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (plugin) {
    const response = await plugin.request({
      method: "GET",
      path: "/api/notifications/launch-target/consume",
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return parseLaunchTarget(response.body);
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const response = await fetchImpl(
    resolveApiUrl("/api/notifications/launch-target/consume"),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) return null;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const body = isRecord(payload) && "body" in payload ? payload.body : payload;
  return parseLaunchTarget(body);
}
