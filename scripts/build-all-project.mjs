import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const npmCommand = "npm";
const gradleCommand = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAndroidJavaHome() {
  const javaBinary = process.platform === "win32" ? "java.exe" : "java";
  const candidatePaths = [];

  if (typeof process.env.ANDROID_STUDIO_JDK === "string") {
    candidatePaths.push(process.env.ANDROID_STUDIO_JDK);
  }

  if (process.platform === "win32") {
    candidatePaths.push("C:\\Program Files\\Android\\Android Studio\\jbr");
  }

  if (typeof process.env.JAVA_HOME === "string") {
    candidatePaths.push(process.env.JAVA_HOME);
  }

  for (const candidate of candidatePaths) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const javaBinaryPath = path.join(trimmed, "bin", javaBinary);
    if (await pathExists(javaBinaryPath)) {
      return trimmed;
    }
  }

  return null;
}

async function main() {
  console.log("-> Building web frontend");
  await run(npmCommand, ["run", "build:web"]);

  console.log("-> Building API");
  await run(npmCommand, ["run", "build:api"]);

  console.log("-> Building desktop wrapper");
  await run(npmCommand, ["run", "build:desktop"]);

  console.log("-> Building mobile wrapper");
  await run(npmCommand, ["run", "build:mobile"]);

  console.log("-> Building desktop installer artifact");
  await run(npmCommand, ["run", "dist", "--workspace", "@tg-gf/desktop"]);

  console.log("-> Syncing Android project");
  await run(npmCommand, ["run", "sync:android", "--workspace", "@tg-gf/mobile"]);

  console.log("-> Building Android debug APK");
  const androidJavaHome = await resolveAndroidJavaHome();
  const androidBuildEnv = { ...process.env };
  if (androidJavaHome) {
    androidBuildEnv.JAVA_HOME = androidJavaHome;
    androidBuildEnv.Path = `${path.join(androidJavaHome, "bin")}${path.delimiter}${
      process.env.Path ?? ""
    }`;
    console.log(`-> Using JAVA_HOME for Android build: ${androidJavaHome}`);
  }

  await run(gradleCommand, ["assembleDebug"], {
    cwd: path.join(rootDir, "apps", "mobile", "android"),
    env: androidBuildEnv,
  });

  console.log("-> Copying runtime artifacts to dist/downloads");
  await run(process.execPath, [path.join(rootDir, "scripts", "copy-runtime-artifacts-to-dist.mjs")]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
