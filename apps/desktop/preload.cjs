const { contextBridge } = require("electron");

function createDesktopBridge(apiBaseUrl, fetchImpl = globalThis.fetch) {
  return {
    mode: "desktop",
    apiBaseUrl,
    async health() {
      const response = await fetchImpl(`${apiBaseUrl}/api/health`);
      if (!response.ok) {
        throw new Error(`Desktop backend health failed: HTTP ${response.status}`);
      }
      return response.json();
    },
  };
}

function createDesktopBridgeFromEnv(env = process.env) {
  const apiBaseUrl = (env.TG_DESKTOP_API_BASE_URL || "").trim() || "http://127.0.0.1:8787";
  return createDesktopBridge(apiBaseUrl);
}

if (process.env.NODE_ENV !== "test") {
  contextBridge.exposeInMainWorld("tgWrapper", createDesktopBridgeFromEnv());
}

module.exports = {
  createDesktopBridge,
  createDesktopBridgeFromEnv,
};
