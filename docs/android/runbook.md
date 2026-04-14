# Android Wrapper Runbook

## Scope
- Android runtime: Capacitor wrapper + native Android module bridge (`LocalApi`).
- Build output: debug APK for local install.
- Group autonomy path: native executors + WorkManager recovery + ForegroundService heartbeat/observability.

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

## Runtime Health States
- `native active`
  - Native group iteration feature flag is enabled.
  - Foreground service is enabled/running.
  - No stale workers, no stale leased jobs, no active worker error.
- `native degraded`
  - Foreground service is not running, or stale workers/stale leased jobs/errors detected.
  - Native execution can recover automatically, but requires diagnosis.
- `bridge fallback`
  - Native group iteration feature flag is disabled or runtime is not Android.
  - Background autonomy is reduced to legacy bridge behavior.

## Smoke Checklist (Debug APK)
1. Open Settings -> Android background mode.
2. Enable foreground service toggle and press `Обновить статус`.
3. Confirm health is `native active`.
4. Confirm queue/worker metrics are non-negative and update after activity.
5. Start group activity and verify:
   - worker heartbeats advance,
   - `queue depth` changes,
   - `active group rooms` reflects active room count.
6. Force-stop app process and relaunch:
   - service recovers,
   - health returns to `native active` or explicitly reports `native degraded`.
7. Optional reboot test:
   - after reboot, scheduler re-enqueues work and status becomes live without manual queue repair.

## Diagnostics Playbook
1. Health = `bridge fallback`
   - Check `androidNativeGroupIterationV1` in Settings rollout controls.
   - Enable flag, save settings, refresh foreground status.
2. Health = `native degraded`
   - Check `stale workers`:
     - if `>0`, inspect worker `lastError` and runtime events.
   - Check `stale jobs`:
     - if `>0`, stale leases are being reclaimed/retried; monitor if count drops after 1-2 intervals.
   - Check service running state:
     - if stopped, re-enable foreground service and verify battery optimization exclusions.
3. Persistent worker error
   - Capture `lastError`, related runtime events, and job id if present.
   - Toggle `androidNativeGroupImagesV1` off if image pipeline is the failing path.
   - If storage inconsistency suspected, keep `androidNativeGroupStructuredStorageDualWrite=true` during recovery.

## Staged Rollout Controls
- `androidNativeGroupIterationV1`: master switch for native group iteration.
- `androidNativeGroupImagesV1`: native image generation inside group pipeline.
- `androidNativeGroupStructuredStorageV1`: SQLite-backed structured runtime stores.
- `androidNativeGroupStructuredStorageDualWrite`: compatibility dual-write to legacy store.

### Recommended Rollout Order
1. Internal: enable `iterationV1` only.
2. Beta: enable `imagesV1` for selected testers.
3. Pre-prod: keep `structuredStorageV1=true` and `dualWrite=true`.
4. Prod hardening: disable `dualWrite` only after stability window and data parity checks.

## Release Checklist + Rollback Gates
- Gate 1: Smoke checklist passes on at least one real device.
- Gate 2: No sustained `native degraded` (> 15 minutes) in acceptance run.
- Gate 3: No unrecoverable stale leased jobs after restart/reboot scenario.
- Gate 4: Rollback path validated by toggling `androidNativeGroupIterationV1=false`.

Rollback trigger examples:
- Repeated worker errors with same root cause across retries.
- Growing stale leased job count after recovery window.
- Message/event persistence mismatch after app restart.

## Logs and Diagnostics
- Android Studio Logcat:
  - filter by appId `com.tggf.app`
- In-app logs (Settings -> Logs):
  - `foreground_service.*`
  - `group_iteration.*`
  - `topic_generation.*`
- If build fails:
  - verify SDK path in `apps/mobile/android/local.properties`
  - verify Java 17 is used
  - rerun `npm run sync:android --workspace @tg-gf/mobile`

## Rollback Procedure
1. Checkout last known stable revision.
2. Repeat setup + sync + build steps.
3. Re-install previous APK on test devices.
4. Immediate functional rollback (without APK downgrade):
   - set `androidNativeGroupIterationV1=false` in app settings.
   - keep app running in fallback mode while root-cause analysis proceeds.
