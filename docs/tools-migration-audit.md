# Tool Calling Migration Audit (LLM I/O only)

Date: 2026-04-10  
Project: `tg-gf`  
Intent: перевести взаимодействие с моделями на native tool calling (чаты, оркестратор, image generation planning), убрать системные `<...></...>` блоки как основной контракт.

## 0) Текущий реестр tools (реализовано)

Базовый реестр и расширяемая структура вынесены в отдельный модуль:

```
src/tooling/
  index.ts
  registry/
    index.ts
    types.ts
    common.ts
    chat.ts
    group.ts
    image.ts
```

### 0.1 Единый реестр

`src/tooling/registry/index.ts` содержит:

1. `TOOL_REGISTRY` — список зарегистрированных tools с `key/task/toolName/owner/description`.
2. `getToolRegistryEntry(toolName)` — быстрый lookup по имени tool.
3. Экспорт фабрик конфигов runtime (`create*ToolConfig`).

### 0.2 Разделение по доменам

1. `chat.ts` — `emit_chat_turn`.
2. `group.ts` — `select_group_turn_action`, `emit_group_persona_turn`.
3. `image.ts` — `emit_themed_comfy_prompt`, `emit_comfy_prompts_from_description`.
4. `common.ts` — общие парсеры/нормализация payload для всех tool-веток.

### 0.3 Подключение в runtime

1. `src/lmstudio.ts` использует фабрики из реестра для 1:1 chat и image tools.
2. `src/groupOrchestrator.ts` использует фабрики из реестра для group tools.
3. Inline-схемы/валидаторы из этих мест удалены в пользу registry-driven конфигурации.

## 1) Что именно мигрируем

Только слой **LLM input/output protocol**:

1. 1:1 chat response format.
2. Group orchestrator decision format.
3. Group persona response format.
4. Image description -> comfy prompts format.

Бизнес-логика (`store/groupStore/comfy/db`) остается, меняется только способ получения валидной структуры от модели.

---

## 2) Почему это нужно сейчас

Сейчас контракт держится на текстовых/теговых блоках и пост-парсинге:

1. `src/messageContent.ts:326` (`splitAssistantContent`) парсит `<comfyui_prompt>`, `<persona_control>` и т.п.
2. `src/groupOrchestrator.ts:80` + `:453` (`parseJsonObjectFromText`) парсит решение оркестратора из свободного текста.
3. `src/lmstudio.ts:1079` (`generateComfyPromptsFromImageDescription`) требует tag-block формат и fallback-очистку.
4. `src/store.ts:1046+` и `src/groupStore.ts:1772+` вынуждены защищаться от невалидных форматов.

Нужный эффект от tool calling:

1. Аргументы сразу schema-валидируемы.
2. При ошибке модель получает структурированную ошибку и перегенерирует вызов.
3. Меньше regex/heuristics и меньше silent-fail кейсов.

---

## 3) Текущие точки интеграции (где внедрять)

### 3.1 Общий шлюз

`src/lmstudio.ts`:

1. `GenericChatRequest` (`:438`) пока без tools/schema.
2. `requestProviderChatCompletion` (`:536`) отправляет plain chat payload.
3. `requestGenericChatCompletion` (`:635`) не умеет tool loop.

Это главный entrypoint для миграции.

### 3.2 Оркестратор

1. `requestLlmOrchestratorDecision` в `src/groupOrchestrator.ts:361`.
2. Сейчас: free-text JSON -> `parseJsonObjectFromText` (`:453`).

### 3.3 Persona response (1:1 и group)

1. 1:1: `requestChatCompletion` в `src/lmstudio.ts:651`.
2. Group: `requestLlmPersonaMessage` в `src/groupOrchestrator.ts:483`.
3. Сейчас оба сценария завязаны на `splitAssistantContent`.

### 3.4 Image planning

1. `generateComfyPromptsFromImageDescription` в `src/lmstudio.ts:1079`.
2. Сейчас контракт: `<comfyui_prompt>...</comfyui_prompt>` + fallback.

