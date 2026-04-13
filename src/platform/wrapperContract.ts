export type WrapperMode = "desktop" | "android";

export interface WrapperHealthPayload {
  ok: boolean;
  service?: string;
  [key: string]: unknown;
}

export interface WrapperBridge {
  mode: WrapperMode;
  apiBaseUrl: string;
  health?: () => Promise<WrapperHealthPayload>;
}

export function getWrapperBridge(scope: Record<string, unknown>): WrapperBridge | null {
  const raw = scope.tgWrapper;
  if (!raw || typeof raw !== "object") return null;
  const bridge = raw as Partial<WrapperBridge>;
  if (
    (bridge.mode !== "desktop" && bridge.mode !== "android") ||
    typeof bridge.apiBaseUrl !== "string"
  ) {
    return null;
  }
  if (bridge.health && typeof bridge.health !== "function") {
    return null;
  }
  return bridge as WrapperBridge;
}

