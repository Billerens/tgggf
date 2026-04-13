import { createApiBaseUrl } from "../api/transport";
import { detectRuntimeMode, type RuntimeMode } from "./runtimeMode";
import { getWrapperBridge } from "./wrapperContract";

export interface WrapperInfo {
  mode: RuntimeMode;
  apiBaseUrl: string;
}

export function getWrapperInfo(
  windowLike: Record<string, unknown>,
  configuredBackendUrl?: string,
): WrapperInfo {
  const bridge = getWrapperBridge(windowLike);
  if (bridge) {
    const bridgeMode = bridge.mode;
    const bridgeApiBaseUrl = bridge.apiBaseUrl.trim();
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
