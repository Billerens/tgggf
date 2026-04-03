# Chat / Group Chat / Adventure Mode Master Plan

## Документ
- Статус: `DRAFT -> ACTIVE` (после первого review)
- Версия: `0.1.0`
- Обновлен: `2026-04-03`
- Владелец: `Product + Engineering`

## Как пользоваться этим файлом
1. Этот файл является единой точкой управления реализацией чатов, групповых чатов и режима приключений.
2. После каждого завершенного шага менять `[ ]` на `[x]`.
3. В конце файла вести журнал:
   - `Реализовано`
   - `Выявлено в процессе`
   - `Решения/компромиссы`
4. Не удалять старые записи, только дополнять.

---

## 1) Цели и рамки

### Цели
1. Поддержать три режима как отдельные продуктовые сущности:
   - `Личные чаты`
   - `Групповые чаты`
   - `Приключения` (отдельный режим, не подтип группового чата в UI)
2. Обеспечить строгий контроль нагрузки:
   - Пока идет генерация сообщения/изображения, чат ждет.
   - Никакой параллельной генерации внутри одного чата.
3. Заложить архитектуру для будущего развития режима `Приключения`:
   - Рассказчик/Арбитр решает исходы событий без RPG-циферок.
   - Решения опираются на характеры, память, отношения, недавние и давние события, контролируемую случайность.

### Не-цели (на текущем этапе)
1. Полноценная RPG-механика (характеристики, броски, таблицы навыков).
2. Сетевой мульти-юзер с синхронизацией между устройствами в реальном времени.
3. Публичные комнаты и социальные лобби.

---

## 2) Ключевые принципы архитектуры

1. `Single-flight per chat`: у чата только один активный ход.
2. `Queue-first`: любое действие генерации проходит через очередь задач.
3. `Deterministic-ish`: у каждого хода есть seed и трассировка причины решения.
4. `Event-first`: критичные события пишутся в журнал событий, UI строится поверх.
5. `Backward compatibility`: существующие личные чаты и данные не теряются.
6. `Progressive rollout`: функциональность включается по фазам с feature flags.
7. `LLM-governed behavior`: поведенческие и контентные правила задаются ролям LLM
   (`persona`, `director`, `narrator`, `arbiter`) через системные промпты и внутренние протоколы.
8. `No app-level content moderation`: приложение не делает контентных валидаторов/блокировок;
   в приложении остаются только технические проверки целостности (схема данных, очереди, state machine).

---

## 3) Режимы продукта

## 3.1 Личные чаты (`direct`)
- Участники: `user + 1 persona`.
- Текущая логика остается рабочей, но переводится на унифицированную модель участников.

## 3.2 Групповые чаты (`group`)
- Участники: `user + N persona` (N >= 2).
- Оркестрация ходов: `Director` выбирает следующего говорящего.
- Поддержка действий:
  - текст
  - реакция
  - упоминание
  - отправка изображения

## 3.3 Приключения (`adventure`) — отдельный режим
- Отдельный entry-point в UI (наравне с чатами/группами/генератором).
- Внутри работает `Narrator/Arbiter` слой:
  - определяет развитие сцены
  - решает исходы конфликтов/споров/драк
  - публикует результат в художественной форме
- Без RPG-условностей для пользователя.

---

## 4) Системные компоненты

1. `ChatMode Engine`
   - Определяет режим (`direct|group|adventure`) и активирует соответствующий pipeline.
2. `Turn Orchestrator`
   - Запускает стадии хода по очереди.
   - Следит за `turn_state` и блокировкой чата.
3. `Director` (для `group`)
   - Выбор спикера и типа следующего действия.
4. `Narrator/Arbiter` (для `adventure`)
   - Решение исходов событий.
   - Ведение narrative continuity (связности истории).
5. `Actor Generator`
   - Генерация реплик от имени конкретной персоны.
6. `Image Action Pipeline`
   - Генерация изображений по action `send_image`.
