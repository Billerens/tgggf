import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface RuntimeLogger {
  filePath: string;
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

function serializeDetails(details: unknown) {
  if (details === undefined) return "";
  if (details instanceof Error) {
    const stack = details.stack || `${details.name}: ${details.message}`;
    return stack;
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function resolveLogFilePath() {
  const logDate = new Date().toISOString().slice(0, 10);
  const primaryDir = path.join(app.getPath("userData"), "logs");
  try {
    fs.mkdirSync(primaryDir, { recursive: true });
    return path.join(primaryDir, `desktop-${logDate}.log`);
  } catch {
    const fallbackDir = path.join(app.getPath("temp"), "tg-gf-logs");
    fs.mkdirSync(fallbackDir, { recursive: true });
    return path.join(fallbackDir, `desktop-${logDate}.log`);
  }
}

export function createRuntimeLogger(): RuntimeLogger {
  const filePath = resolveLogFilePath();

  const writeLine = (level: "INFO" | "ERROR", message: string, details?: unknown) => {
    const timestamp = new Date().toISOString();
    const serialized = serializeDetails(details);
    const line = serialized
      ? `${timestamp} [${level}] ${message} | ${serialized}\n`
      : `${timestamp} [${level}] ${message}\n`;

    try {
      fs.appendFileSync(filePath, line, { encoding: "utf8" });
    } catch {
      // Swallow logging IO errors to avoid breaking application startup.
    }
  };

  return {
    filePath,
    info(message, details) {
      writeLine("INFO", message, details);
    },
    error(message, details) {
      writeLine("ERROR", message, details);
    },
  };
}
