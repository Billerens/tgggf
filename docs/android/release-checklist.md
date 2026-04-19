# Android Native Runtime - Release Checklist

## Purpose
Operational checklist for staged rollout of Android native runtime (`group_iteration` + `topic_generation` + `one_to_one_chat`) with explicit stop criteria and rollback gates.

## Inputs
- Latest debug/release candidate APK.
- Current rollout settings in app:
  - `androidNativeRolloutStage`
  - `androidNativeGroupIterationV1`
  - `androidNativeGroupImagesV1`
  - `androidNativeGroupStructuredStorageV1`
  - `androidNativeGroupStructuredStorageDualWrite`
- Current runtime health snapshot from Settings.

## Stage Presets
1. `internal`
   - iteration: `true`
   - images: `false`
   - structured storage: `true`
   - dual-write: `true`
2. `beta`
   - iteration: `true`
   - images: `true`
   - structured storage: `true`
   - dual-write: `true`
3. `prod`
   - iteration: `true`
   - images: `true`
   - structured storage: `true`
   - dual-write: `false`

## Promotion Checklist
1. Apply target stage preset in Settings.
2. Save settings and refresh foreground status.
3. Confirm health is `native active` for baseline run.
4. Execute smoke flow from `docs/android/runbook.md`.
5. Confirm no persistent stale workers and no persistent stale leased jobs.
6. Confirm no recurring worker `lastError` for at least 15 minutes.
7. Confirm `one_to_one_chat` events progress to `job_completed` or `job_failed_terminal` without hanging pending states.
8. Document evidence:
   - timestamp
   - stage
   - queue depth
   - stale jobs
   - stale workers
   - last error (if any)
9. Promote to next stage only after all checks pass.

## SLO Targets
- Availability SLO:
  - `native active` >= 99% of observed checks during stage window.
- Freshness SLO:
  - `stale workers == 0` for >= 95% of checks.
  - `stale jobs == 0` for >= 95% of checks.
- Error SLO:
  - no repeating identical worker error across 3 consecutive intervals.

## Stop Criteria
Stop rollout progression immediately if any condition is met:
1. Health remains `native degraded` for more than 15 minutes.
2. `stale jobs` increases across 3 consecutive refreshes.
3. Same worker `lastError` repeats 3 times подряд.
4. Message/event persistence mismatch detected after restart.
5. `one_to_one_chat` jobs remain pending without progress across 3 refresh intervals.

## Rollback (No Data Loss)
1. In Settings, run `Rollback в fallback` (or set `androidNativeGroupIterationV1=false`).
2. Keep `androidNativeGroupStructuredStorageV1=true`.
3. Keep `androidNativeGroupStructuredStorageDualWrite=true` during recovery window.
4. Refresh foreground status and confirm `bridge fallback`.
5. Verify chats/rooms/messages/events are still readable, including latest 1:1 message state.
6. Export backup (`JSON` or `ZIP`) before retrying rollout.

## Evidence Template
- Build:
- Device:
- Stage:
- Start time:
- End time:
- Health distribution (`active/degraded/fallback`):
- Queue observations:
- Stale metrics observations:
- Errors observed:
- Decision (`promote/hold/rollback`):