7. `Memory & Relationship Layer`
   - Личные и сценические воспоминания.
   - Межперсонные отношения в контексте чата/приключения.
8. `Event Log`
   - Источник трассировки, отладки и post-analysis.

---

## 5) Управление нагрузкой и очереди

## 5.1 Состояния хода
- `idle`
- `planning`
- `generating_text`
- `generating_image`
- `committing`
- `error`

Переход в новый ход возможен только из `idle`.

## 5.2 Очередь задач
Добавить хранилище `turnJobs`:
- `id`
- `chatId`
- `turnId`
- `mode`
- `stage`
- `payload`
- `status (queued|running|done|failed|cancelled)`
- `retryCount`
- `createdAt/startedAt/finishedAt`

## 5.3 Политика блокировок
1. Внутри чата: максимум 1 `running` job.
2. Глобально: ограничение числа активных генераций (`globalConcurrency`).
3. Во время `running`:
   - либо блокируем ввод
   - либо сохраняем `pending_user_input` (FIFO, configurable).

## 5.4 Политика ошибок
1. Ретраи с ограничением.
2. Если stage окончательно упал:
   - чат уходит в `error`
   - показываем причину + кнопку `Повторить stage`.

---

## 6) Модель данных и миграции (IndexedDB)

## 6.1 Изменения существующих сущностей

### `ChatSession`
Добавить:
- `mode: "direct" | "group" | "adventure"`
- `status: "idle" | "busy" | "error"`
- `activeTurnId?: string`
- `scenarioId?: string` (для `adventure`)
- `updatedAt`

`personaId` в будущем считается legacy-полем для обратной совместимости `direct`.

### `ChatMessage`
Добавить:
- `authorParticipantId?: string`
- `messageType?: "text" | "system" | "narration" | "action_result"`
- `attachments?: ChatAttachment[]`
- `turnId?: string`
- `eventId?: string`

### `PersonaRuntimeState`
Текущий ключ по `chatId` недостаточен для мультиперсон.
Новая модель:
- ключ: `id = ${chatId}:${personaId}`
- поля:
  - `chatId`
  - `personaId`
  - emotion/state метрики

Миграция legacy:
- старую запись проецировать на активную персону чата (для direct).

## 6.2 Новые хранилища

### `chatParticipants`
- `id`
- `chatId`
- `participantType: "user" | "persona" | "narrator"`
- `participantRefId` (personaId или `user`, или `narrator`)
- `displayName`
- `order`
- `isActive`
- `joinedAt`

### `chatEvents`
- `id`
- `chatId`
- `turnId`
- `eventType`
  - `turn_started`
  - `speaker_selected`
  - `arbiter_decision`
  - `message_created`
  - `image_requested`
  - `image_created`
  - `turn_committed`
  - `turn_failed`
- `payload`
- `createdAt`

### `turnJobs`
- см. раздел 5.2.

### `relationshipEdges`
- `id = ${chatId}:${fromPersonaId}:${toPersonaId}`
- `chatId`
- `fromPersonaId`
- `toPersonaId`
- `bondState` (`neutral|interest|romance|partnership|estranged|hostile`)
- `romanticIntent` (`none|curious|attracted|attached|obsessed`)
- `consentAlignment` (`unknown|mutual|one_sided|withdrawn`)
- `trust` (доверие)
- `safety` (ощущение безопасности рядом с человеком)
- `respect` (уважение)
- `affection` (теплота/симпатия)
- `attraction` (влечение, не обязательно романтическое)
- `admiration` (восхищение)
- `gratitude` (благодарность)
- `dependency` (эмоциональная опора/зависимость)
- `jealousy` (ревность)
- `envy` (зависть)
- `irritation` (раздражение)
- `contempt` (презрение)
- `aversion` (неприязнь/отвращение)
- `fear` (опасение перед человеком)
- `tension` (напряжение как итоговый индикатор)
- `intimacy` (степень близости)
- `distancePreference` (желательная дистанция общения)
- `conflictHistoryScore` (след конфликтов)
- `repairReadiness` (готовность к примирению/сближению)
- `lastSignificantEventId`
- `lastBondShiftAt`
- `updatedAt`

