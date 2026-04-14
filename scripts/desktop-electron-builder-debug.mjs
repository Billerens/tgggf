import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const desktopDir = path.join(rootDir, "apps", "desktop");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
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

function resolveElectronBuilderCli() {
  const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));
  const packageJsonPath = requireFromDesktop.resolve("electron-builder/package.json");
  const packageJsonRaw = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw);
  const binValue =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.["electron-builder"];
  if (typeof binValue !== "string" || !binValue.trim()) {
    throw new Error("Cannot resolve electron-builder CLI binary from package metadata");
  }
  return path.resolve(path.dirname(packageJsonPath), binValue);
}

async function main() {
  const builderArgs = process.argv.slice(2);
  const electronBuilderCli = resolveElectronBuilderCli();
  await run(
    process.execPath,
    [electronBuilderCli, ...builderArgs],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        NODE_ENV: "development",
        TG_DESKTOP_DEBUG: "1",
      },
    },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
