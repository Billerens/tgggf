import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const npmCommand = "npm";
const devServerUrl = "http://127.0.0.1:5173";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: rootDir,
      shell: process.platform === "win32",
      ...options,
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDevServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Dev server returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(400);
  }

  const details =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Dev server did not become ready in ${timeoutMs}ms.${details}`);
}

function terminateProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      shell: true,
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // no-op
      }
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // no-op
  }
}

async function main() {
  const webServer = spawn(npmCommand, ["run", "dev:web"], {
    stdio: "inherit",
    cwd: rootDir,
    shell: process.platform === "win32",
  });

  const cleanup = () => terminateProcessTree(webServer);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  try {
    console.log("-> Waiting for Vite dev server");
    await waitForDevServer(devServerUrl);

    console.log("-> Building API");
    await run(npmCommand, ["run", "build:api"]);

    console.log("-> Building desktop main/preload");
    await run(npmCommand, ["run", "build:desktop"]);

    console.log("-> Starting desktop in debug mode");
    await run(npmCommand, ["run", "start", "--workspace", "@tg-gf/desktop"], {
      env: {
        ...process.env,
        NODE_ENV: "development",
        DESKTOP_RENDERER_URL: devServerUrl,
        TG_DESKTOP_FORWARD_API_LOGS:
          process.env.TG_DESKTOP_FORWARD_API_LOGS?.trim() || "1",
      },
    });
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