Примечание:
- Отношения строго направленные (`A -> B` и `B -> A` независимы).
- Допустимы асимметричные состояния:
  - `A -> B`: высокая теплота/привязанность
  - `B -> A`: высокая неприязнь/отвращение
  Это считается нормальным и должно влиять на тон и последствия диалогов.

### `adventureScenarios`
- `id`
- `title`
- `startContext`
- `initialGoal`
- `narratorStyle`
- `worldTone`
- `createdAt`
- `updatedAt`

### `adventureState`
- `id` (обычно = chatId)
- `chatId`
- `scenarioId`
- `currentScene`
- `sceneObjective`
- `openThreads[]`
- `resolvedThreads[]`
- `timelineSummary`
- `updatedAt`

### `personaSocialSignatures` (опционально, но рекомендовано)
- `personaId`
- `attachmentStyle` (secure/anxious/avoidant/disorganized-like profile)
- `conflictStyle` (avoid/compete/accommodate/collaborate)
- `apologyStyle` (словами/действиями/избегание)
- `forgivenessLatency` (насколько долго отпускает конфликт)
- `boundaryRigidity` (жесткость личных границ)
- `humorUnderStress` (юмор как защита/разрядка/отсутствует)
- `vulnerabilityTolerance` (готовность к откровенности)
- `statusSensitivity` (болезненность к унижению/игнорированию)
- `touchpointNeeds` (частота эмоционального контакта)
- `updatedAt`

---

## 7) Оркестрация ходов

## 7.1 Unified turn pipeline
1. `TurnStart`
2. `Planner`
3. `Decision`
   - group: `Director`
   - adventure: `Narrator/Arbiter`
4. `ActorResponse` (если нужен)
5. `ImageAction` (опционально)
6. `Commit`
7. `Finalize`

## 7.2 Особенности `group`
1. Director выбирает:
   - кто говорит
   - кто отвечает
   - есть ли media action
2. Анти-спам правила:
   - один и тот же персонаж не говорит >2 раз подряд
   - приоритет упомянутых участников

## 7.3 Особенности `adventure`
1. Narrator/Arbiter решает:
   - исход ситуации
   - последствия
   - переход сцены
2. Решение основано на:
   - профили персонажей
   - текущие отношения
   - социальные сигнатуры персонажей
   - краткосрочная память (последние ходы)
   - долгосрочные факты
   - controlled randomness
3. Выход:
   - narrative text
   - side effects (обновления state/relations/memory)
   - optional image requests

## 7.4 Human Relationship Simulation Rules (для `group` и `adventure`)
1. Никакой "идеальной симметрии":
   - эмоциональные векторы у участников могут расходиться радикально.
2. Эмоции меняются не мгновенно:
   - крупные сдвиги требуют значимого события или накопления микро-событий.
3. Память конфликтов и заботы имеет разный период полураспада:
   - у разных персонажей по-разному (через social signature).
4. После конфликта обязательны микропоследствия:
   - холодность, сарказм, дистанция, избегание, попытка восстановить контакт.
5. Примирение не "бесплатно":
   - требуется событие ремонта (`repair event`) и готовность сторон.
6. Эмоциональная инерция:
   - текущая сцена не должна полностью перезаписывать давнюю динамику.
7. Контекст публичности влияет на поведение:
   - в группе персонаж может "держать лицо", а в приватном моменте вести себя иначе.
8. Ревность/зависть/стыд активируются триггерами:
   - игнорирование, сравнение, демонстративная близость, подрыв статуса.
9. Арбитр обязан учитывать последние "эмоциональные долги":
   - кому не ответили, кого унизили, кто поддержал, кто предал.
