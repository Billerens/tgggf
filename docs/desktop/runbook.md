# Desktop Wrapper Runbook

## Scope
- Desktop runtime: Electron wrapper + local Node API process.
- Build output: unpacked app and installer artifacts in `apps/desktop/release/`.

## Prerequisites
- Node.js 20+
- npm 10+
- Windows/macOS/Linux environment supported by Electron

## Local Startup (Dev)
1. Install dependencies:
   - `npm install --include=dev`
2. Start web + local API + Electron:
   - `npm run dev:desktop`

## Local Build (Artifact)
1. Build unpacked desktop app:
   - `npm run pack:desktop`
2. Build installer:
   - `npm run dist:desktop`
3. Artifacts:
   - unpacked app: `apps/desktop/release/win-unpacked/` (or platform equivalent)
   - installer: `apps/desktop/release/*.exe` (Windows NSIS)

## Runtime Health Checks
- Local API health endpoint:
  - `http://127.0.0.1:8787/api/health`
- Expected payload includes:
  - `ok: true`
  - `service: "local-api"`

## Logs and Diagnostics
- Desktop main process forwards backend process logs with prefix:
  - `[desktop->api]`
- On startup failures, check:
  - backend entry resolution in `apps/desktop/src/main.ts`
  - `/api/health` availability
  - API process crash messages in console

## Crash Recovery
1. Restart app.
2. If repeatable crash:
   - run `npm run build:api`
   - run `npm run build:desktop`
   - run `npm run pack:desktop`
3. Verify local API starts and returns `/api/health`.

## Rollback Procedure
1. Identify last known good commit/tag.
2. Rebuild from that revision:
   - `npm install --include=dev`
   - `npm run dist:desktop`
3. Re-distribute prior installer artifact.
