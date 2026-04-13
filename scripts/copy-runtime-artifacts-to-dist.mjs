import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const WINDOWS_TARGET = path.join(
  distDir,
  "downloads",
  "windows",
  "tg-gf-windows.exe",
);
const ANDROID_TARGET = path.join(
  distDir,
  "downloads",
  "android",
  "tg-gf-android-debug.apk",
);

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFilesRecursively(targetPath) {
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursively(absolutePath);
      files.push(...nested);
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function normalizeFilePath(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

async function resolveWindowsSource() {
  const releaseDir = path.join(rootDir, "apps", "desktop", "release");
  if (!(await pathExists(releaseDir))) {
    return null;
  }

  const files = await collectFilesRecursively(releaseDir);
  const exes = files.filter((item) => item.toLowerCase().endsWith(".exe"));
  if (exes.length === 0) {
    return null;
  }

  const setup = exes.find((item) => {
    const baseName = path.basename(item);
    const normalized = normalizeFilePath(item);
    return /setup/i.test(baseName) && !normalized.includes("/win-unpacked/");
  });
  if (setup) return setup;

  const nonUnpacked = exes.find(
    (item) => !normalizeFilePath(item).includes("/win-unpacked/"),
  );
  if (nonUnpacked) return nonUnpacked;

  return exes[0];
}

async function resolveAndroidSource() {
  const sourcePath = path.join(
    rootDir,
    "apps",
    "mobile",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "debug",
    "app-debug.apk",
  );
  return (await pathExists(sourcePath)) ? sourcePath : null;
}

async function copyFileToTarget(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function removeTargetIfExists(targetPath) {
  if (await pathExists(targetPath)) {
    await fs.rm(targetPath, { force: true });
  }
}

async function main() {
  if (!(await pathExists(distDir))) {
    console.warn("[artifact-copy] dist/ not found, skip artifact copy.");
    return;
  }

  const windowsSource = await resolveWindowsSource();
  if (windowsSource) {
    await copyFileToTarget(windowsSource, WINDOWS_TARGET);
    console.log(
      `[artifact-copy] windows -> ${path.relative(rootDir, WINDOWS_TARGET).replace(/\\/g, "/")}`,
    );
  } else {
    await removeTargetIfExists(WINDOWS_TARGET);
    console.log(
      "[artifact-copy] windows source not found (apps/desktop/release). Skipped.",
    );
  }

  const androidSource = await resolveAndroidSource();
  if (androidSource) {
    await copyFileToTarget(androidSource, ANDROID_TARGET);
    console.log(
      `[artifact-copy] android -> ${path.relative(rootDir, ANDROID_TARGET).replace(/\\/g, "/")}`,
    );
  } else {
    await removeTargetIfExists(ANDROID_TARGET);
    console.log(
      "[artifact-copy] android source not found (app-debug.apk). Skipped.",
    );
  }
}

main().catch((error) => {
  console.error(
    `[artifact-copy] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
