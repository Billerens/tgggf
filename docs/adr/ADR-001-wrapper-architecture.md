# ADR-001: Dual Wrapper Architecture (Desktop + Android)

## Status
Accepted

## Date
2026-04-13

## Context
The product started as a browser-oriented React app with IndexedDB-centric persistence and no local process boundary. We need an architecture that supports:
- desktop runtime with embedded backend process
- android runtime with embedded native local service bridge
- future autonomous background capabilities without immediate behavior rollout

## Decision
Adopt a dual-wrapper architecture:
- Shared React UI remains the single presentation layer.
- Runtime mode is resolved via wrapper bridge contract (`web`, `desktop`, `android`).
- Desktop wrapper:
  - Electron main process
  - local Node API process supervisor
  - preload bridge exposed as `tgWrapper`
- Android wrapper:
  - Capacitor host app
  - native plugin bridge (`LocalApi`)
  - WorkManager skeleton for periodic background rails
- Shared API transport abstraction selects endpoint semantics by runtime mode.

## Consequences
### Positive
- One UI codebase across web, desktop, and android.
- Clear process boundary for future local backend features.
- Controlled path toward background autonomy without coupling it into UI layer immediately.

### Trade-offs
- Additional build/deployment complexity (Electron + Android pipelines).
- Need CI and runbooks for platform-specific troubleshooting.
- Temporary dual persistence reality (existing IndexedDB paths + backend scaffolds) until data plane migration is complete.

## Follow-up
- Complete backend-first data path migration from direct UI storage calls to wrapper transport contracts.
- Expand native Android bridge beyond health/check scaffolds.
- Introduce release signing pipelines (desktop code signing and Android release keystore flow).
