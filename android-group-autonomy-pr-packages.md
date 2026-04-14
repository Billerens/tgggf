# Android Group Autonomy - PR Package Breakdown

## Goal
Разбить реализацию фоновой автономности групповых чатов на безопасную серию PR с контролируемым риском, быстрым rollback и прозрачной верификацией.

## PR-01: Feature Flag + Runtime Wiring
### Scope
- Добавить флаг `androidNativeGroupIterationV1` (default: `false`).
- Проложить чтение флага в web/native контуры групповой итерации.
- Добавить статус-флаги в system logs и UI diagnostics.

### Files (expected)
- `src/features/mobile/useGroupIterationBackgroundWorker.ts`
- `src/components/SettingsModal.tsx`
- `src/App.tsx`
- `src/features/system-logs/systemLogStore.ts` (если нужен новый event type)

### Out of Scope
- Любая бизнес-логика native execution.

### Verification
- `pwsh -NoLogo -NoProfile -Command "npm run test -- src/features/mobile/useGroupIterationBackgroundWorker.ts"`
- Ручная проверка: при переключении флага пишется диагностический лог с текущим режимом.

### Rollback
- Выключение флага возвращает текущее поведение без удаления кода.

---

## PR-02: Extract Shared Group Iteration Domain Core
### Scope
- Вынести из `groupStore.runActiveGroupIteration` доменные шаги в отдельный модуль:
  - room blocking checks
  - speaker selection merge
  - event/message patch builders
  - memory/relation state transition functions
- Сохранить API, чтобы текущая web-ветка продолжала работать.

### Files (expected)
- `src/groupStore.ts`
- `src/features/group-iteration/domain/*.ts` (новая папка)
- `src/features/group-iteration/domain/*.test.ts`

### Out of Scope
- Native HTTP/LLM исполнение.

### Verification
- `pwsh -NoLogo -NoProfile -Command "npm run test -- src/features/group-iteration/domain"`
- `pwsh -NoLogo -NoProfile -Command "npm run test -- src/groupStore.ts"`

### Rollback
- Возврат к прежнему inline-коду в `groupStore.ts`.

---

## PR-03: Native Headless Group Executor (Deterministic Path)
### Scope
- Перевести `GroupIterationNativeExecutor` на headless execution без обязательного bridge-события в WebView.
- Обрабатывать due jobs и напрямую писать room/events/messages через native repository.
- Оставить bridge fallback как временный режим под флагом.

### Files (expected)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/GroupIterationNativeExecutor.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/BackgroundJobRepository.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/BackgroundRuntimeRepository.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/LocalApiBridgePlugin.kt` (минимально)

### Out of Scope
- LLM вызовы из native.

### Verification
- `pwsh -NoLogo -NoProfile -Command "cd apps/mobile/android; .\\gradlew.bat testDebugUnitTest"`
- Ручная проверка: при закрытом UI есть `iteration_*` runtime events и reschedule jobs.

### Rollback
- Возврат на bridge dispatch-only path по feature flag.

---

## PR-04: Native LLM Orchestrator + Persona Speech
### Scope
- Добавить в Android native клиент вызовы:
  - orchestrator decision
  - persona message generation
- Поддержать auth modes, timeout, retry/backoff и error mapping, совместимые с web.
- Подключить LLM path в native group iteration loop.

### Files (expected)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/GroupIterationNativeExecutor.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/LocalRepository.kt` (чтение настроек/моделей)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/*.kt` (новый http/llm helper)

### Out of Scope
- Генерация изображений для групп.

### Verification
- `pwsh -NoLogo -NoProfile -Command "cd apps/mobile/android; .\\gradlew.bat testDebugUnitTest"`
- Интеграционно: минимум 1 полный цикл `decision -> persona_spoke -> next_run_scheduled` в фоне.

### Rollback
- Флагом отключить native LLM path и вернуться к deterministic-only.

---

## PR-05: Native Group Image Generation Pipeline
### Scope
- Добавить в group native pipeline генерацию изображений по аналогии с topic executor.
- Вести `imageGenerationPending/Expected/Completed` и `imageMetaByUrl`.
- Гарантировать корректное завершение/ошибку без зависаний pending.

