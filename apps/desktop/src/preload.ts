import { contextBridge } from "electron";

export interface DesktopHealthPayload {
  ok: boolean;
  service?: string;
  [key: string]: unknown;
}

export interface DesktopBridge {
  mode: "desktop";
  apiBaseUrl: string;
  health(): Promise<DesktopHealthPayload>;
}

export function createDesktopBridge(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): DesktopBridge {
  return {
    mode: "desktop",
    apiBaseUrl,
    async health() {
      const response = await fetchImpl(`${apiBaseUrl}/api/health`);
      if (!response.ok) {
        throw new Error(`Desktop backend health failed: HTTP ${response.status}`);
      }
      const payload = (await response.json()) as DesktopHealthPayload;
      return payload;
    },
  };
}

export function createDesktopBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopBridge {
  const apiBaseUrl = (env.TG_DESKTOP_API_BASE_URL || "").trim() || "http://127.0.0.1:8787";
  return createDesktopBridge(apiBaseUrl);
}

if (process.env.NODE_ENV !== "test") {
  contextBridge.exposeInMainWorld("tgWrapper", createDesktopBridgeFromEnv());
}