10. Система должна позволять сложные дуги:
   - от неприязни к уважению, от симпатии к разрыву, от страха к доверию.

## 7.5 Repair and Fracture Events
Добавить типы событий (в `chatEvents`) для живых социальных дуг:
- `support_offered`
- `boundary_crossed`
- `public_humiliation`
- `betrayal_hint`
- `apology_attempted`
- `apology_rejected`
- `trust_repair_step`
- `reconciliation_moment`
- `emotional_withdrawal`
- `status_challenge`
- `romantic_signal`
- `romantic_rejection`
- `relationship_commitment`
- `relationship_breakup`
- `cooling_off_period`

Эти события:
1. Обновляют `relationshipEdges`.
2. Меняют выбор спикеров и тон следующих реплик.
3. В `adventure` влияют на исходы сцен наравне с фактами сюжета.

## 7.6 Romance / Breakups / Human Arcs
Система должна поддерживать естественные дуги:
1. Влюбленность, взаимная симпатия, односторонняя симпатия.
2. Ревность, эмоциональная дистанция, ссоры, расставания.
3. Попытки восстановления связи, повторное сближение или окончательный разрыв.
4. Разные траектории в разных жанрах:
   - мягкая/теплая
   - драматическая
   - мрачная (dark-fantasy)

Принципы моделирования:
1. Переходы состояний не должны быть мгновенными без веских событий.
2. Арбитр должен учитывать историю отношений, а не только последний ход.
3. Одни и те же события по-разному влияют на разных персонажей.
4. Конфликт может усиливать близость или разрушать ее, в зависимости от контекста и сигнатур.

## 7.7 Mature Tone Governance (LLM-only, 18+)
Поддержка зрелой тональности:
1. Допускаются взрослые темы, сложные эмоциональные и мрачные сюжеты.
2. Допускаются жанры от light fantasy до dark-fantasy.
3. Уровень явности описаний должен настраиваться (`fade_to_black` по умолчанию).

Управление границами выполняется только LLM-слоем:
1. Все роли получают единый constitutional prompt профиля произведения
   (тон, жанр, границы допустимого, возрастные ограничения, стиль явности).
   В этот prompt явно включается запрет на non-consensual sexual content.
2. Финальное право решения у `Arbiter`, который:
   - оценивает предложение сцены от других ролей,
   - при необходимости переписывает исход в допустимый вариант,
   - логирует rationale в `chatEvents`.
3. В приложении нет контентного runtime-валидатора; контроль реализуется через:
   - многошаговый LLM-protocol (`propose -> review -> arbitrate -> narrate`),
   - self-check у арбитра перед коммитом хода.
4. Для снижения drift:
   - использовать короткие policy reminders на каждом ходе,
   - периодически пересобирать policy summary для активной сессии.

---

## 8) Изображения между персонами

1. Поддержать attachment как часть message:
   - `type: "image"`
   - `imageAssetId`
   - `caption`
   - `targetParticipantIds?: string[]`
   - `visibility: "all" | "targeted"`
2. Action `send_image` проходит через очередь, чат ждет завершения.
3. Commit атомарный:
   - сообщение + attachment + meta + event log.
4. Лимиты:
   - max изображений за N ходов
   - cooldown per participant

---

## 9) UI/UX план

## 9.1 Навигация режимов
- `Чаты` (direct)
- `Групповые`
- `Приключения`
- `Сессии генератора`

## 9.2 Групповой чат
1. Создание: выбрать 2+ персон.
2. Экран:
   - список участников
   - статусы генерации (`busy stage`)
   - контроль цикла (`Старт`, `Пауза`, `Следующий ход`)

## 9.3 Приключение
1. Создание:
   - выбор участников
   - стартовый сценарий
   - тон/стиль рассказчика
2. Экран:
   - текущая сцена
   - активные цели
   - лента событий (сообщения + narrative/system)
   - мягкие инструменты влияния пользователя:
     - "вмешаться"
     - "изменить тон"
     - "попросить рассказчика ускорить/замедлить темп"

