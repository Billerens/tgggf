import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { createBackendSupervisor } from "./backendSupervisor.js";

function resolvePreloadPath() {
  const filePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(filePath);
  return path.resolve(currentDir, "preload.js");
}

function resolveRendererUrl() {
  const explicit = process.env.DESKTOP_RENDERER_URL?.trim();
  if (explicit) return explicit;

  if (process.env.NODE_ENV === "development") {
    return "http://127.0.0.1:5173";
  }

  const filePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(filePath);
  const indexPath = path.resolve(currentDir, "../../../dist/index.html");
  return pathToFileURL(indexPath).toString();
}

function createMainWindow(rendererUrl: string) {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolvePreloadPath(),
    },
  });
  void window.loadURL(rendererUrl);
  return window;
}

export async function startDesktopApp() {
  const apiPortRaw = Number(process.env.API_PORT || 8787);
  const apiPort = Number.isFinite(apiPortRaw) && apiPortRaw > 0 ? apiPortRaw : 8787;
  const backend = createBackendSupervisor({ apiPort });
  await backend.start();
  await backend.waitUntilReady();
  process.env.TG_DESKTOP_API_BASE_URL = backend.apiUrl;

  const rendererUrl = resolveRendererUrl();
  createMainWindow(rendererUrl);

  app.on("before-quit", () => {
    void backend.stop();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(rendererUrl);
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  app.whenReady()
    .then(() => startDesktopApp())
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[desktop] bootstrap failed", error);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
