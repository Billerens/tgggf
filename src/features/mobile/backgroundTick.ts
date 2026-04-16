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

export interface BackgroundTickPayload {
  source: string;
  timestamp: number;
  sequence: number;
  intervalMs: number;
  enabled: boolean;
  running: boolean;
}

type BackgroundTickListener = (payload: BackgroundTickPayload) => void;

const listeners = new Set<BackgroundTickListener>();

let listenerHandle: PluginListenerHandleLike | null = null;
let subscribeInFlight: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeBackgroundTickPayload(raw: unknown): BackgroundTickPayload {
  const source = isRecord(raw) ? raw : {};
  return {
    source:
      typeof source.source === "string" && source.source.trim()
        ? source.source.trim()
        : "foreground_service",
    timestamp: toNumber(source.timestamp, Date.now()),
    sequence: toNumber(source.sequence, 0),
    intervalMs: toNumber(source.intervalMs, 0),
    enabled: toBoolean(source.enabled, true),
    running: toBoolean(source.running, false),
  };
}

function resolveLocalApiPlugin(
  scope: CapacitorScopeLike,
): LocalApiPluginLike | null {
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
    plugin.addListener?.("backgroundTick", (payload: unknown) => {
      const normalized = normalizeBackgroundTickPayload(payload);
      for (const listener of listeners) {
        try {
          listener(normalized);
        } catch {
          // Listener errors should never break the bridge event fanout.
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

export function subscribeBackgroundTick(
  listener: BackgroundTickListener,
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
