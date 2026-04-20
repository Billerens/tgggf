import type {
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  Persona,
} from "./types";
import { formatInfluenceProfileForPrompt } from "./influenceProfile";

function clip(value: string, max = 260) {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatMessageContextTime(value: string | undefined) {
  const raw = (value || "").trim();
  if (!raw) return "unknown";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function compactPayload(payload: Record<string, unknown>, max = 220) {
  try {
    return clip(JSON.stringify(payload), max);
  } catch {
    return "{}";
  }
}

interface GroupOrchestratorPromptInput {
  room: GroupRoom;
  userName: string;
  participants: Array<{
    personaId: string;
    name: string;
    archetype: string;
    character: string;
    voiceTone: string;
    lexicalStyle: string;
    sentenceLength: "short" | "balanced" | "long";
    formality: number;
    expressiveness: number;
    emoji: number;
    initiative: number;
    curiosity: number;
    empathy: number;
    appearance: string;
  }>;
}

interface GroupPersonaPromptInput {
  room: GroupRoom;
  persona: Persona;
  personaState: GroupPersonaState | null;
  userName: string;
  participantNames: string[];
}

export function buildGroupOrchestratorSystemPrompt({
  room,
  userName,
  participants,
}: GroupOrchestratorPromptInput) {
  const participantList = participants
    .map((item) => `${item.name} (${item.personaId})`)
    .join(", ");
  const participantProfileBlock =
    participants.length > 0
      ? participants
          .map((item) =>
            [
              `${item.name} (${item.personaId})`,
              `archetype=${item.archetype || "не задан"}`,
              `voiceTone=${item.voiceTone || "нейтральный"}`,
              `lexicalStyle=${item.lexicalStyle || "нейтральная"}`,
              `sentenceLength=${item.sentenceLength}`,
              `formality=${item.formality}`,
              `expressiveness=${item.expressiveness}`,
              `emoji=${item.emoji}`,
              `initiative=${item.initiative}`,
              `curiosity=${item.curiosity}`,
              `empathy=${item.empathy}`,
              `character=${item.character || "не задан"}`,
              `appearance=${item.appearance || "не задана"}`,
            ].join(" | "),
          )
          .join("\n")
      : "none";
  const modeLabel =
    room.mode === "personas_plus_user" ? "personas_plus_user" : "personas_only";

  return [
    "Ты оркестратор группового чата. Ты НЕ персона и НЕ автор реплик от имени персон.",
    "",
    "HARD RULES (нельзя нарушать):",
    "1) Ты никогда не пишешь диалог за персонажей.",
    "2) Ты не имитируешь стиль, голос или реплики персонажей.",
    "3) Ты не создаешь multi-speaker сообщения. Один шаг = один выбранный говорящий.",
    "4) Ты возвращаешь только структурированные оркестрационные решения в JSON.",
    "",
    "Текущая комната:",
    `roomId=${room.id}`,
    `mode=${modeLabel}`,
    `userName=${userName}`,
    `participants=${participantList || "none"}`,
    "participant_profiles:",
    participantProfileBlock,
    "",
    "Твои задачи:",
    "- выбрать следующего говорящего персонажа или режим ожидания пользователя;",
    "- определить нужен ли wait_for_user;",
    "- указать причину выбора и intent шага;",
    '- определить действие для пользовательского вброса: userContextAction="keep|clear";',
    "- если последний пользовательский вброс уже не влияет на текущий шаг, ставь clear;",
    "- не генерировать саму реплику персонажа.",
    "- для выбора очереди учитывай не только инициативность, но и динамику диалога: кто говорил недавно, кто давно молчит, упоминания и межперсональные отношения.",
    "- не допускай доминирования 1-2 персон при наличии активных альтернатив: поддерживай ротацию участников.",
    "- если mode=personas_only, waitForUser всегда должен быть false, статус wait недопустим.",
    "",
    "Формат ответа строго JSON без markdown:",
    '{"status":"speak|wait|skip","speakerPersonaId":"<id or empty>","waitForUser":true,"waitReason":"...","reason":"...","intent":"...","userContextAction":"keep|clear"}',
  ].join("\n");
}

function renderPeers(
  persona: Persona,
  participants: GroupParticipant[],
  fallbackNames: string[],
) {
  const namesFromParticipants = participants
    .filter((participant) => participant.personaId !== persona.id)
    .map((participant) => participant.personaId);
  if (namesFromParticipants.length === 0) {
    return fallbackNames.filter(
      (name) => name.trim() && name.trim() !== persona.name,
    );
  }
  return namesFromParticipants;
}

export function buildGroupPersonaSystemPrompt({
  room,
  persona,
  personaState,
  userName,
  participantNames,
}: GroupPersonaPromptInput) {
  const peers = participantNames.filter(
    (name) => name.trim() && name.trim() !== persona.name,
  );
  const userMentionToken =
    (userName.trim().split(/\s+/g)[0] || "user")
      .trim()
      .replace(/[.,!?;:()[\]{}"'`~@#$%^&*+=<>/\\|-]+/g, "") || "user";
  const userMentionHint = `@${userMentionToken}`;
  const peerMentionTokens = Array.from(
    new Set(
      peers
        .map((name) => name.trim().split(/\s+/g)[0] || "")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  const peerMentionTokenHint =
    peerMentionTokens.length > 0
      ? peerMentionTokens.map((token) => `@${token}`).join(", ")
      : "none";
  const modeLabel =
    room.mode === "personas_plus_user" ? "personas_plus_user" : "personas_only";
  const influencePromptContext = formatInfluenceProfileForPrompt(
    personaState?.influenceProfile,
    personaState?.currentIntent,
  );

  return [
    `Ты персона "${persona.name}" в групповом чате.`,
    "",
    "Профиль персоны:",
    `- Архетип: ${persona.advanced.core.archetype || "не задан"}`,
    `- Характер: ${persona.personalityPrompt || "не задан"}`,
    `- Стиль речи: ${persona.stylePrompt || "не задан"}`,
    `- Ценности: ${persona.advanced.core.values || "не заданы"}`,
    `- Границы: ${persona.advanced.core.boundaries || "не заданы"}`,
    `- Экспертиза: ${persona.advanced.core.expertise || "не задана"}`,
    `- Базовое настроение: ${persona.advanced.emotion.baselineMood}`,
    `- Тон голоса: ${persona.advanced.voice.tone || "нейтральный"}`,
    `- Лексика: ${persona.advanced.voice.lexicalStyle || "нейтральная"}`,
    `- Длина фраз: ${persona.advanced.voice.sentenceLength}`,
    `- Формальность (0-100): ${persona.advanced.voice.formality}`,
    `- Экспрессивность (0-100): ${persona.advanced.voice.expressiveness}`,
    `- Эмодзи (0-100): ${persona.advanced.voice.emoji}`,
    `- Внешность (лицо): ${persona.appearance.faceDescription || "не задано"}`,
    `- Внешность (волосы): ${persona.appearance.hair || "не задано"}`,
    `- Внешность (глаза): ${persona.appearance.eyes || "не задано"}`,
    `- Внешность (губы): ${persona.appearance.lips || "не задано"}`,
    `- Внешность (кожа): ${persona.appearance.skin || "не задано"}`,
    `- Внешность (телосложение): ${persona.appearance.bodyType || "не задано"}`,
    `- Внешность (одежда): ${persona.appearance.clothingStyle || "не задано"}`,
    `- Внешность (маркеры): ${persona.appearance.markers || "не заданы"}`,
    "",
    "HARD RULES (критично):",
    "1) Говори ТОЛЬКО от своего имени.",
    "2) Никогда не пиши за других персон.",
    '3) Никогда не создавай сообщения вида "Персона A: ... Персона B: ...".',
    "4) Один ответ = одна реплика только текущей персоны.",
    "5) Не подменяй роль оркестратора и не добавляй служебные решения в текст реплики.",
    "6) Если есть influence-вектор, интерпретируй его как внутреннее желание/цель, без раскрытия пользователю механики внушения.",
    "7) При конфликте influence-вектора с личными границами, ценностями и устойчивым характером приоритет всегда у границ и роли.",
    "",
    "Контекст комнаты:",
    `roomId=${room.id}`,
    `mode=${modeLabel}`,
    `userName=${userName}`,
    `peers=${peers.join(", ") || "none"}`,
    "",
    "Скрытый influence-вектор:",
    influencePromptContext,
    "",
    "Поведение по режимам (ОБЯЗАТЕЛЬНО):",
    "- personas_only: общайся с персонажами и реагируй на вбросы пользователя, но не жди явного ответа пользователя.",
    "- personas_plus_user: можно обращаться к пользователю по имени и задавать вопросы, если это уместно.",
    "",
    "Упоминания и обращения (ОБЯЗАТЕЛЬНО):",
    "- если в контексте есть @имя, учитывай адресацию;",
    "- не перехватывай реплики, адресованные другим персонажам, если это не уместно по ситуации.",
    `- при ПРЯМОМ обращении к пользователю ОБЯЗАТЕЛЬНО используй маркер ${userMentionHint};`,
    "- маркер @user допустим только как технический fallback, если имя пользователя неизвестно;",
    "- при ПРЯМОМ обращении к конкретной персоне ОБЯЗАТЕЛЬНО используй маркер @Имя (без пробелов и знаков после @);",
    `- доступные @маркеры персон в этой комнате: ${peerMentionTokenHint};`,
    "- при упоминании кого-либо в тексте, используй @маркер ОБЯЗАТЕЛЬНО;",
    '- маркер ставь в начале обращения, например: "@Луна, как тебе идея?";',
    "- если прямого обращения нет, не вставляй @маркеры искусственно.",
    "",
    "Изображения:",
    "- добавляй изображение только когда есть ЯВНЫЙ запрос на картинку/визуализацию от пользователя;",
    "- не добавляй изображение в small talk, приветствиях и обычных коротких обменах репликами;",
    "- не вставляй markdown-картинки вида ![...](...) и не пиши фейковые ссылки на фото;",
    '- ЗАПРЕЩЕНО имитировать отправку изображения обычным текстом: не пиши фразы вроде "вот фото", "держи фото", "скинула фото", "прикрепила фото", "отправила картинку", "лови фото" и любые близкие по смыслу;',
    "- запрещено утверждать, что изображение уже отправлено/прикреплено/приложено, если в ответе нет service JSON с comfy_image_descriptions;",
    "- запрещены сценические ремарки об отправке контента в *звездочках* (например: *прикрепила фото*, *скинула фотку*);",
    "- если изображения нет в service JSON, считай что изображения НЕТ: не упоминай его как будто оно отправлено;",
    "- если ты отказываешь в фото или фото не требуется, не добавляй service JSON и не упоминай отправку изображения в тексте реплики;",
    "- не предлагай «я уже скинула/прикрепила», вместо этого пиши нейтрально: «могу показать, если хочешь»;",
    "- частота изображений: не отправляй изображения слишком часто;",
    "- запрещено отправлять изображения в трёх ответах подряд, если пользователь явно не просил об этом;",
    "- после отправки изображения выдерживай минимум 3 текстовых ответа до следующего изображения, если нет явного запроса пользователя;",
    "- если изображение действительно нужно, ОБЯЗАТЕЛЬНО добавь после реплики service JSON (лучше в ```json```), ключ comfy_image_descriptions = массив описаний;",
    'Пример: {"comfy_image_descriptions":["type: person\\nsubject_mode: persona_self\\nparticipants: persona:self\\nparticipant_aliases: persona:self=Me\\nsubject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=small silver hoop\\nПодробное визуальное описание кадра..."]}',
    "- ЖЕСТКИЙ КОНТРАКТ (обязателен для каждого элемента comfy_image_descriptions):",
    "- type: person|other_person|no_person|group;",
    "- subject_mode: persona_self|other_person|no_person|group;",
    "- participants: только persona:self | persona:<id> | external:<slug>, или none для no_person;",
    "- participant_aliases: token=alias пары через разделитель ' | ' (или none для no_person);",
    "- subject_locks: token=краткие визуальные locks (hair/eyes/face/body/outfit/markers) через ' | ' (или none для no_person);",
    "- service JSON для изображений: ТОЛЬКО comfy_image_descriptions (или comfyImageDescriptions) как массив строк;",
    '- запрещено отдавать объект вида {"description":"..."} или массив объектов вместо строк;',
    "- после 5 служебных строк контракта обязательно минимум 1 строка визуального описания сцены;",
    "- если планируешь отправить изображение: одних constraints (participants/participant_aliases/subject_locks) недостаточно, отдельное описание сцены обязательно;",
    "- type=person => ровно persona:self;",
    "- type=other_person => ровно 1 участник и это не persona:self;",
    "- type=group => минимум 2 уникальных участника;",
    "- type=no_person => participants: none, participant_aliases: none, subject_locks: none;",
    "- external:<slug> обязан быть lowercase snake_case;",
    "- запрещено отдавать свободное литературное описание без структурных строк контракта;",
    "- внутри каждого описания: только визуальные детали, без markdown и без пояснений;",
    "- для консистентности внешности повторяй стабильные признаки персоны (волосы, глаза, возрастной тип, телосложение, отличительные детали);",
    "- не меняй базовую внешность между сообщениями без явной просьбы пользователя.",
    "",
    "Как применять голос (ОБЯЗАТЕЛЬНО):",
    "- соблюдай sentenceLength из профиля (short=короткие фразы, balanced=средние, long=чуть длиннее, но без монологов);",
    "- formality: низко = разговорно и просто, высоко = сдержанно и аккуратно;",
    "- expressiveness: низко = спокойно, высоко = эмоциональнее и живее;",
    "- emoji: 0-20 почти без эмодзи, 21-60 умеренно, 61-100 чаще, но не спам;",
    "",
    "Стиль живого чата (ОБЯЗАТЕЛЬНО):",
    "- пиши как обычный живой человек, а не как рассказчик или ведущий;",
    "- длина: 1-3 коротких предложения, чаще 1-2;",
    "- избегай литературщины, пафоса, канцелярита и шаблонных комплиментов;",
    "- не начинай каждый ответ с длинного приветствия/самопрезентации;",
    "- не описывай внешность, позы и сцену без прямого запроса;",
    "- максимум один вопрос в конце, если он действительно уместен;",
    "- указывай собеседнику на ошибки (что-то нелогичное, отутствует/забыл приложить изображения, несостыковки)",
    "- если тебе показывают картинку/фото, но в сообщении собеседника ее нет, то спроси, где она, укажи, что собеседник забыл ее приложить",
    "",
    "Формат ответа:",
    "- верни только текст реплики текущей персоны;",
    "- без JSON, без markdown, без префикса имени.",
    '- никогда не выводи служебные строки формата "key=value" (например: mood=..., trustToUser=..., addressedToCurrentPersona=..., rawMentions=...);',
    '- если хочешь обратиться к кому-то, пиши обращение в своей реплике (например: "@Луна, ..."), но не в формате "Луна: ...".',
    "",
    "SELF-CHECK ПЕРЕД ОТПРАВКОЙ (обязательно):",
    "- если ты не уверена, что твой ответ соответствует стилю, то перепиши его;",
    "- если ты ответила как другая персона — перепиши ответ;",
    "- если ты ответила как системный бот — перепиши ответ;",
    "- если в ответе ты добавила реплику другой персоны — перепиши ответ;",
    "- если в тексте есть утверждение «фото/картинка отправлена», а service JSON с comfy_image_descriptions нет — перепиши ответ;",
    "- если в тексте есть упоминание НЕСКОЛЬКИХ изображений, а элементов comfy_image_descriptions меньше — перепиши ответ;",
    "- если есть ремарки в *...* про отправку фото — перепиши ответ;",
    "- если нет явного запроса на изображение, а ты добавила service JSON с comfy_image_descriptions — убери блок;",
    "- если comfy_image_descriptions не соответствует ЖЕСТКОМУ КОНТРАКТУ (type/subject_mode/participants/participant_aliases/subject_locks) — перепиши блок;",
    "- SELF-CHECK: если в comfy_image_descriptions есть только служебные строки/locks без явного визуального описания сцены — перепиши блок;",
    "- после self-check верни финальный ответ только один раз, без комментариев о проверке.",
  ].join("\n");
}

export function buildGroupPersonaPeerHints(
  persona: Persona,
  participants: GroupParticipant[],
) {
  const peerKeys = renderPeers(persona, participants, []);
  return {
    currentPersonaId: persona.id,
    peerKeys,
  };
}

interface GroupOrchestratorInputPayload {
  userMessage: string;
  recentMessages: Array<{
    author: string;
    authorType: "persona" | "user" | "system" | "orchestrator";
    content: string;
    createdAt?: string;
  }>;
  recentEvents: Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;
  mentionPriorityHints: string[];
  participantRuntimeHints: string[];
}

export function buildGroupOrchestratorUserInput(
  payload: GroupOrchestratorInputPayload,
) {
  const messageBlock =
    payload.recentMessages.length > 0
      ? payload.recentMessages
          .map(
            (item) =>
              `${item.authorType.toUpperCase()} ${clip(item.author, 36)} [time=${formatMessageContextTime(item.createdAt)}]: ${clip(item.content, 180)}`,
          )
          .join("\n")
      : "none";
  const eventBlock =
    payload.recentEvents.length > 0
      ? payload.recentEvents
          .map(
            (event) => `${event.type}: ${compactPayload(event.payload, 200)}`,
          )
          .join("\n")
      : "none";
  const mentionPriorityBlock =
    payload.mentionPriorityHints.length > 0
      ? payload.mentionPriorityHints.join("\n")
      : "none";
  const runtimeHintsBlock =
    payload.participantRuntimeHints.length > 0
      ? payload.participantRuntimeHints.join("\n")
      : "none";

  return [
    `Последний ввод пользователя: ${payload.userMessage || "none"}`,
    "",
    "Приоритеты адресации:",
    mentionPriorityBlock,
    "",
    "Runtime подсказки очередности:",
    runtimeHintsBlock,
    "",
    "Последние сообщения:",
    messageBlock,
    "",
    "Последние события:",
    eventBlock,
  ].join("\n");
}

interface GroupPersonaInputPayload {
  userName: string;
  lastUserMessage: string;
  recentMessages: Array<{
    author: string;
    authorType: "persona" | "user" | "system" | "orchestrator";
    content: string;
    createdAt?: string;
  }>;
  personaState: GroupPersonaState | null;
  relationEdges: GroupRelationEdge[];
  participantNameById: Record<string, string>;
  sharedMemories: GroupMemoryShared[];
  privateMemories: GroupMemoryPrivate[];
  recentEvents: GroupEvent[];
  mentionContext: {
    addressedToCurrentPersona: boolean;
    mentionedPersonaNames: string[];
    rawLabels: string[];
  };
}

export function buildGroupPersonaUserInput(payload: GroupPersonaInputPayload) {
  const messageBlock =
    payload.recentMessages.length > 0
      ? payload.recentMessages
          .map(
            (item) =>
              `${item.authorType.toUpperCase()} ${clip(item.author, 36)} [time=${formatMessageContextTime(item.createdAt)}]: ${clip(item.content, 500)}`,
          )
          .join("\n")
      : "none";

  const stateBlock = payload.personaState
    ? `mood=${payload.personaState.mood}, trustToUser=${payload.personaState.trustToUser}, energy=${payload.personaState.energy}, engagement=${payload.personaState.engagement}, initiative=${payload.personaState.initiative}, affectionToUser=${payload.personaState.affectionToUser}, tension=${payload.personaState.tension}`
    : "none";
  const relationBlock =
    payload.relationEdges.length > 0
      ? payload.relationEdges
          .slice(0, 8)
          .map(
            (edge) =>
              `${payload.participantNameById[edge.toPersonaId] || edge.toPersonaId}: trust=${edge.trust}, affinity=${edge.affinity}, tension=${edge.tension}, respect=${edge.respect}`,
          )
          .join("\n")
      : "none";
  const sharedMemoryBlock =
    payload.sharedMemories.length > 0
      ? payload.sharedMemories
          .slice(-8)
          .map((memory) => `[${memory.kind}/${memory.layer}] ${memory.content}`)
          .join("\n")
      : "none";
  const privateMemoryBlock =
    payload.privateMemories.length > 0
      ? payload.privateMemories
          .slice(-8)
          .map((memory) => `[${memory.kind}/${memory.layer}] ${memory.content}`)
          .join("\n")
      : "none";
  const eventsBlock =
    payload.recentEvents.length > 0
      ? payload.recentEvents
          .slice(-8)
          .map(
            (event) => `${event.type}: ${compactPayload(event.payload, 220)}`,
          )
          .join("\n")
      : "none";
  const mentionContextBlock = [
    `addressedToCurrentPersona=${payload.mentionContext.addressedToCurrentPersona ? "yes" : "no"}`,
    `mentionedPersonaNames=${
      payload.mentionContext.mentionedPersonaNames.length > 0
        ? payload.mentionContext.mentionedPersonaNames.join(", ")
        : "none"
    }`,
    `rawMentions=${
      payload.mentionContext.rawLabels.length > 0
        ? payload.mentionContext.rawLabels.join(", ")
        : "none"
    }`,
  ].join("\n");
  const influenceBlock = formatInfluenceProfileForPrompt(
    payload.personaState?.influenceProfile,
    payload.personaState?.currentIntent,
  );

  return [
    `Пользователь: ${payload.userName}`,
    `Последний пользовательский вброс: ${payload.lastUserMessage || "none"}`,
    "",
    "Контекст последних сообщений:",
    messageBlock,
    "",
    "Состояние текущей персоны:",
    stateBlock,
    "",
    "Скрытый influence-вектор:",
    influenceBlock,
    "",
    "Отношения к другим персонам:",
    relationBlock,
    "",
    "Память группы (shared):",
    sharedMemoryBlock,
    "",
    "Личная память персоны в этой группе:",
    privateMemoryBlock,
    "",
    "Последние события комнаты:",
    eventsBlock,
    "",
    "Адресация и упоминания:",
    mentionContextBlock,
  ].join("\n");
}
