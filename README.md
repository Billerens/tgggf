# tg-gf Wrapper Architecture

Shared React UI with dual local wrappers:
- Desktop: Electron + embedded Node API process
- Android: Capacitor + native bridge module

## Requirements
- Node.js 20+
- npm 10+
- Android Studio (for Android builds)

## Install
```bash
npm install --include=dev
```

## Development
- Web only:
  - `npm run dev:web`
- Local API:
  - `npm run dev:api`
- Desktop wrapper:
  - `npm run dev:desktop`

## Build
- Web bundle:
  - `npm run build:web`
- API:
  - `npm run build:api`
- Desktop wrapper:
  - unpacked: `npm run pack:desktop`
  - installer: `npm run dist:desktop`
- Android wrapper:
  - sync native project: `npm run sync:android --workspace @tg-gf/mobile`
  - build APK from `apps/mobile/android`:
    - `gradlew.bat assembleDebug` (Windows)
    - `./gradlew assembleDebug` (Linux/macOS)

## Artifacts
- Desktop:
  - unpacked app: `apps/desktop/release/win-unpacked/` (platform variant by runner OS)
  - installer: `apps/desktop/release/*.exe` (Windows)
- Android:
  - debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

## CI
- Desktop matrix build workflow:
  - `.github/workflows/desktop-build.yml`
- Android debug build workflow:
  - `.github/workflows/android-build.yml`

## Operations
- Desktop runbook: `docs/desktop/runbook.md`
- Android runbook: `docs/android/runbook.md`
- Architecture decision: `docs/adr/ADR-001-wrapper-architecture.md`
