import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const npmCommand = "npm";
const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : "debug";
if (mode !== "debug" && mode !== "prod") {
  console.error(`Unsupported build mode: ${mode}`);
  process.exit(1);
}
const isProd = mode === "prod";

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

async function main() {
  console.log(`-> Building all parts in ${mode} mode`);

  console.log("-> Building web frontend");
  await run(npmCommand, ["run", isProd ? "build:web" : "build:web:debug"]);

  console.log("-> Building API");
  await run(npmCommand, ["run", "build:api"]);

  console.log("-> Building desktop wrapper");
  await run(npmCommand, ["run", "build:desktop"]);

  console.log("-> Building mobile wrapper");
  await run(npmCommand, ["run", isProd ? "build:mobile:prod" : "build:mobile"]);

  console.log("-> Building desktop installer artifact");
  await run(npmCommand, [
    "run",
    isProd ? "dist:prod" : "dist:debug",
    "--workspace",
    "@tg-gf/desktop",
  ]);

  console.log("-> Copying runtime artifacts to dist/downloads");
  await run(
    process.execPath,
    [
      path.join(rootDir, "scripts", "copy-runtime-artifacts-to-dist.mjs"),
      `--mode=${mode}`,
    ],
    {
      env: {
        ...process.env,
        TG_BUILD_PROFILE: mode,
      },
    },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
