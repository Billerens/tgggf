import type { RuntimeMode } from "../platform/runtimeMode";

export function createApiBaseUrl(mode: RuntimeMode, configured?: string): string {
  if (mode === "desktop") return "/api";
  if (mode === "android") return "bridge://api";
  return (configured || "").trim();
}