---

## 4) Критичные ограничения, которые надо учесть до начала

### 4.1 `responseId` — это transport metadata, не tool payload

`responseId` приходит от провайдера (`src/lmstudio.ts:588`, `:630`) и используется в цепочке `previousResponseId` (`src/store.ts:1106`, `src/groupStore.ts:127`).

Требование:

1. Не включать `responseId` в JSON-аргументы tool-вызова.
2. Возвращать `responseId` отдельно, как часть runtime-результата запроса.

### 4.2 Нужен provider capability matrix

Сейчас в проекте три провайдера маршрутизации (`lmstudio`, `openrouter`, `huggingface`) с разными endpoint-путями (`src/lmstudio.ts:554`, `:593`).

Требование:

1. Явно проверить поддержку `tools/tool_choice` для каждого провайдера.
2. Реализовать runtime probe + кэш capability.
3. Для провайдера без tools использовать контролируемый legacy fallback.

### 4.3 Нельзя сразу удалять legacy parser

Исторические сообщения в БД и UI все еще читаются через `splitAssistantContent` (`src/components/ChatPane.tsx:314`, `src/store.ts:152`).

Требование:

1. Сначала мигрировать write-path.
2. Потом ввести read compatibility layer.
3. Только после backfill/TTL удалять legacy parsing.

---

## 5) Целевой протокол: tool loop с retry

### 5.1 Базовый цикл

1. Отправляем модели `messages + tools`.
2. Ждем `tool_call`.
3. Валидируем `tool_call.arguments` по строгой схеме.
4. Если invalid:
   - формируем `tool_result` с ошибкой валидации,
   - отправляем обратно модели,
   - просим исправить tool arguments.
5. Если valid:
   - возвращаем в app типизированный payload.

Рекомендуемо ограничить `maxRepairAttempts` (например 2-3).

### 5.2 Возврат из runtime

Результат tool runtime должен быть двухслойным:

1. `payload` — валидированный объект из tool arguments.
2. `meta` — transport metadata (`responseId`, provider, model, repairAttempts, source).

Это снимает смешение бизнес-полей и транспортных идентификаторов.

### 5.3 Режимы выполнения

1. `tool_required`: для критичных путей, где модель обязана вернуть tool call.
2. `tool_preferred`: постепенный rollout, с fallback на legacy parser.
3. `legacy_only`: провайдер не поддерживает tools.

---

## 6) Минимальный набор tools (v1)

1. `emit_chat_turn`
   - `visibleText`
   - `personaControl`
   - `comfyPrompts[]`
   - `imageDescriptions[]`

2. `select_group_turn_action`
   - `status`
   - `speakerPersonaId`
   - `waitForUser`
   - `waitReason`
   - `reason`
   - `intent`
   - `userContextAction`

3. `emit_group_persona_turn`
   - как `emit_chat_turn` (без `responseId`)

4. `convert_scene_to_comfy_prompts`
   - `prompts[]`
   - `sceneType`
   - `participants`
   - `warnings[]`

---

## 7) Реализация в текущем коде (пошагово)

### Phase A0: Provider capability layer

1. Добавить `ProviderToolCapabilities` в `src/lmstudio.ts`.
2. Реализовать probe/cached resolution:
   - поддерживает ли endpoint `tools`;
   - поддерживает ли `tool_choice=required`.
3. Добавить telemetry для решения режима (`tool_required/tool_preferred/legacy_only`).

### Phase A: Tool runtime core (`lmstudio.ts`)

1. Расширить `GenericChatRequest`:
   - `tools`
   - `toolChoice`
   - `maxRepairAttempts`
2. Добавить `ToolDefinition`, `ToolCallValidationResult`, `ToolRuntimeMeta` типы.
3. Реализовать `requestGenericChatCompletionWithTools(...)`:
   - provider call
   - extraction tool call(s)
   - schema validation
   - repair loop
   - возврат `{ payload, meta }`.

