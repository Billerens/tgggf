import { mapBridgeHealthPayload } from "./localApiAdapter.js";
import { LocalApi } from "./plugins/localApi.js";

export function resolveAndroidApiBase() {
  return "bridge://api";
}

export async function getAndroidLocalHealth() {
  const payload = await LocalApi.health();
  return mapBridgeHealthPayload(payload);
}

if (process.env.NODE_ENV !== "test") {
  // Placeholder for future Capacitor plugin wiring.
  // eslint-disable-next-line no-console
  console.log(`[mobile] android api base: ${resolveAndroidApiBase()}`);
}
