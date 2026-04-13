import { createApiBaseUrl } from "../api/transport";
import { detectRuntimeMode, type RuntimeMode } from "./runtimeMode";

interface WrapperWindowPayload {
  mode?: unknown;
  apiBaseUrl?: unknown;
}

export interface WrapperInfo {
  mode: RuntimeMode;
  apiBaseUrl: string;
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "web" || value === "desktop" || value === "android";
}

export function getWrapperInfo(
  windowLike: Record<string, unknown>,
  configuredBackendUrl?: string,
): WrapperInfo {
  const bridge = windowLike.tgWrapper as WrapperWindowPayload | undefined;
  const bridgeMode = bridge?.mode;
  if (isRuntimeMode(bridgeMode) && bridgeMode !== "web") {
    const bridgeApiBaseUrl =
      typeof bridge?.apiBaseUrl === "string" ? bridge.apiBaseUrl.trim() : "";
    return {
      mode: bridgeMode,
      apiBaseUrl: bridgeApiBaseUrl || createApiBaseUrl(bridgeMode, configuredBackendUrl),
    };
  }

  const mode = detectRuntimeMode(windowLike);
  return {
    mode,
    apiBaseUrl: createApiBaseUrl(mode, configuredBackendUrl),
  };
}