### Phase B: Перевод критичных вызовов

1. `requestLlmOrchestratorDecision` -> `select_group_turn_action`.
2. `requestChatCompletion` -> `emit_chat_turn`.
3. `requestLlmPersonaMessage` -> `emit_group_persona_turn`.
4. `generateComfyPromptsFromImageDescription` -> `convert_scene_to_comfy_prompts`.

### Phase C: Compatibility + cleanup

1. Legacy tag-parser оставить как fallback path за feature flag.
2. Добавить read compatibility для исторических сообщений.
3. После backfill/TTL удалить fallback полностью.

### Phase D: Rollout gates

1. Shadow mode для сравнения tool payload vs legacy parse.
2. Canary rollout по проценту сессий.
3. Полное включение после прохождения метрик качества.

---

## 8) Что НЕ нужно менять

1. `src/store.ts` / `src/groupStore.ts` бизнес-сценарии и state transitions.
2. `src/comfy.ts` execution, queue, polling, metadata extraction.
3. `src/db.ts`, backup, Google Drive sync, UI.

Их нужно только подключить к новому типизированному LLM output, не переписывать.

---

## 9) Валидация и retry policy

Рекомендуемая стратегия:

1. `temperature` ниже для tool responses (например 0.2-0.5).
2. `toolChoice = required` для критичных функций (orchestrator, scene->prompts), если capability подтверждена.
3. На ошибке валидации отдавать модели краткий machine-readable feedback:
   - field path
   - expected type/range
   - received value
4. Лимит попыток:
   - 2 для оркестратора,
   - 2-3 для persona turn,
   - 3 для image planning.
5. Если лимит исчерпан:
   - fallback на deterministic/legacy path,
   - логировать telemetry событие.

---

## 10) Telemetry (обязательная)

Минимальный набор событий:

1. `llm_tool_mode_selected` (provider, task, mode).
2. `llm_tool_validation_failed` (task, fieldPath, attempt).
3. `llm_tool_repair_succeeded` (task, attemptsUsed).
4. `llm_tool_repair_exhausted` (task, attemptsUsed, fallbackMode).
5. `llm_legacy_fallback_used` (task, reason).

KPI rollout:

1. validation fail rate
2. repair success rate
3. fallback rate
4. empty/invalid persona speech rate
5. orchestrator decision reject rate

---

## 11) План совместимости и backfill

1. Новый write-path сохраняет структурированные поля (`comfyPrompts`, `comfyImageDescriptions`, `personaControlRaw`) как primary source.
2. Старый контент с тегами продолжает читаться через `splitAssistantContent` только как compatibility read-path.
3. Добавить offline backfill job (опционально) для нормализации старых сообщений.
4. Удаление `splitAssistantContent` как primary parser возможно только после:
   - стабилизации write-path;
   - снижения fallback rate;
   - завершения backfill/TTL окна.

---

## 12) Приоритеты

1. Critical: `select_group_turn_action`
2. High: `emit_chat_turn`, `emit_group_persona_turn`
3. High: `convert_scene_to_comfy_prompts`
4. Medium: вторичные генераторы (`generateThemedComfyPrompt`, persona drafts, summary JSON) после стабилизации core loop

---

## 13) Definition of Done

1. Все 4 критичных потока работают через typed tool payload.
2. Для провайдеров без tools корректно работает controlled fallback.
3. `responseId` стабильно передается как transport metadata и не попадает в domain payload.
4. Ошибки валидации и fallback полностью наблюдаемы в telemetry.
5. Legacy parser больше не является primary write-path.

---

## 14) Итог

Да, проекту нужен этот рефактор:  
**текстовые `<...></...>` контракты -> tool calling + strict validation + repair loop**.

Это точечный I/O рефактор LLM-слоя, но его надо делать с тремя guardrails:

1. capability matrix по провайдерам,
2. separation transport metadata (`responseId`) от бизнес-payload,
3. управляемая legacy совместимость и backfill.
