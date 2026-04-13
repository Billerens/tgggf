import path from "node:path";
import { existsSync } from "node:fs";
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

  const appRoot = app.getAppPath();
  const candidates = [
    path.resolve(appRoot, "dist/index.html"),
    path.resolve(appRoot, "../dist/index.html"),
    path.resolve(appRoot, "../../dist/index.html"),
  ];
  const indexPath = candidates.find((candidate) => existsSync(candidate));
  if (!indexPath) {
    throw new Error(
      `Renderer index.html not found. Checked: ${candidates.join(", ")}`,
    );
  }

  return pathToFileURL(indexPath).toString();
}

function resolveBackendEntryPath() {
  const explicit = process.env.TG_DESKTOP_BACKEND_ENTRY?.trim();
  if (explicit) return explicit;

  const appRoot = app.getAppPath();
  const filePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(filePath);
  const candidates = [
    path.resolve(currentDir, "../../api/dist/server.js"),
    path.resolve(currentDir, "../../../api/dist/server.js"),
    path.resolve(appRoot, "apps/api/dist/server.js"),
    path.resolve(appRoot, "../apps/api/dist/server.js"),
  ];
  const entryPath = candidates.find((candidate) => existsSync(candidate));
  if (!entryPath) {
    throw new Error(
      `Backend entry not found. Checked: ${candidates.join(", ")}`,
    );
  }

  return entryPath;
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
  const backend = createBackendSupervisor({
    apiPort,
    backendEntryPath: resolveBackendEntryPath(),
    onCrash: (error) => {
      // eslint-disable-next-line no-console
      console.error("[desktop] backend crash detected", error.message);
    },
  });
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