## 9.4 Состояния нагрузки
1. Явный индикатор стадии (`planning`, `text`, `image`, `commit`).
2. Блокировка конфликтующих действий на UI во время busy.

---

## 10) Фазы реализации

## Phase 0 — Подготовка и миграционный каркас
- [x] Добавить новые типы и enum режимов.
- [x] Подготовить DB migration scaffolding.
- [x] Добавить feature flags для `group` и `adventure`.

## Phase 1 — Data layer
- [x] Ввести `chatParticipants`.
- [x] Ввести `turnJobs`.
- [x] Ввести `chatEvents`.
- [x] Перевести `personaStates` на ключ `${chatId}:${personaId}`.
- [x] Добавить `relationshipEdges`.
- [x] Добавить `adventureScenarios` + `adventureState`.

## Phase 2 — Turn Orchestrator + single-flight
- [x] Реализовать state machine хода.
- [x] Реализовать per-chat lock.
- [x] Реализовать global concurrency gate.
- [x] Реализовать retry/failure policy.

## Phase 3 — Group chat MVP
- [x] UI создания группового чата.
- [x] Director selection logic.
- [x] Actor generation pipeline.
- [x] Сообщения с `authorParticipantId`.
- [x] Базовый event log viewer.

## Phase 4 — Image actions in group
- [x] Action `send_image`.
- [x] Attachment rendering.
- [x] Rate limits/cooldowns.
- [x] Atomic commit with events.

## Phase 5 — Adventure mode MVP
- [x] Отдельный раздел в sidebar.
- [x] Создание adventure с выбором сценария.
- [x] Narrator/Arbiter layer.
- [x] Обновление `adventureState` по ходу.
- [x] Narrative events в ленте.
- [x] Профили тональности (`light|balanced|dark`) и политика явности (`fade_to_black` default).
- [x] LLM governance protocol для mature-границ (`propose -> review -> arbitrate`).

## Phase 6 — Stability and quality
- [x] Тесты миграции.
- [x] Тесты очередей и блокировок.
- [x] Тесты race conditions.
- [x] Тесты восстановления после reload.
- [x] Оптимизация контекста (summary policy).

---

## 11) Тестовая матрица

## 11.1 Функциональные
- [ ] Direct chat работает как раньше.
- [ ] Group chat: 3+ персоны корректно чередуются.
- [x] Adventure: рассказчик ведет сцену и обновляет состояние.
- [ ] Image action в group/adventure коммитится корректно.
- [ ] Асимметричные отношения устойчиво воспроизводятся (`A любит`, `B отвергает`).
- [ ] После конфликтов проявляются устойчивые последствия в тоне и выборе действий.
- [ ] Примирение требует цепочки событий, а не одной случайной реплики.
- [ ] Поддерживаются дуги: влюбленность -> конфликт -> расставание -> (опц.) примирение.
- [ ] Разные жанровые профили реально меняют стиль событий и развилки.
- [ ] Mature-границы соблюдаются через LLM-оркестрацию (без app-level модерации).

## 11.2 Нагрузочные
- [x] Одновременные команды не ломают очередь.
- [x] Пока идет генерация, повторный старт хода не запускается.
- [ ] После ошибки можно продолжить диалог.

## 11.3 Data integrity
- [ ] Нет потери существующих чатов после миграции.
- [ ] Нет дубликатов участников/состояний при повторных операциях.
- [ ] Экспорт/импорт сохраняет новые сущности (`participants/events/adventure state`).

---

## 12) Риски и меры

1. Риск: рост сложности orchestration.
   - Мера: строгая state machine + unit tests на переходы.
2. Риск: race conditions в async генерациях.
   - Мера: `turnId` техническая проверка на каждом этапе + per-chat lock.
3. Риск: распухание контекста.
   - Мера: summary windows и event compaction.
4. Риск: деградация UX при busy lock.
   - Мера: прозрачные индикаторы стадии и pending queue.
