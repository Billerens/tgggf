import { mapBridgeHealthPayload } from "./localApiAdapter.js";
import { LocalApi } from "./plugins/localApi.js";

export function resolveAndroidApiBase() {
  return "bridge://api";
}

export async function getAndroidLocalHealth() {
  const payload = await LocalApi.health();
  return mapBridgeHealthPayload(payload);
}

export interface AndroidWrapperBridge {
  mode: "android";
  apiBaseUrl: string;
  health(): ReturnType<typeof getAndroidLocalHealth>;
}

export function createAndroidWrapperBridge(
  healthFn: () => ReturnType<typeof getAndroidLocalHealth> = getAndroidLocalHealth,
): AndroidWrapperBridge {
  return {
    mode: "android",
    apiBaseUrl: resolveAndroidApiBase(),
    health: healthFn,
  };
}

export function installAndroidWrapperBridge(
  target: Record<string, unknown>,
  healthFn: () => ReturnType<typeof getAndroidLocalHealth> = getAndroidLocalHealth,
) {
  target.tgWrapper = createAndroidWrapperBridge(healthFn);
}

if (process.env.NODE_ENV !== "test") {
  installAndroidWrapperBridge(globalThis as unknown as Record<string, unknown>);
}
