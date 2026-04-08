# Deep Group Chat System Plan

Date: 2026-04-03
Branch: codex/group-chat-deep-system
Status: In progress

## Goals

- Build a deep, separate group chat subsystem that does not break existing 1:1 chats.
- Support two group modes:
  - personas_only: personas talk autonomously, user can inject messages/events.
  - personas_plus_user: personas can address user directly and room can wait for user reply.
- Add orchestrator-driven lifecycle, event log, group memory, private persona memory in group, relation graph, liveliness logic.
- Support images in group messages (like 1:1), mentions, addressing, and clear author identity in UI.
- Add user name to system settings so personas can account for it.

## Hard Invariants (must never be violated)

- Persona speaks only for self.
- One generation call -> one speaking persona -> one authored message.
- Orchestrator never writes character dialogue as persona text.
- UI always shows avatar + name near each group message bubble.
- Group subsystem is isolated from 1:1 data model and flows.

## Trackable Checklist

### Phase 0. Foundation and safety

- [x] Create dedicated branch for group chat development.
- [x] Add this plan file as living tracking artifact.
- [ ] Define coding guardrails for encoding-safe file edits and migration-safe DB changes.

### Phase 1. Settings and prompt prerequisites

- [x] Add userName field to AppSettings and DB normalization/defaults.
- [x] Add user name field to Settings UI.
- [x] Include userName in system prompt context for persona responses.

### Phase 2. Domain model for group chats

- [x] Add new types for GroupRoom, GroupParticipant, GroupMessage, GroupEvent.
- [x] Add types for GroupPersonaState, GroupRelationEdge, GroupMemoryShared, GroupMemoryPrivate.
- [x] Add mention model for group messages.
- [x] Add group message image attachment model.

### Phase 3. Persistence (IndexedDB)

- [x] Add DB version migration with new object stores for group subsystem.
- [x] Add indices for room timeline, events, participants, relations, memory layers.
- [x] Add dbApi methods for group rooms/messages/events/state/relation/memory.
- [x] Add snapshot storage for fast room restore.

### Phase 4. Orchestrator

- [x] Implement group orchestrator service entrypoint.
- [x] Implement tick pipeline: ingest -> analyze -> plan -> execute -> persist -> schedule.
- [x] Implement strict author-integrity guard (reject multi-speaker persona output).
- [x] Implement mode-specific waiting logic for personas_plus_user.

### Phase 5. Memory and relations

- [x] Implement shared group memory write/read/reconcile.
- [x] Implement private per-persona-in-group memory layer.
- [x] Implement directed relation edges and speech-act based updates.
- [x] Implement relation decay and smoothing.

### Phase 6. Liveliness and pacing

- [x] Add initiative/cooldown/liveness scoring.
- [x] Add anti-spam and anti-monologue balancing.
- [x] Add dormant-persona reactivation heuristics.

### Phase 7. UI and UX for group chats

- [x] Add groups tab and room navigation in sidebar.
- [x] Add group chat pane separate from existing 1:1 pane.
- [x] Render avatar + name per bubble for clear authorship.
- [x] Render mentions with dedicated visual treatment.
- [x] Render image bubbles and image actions in group messages.
- [x] Show orchestrator status and waiting-for-user state.
- [x] Add dev event-log panel for group room diagnostics.

### Phase 8. Parsing, mentions, addressing

- [x] Add mention parser and resolver (@persona, @user, aliases).
- [x] Route mention signals into orchestrator planning priorities.
- [x] Add addressing-aware prompt context to speaking persona.

### Phase 9. Tests and quality gates

- [ ] Add tests for single-author invariant enforcement.
- [ ] Add tests for mode transitions and waiting TTL behavior.
- [ ] Add tests for relation/memory updates from events.
- [ ] Add tests for group message UI (avatar/name/mentions/images).

## Event Log Schema (draft)

Planned event types:

- room_created
- room_mode_changed
- participant_added
- participant_removed
- user_injected
- orchestrator_tick_started
- speaker_selected
- persona_spoke
- message_image_requested
- message_image_generated
- mention_resolved
- relation_changed
- memory_shared_written
- memory_private_written
- room_waiting_user
- room_resumed
- room_paused
- snapshot_written

## Prompt Contracts (draft)

### Orchestrator system prompt rules

- Never produce dialogue as any persona.
- Return only structured orchestration decisions.
- Enforce one active speaker per step unless a system event explicitly allows otherwise.

### Persona system prompt rules in group mode

- Speak only as current persona identity.
- Never write lines on behalf of other personas.
- Never output multi-role transcript format.
- Respect mentions/addressing and room mode.

## Notes and Risks

- Preserve existing 1:1 behavior and UX with strict separation.
- Minimize prompt bloat by using compact memory cards.
- Keep event log append-only; derive read models separately.

## Progress Log