5. Риск: уход narrative в неприемлемый mature-контент.
   - Мера: multi-pass arbiter self-check + mandatory rationale + fallback narration policy.

---

## 13) Definition of Done (по режимам)

## Group chat DoD
- [ ] Есть создание/редактирование группы.
- [ ] Есть стабильная оркестрация ходов.
- [ ] Есть отправка и показ изображений между участниками.
- [ ] Нет параллельной генерации внутри чата.
- [ ] Межперсонные отношения живые и асимметричные, не "плоские".

## Adventure mode DoD
- [ ] Есть отдельный UI-режим приключений.
- [ ] Narrator/Arbiter ведет сценарий.
- [ ] Решения исходов событий объяснимы в event log.
- [ ] Сцена, цели и нити сюжета обновляются последовательно.
- [ ] Арбитр последовательно учитывает историю отношений и социальные сигнатуры.
- [ ] Реализованы живые романтические и конфликтные дуги (без "плоских" переходов).
- [ ] Темные сценарии поддерживаются, но mature-границы соблюдаются строго.
- [ ] Контроль границ работает LLM-ролями без контентных проверок в приложении.

---

## 14) Журнал прогресса

## Реализовано
- [x] 2026-04-03: Phase 0 каркас в коде.
  - Добавлены типы режимов чатов и статус выполнения хода.
  - Добавлены feature flags в settings (`enableGroupChats`, `enableAdventureMode`).
  - Поднят DB schema version и добавлен migration scaffold.
- [x] 2026-04-03: Phase 1 data-layer.
  - Добавлены object stores: `chatParticipants`, `turnJobs`, `chatEvents`, `relationshipEdges`,
    `adventureScenarios`, `adventureStates`, `personaStatesV2`.
  - Добавлены API-методы dbApi для CRUD/чтения новых сущностей.
  - Для `personaStates` внедрен v2-ключ `${chatId}:${personaId}` с lazy fallback-migration.
- [x] 2026-04-03: Phase 2 turn orchestration.
  - В `sendMessage` добавлены `per-chat lock` (`acquireChatTurnLock` / `releaseChatTurnLock`) и
    защита от параллельного старта хода.
  - Ход теперь ведется как последовательные стадии `turn_start -> planning -> actor_response ->
    image_action -> commit -> finalize` с записью в `turnJobs`.
  - События жизненного цикла хода пишутся в `chatEvents`
    (`turn_started`, `message_created`, `image_requested`, `image_created`, `turn_committed`, `turn_failed`).
  - Генерация изображений переведена в синхронный этап хода: чат остается занятым до завершения
    текста и изображений, UI-ввод блокируется на статусе `busy`.
  - Добавлен базовый `global concurrency gate` (ограничение активных ходов между чатами).
  - Добавлен базовый retry/backoff для retryable LLM-стадий (`actor_response`, prompt synthesis).
- [x] 2026-04-03: Phase 3 (частично) group chat UI + participants.
  - Добавлен UI конструктора группового чата в sidebar (выбор персон, опциональный title).
  - Добавлен store action `createGroupChat` с сохранением `chatParticipants`
    и инициализацией `PersonaRuntimeState` для всех персон группы.
  - В direct chat при создании теперь также сохраняются участники (`user + persona`) в `chatParticipants`.
  - В UI добавлены маркеры режима (`Личный чат` / `Группа` / `Приключение`) и
    базовое отображение состава в деталях чата.
  - Добавлен базовый viewer `chatEvents` во вкладке "События" в деталях чата.
  - В настройках чата добавлены feature-toggle переключатели:
    `enableGroupChats`, `enableAdventureMode`.
