# Android Wrapper Runbook

## Scope
- Android runtime: Capacitor wrapper + native Android module bridge (`LocalApi`).
- Build output: debug APK for local install.

## Prerequisites
- Android Studio (latest stable)
- JDK 17 (Android Studio JBR recommended)
- Android SDK Platform 34 + Build Tools 34.0.0
- Node.js 20+

## Local Setup
1. Install dependencies:
   - `npm install --include=dev`
2. Build web bundle:
   - `npm run build:web`
3. Sync Capacitor Android project:
   - `npm run sync:android --workspace @tg-gf/mobile`

## Build APK
1. CLI build:
   - `cd apps/mobile/android`
   - `./gradlew assembleDebug` (Linux/macOS)
   - `gradlew.bat assembleDebug` (Windows)
2. Output:
   - `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

## Run on Device/Emulator
1. Open project in Android Studio:
   - `apps/mobile/android`
2. Select emulator/device.
3. Run app from Android Studio.

## Health and Bridge Checks
- On startup, wrapper bridge is installed into `tgWrapper`.
- Native plugin `LocalApi` exposes:
  - `health()`
  - `request(...)` (currently scaffold-level behavior)

## Logs and Diagnostics
- Android Studio Logcat:
  - filter by appId `com.tggf.app`
- If build fails:
  - verify SDK path in `apps/mobile/android/local.properties`
  - verify Java 17 is used
  - rerun `npm run sync:android --workspace @tg-gf/mobile`

## Rollback Procedure
1. Checkout last known stable revision.
2. Repeat setup + sync + build steps.
3. Re-install previous APK on test devices.