### Files (expected)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/GroupIterationNativeExecutor.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/TopicGenerationNativeExecutor.kt` (переиспользование helper)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/LocalRepository.kt`

### Out of Scope
- WorkManager/boot recovery.

### Verification
- `pwsh -NoLogo -NoProfile -Command "cd apps/mobile/android; .\\gradlew.bat testDebugUnitTest"`
- Фоновая интеграция: событие `message_image_generated` появляется и счётчики синхронны.

### Rollback
- Feature flag `nativeGroupImages` (в рамках общего флага или отдельного).

---

## PR-06: Shared Persistence Upgrade (SQLite/Room for Group Runtime)
### Scope
- Уйти от SharedPreferences JSON как primary source для group runtime.
- Ввести структурированное storage (Room/SQLite tables) для group rooms/messages/events/states.
- Сохранить migration/compat слой для старых данных.

### Files (expected)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/LocalRepository.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/db/*` (новые сущности/dao)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/LocalApiBridgePlugin.kt` (чтение/запись через новый слой)

### Out of Scope
- Планировщик восстановления после reboot.

### Verification
- `pwsh -NoLogo -NoProfile -Command "cd apps/mobile/android; .\\gradlew.bat testDebugUnitTest"`
- Migration test: данные из старого хранилища читаются после обновления и не теряются.

### Rollback
- Временный dual-write/dual-read режим до полного cutover.

---

## PR-07: WorkManager + Boot Recovery + Scheduler Activation
### Scope
- Реализовать `SchedulerWorker` (не заглушка).
- Добавить enqueue unique work, periodic/one-time recovery, lease watchdog.
- Добавить boot receiver и восстановление очереди после перезагрузки.

### Files (expected)
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/SchedulerWorker.kt`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/*Scheduler*.kt` (новые helper-классы)
- `apps/mobile/android/app/src/main/AndroidManifest.xml` (receiver/perms)
- `apps/mobile/android/app/src/main/java/com/tggf/app/MainActivity.java` (минимальные интеграции при необходимости)

### Out of Scope
- UI polishing.

### Verification
- `pwsh -NoLogo -NoProfile -Command "cd apps/mobile/android; .\\gradlew.bat testDebugUnitTest"`
- Device test: force-stop/reboot -> jobs восстанавливаются и продолжают цикл.

### Rollback
- Отключаем scheduler-enqueue и остаёмся только на foreground loop.

---

## PR-08: Observability + Runbook + Staged Rollout Controls
### Scope
- Расширить runtime metrics/events: queue depth, stale jobs, worker heartbeats, lastError.
- Добавить UI-статусы `native active / degraded / fallback`.
- Обновить `docs/android/runbook.md` и release checklist (rollback gates).

### Files (expected)
- `src/components/SettingsModal.tsx`
- `src/features/mobile/foregroundService.ts`
- `apps/mobile/android/app/src/main/java/com/tggf/app/localapi/ForegroundSyncService.kt`
- `docs/android/runbook.md`
- `android-group-autonomy-plan.md` (опционально синхронизация этапов)

### Out of Scope
- Большие архитектурные изменения runtime.

### Verification
- `pwsh -NoLogo -NoProfile -Command "npm run test"`
- Smoke checklist из runbook проходит на debug APK.

### Rollback
- UI/логика наблюдения отключается без влияния на core execution.

---

## Merge Order
1. PR-01
2. PR-02
3. PR-03
4. PR-04
5. PR-05
6. PR-06
7. PR-07
8. PR-08

## Critical Gates (must pass before next PR)
- Gate A (after PR-03): headless cycle не зависит от bridge listener.
- Gate B (after PR-04): LLM ошибки не приводят к queue deadlock.
- Gate C (after PR-06): миграция storage без потери данных.
- Gate D (after PR-07): restart/reboot recovery подтверждён на устройстве.

## Risk Notes
- Самый высокий риск: расхождение поведения web/native оркестрации.
- Снижение риска: общий доменный core (PR-02), feature flag rollout, contract tests и runtime event telemetry.
