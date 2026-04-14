interface PluginListenerHandleLike {
  remove: () => Promise<void> | void;
}

interface LocalApiPluginLike {
  addListener?: (
    eventName: string,
    listener: (payload: unknown) => void,
  ) => Promise<PluginListenerHandleLike> | PluginListenerHandleLike;
}

interface CapacitorScopeLike {
  Capacitor?: {
    Plugins?: {
      LocalApi?: LocalApiPluginLike;
    };
  };
}

export interface GroupIterationRunRequestPayload {
  source: string;
  roomId: string;
  jobId: string;
  intervalMs: number;
  leaseUntilMs: number;
  requestedAtMs: number;
}

type GroupIterationRunRequestListener = (
  payload: GroupIterationRunRequestPayload,
) => void;

const listeners = new Set<GroupIterationRunRequestListener>();
let listenerHandle: PluginListenerHandleLike | null = null;
let subscribeInFlight: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toText(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizePayload(raw: unknown): GroupIterationRunRequestPayload {
  const source = isRecord(raw) ? raw : {};
  return {
    source: toText(source.source, "native_group_executor"),
    roomId: toText(source.roomId),
    jobId: toText(source.jobId),
    intervalMs: Math.max(1_000, toNumber(source.intervalMs, 4_200)),
    leaseUntilMs: toNumber(source.leaseUntilMs, Date.now() + 60_000),
    requestedAtMs: toNumber(source.requestedAtMs, Date.now()),
  };
}

function resolveLocalApiPlugin(scope: CapacitorScopeLike): LocalApiPluginLike | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.addListener !== "function") return null;
  return plugin;
}

async function ensureBridgeSubscription(scope: CapacitorScopeLike) {
  if (listenerHandle || subscribeInFlight) return;
  if (listeners.size === 0) return;

  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) return;

  subscribeInFlight = Promise.resolve(
    plugin.addListener?.("groupIterationRunRequest", (payload: unknown) => {
      const normalized = normalizePayload(payload);
      if (!normalized.roomId || !normalized.jobId) return;
      for (const listener of listeners) {
        try {
          listener(normalized);
        } catch {
          // Listener errors should not break event fanout.
        }
      }
    }),
  )
    .then((handle) => {
      listenerHandle = handle ?? null;
    })
    .catch(() => {
      listenerHandle = null;
    })
    .finally(() => {
      subscribeInFlight = null;
    });

  await subscribeInFlight;
}

function teardownBridgeSubscription() {
  const handle = listenerHandle;
  listenerHandle = null;
  if (!handle || typeof handle.remove !== "function") return;
  void Promise.resolve(handle.remove()).catch(() => {
    // Ignore plugin detach errors during teardown.
  });
}

export function subscribeGroupIterationRunRequest(
  listener: GroupIterationRunRequestListener,
  scope: CapacitorScopeLike = globalThis as unknown as CapacitorScopeLike,
) {
  listeners.add(listener);
  void ensureBridgeSubscription(scope);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardownBridgeSubscription();
    }
  };
}
