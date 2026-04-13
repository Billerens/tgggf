# Wrapper Architecture Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the current browser-only app to a dual-wrapper architecture (Desktop + Android) with an embedded local backend foundation (no proactive features yet).

**Architecture:** Keep the React UI as a shared presentation layer, introduce a runtime transport abstraction, and run platform-specific local backend runtimes behind one API contract. Desktop uses Electron + local Node API process. Android uses Capacitor + native Android local service module (Room + WorkManager) exposed to web UI via a bridge adapter. Build in thin slices with strict compatibility checkpoints between web, desktop, and android modes.

**Tech Stack:** React 19 + Vite 8, Electron, Capacitor Android, Node.js 20, Fastify, SQLite, Kotlin, Room, WorkManager, Vitest

---

### Task 1: Create Runtime Mode Contract (Web vs Desktop vs Android)

**Files:**
- Create: `src/platform/runtimeMode.ts`
- Create: `src/platform/runtimeMode.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

```ts
// src/platform/runtimeMode.test.ts
import { describe, expect, it } from "vitest";
import { detectRuntimeMode } from "./runtimeMode";

describe("detectRuntimeMode", () => {
  it("returns web by default", () => {
    expect(detectRuntimeMode({})).toBe("web");
  });

  it("returns desktop when wrapper flag is present", () => {
    expect(detectRuntimeMode({ __TG_WRAPPER__: "desktop" })).toBe("desktop");
  });

  it("returns android when wrapper flag is present", () => {
    expect(detectRuntimeMode({ __TG_WRAPPER__: "android" })).toBe("android");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/platform/runtimeMode.test.ts`
Expected: FAIL with module/function not found.

**Step 3: Write minimal implementation**

```ts
// src/platform/runtimeMode.ts
export type RuntimeMode = "web" | "desktop" | "android";

export function detectRuntimeMode(env: Record<string, unknown>): RuntimeMode {
  if (env.__TG_WRAPPER__ === "desktop") return "desktop";
  if (env.__TG_WRAPPER__ === "android") return "android";
  return "web";
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/platform/runtimeMode.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add package.json src/platform/runtimeMode.ts src/platform/runtimeMode.test.ts
git commit -m "chore: add runtime mode contract for wrapper migration"
```

### Task 2: Add Backend Transport Abstraction in UI

**Files:**
- Create: `src/api/transport.ts`
- Create: `src/api/transport.test.ts`
- Modify: `src/db.ts`

**Step 1: Write the failing test**

```ts
// src/api/transport.test.ts
import { describe, expect, it } from "vitest";
import { createApiBaseUrl } from "./transport";

describe("createApiBaseUrl", () => {
  it("uses relative /api in desktop mode", () => {
    expect(createApiBaseUrl("desktop", undefined)).toBe("/api");
  });

  it("uses bridge://api in android mode", () => {
    expect(createApiBaseUrl("android", undefined)).toBe("bridge://api");
  });

  it("uses provided backend url in web mode", () => {
    expect(createApiBaseUrl("web", "https://api.example.com")).toBe("https://api.example.com");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/api/transport.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// src/api/transport.ts
import type { RuntimeMode } from "../platform/runtimeMode";

export function createApiBaseUrl(mode: RuntimeMode, configured?: string): string {
  if (mode === "desktop") return "/api";
  if (mode === "android") return "bridge://api";
  return (configured || "").trim();
}
```

Update `src/db.ts` to use `createApiBaseUrl(...)` instead of direct env branching.

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/api/transport.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/api/transport.ts src/api/transport.test.ts src/db.ts
git commit -m "refactor: introduce api transport abstraction for desktop mode"
```

### Task 3: Scaffold Local Backend Service (Process Boundary Only)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/server.test.ts`
- Create: `apps/api/tsconfig.json`
- Modify: `package.json`

**Step 1: Write the failing test**

```ts
// apps/api/src/server.test.ts
import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("api health", () => {
  it("returns ok payload", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/api -- src/server.test.ts`
Expected: FAIL (workspace/app not configured).

**Step 3: Write minimal implementation**

```ts
// apps/api/src/server.ts
import Fastify from "fastify";

export function buildServer() {
  const app = Fastify();
  app.get("/api/health", async () => ({ ok: true, service: "local-api" }));
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT || 8787);
  buildServer().listen({ host: "127.0.0.1", port });
}
```

Configure root workspaces and scripts:
- `dev:api`
- `build:api`
- `test:api`

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/api -- src/server.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add package.json apps/api
git commit -m "feat: scaffold local api process with health endpoint"
```

### Task 4: Add Local Persistence Layer (SQLite + Repository Contract)

**Files:**
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/repository.ts`
- Create: `apps/api/src/db/repository.test.ts`
- Modify: `apps/api/src/server.ts`

**Step 1: Write the failing test**

```ts
// apps/api/src/db/repository.test.ts
import { describe, expect, it } from "vitest";
import { createRepository } from "./repository";

describe("repository bootstrap", () => {
  it("creates default tables", async () => {
    const repo = await createRepository(":memory:");
    const ok = await repo.healthcheck();
    expect(ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/api -- src/db/repository.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// apps/api/src/db/repository.ts
export interface Repository {
  healthcheck(): Promise<boolean>;
}

export async function createRepository(_path: string): Promise<Repository> {
  return {
    async healthcheck() {
      return true;
    },
  };
}
```

Wire repository initialization into `buildServer()` and expose DB status in `/api/health`.

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/api -- src/db/repository.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/db apps/api/src/server.ts
git commit -m "feat: add sqlite repository contract for local backend"
```

### Task 5: Add Background Worker Skeleton (No Business Logic Yet)

**Files:**
- Create: `apps/api/src/worker/scheduler.ts`
- Create: `apps/api/src/worker/scheduler.test.ts`
- Modify: `apps/api/src/server.ts`

**Step 1: Write the failing test**

```ts
// apps/api/src/worker/scheduler.test.ts
import { describe, expect, it, vi } from "vitest";
import { createScheduler } from "./scheduler";

describe("scheduler", () => {
  it("ticks on interval", async () => {
    const run = vi.fn();
    const scheduler = createScheduler({ intervalMs: 10, run });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 35));
    scheduler.stop();
    expect(run).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/api -- src/worker/scheduler.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// apps/api/src/worker/scheduler.ts
export function createScheduler(opts: { intervalMs: number; run: () => void }) {
  let timer: NodeJS.Timeout | null = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(opts.run, opts.intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
```

Initialize scheduler in server bootstrap with `run` as no-op placeholder.

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/api -- src/worker/scheduler.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/worker apps/api/src/server.ts
git commit -m "feat: add background scheduler skeleton for autonomous workflows"
```

### Task 6: Scaffold Desktop Wrapper (Electron) and Process Supervisor

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/backendSupervisor.ts`
- Create: `apps/desktop/src/backendSupervisor.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

```ts
// apps/desktop/src/backendSupervisor.test.ts
import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./backendSupervisor";

describe("resolveApiUrl", () => {
  it("returns local api url", () => {
    expect(resolveApiUrl(8787)).toBe("http://127.0.0.1:8787");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/desktop -- src/backendSupervisor.test.ts`
Expected: FAIL (workspace missing).

**Step 3: Write minimal implementation**

```ts
// apps/desktop/src/backendSupervisor.ts
export function resolveApiUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}
```

Create Electron `main.ts`:
- starts backend child process (`apps/api/dist/server.js`)
- waits for `/api/health`
- opens BrowserWindow with UI URL

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/desktop -- src/backendSupervisor.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop package.json
git commit -m "feat: scaffold electron wrapper and backend supervisor"
```

### Task 7: Wire UI + Wrapper Integration Contract

**Files:**
- Create: `src/platform/wrapperBridge.ts`
- Create: `src/platform/wrapperBridge.test.ts`
- Modify: `src/main.tsx`
- Modify: `vite.config.ts`

**Step 1: Write the failing test**

```ts
// src/platform/wrapperBridge.test.ts
import { describe, expect, it } from "vitest";
import { getWrapperInfo } from "./wrapperBridge";

describe("wrapper bridge", () => {
  it("returns desktop mode when bridge exists", () => {
    const info = getWrapperInfo({
      tgWrapper: { mode: "desktop", apiBaseUrl: "http://127.0.0.1:8787" },
    });
    expect(info.mode).toBe("desktop");
  });

  it("returns android mode when bridge exists", () => {
    const info = getWrapperInfo({
      tgWrapper: { mode: "android", apiBaseUrl: "bridge://api" },
    });
    expect(info.mode).toBe("android");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/platform/wrapperBridge.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// src/platform/wrapperBridge.ts
export function getWrapperInfo(windowLike: Record<string, unknown>) {
  const tgWrapper = windowLike.tgWrapper as { mode?: string; apiBaseUrl?: string } | undefined;
  if (tgWrapper?.mode === "desktop") {
    return { mode: "desktop" as const, apiBaseUrl: tgWrapper.apiBaseUrl || "/api" };
  }
  if (tgWrapper?.mode === "android") {
    return { mode: "android" as const, apiBaseUrl: tgWrapper.apiBaseUrl || "bridge://api" };
  }
  return { mode: "web" as const, apiBaseUrl: "/api" };
}
```

Initialize runtime mode in `main.tsx` before app bootstrap.

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/platform/wrapperBridge.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/platform/wrapperBridge.ts src/platform/wrapperBridge.test.ts src/main.tsx vite.config.ts
git commit -m "feat: wire wrapper bridge into frontend bootstrap"
```

### Task 8: Desktop Delivery Pipeline and Operations Baseline

**Files:**
- Create: `.github/workflows/desktop-build.yml`
- Create: `docs/desktop/runbook.md`
- Create: `docs/adr/ADR-001-wrapper-architecture.md`
- Modify: `README.md`

**Step 1: Write the failing test**

```ts
// scripts/validate-release-artifacts.test.ts (or equivalent)
// Assert workflow file exists and contains matrix for win/mac/linux.
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- scripts/validate-release-artifacts.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add CI workflow with:
- web build
- api build
- desktop packaging (draft artifacts only)

Add runbook sections:
- startup flow
- backend crash recovery
- log locations
- safe rollback procedure

**Step 4: Run test to verify it passes**

Run: `npm run test -- scripts/validate-release-artifacts.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/desktop-build.yml docs/desktop/runbook.md docs/adr/ADR-001-wrapper-architecture.md README.md
git commit -m "chore: add desktop delivery pipeline and operations docs"
```

### Task 9: Scaffold Android Wrapper (Capacitor)

**Files:**
- Create: `apps/mobile/package.json`
- Create: `apps/mobile/capacitor.config.ts`
- Create: `apps/mobile/android/` (generated by Capacitor)
- Create: `apps/mobile/src/androidBridge.ts`
- Create: `apps/mobile/src/androidBridge.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

```ts
// apps/mobile/src/androidBridge.test.ts
import { describe, expect, it } from "vitest";
import { resolveAndroidApiBase } from "./androidBridge";

describe("resolveAndroidApiBase", () => {
  it("returns bridge scheme for android wrapper", () => {
    expect(resolveAndroidApiBase()).toBe("bridge://api");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/mobile -- src/androidBridge.test.ts`
Expected: FAIL (workspace missing).

**Step 3: Write minimal implementation**

```ts
// apps/mobile/src/androidBridge.ts
export function resolveAndroidApiBase() {
  return "bridge://api";
}
```

Initialize Capacitor project and wire root scripts:
- `dev:mobile`
- `build:mobile`
- `sync:android`

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/mobile -- src/androidBridge.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/mobile package.json
git commit -m "feat: scaffold android wrapper with capacitor"
```

### Task 10: Add Android Local Service Module Contract (Background-Capable)

**Files:**
- Create: `apps/mobile/android/app/src/main/java/.../LocalApiBridge.kt`
- Create: `apps/mobile/android/app/src/main/java/.../LocalRepository.kt`
- Create: `apps/mobile/android/app/src/main/java/.../SchedulerWorker.kt`
- Create: `apps/mobile/src/localApiAdapter.ts`
- Create: `apps/mobile/src/localApiAdapter.test.ts`

**Step 1: Write the failing test**

```ts
// apps/mobile/src/localApiAdapter.test.ts
import { describe, expect, it } from "vitest";
import { mapBridgeHealthPayload } from "./localApiAdapter";

describe("mapBridgeHealthPayload", () => {
  it("maps native payload to shared health contract", () => {
    const result = mapBridgeHealthPayload({ ok: true, service: "android-local-api" });
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test --workspace @tg-gf/mobile -- src/localApiAdapter.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// apps/mobile/src/localApiAdapter.ts
export function mapBridgeHealthPayload(payload: { ok: boolean; service: string }) {
  return { ok: payload.ok, service: payload.service };
}
```

In native Android module:
- expose `health`, `read`, `write` bridge methods
- back data by Room
- create periodic worker skeleton via WorkManager (no business logic)

**Step 4: Run test to verify it passes**

Run: `npm run test --workspace @tg-gf/mobile -- src/localApiAdapter.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/mobile/android apps/mobile/src
git commit -m "feat: add android local api bridge and background worker skeleton"
```

### Task 11: Android Build/Release Baseline and Runbook

**Files:**
- Create: `.github/workflows/android-build.yml`
- Create: `docs/android/runbook.md`
- Modify: `README.md`

**Step 1: Write the failing test**

```ts
// scripts/validate-android-workflow.test.ts (or equivalent)
// Assert android workflow exists and builds debug artifact.
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- scripts/validate-android-workflow.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add CI workflow with:
- web build
- capacitor sync
- android debug build artifact

Add android runbook sections:
- local setup (JDK/Android SDK)
- run on device/emulator
- logs and crash diagnostics
- rollback checklist

**Step 4: Run test to verify it passes**

Run: `npm run test -- scripts/validate-android-workflow.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/android-build.yml docs/android/runbook.md README.md
git commit -m "chore: add android build pipeline and operations docs"
```

---

## Milestone Exit Criteria

1. App works in three modes from one codebase: browser mode, desktop-wrapper mode, and android-wrapper mode.
2. Desktop app starts local backend automatically and waits for health before showing UI.
3. Android app exposes a local API bridge and background worker skeleton with a compatible contract.
4. Local backend persistence baseline exists for both desktop and android runtimes.
5. No proactive persona behavior implemented yet (only architecture rails).
6. CI produces desktop + android artifacts and operational runbooks exist.

## Out of Scope (for this plan)

1. Autonomous persona behavior policies.
2. User-facing settings for proactive messages.
3. Tool-calling autonomy and multimodal initiative policies.
