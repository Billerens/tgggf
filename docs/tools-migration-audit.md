# Tool Calling Migration Audit (LLM I/O only)

Date: 2026-04-10  
Project: `tg-gf`  
Intent: перевести взаимодействие с моделями на native tool calling (чаты, оркестратор, image generation planning), убрать системные `<...></...>` блоки как основной контракт.

## 1) Что именно мигрируем

Только слой **LLM input/output protocol**:

1. 1:1 chat response format.
2. Group orchestrator decision format.
3. Group persona response format.
4. Image description -> comfy prompts format.

Бизнес-логика (store/groupStore/comfy/db) остается, меняется только способ получения валидной структуры от модели.

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

## 3.1 Общий шлюз

`src/lmstudio.ts`:

1. `GenericChatRequest` (`:438`) пока без tools/schema.
2. `requestProviderChatCompletion` (`:536`) отправляет plain chat payload.
3. `requestGenericChatCompletion` (`:635`) не умеет tool loop.

Это главный entrypoint для миграции.

## 3.2 Оркестратор

1. `requestLlmOrchestratorDecision` в `src/groupOrchestrator.ts:361`.
2. Сейчас: free-text JSON -> `parseJsonObjectFromText` (`:453`).

## 3.3 Persona response (1:1 и group)

1. 1:1: `requestChatCompletion` в `src/lmstudio.ts:651`.
2. Group: `requestLlmPersonaMessage` в `src/groupOrchestrator.ts:483`.
3. Сейчас оба сценария завязаны на `splitAssistantContent`.

## 3.4 Image planning

1. `generateComfyPromptsFromImageDescription` в `src/lmstudio.ts:1079`.
2. Сейчас контракт: `<comfyui_prompt>...</comfyui_prompt>` + fallback.

---

## 4) Целевой протокол: tool loop с retry

## 4.1 Базовый цикл

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

## 4.2 Минимальный набор tools

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

3. `emit_group_persona_turn`
   - как `emit_chat_turn` + `responseId` (опционально)

4. `convert_scene_to_comfy_prompts`
   - `prompts[]`
   - `sceneType`
   - `participants`
   - `warnings[]`

---

## 5) Реализация в текущем коде (пошагово)

## Phase A: Tool runtime core (lmstudio.ts)

1. Расширить `GenericChatRequest`:
   - `tools`
   - `toolChoice`
   - `maxRepairAttempts`
2. Добавить `ToolDefinition` и `ToolCallValidationResult` типы.
3. Реализовать `requestGenericChatCompletionWithTools(...)`:
   - provider call
   - extraction tool_call
   - schema validation
   - repair loop

## Phase B: Перевод критичных вызовов

1. `requestLlmOrchestratorDecision` -> `select_group_turn_action`.
2. `requestChatCompletion` -> `emit_chat_turn`.
3. `requestLlmPersonaMessage` -> `emit_group_persona_turn`.
4. `generateComfyPromptsFromImageDescription` -> `convert_scene_to_comfy_prompts`.

## Phase C: Cleanup

1. Удалить tag-based контракт как primary path.
2. Оставить временный fallback на старый parser за feature flag.
3. После стабилизации удалить fallback полностью.

---

## 6) Что НЕ нужно менять

1. `src/store.ts` / `src/groupStore.ts` бизнес-сценарии и state transitions.
2. `src/comfy.ts` execution, queue, polling, metadata extraction.
3. `src/db.ts`, backup, Google Drive sync, UI.

Их нужно только подключить к новому типизированному LLM output, не переписывать.

---

## 7) Валидация и retry policy

Рекомендуемая стратегия:

1. `temperature` ниже для tool responses (например 0.2-0.5).
2. `toolChoice = required` для критичных функций (orchestrator, scene->prompts).
3. На ошибке валидации отдавать модели краткий machine-readable feedback:
   - field path
   - expected type/range
   - received value
4. Лимит попыток:
   - 2 для оркестратора,
   - 3 для image planning.
5. Если лимит исчерпан:
   - fallback на deterministic path,
   - логировать telemetry событие.

---

## 8) Приоритеты

1. Critical: `select_group_turn_action`
2. High: `emit_chat_turn`, `emit_group_persona_turn`
3. High: `convert_scene_to_comfy_prompts`
4. Medium: вторичные генераторы (themed prompt/look/persona drafts) после стабилизации core loop

---

## 9) Итог

Да, проекту нужен именно такой рефактор:  
**текстовые `<...></...>` контракты -> tool calling + strict validation + repair loop**.

Это точечный I/O рефактор LLM-слоя, а не перенос бизнес-логики в “tools”.
