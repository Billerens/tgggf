import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const mobileAndroidDir = path.join(rootDir, "apps", "mobile", "android");
const npmCommand = "npm";
const gradleCommand = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const debugApkSource = path.join(
  mobileAndroidDir,
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);
const debugApkTarget = path.join(
  rootDir,
  "dist",
  "downloads",
  "android",
  "tg-gf-android-debug.apk",
);

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

async function copyDebugApkToDist() {
  if (!(await pathExists(debugApkSource))) {
    throw new Error(`Android debug APK not found: ${debugApkSource}`);
  }

  await fs.mkdir(path.dirname(debugApkTarget), { recursive: true });
  await fs.copyFile(debugApkSource, debugApkTarget);
  console.log(
    `-> Copied Android debug APK to ${path.relative(rootDir, debugApkTarget).replace(/\\/g, "/")}`,
  );
}

async function main() {
  console.log("-> Syncing Android project");
  await run(npmCommand, ["run", "sync:android", "--workspace", "@tg-gf/mobile"]);

  console.log("-> Building Android debug APK");
  const androidJavaHome = await resolveAndroidJavaHome();
  const androidBuildEnv = { ...process.env };
  if (androidJavaHome) {
    const javaBin = path.join(androidJavaHome, "bin");
    const currentPath = process.env.Path ?? process.env.PATH ?? "";
    const nextPath = `${javaBin}${path.delimiter}${currentPath}`;
    androidBuildEnv.JAVA_HOME = androidJavaHome;
    androidBuildEnv.Path = nextPath;
    androidBuildEnv.PATH = nextPath;
    console.log(`-> Using JAVA_HOME for Android build: ${androidJavaHome}`);
  }

  await run(gradleCommand, ["assembleDebug"], {
    cwd: mobileAndroidDir,
    env: androidBuildEnv,
  });

  await copyDebugApkToDist();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
