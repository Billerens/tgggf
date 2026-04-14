# Android Group Background Autonomy Plan

## Goal
Сделать обработку групповых чатов на Android полностью фоновой и автономной, без зависимости от живого WebView/UI.

## Tasks
- [ ] Task 1: Зафиксировать целевую модель выполнения (`native-first`, UI только для наблюдения) и ввести feature-flag `androidNativeGroupIterationV1` → Verify: флаг читается в `useGroupIterationBackgroundWorker` и в `GroupIterationNativeExecutor`, есть лог старта режима.
- [ ] Task 2: Вынести из `groupStore.runActiveGroupIteration` чистое доменное ядро итерации (select speaker, decision merge, message/events/memory/relation patches) в платформенно-нейтральный модуль → Verify: unit-тесты на детерминированный ход и блокировки (`waiting_for_user`, `room_not_active`, `pending_image_generation`) проходят.
- [ ] Task 3: Реализовать native headless executor для group iteration (без `emitGroupIterationRunRequest` как обязательного шага), который напрямую читает/пишет stores и runtime-events → Verify: при выключенном UI появляются `iteration_completed` и новые group events/messages в локальном хранилище.
- [ ] Task 4: Перенести LLM-запросы для оркестратора и персоны в Android native layer (HTTP client + auth modes + таймауты + retry/backoff) с тем же контрактом, что у web-ветки → Verify: интеграционный тест/лог показывает успешный цикл `decision + persona_speech` в фоне.
- [ ] Task 5: Перенести генерацию изображений в native group pipeline (по аналогии с `TopicGenerationNativeExecutor`) и синхронизировать статусы `imageGenerationPending/Completed` → Verify: в фоне создаются attachments/meta, а при ошибке пишется `message_image_generated: generation_failed`.
- [ ] Task 6: Сделать shared persistence для background-контуров через SQLite/Room (убрать зависимость от периодического `raw-snapshot` из UI как источника истины) → Verify: после перезапуска процесса состояние room/messages/events восстанавливается без открытия экрана чата.
- [ ] Task 7: Включить реальный WorkManager recovery path (`SchedulerWorker` + unique periodic/one-time work + boot re-enqueue), ForegroundService оставить как ускоритель/heartbeat → Verify: после kill процесса и reboot устройства задания автоматически восстанавливаются и продолжают выполняться.
- [ ] Task 8: Добавить Android lifecycle hardening (battery optimization intent flow, doze-safe scheduling, stale lease reclaim, watchdog metrics) → Verify: при имитации Doze/ограничений есть восстановление и нет вечных `leased` jobs.
- [ ] Task 9: Обновить UI наблюдения (статусы workers, lastError, queue depth, active rooms) и runbook → Verify: в Settings видно различие `native active / degraded / bridge fallback`, runbook содержит шаги диагностики и recovery.
- [ ] Task 10: Провести staged rollout (internal -> beta -> prod) с rollback по флагу и критериями остановки → Verify: есть чеклист релиза, метрики SLO и подтверждён rollback-сценарий без потери данных.

## Done When
- [ ] Group iteration выполняется в фоне при закрытом UI и не зависит от `groupIterationRunRequest` bridge.
- [ ] После restart/kill/reboot Android-задачи автоматически восстанавливаются и продолжают обработку.
- [ ] Ошибки LLM/изображений не ломают цикл, а переводятся в контролируемые retries/fail events.
- [ ] Документация и мониторинг позволяют быстро локализовать и восстановить сбои.

## Notes
- Critical path: Task 2 -> Task 3 -> Task 4 -> Task 6 -> Task 7.
- Parallelizable: Task 9 можно делать параллельно с Task 7/8.
- Первичный риск: расхождение логики web/native; смягчается общим доменным ядром и контрактными тестами.