- 2026-04-03: Branch created, architecture baseline finalized, implementation started.
- 2026-04-03: Added `userName` to settings model/UI/system prompt.
- 2026-04-03: Added group domain types and separate IndexedDB stores + dbApi scaffolding.
- 2026-04-03: Added base `useGroupStore`, groups sidebar tab, and first `GroupChatPane` with author avatar/name, mentions and image bubble rendering.
- 2026-04-03: Added dedicated group prompt contracts (`groupPrompts.ts`) with hard single-author constraints for orchestrator and personas.
- 2026-04-03: Added scrollable sidebar tabs, GroupRoom creation modal (title + participants via dropdown/chips), and group header controls (start/pause/iteration + participant avatars).
- 2026-04-03: Fixed group avatar resolution from `idb://` sources, added portal-based dropdown rendering in group modal, enriched participant dropdown/chips with avatar + persona traits, and added group deletion from sidebar list and group header.
- 2026-04-03: Added standalone orchestrator module (`groupOrchestrator.ts`) + auto-tick loop for active rooms, appended full orchestration event flow in store, and shipped in-chat dev event log panel.
- 2026-04-03: Switched group orchestration to hybrid LLM mode: LLM decides next step/speaker (JSON contract) and generates persona speech; deterministic logic now acts as guarded fallback with invariant enforcement.
- 2026-04-03: Added contextual behavior layer for group persona replies: prompts now include persona profile (character/style/values/boundaries/expertise), active persona state, relation edges, shared/private group memory, and recent room events; store now persists and updates these artifacts during turns.
- 2026-04-03: Hardened `personas_plus_user` waiting flow: strict waiting lock bypasses LLM override while waiting for user, emits `room_resumed` when user replies, deduplicates repeated `room_waiting_user`, and records `memory_shared_written` / `memory_private_written` / `relation_changed` events for diagnostics.
- 2026-04-03: Added explicit mention/addressing signals to LLM prompt contracts: orchestrator input now includes mention priority hints from the latest user message, and persona input includes direct-address flags + mention context.
- 2026-04-03: Implemented group memory reconciliation and relation dynamics layer (`groupDynamics.ts`): shared/private memory dedup+decay+promotion+trimming, speech-act-aware relation updates, and relation baseline decay/smoothing integrated into orchestrator turns.
- 2026-04-03: Implemented liveliness pacing in deterministic orchestrator fallback: participant scoring by initiative+alive score, anti-monologue penalties by recent speaker frequency, dormancy boosts, plus cooldown (`muteUntil`) and alive-score updates per turn in group store.
- 2026-04-03: Hardened `runActiveGroupIteration` against invalid LLM skip/wait overrides when deterministic speaker selection is valid; this fixes false stalls like "no personas available ... previous speaker was user".
- 2026-04-03: Expanded group mentions and events: alias-based mention resolver (`@name`, compact/short aliases), `@all/@everyone/@все`, and append-only `mention_resolved` events for user/persona messages.
- 2026-04-03: Added group image generation pipeline for persona turns using Comfy flow (prompt/image-description handling, message patching with attachments/meta, and `message_image_requested`/`message_image_generated` events).
- 2026-04-03: Enriched group persona prompt context with appearance fields and relation labels by persona names (instead of raw relation target IDs).
- 2026-04-03: Fixed `personas_only` autonomy guardrails: room no longer enters/keeps waiting-for-user in this mode, and auto-iteration loop in App only pauses on `waitingForUser` for `personas_plus_user`.
- 2026-04-03: Upgraded orchestrator profile context from plain names to rich participant cards (archetype, character, voice, behavior, appearance) plus runtime queue hints (aliveScore/cooldown/initiativeBias) for better speaker sequencing.
- 2026-04-03: Added human-like pacing guard (`typing_delay`) in deterministic orchestrator logic: minimum time between group messages based on recent message author and text length.
- 2026-04-03: Added per-persona LMStudio continuity for group replies: pass `previous_response_id` from `GroupPersonaState.lastResponseId`, persist returned `response_id` back to the speaking persona state.
- 2026-04-03: Fixed pause race/override issues: room status is no longer force-reset to `active` at tick completion, and group controls allow pause/start during orchestrator ticking.
- 2026-04-03: Added anti-loop safeguards for group dialogue quality: mention-priority is applied only when the latest room message is from user, `personas_only` avoids immediate same-speaker repeats when alternatives exist, and exact same-speaker text duplicates are replaced with deterministic fallback text.
- 2026-04-03: Added context compaction for group prompts to prevent quality drift over long sessions: clipped message/event blocks, reduced recent windows, and compact payload rendering.
- 2026-04-03: Fixed `previous_response_id` chain integrity in group persona flow: do not persist `response_id` when LLM output was discarded (dedupe/fallback), persist only when LLM text is actually used.
