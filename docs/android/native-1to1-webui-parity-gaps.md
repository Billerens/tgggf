# Android Native 1:1 vs WebUI — Расхождения для фикса

Дата фиксации: 2026-04-19  
Цель: единый список найденных расхождений между WebUI-путем 1:1 и Android native 1:1, чтобы идти по нему при фиксе и повторной сверке.

## Как читать

- `P1` — критично для parity поведения.
- `P2` — заметное расхождение, влияет на результат/качество.
- `P3` — локальное/UI-метаданные, но лучше выровнять.
- Чекбокс `- [ ]` закрывается после фикса и повторной проверки.

## Найденные расхождения

### 1) [P1] Системный промпт 1:1 сильно отличается (Web богаче, Native упрощен)

- [ ] Выровнять системный промпт Native 1:1 с Web-логикой (hard constraints, image policy, memory policy, persona control policy, influence rules и пр.).
- В Web используется большой `buildSystemPrompt(...)` с обширными ограничениями и политиками.
- В Native используется более короткий `buildOneToOneSystemPrompt(...)` (состояние + память + summary + формат JSON).

Refs:
- `D:\Projects\tgggf\src\lmstudio.ts:286`
- `D:\Projects\tgggf\src\lmstudio.ts:308`
- `D:\Projects\tgggf\src\lmstudio.ts:447`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\NativeLlmClient.kt:1781`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\NativeLlmClient.kt:1800`

---

### 2) [P1] Разный failover при `comfy_image_description` contract invalid

- [ ] Выровнять поведение: в Web это мягкий fallback без падения всего turn, в Native сейчас исключение может увести job в retry/terminal fail.
- Web ловит contract error и завершает image-путь без зависания turn.
- Native при `contract_invalid:*` поднимает исключение, которое попадает в retry/terminal pipeline job.

Refs:
- `D:\Projects\tgggf\src\store.ts:1415`
- `D:\Projects\tgggf\src\store.ts:1427`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\NativeLlmClient.kt:2796`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:301`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:268`

---

### 3) [P1] Разный приоритет источника image prompt (descriptions vs prompts)

- [ ] Выровнять логику выбора источника prompt.
- Web: если есть `comfyImageDescriptions`, prompts пересобираются из descriptions.
- Native: descriptions используются только если `comfyPrompts` пусты.

Refs:
- `D:\Projects\tgggf\src\store.ts:1367`
- `D:\Projects\tgggf\src\store.ts:1403`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:717`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:720`

---

### 4) [P1] В native 1:1 не прокидываются `styleReferenceImage` и `chatStyleStrength`

- [ ] Добавить в native 1:1 image-generation путь использование style reference и style strength как в Web.
- Web подставляет `styleReferenceImage` и `styleStrength` условно по типу сцены.
- Native 1:1 вызывает `runBaseGeneration(...)` без этих полей.

Refs:
- `D:\Projects\tgggf\src\store.ts:1443`
- `D:\Projects\tgggf\src\store.ts:1453`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:771`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\ComfyNativeClient.kt:87`

---

### 5) [P2] Упрощенная memory extraction в Native

- [ ] Выровнять набор экстракторов фактов/предпочтений/целей.
- Web использует расширенные паттерны (`extractFactCandidates`, `extractPreferenceCandidates`, `extractGoalCandidates`).
- Native использует более узкий regex-набор.

Refs:
- `D:\Projects\tgggf\src\personaDynamics.ts:588`
- `D:\Projects\tgggf\src\personaDynamics.ts:653`
- `D:\Projects\tgggf\src\personaDynamics.ts:676`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:1374`

---

### 6) [P2] Разный memory ranking/reconcile (freshness/decay не совпадает)

- [ ] Выровнять ranking памяти по freshness/decay.
- Web: `rankByFreshness(...)` учитывает `decayDays`.
- Native: сортировка по `salience`, затем `updatedAt`.

Refs:
- `D:\Projects\tgggf\src\personaDynamics.ts:736`
- `D:\Projects\tgggf\src\personaDynamics.ts:764`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:1484`

---

### 7) [P2] Fallback-эволюция state отличается

- [ ] Выровнять fallback state evolution.
- Web: `evolvePersonaState(...)` через `calculateStateEvolution(...)`.
- Native: fallback в основном про `engagement/energy`.

Refs:
- `D:\Projects\tgggf\src\store.ts:1531`
- `D:\Projects\tgggf\src\personaDynamics.ts:319`
- `D:\Projects\tgggf\src\personaBehaviors.ts:112`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:1144`

---

### 8) [P2] Summary pipeline похож, но не 1:1 по инструкциям и fallback

- [ ] Выровнять текст summary-инструкций и fallback-поведение.
- Разница в системном промпте summary (Web строже по ряду правил формулировки).
- Fallback:
  - Web при parse-fail в `legacy_only` возвращает `existing`.
  - Native при exception возвращает `null` (патч не применяется).

Refs:
- `D:\Projects\tgggf\src\lmstudio.ts:1757`
- `D:\Projects\tgggf\src\lmstudio.ts:1800`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\NativeLlmClient.kt:544`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\NativeLlmClient.kt:612`

---

### 9) [P3] `relationshipProposal*` поля сообщения не выставляются в Native assistant message

- [ ] Заполнять `relationshipProposalType/Stage/Status` в native assistant message (или гарантировать единый fallback во всех UI-местах).
- Web сохраняет эти поля напрямую в message.
- Native сохраняет `personaControlRaw`, но не дублирует proposal-поля.
- В части UI есть fallback из `personaControlRaw`, но не везде.

Refs:
- `D:\Projects\tgggf\src\store.ts:1295`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\OneToOneChatNativeExecutor.kt:675`
- `D:\Projects\tgggf\src\components\ChatPane.tsx:388`
- `D:\Projects\tgggf\src\components\ChatDetailsModal.tsx:416`

## Что уже совпадает (для ориентира)

- [x] Android enqueue-flow: `job per user message`, id формата `one_to_one_chat:<chatId>:<userMessageId>`.
- [x] Context sync перед enqueue (`settings/personas/chats/messages/personaStates/memories/imageAssets`).
- [x] Scheduler/recovery hooks подключены (`ForegroundSyncService`, `SchedulerWorker`, `BootRecoveryReceiver`).
- [x] Delta pull/ack + обработка terminal fail в web mobile worker.

Refs:
- `D:\Projects\tgggf\src\store.ts:1212`
- `D:\Projects\tgggf\src\features\mobile\oneToOneNativeRuntime.ts:128`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\SchedulerWorker.kt:20`
- `D:\Projects\tgggf\apps\mobile\android\app\src\main\java\com\tggf\app\localapi\BootRecoveryReceiver.kt:23`
- `D:\Projects\tgggf\src\features\mobile\useOneToOneBackgroundWorker.ts:138`
- `D:\Projects\tgggf\src\features\mobile\useOneToOneBackgroundWorker.ts:172`

## Рекомендуемый порядок фиксов

1. Системный промпт parity (`P1`).
2. Image flow parity (`P1`: contract fallback, prompt source precedence, style reference/strength).
3. Memory/state parity (`P2`: extraction, ranking, fallback evolution).
4. Summary parity + fallback унификация (`P2`).
5. Message metadata parity для relationship proposal (`P3`).