- [x] 2026-04-03: Phase 3 (MVP orchestration) director + actor + authorship.
  - В `sendMessage` добавлен шаг `decision` с выбором спикера в `group`:
    приоритет упомянутых участников + anti-repeat через round-robin по последнему `assistant`.
  - Для `group` пишется событие `speaker_selected` в `chatEvents` и метаданные выбора в `turnJobs`.
  - Генерация ответа (`requestChatCompletion`) выполняется от выбранной персоны, а не всегда от active persona.
  - Обновление runtime/memory выполняется по `speakerPersona` (state/memory isolation по personaId в рамках чата).
  - В `ChatMessage` для user/assistant сохраняется `authorParticipantId`; в UI чата добавлена подпись автора сообщения.
- [x] 2026-04-03: Hotfix IndexedDB schema mismatch.
  - Поднят `DB_VERSION` до `7`, чтобы гарантированно доехать миграция создания store на существующих профилях.
  - Мульти-store операции (`clearAllData`, `deletePersona`, `deleteChat`) переведены на schema-tolerant режим:
    транзакция открывается только по реально существующим store, без падения `object store not found`.
- [x] 2026-04-03: Live update `chatEvents` в активном чате.
  - В `sendMessage` добавлен helper append/save событий, который обновляет `activeChatEvents` сразу при каждом событии
    (`turn_started`, `speaker_selected`, `message_created`, `image_*`, `turn_committed`, `turn_failed`),
    без ожидания полного reload артефактов в `finally`.
- [x] 2026-04-03: Director upgraded (LLM policy + guardrails).
  - Добавлен отдельный LLM вызов `requestGroupDirectorDecision` для стадии `decision` в `group`.
  - В `sendMessage` добавлен гибридный режим выбора спикера: LLM Director с fallback на эвристики.
  - Добавлен hard guard против монополии спикера: если один участник уже дал 2+ последних assistant-реплики,
    он временно блокируется для следующего хода при наличии альтернатив.
  - В payload `turnJobs/chatEvents` пишутся `decisionSource`, `blockedParticipantIds`, `antiRepeatGuardApplied`.
- [x] 2026-04-03: Phase 4 (частично) image attachments.
  - Генерация изображений в `sendMessage` теперь сохраняет attachment-структуры (`type=image`, `imageAssetId`, `visibility=all`) прямо в `ChatMessage.attachments`.
  - В `chatEvents.image_created` добавлен `attachmentCount` для трассировки результата image-stage.
  - В `ChatPane` добавлена подгрузка `imageAssetId -> dataUrl` из IndexedDB и рендер attachment-изображений в ленте
    (с обратной совместимостью через `message.imageUrls`).
- [x] 2026-04-03: Phase 4 (частично) image rate limiting.
  - Добавлены базовые ограничения image-action на уровне `sendMessage`:
    cooldown по одному спикеру и лимит количества image-ответов в скользящем окне assistant-ходов.
  - При срабатывании лимита image-блоки снимаются до коммита сообщения, а в `chatEvents` пишется
    `image_requested` с `blocked=true` и причиной блокировки.
- [x] 2026-04-03: Phase 4 закрытие — атомарный commit артефактов хода.
  - В `dbApi` добавлен транзакционный `commitTurnArtifacts` (stores: `chats`, `messages`, `chatEvents`, `turnJobs`).
  - В `sendMessage` переведены критичные точки на атомарный путь:
    `message_created` (user/assistant), финальный `image_created`, `turn_committed`, `turn_failed`.
  - Финал успешного/ошибочного хода теперь пишет `event + turnJob (+chat/+message)` единым commit-шагом.
- [x] 2026-04-03: Phase 5 старт — отдельный раздел `Приключения` в sidebar.
  - Список чатов в sidebar разбит по секциям:
    `Личные чаты`, `Групповые`, `Приключения`.
  - Раздел `Приключения` отображается как самостоятельный блок, независимый от остальных режимов.
- [x] 2026-04-03: Phase 5 — создание adventure с выбором сценария.
  - В store добавлен `createAdventureChat`: создаются `adventureScenario`, `adventureState`,
    `ChatSession(mode=adventure, scenarioId)` и участники (`user`, `narrator`, выбранные персоны).
  - В sidebar добавлен builder `Новое приключение`:
    выбор участников, название, стартовый контекст, цель сцены, стиль рассказчика и `worldTone`.
  - При создании приключения выполняется инициализация persona state по участникам и стартовое narration-сообщение.
