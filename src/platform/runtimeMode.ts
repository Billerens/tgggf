export type RuntimeMode = "web" | "desktop" | "android";

function detectCapacitorAndroid(env: Record<string, unknown>): boolean {
  const maybeCapacitor = env.Capacitor;
  if (!maybeCapacitor || typeof maybeCapacitor !== "object") return false;

  const capacitor = maybeCapacitor as {
    getPlatform?: () => string;
    platform?: string;
    Plugins?: Record<string, unknown>;
  };

  if (typeof capacitor.getPlatform === "function") {
    try {
      return capacitor.getPlatform() === "android";
    } catch {
      return false;
    }
  }

  const hasLocalApiPlugin =
    Boolean(capacitor.Plugins) &&
    typeof capacitor.Plugins === "object" &&
    "LocalApi" in capacitor.Plugins;
  if (hasLocalApiPlugin) {
    return true;
  }

  return capacitor.platform === "android";
}

export function detectRuntimeMode(env: Record<string, unknown>): RuntimeMode {
  const raw = env.__TG_WRAPPER__;
  if (raw === "desktop") return "desktop";
  if (raw === "android") return "android";
  if (detectCapacitorAndroid(env)) return "android";
  return "web";
}
