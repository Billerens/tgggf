import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { createBackendSupervisor } from "./backendSupervisor.js";
import { createRuntimeLogger, type RuntimeLogger } from "./runtimeLogger.js";

function isDesktopDebugMode() {
  return (
    process.env.TG_DESKTOP_DEBUG === "1" ||
    process.env.NODE_ENV === "development"
  );
}

let runtimeLogger: RuntimeLogger | null = null;
let diagnosticsAttached = false;

function logInfo(message: string, details?: unknown) {
  const shouldEchoToConsole =
    process.env.TG_DESKTOP_FORWARD_MAIN_LOGS === "1" ||
    process.env.NODE_ENV === "development";
  if (shouldEchoToConsole) {
    // eslint-disable-next-line no-console
    console.log("[desktop]", message, details ?? "");
  }
  runtimeLogger?.info(message, details);
}

function logError(message: string, details?: unknown) {
  // eslint-disable-next-line no-console
  console.error("[desktop]", message, details ?? "");
  runtimeLogger?.error(message, details);
}

function ensureRuntimeLogger() {
  if (runtimeLogger) return runtimeLogger;
  runtimeLogger = createRuntimeLogger();
  logInfo("Desktop logger initialized", { filePath: runtimeLogger.filePath });
  return runtimeLogger;
}

function resolvePreloadPath() {
  const filePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(filePath);
  const appRoot = app.getAppPath();
  const candidates = [
    path.resolve(currentDir, "../preload.cjs"),
    path.resolve(appRoot, "preload.cjs"),
    path.resolve(currentDir, "preload.js"),
  ];
  const preloadPath = candidates.find((candidate) => existsSync(candidate));
  if (!preloadPath) {
    throw new Error(
      `Preload script not found. Checked: ${candidates.join(", ")}`,
    );
  }
  return preloadPath;
}

function resolveRendererUrl() {
  const explicit = process.env.DESKTOP_RENDERER_URL?.trim();
  if (explicit) return explicit;

  // In unpackaged development we prefer the live Vite server.
  // Packaged debug builds still load bundled index.html.
  if (isDesktopDebugMode() && !app.isPackaged) {
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

function attachWindowDiagnostics(window: BrowserWindow, logger: RuntimeLogger) {
  window.webContents.on("did-finish-load", () => {
    logger.info("Renderer finished load", {
      url: window.webContents.getURL(),
      title: window.getTitle(),
    });
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      logger.error("Renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl,
        isMainFrame,
      });
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error("Renderer process gone", details);
  });
  window.on("closed", () => {
    logger.info("Main window closed");
  });
}

function createMainWindow(rendererUrl: string, logger: RuntimeLogger) {
  const preloadPath = resolvePreloadPath();
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });
  logger.info("Created main window", { rendererUrl, preloadPath });
  void window.loadURL(rendererUrl);
  attachWindowDiagnostics(window, logger);
  if (isDesktopDebugMode()) {
    void window.webContents.openDevTools({ mode: "detach" });
  }
  return window;
}

function attachProcessDiagnostics(logger: RuntimeLogger) {
  if (diagnosticsAttached) return;
  diagnosticsAttached = true;

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", reason);
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    logger.error("App render-process-gone", {
      details,
      url: webContents.getURL(),
    });
  });
  app.on("child-process-gone", (_event, details) => {
    logger.error("App child-process-gone", details);
  });
}

export async function startDesktopApp() {
  const logger = ensureRuntimeLogger();
  attachProcessDiagnostics(logger);

  logger.info("Desktop bootstrap started", {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
    execPath: process.execPath,
    cwd: process.cwd(),
  });

  const apiPortRaw = Number(process.env.API_PORT || 8787);
  const apiPort = Number.isFinite(apiPortRaw) && apiPortRaw > 0 ? apiPortRaw : 8787;
  const backendEntryPath = resolveBackendEntryPath();
  const backend = createBackendSupervisor({
    apiPort,
    backendEntryPath,
    onLog: ({ level, message }) => {
      if (level === "error") {
        logger.error("Backend log", message);
        return;
      }
      logger.info("Backend log", message);
    },
    onCrash: (error) => {
      logger.error("Backend crash detected", error.message);
    },
  });
  logger.info("Starting backend", { apiPort, backendEntryPath });
  try {
    await backend.start();
    await backend.waitUntilReady();
  } catch (error) {
    logger.error("Backend failed to become ready", error);
    throw error;
  }
  process.env.TG_DESKTOP_API_BASE_URL = backend.apiUrl;
  logger.info("Backend is ready", { apiUrl: backend.apiUrl });

  const rendererUrl = resolveRendererUrl();
  createMainWindow(rendererUrl, logger);

  app.on("before-quit", () => {
    logger.info("before-quit received, stopping backend");
    void backend.stop().catch((error) => {
      logger.error("Backend stop failed", error);
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      logger.info("Re-creating main window after activate");
      createMainWindow(rendererUrl, logger);
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  if (isDesktopDebugMode()) {
    const debugPort =
      process.env.TG_DESKTOP_REMOTE_DEBUG_PORT?.trim() || "9222";
    app.commandLine.appendSwitch("remote-debugging-port", debugPort);
    logInfo("Remote debugging enabled", { debugPort });
  }

  app.whenReady()
    .then(() => startDesktopApp())
    .catch((error) => {
      if (app.isReady()) {
        ensureRuntimeLogger();
      }
      logError("bootstrap failed", error);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
