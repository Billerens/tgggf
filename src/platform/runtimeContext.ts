import { createApiBaseUrl } from "../api/transport";
import type { RuntimeMode } from "./runtimeMode";

export interface RuntimeContext {
  mode: RuntimeMode;
  apiBaseUrl: string;
}

let runtimeContext: RuntimeContext = {
  mode: "web",
  apiBaseUrl: createApiBaseUrl(
    "web",
    typeof import.meta.env.VITE_BACKEND_URL === "string"
      ? import.meta.env.VITE_BACKEND_URL
      : "",
  ),
};

export function getRuntimeContext(): RuntimeContext {
  return runtimeContext;
}

export function setRuntimeContext(next: RuntimeContext) {
  runtimeContext = next;
}

