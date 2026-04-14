import { pushSystemLog, type SystemLogLevel } from "./systemLogStore";

type ConsoleMethodName = "debug" | "info" | "warn" | "error" | "log";

interface ScopeLike {
  console?: Console;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
}

let installed = false;

const CONSOLE_METHOD_LEVEL: Record<ConsoleMethodName, SystemLogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  log: "info",
};

function stringifyShort(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildConsoleMessage(args: unknown[]) {
  const message = args.map((arg) => stringifyShort(arg)).join(" ").trim();
  return message || "(empty console message)";
}

function buildConsoleDetails(args: unknown[]) {
  if (args.length <= 1) return undefined;
  return args;
}

function patchConsole(scope: ScopeLike) {
  const consoleObject = scope.console;
  if (!consoleObject) return;

  const methods: ConsoleMethodName[] = ["debug", "info", "warn", "error", "log"];
  for (const method of methods) {
    const original = consoleObject[method];
    if (typeof original !== "function") continue;
    const originalBound = original.bind(consoleObject);
    consoleObject[method] = (...args: unknown[]) => {
      originalBound(...args);
      pushSystemLog({
        level: CONSOLE_METHOD_LEVEL[method],
        eventType: `console.${method}`,
        message: buildConsoleMessage(args),
        details: buildConsoleDetails(args),
      });
    };
  }
}

function installWindowErrorCapture(scope: ScopeLike) {
  if (typeof scope.addEventListener !== "function") return;

  scope.addEventListener("error", (event) => {
    const err = event as ErrorEvent;
    const message = err.message?.trim() || "Unhandled window error";
    pushSystemLog({
      level: "error",
      eventType: "window.error",
      message,
      details: {
        filename: err.filename,
        lineno: err.lineno,
        colno: err.colno,
        stack: err.error instanceof Error ? err.error.stack : undefined,
      },
    });
  });

  scope.addEventListener("unhandledrejection", (event) => {
    const rejection = event as PromiseRejectionEvent;
    const reason = rejection.reason;
    pushSystemLog({
      level: "error",
      eventType: "window.unhandledrejection",
      message:
        reason instanceof Error
          ? `${reason.name}: ${reason.message}`
          : "Unhandled promise rejection",
      details: reason instanceof Error ? reason.stack : reason,
    });
  });

  scope.addEventListener("llm-tooling-telemetry", (event) => {
    const telemetry = event as CustomEvent<Record<string, unknown>>;
    const detail = telemetry.detail ?? {};
    const eventName =
      typeof detail.event === "string" && detail.event.trim()
        ? detail.event.trim()
        : "llm_tooling";
    const level: SystemLogLevel =
      eventName.includes("failed") || eventName.includes("error")
        ? "warn"
        : "info";
    pushSystemLog({
      level,
      eventType: `llm.${eventName}`,
      message: `LLM telemetry: ${eventName}`,
      details: detail,
    });
  });
}

export function installSystemLogCapture(scope: ScopeLike) {
  if (installed) return;
  installed = true;
  patchConsole(scope);
  installWindowErrorCapture(scope);
  pushSystemLog({
    level: "info",
    eventType: "system.startup",
    message: "System log capture enabled",
  });
}

