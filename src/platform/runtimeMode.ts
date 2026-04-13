export type RuntimeMode = "web" | "desktop" | "android";

export function detectRuntimeMode(env: Record<string, unknown>): RuntimeMode {
  const raw = env.__TG_WRAPPER__;
  if (raw === "desktop") return "desktop";
  if (raw === "android") return "android";
  return "web";
}