- [x] 2026-04-03: Phase 5 — Narrator/Arbiter + state progression.
  - Добавлен LLM слой `requestAdventureArbiterDecision` (JSON-решение сцены, нитей и narrative текста).
  - В `sendMessage` для `mode=adventure` добавлен отдельный pipeline:
    `planning -> arbiter decision -> narration message -> commit`.
  - На каждом adventure-ходе обновляется `adventureState`
    (`currentScene`, `sceneObjective`, `openThreads`, `resolvedThreads`, `timelineSummary`).
  - В ленту событий пишется `arbiter_decision`, а в сообщения добавляется narration-реплика рассказчика.
- [x] 2026-04-03: Phase 5 — tone/explicitness profiles + governance protocol.
  - В сценарий приключения добавлена политика явности `explicitnessPolicy`
    (`fade_to_black|balanced|explicit`) с default=`fade_to_black`.
  - Builder приключения в sidebar расширен выбором политики явности.
  - Arbiter переведен на многошаговый LLM-protocol:
    `propose -> review -> arbitrate` с финальным `arbiter_decision` payload.
- [x] 2026-04-03: Phase 6 — тестовый контур стабильности и миграций.
  - Подключены `vitest` + `fake-indexeddb`, добавлен test setup для Node-окружения.
  - Добавлены тесты миграции/нормализации legacy-данных (`chats`, `personaStates -> personaStatesV2`).
  - Добавлены интеграционные тесты очередей/блокировок, race-condition и восстановления после reload.
  - По результату тестов исправлен неатомарный per-chat lock (транзакционный lock/release в IndexedDB).
- [x] 2026-04-03: Phase 6 — summary policy и контекстная компактификация.
  - В `personaDynamics` добавлены `buildConversationSummary` и ограничение длины `buildRecentMessages`.
  - В `sendMessage` подключен summary window (`historical summary + recent window`) при запросе actor-response.
  - В `ChatCompletionContext` и `buildSystemPrompt` добавлен блок `DIALOG SUMMARY`.
  - Добавлены unit-тесты `context.summary.test.ts` на компактификацию и bounded-контекст.

## Выявлено в процессе (обязательно фиксировать)
- [x] 2026-04-03: выявлен race-condition в `acquireChatTurnLock` при параллельных `sendMessage`.
  - Причина: неатомарный путь `read -> write` для lock в IndexedDB позволял двум ходам стартовать одновременно.
  - Фикс: перевод `acquireChatTurnLock`/`releaseChatTurnLock` на `readwrite` транзакции `chats` с check+put в одном tx.

## Решения/компромиссы
- [x] 2026-04-03: Чаты для персоны загружаются не только по `chats.personaId`,
  но и по участию в `chatParticipants` (для групповых чатов). Это не ломает legacy direct-чаты
  и позволяет видеть группы у всех включенных персон.
- [x] 2026-04-03: Director в Phase 3 реализован как эвристический MVP (mention-priority + round-robin),
  а не как отдельный LLM-агент. Это снижает сложность и риски на текущем этапе; LLM-Director выносится в следующий шаг.
- [x] 2026-04-03: Вне исходного плана Phase 3 добавлена адресная загрузка `PersonaRuntimeState`
  для active persona (`getPersonaState(chatId, personaId)`), чтобы в групповом чате UI не показывал состояние чужой персоны.

## Следующие шаги (оперативный короткий список)
- [ ] Утвердить этот документ (v1.0.0)
- [x] Phase 6: тесты миграции и data integrity (IndexedDB/новые сущности).
- [x] Phase 6: тесты очередей/блокировок и race conditions.
- [x] Phase 6: summary policy и тесты контекстной компактификации.
