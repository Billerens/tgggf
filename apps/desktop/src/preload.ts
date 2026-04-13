export interface DesktopBridge {
  mode: "desktop";
  apiBaseUrl: string;
}

export function createDesktopBridge(apiBaseUrl: string): DesktopBridge {
  return {
    mode: "desktop",
    apiBaseUrl,
  };
}

export function createDesktopBridgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DesktopBridge {
  const apiBaseUrl = (env.TG_DESKTOP_API_BASE_URL || "").trim() || "http://127.0.0.1:8787";
  return createDesktopBridge(apiBaseUrl);
}

// Dynamic import keeps test/runtime decoupled from Electron bootstrapping.
const electron = await import("electron");
electron.contextBridge.exposeInMainWorld(
  "tgWrapper",
  createDesktopBridgeFromEnv(),
);
