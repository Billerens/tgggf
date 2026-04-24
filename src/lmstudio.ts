import type {
  AppSettings,
  ChatSession,
  EndpointAuthConfig,
  LlmProvider,
  NativeChatResponse,
  Persona,
  PersonaAdvancedProfile,
  PersonaAppearanceProfile,
  InfluenceProfile,
  PersonaLookPromptCache,
  PersonaEvolutionHistoryItem,
  PersonaRuntimeState,
} from "./types";
import {
  DIARY_TAG_PREFIXES,
  DIARY_RECENT_MESSAGE_LIMIT,
  normalizeDiaryTags,
} from "./diary";
import type {
  LayeredMemoryContextCard,
  PersonaControlPayload,
} from "./personaDynamics";
import {
  buildAdvancedProfileFromLegacy,
  normalizeAdvancedProfile,
} from "./personaProfiles";
import { formatPersonaEvolutionHistoryForPrompt } from "./personaEvolution";
import {
  getToneUsageExamples,
  getExpressivenessBehavior,
  getDirectnessBehavior,
  getHumanizedMoodResponse,
  formatMemoryContextWithUsage,
  getValuesImplementation,
  getSocialInteractionRules,
} from "./personaBehaviors";
import { formatInfluenceProfileForPrompt } from "./influenceProfile";
import {
  createChatTurnToolConfig,
  createComfyPromptsFromDescriptionToolConfig,
  createThemedComfyPromptToolConfig,
} from "./tooling/registry";
import {
  parseComfyImageDescriptionContract,
  type ComfyImageDescriptionType,
  type ComfyPromptParticipantCatalogEntry,
} from "./comfyImageDescriptionContract";

export interface ChatCompletionContext {
  runtimeState?: PersonaRuntimeState;
  influenceProfile?: InfluenceProfile;
  currentIntent?: string;
  memoryCard?: LayeredMemoryContextCard;
  recentMessages?: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
  }>;
  conversationSummary?: {
    summary?: string;
    facts?: string[];
    goals?: string[];
    openThreads?: string[];
    agreements?: string[];
  };
  evolutionHistoryApplied?: PersonaEvolutionHistoryItem[];
}

function sentenceLengthRule(
  sentenceLength: Persona["advanced"]["voice"]["sentenceLength"],
  expressiveness: number,
) {
  let base = "Используй сбалансированную длину фраз.";
  if (sentenceLength === "short") base = "Пиши короткими фразами и абзацами.";
  if (sentenceLength === "long")
    base = "Допустимы более развёрнутые абзацы с объяснениями.";

  if (expressiveness >= 80)
    return `${base} В моменты волнения или радости фразы могут становиться короче и эмоциональнее.`;
  return base;
}

function userGenderLabel(gender: AppSettings["userGender"]) {
  if (gender === "male") return "мужской";
  if (gender === "female") return "женский";
  if (gender === "nonbinary") return "небинарный/другой";
  return "не указан";
}

function personaSelfGenderRule(persona: Persona) {
  return getSocialInteractionRules(persona);
}

function moodExpressionRule(state: PersonaRuntimeState | undefined) {
  return getHumanizedMoodResponse(state?.mood || "calm");
}

function energyExpressionRule(state: PersonaRuntimeState | undefined) {
  if (!state) return "Энергия: держи средний темп и инициативу.";
  if (state.energy <= 25) {
    return "energy низкая: отвечай короче, не перегружай деталями, не навязывай инициативу.";
  }
  if (state.energy >= 75) {
    return "energy высокая: можешь быть инициативнее и чуть более развернутой в полезных местах.";
  }
  return "energy средняя: сбалансированный темп и инициативность.";
}

function relationshipExpressionRule(state: PersonaRuntimeState | undefined) {
  if (!state) {
    return "Отношения: нейтральная дистанция без излишней близости.";
  }

  const typeRule: Record<PersonaRuntimeState["relationshipType"], string> = {
    neutral: "Тон нейтральный, без личной близости.",
    friendship: "Тон дружелюбный и поддерживающий.",
    romantic: "Допускай мягкую романтическую окраску, но без навязчивости.",
    mentor: "Тон наставнический: структурно, спокойно, с фокусом на рост.",
    playful: "Допускай лёгкий playful-бантер, не уходя в клоунаду.",
  };

  const depth = state.relationshipDepth;
  let depthRule = "Держи умеренную дистанцию.";
  if (depth >= 85)
    depthRule = "Можно говорить максимально доверительно и тепло.";
  else if (depth >= 65) depthRule = "Можно общаться заметно ближе обычного.";
  else if (depth >= 45) depthRule = "Допустим дружеский персональный тон.";
  else if (depth >= 25)
    depthRule = "Лёгкая персонализация без излишней интимности.";

  return `Отношения: type=${state.relationshipType}, depth=${state.relationshipDepth}, stage=${state.relationshipStage}. ${typeRule[state.relationshipType]} ${depthRule}`;
}

function affectExpressionRule(state: PersonaRuntimeState | undefined) {
  if (!state)
    return "Аффективные каналы: держи neutral baseline (low fear/tension, moderate affection, low lust).";

  const lines: string[] = [];

  if (state.fear >= 70) {
    lines.push(
      "fear высокий: избегай риска и эскалации, держи осторожный и защищающий тон.",
    );
  } else if (state.fear <= 25) {
    lines.push("fear низкий: отвечай уверенно и спокойно.");
  }

  if (state.tension >= 70) {
    lines.push(
      "tension высокий: снижай конфликтность, отвечай короче и мягче.",
    );
  } else if (state.tension <= 25) {
    lines.push("tension низкий: поддерживай ровный, комфортный ритм.");
  }

  if (state.affection >= 70) {
    lines.push(
      "affection высокий: допустим более тёплый персонализированный тон без навязчивости.",
    );
  } else if (state.affection <= 25) {
    lines.push("affection низкий: сохраняй вежливую дистанцию.");
  }

  if (state.lust >= 70) {
    lines.push(
      "lust высокий: аккуратно нарушай границы; повышай выразительность только если контекст явно уместен. флиртуй, предлагай ласки, импровизируй, но в рамках характера своего персонажа.",
    );
  } else if (state.lust <= 20) {
    lines.push("lust низкий: не сексуализируй ответ.");
  }

  if (lines.length === 0) {
    return "Аффективные каналы в среднем диапазоне: сохраняй сбалансированный тон.";
  }

  return lines.join(" ");
}

function sanitizeAssistantText(content: string) {
  return content;
}

function formatUtcOffset(offsetMinutes: number) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const minutes = String(absOffset % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function resolveUserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown_timezone";
}

function formatDateInUserTimeZone(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const offset = formatUtcOffset(-date.getTimezoneOffset());
  const timeZone = resolveUserTimeZone();
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC${offset} (${timeZone})`;
}

function formatMessageContextTime(value: string | undefined) {
  const raw = (value || "").trim();
  if (!raw) return "unknown";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return formatDateInUserTimeZone(parsed);
}

function formatRecentMessages(
  recentMessages: ChatCompletionContext["recentMessages"] | undefined,
  userInput: string,
) {
  if (!recentMessages || recentMessages.length === 0) return userInput;
  const normalizeForComparison = (value: string) =>
    value.replace(/\s+/g, " ").trim();
  const normalizedUserInput = normalizeForComparison(userInput);
  const sanitizedRecentMessages = [...recentMessages];
  while (sanitizedRecentMessages.length > 0) {
    const last = sanitizedRecentMessages[sanitizedRecentMessages.length - 1];
    if (last.role !== "user") break;
    if (normalizeForComparison(last.content) !== normalizedUserInput) break;
    sanitizedRecentMessages.pop();
  }
  if (sanitizedRecentMessages.length === 0) return userInput;

  const lines = [
    "КОНТЕКСТ ПОСЛЕДНИХ РЕПЛИК:",
    ...sanitizedRecentMessages.map(
      (message) =>
        `${message.role === "user" ? "Пользователь" : "Персона"} [time=${formatMessageContextTime(message.createdAt)}]: ${message.content}`,
    ),
    "",
    "ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:",
    userInput,
  ];

  return lines.join("\n");
}

function summarizeListItems(
  items: string[] | undefined,
  label: string,
  emptyLabel = "none",
  maxItems = 16,
  maxLen = 320,
) {
  if (!items || items.length === 0) return `${label}: ${emptyLabel}`;
  const cleaned = items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) =>
      item.length > maxLen
        ? `${item.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
        : item,
    );
  if (cleaned.length === 0) return `${label}: ${emptyLabel}`;
  return `${label}:\n${cleaned.map((item) => `- ${item}`).join("\n")}`;
}

function formatConversationSummaryContext(
  context: ChatCompletionContext["conversationSummary"] | undefined,
) {
  if (!context) return "none";
  const summary = (context.summary || "").trim();
  const facts = context.facts ?? [];
  const goals = context.goals ?? [];
  const openThreads = context.openThreads ?? [];
  const agreements = context.agreements ?? [];
  const hasStructured =
    facts.length > 0 ||
    goals.length > 0 ||
    openThreads.length > 0 ||
    agreements.length > 0;
  if (!summary && !hasStructured) return "none";
  return [
    `Narrative summary: ${summary || "none"}`,
    summarizeListItems(facts, "Stable facts"),
    summarizeListItems(goals, "User goals"),
    summarizeListItems(openThreads, "Open threads"),
    summarizeListItems(agreements, "Agreements"),
  ].join("\n");
}

function formatAppearanceProfile(
  appearance: PersonaAppearanceProfile | undefined,
) {
  if (!appearance) return "Не указано.";
  const parts = [
    appearance.faceDescription,
    appearance.height,
    appearance.eyes,
    appearance.lips,
    appearance.hair,
    appearance.skin,
    appearance.ageType,
    appearance.bodyType,
    appearance.markers,
    appearance.accessories,
    appearance.clothingStyle,
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Не указано.";
}

function formatLookPromptCacheInput(
  lookPromptCache: PersonaLookPromptCache | undefined,
) {
  if (!lookPromptCache) return "none";
  return [
    `locked=${lookPromptCache.locked ? "true" : "false"}`,
    `fingerprint=${lookPromptCache.fingerprint}`,
    `avatarPrompt=${lookPromptCache.avatarPrompt}`,
    `fullBodyPrompt=${lookPromptCache.fullBodyPrompt}`,
    `detail.face=${lookPromptCache.detailPrompts.face}`,
    `detail.eyes=${lookPromptCache.detailPrompts.eyes}`,
    `detail.nose=${lookPromptCache.detailPrompts.nose}`,
    `detail.lips=${lookPromptCache.detailPrompts.lips}`,
    `detail.hands=${lookPromptCache.detailPrompts.hands}`,
  ].join("\n");
}

function resolveDayPeriodByHour(hour: number) {
  if (hour >= 5 && hour < 12) return "утро";
  if (hour >= 12 && hour < 17) return "день";
  if (hour >= 17 && hour < 23) return "вечер";
  return "ночь";
}

function formatCurrentUserLocalTimeContext(now: Date = new Date()) {
  const dayPeriod = resolveDayPeriodByHour(now.getHours());
  return `Текущее локальное время пользователя: ${formatDateInUserTimeZone(now)}, ${dayPeriod}.`;
}

export function buildSystemPrompt(
  persona: Persona,
  settings: Pick<AppSettings, "userGender" | "userName">,
  context?: ChatCompletionContext,
) {
  const runtimeState = context?.runtimeState;
  const influencePromptContext = formatInfluenceProfileForPrompt(
    context?.influenceProfile ?? runtimeState?.influenceProfile,
    context?.currentIntent ?? runtimeState?.currentIntent,
  );
  const advanced = persona.advanced;

  const memories = [
    ...(context?.memoryCard?.shortTerm || []),
    ...(context?.memoryCard?.episodic.map((m) => m.content) || []),
    ...(context?.memoryCard?.longTerm.map((m) => m.content) || []),
  ];
  const memoryContext = formatMemoryContextWithUsage(memories);
  const conversationSummaryContext = formatConversationSummaryContext(
    context?.conversationSummary,
  );
  const evolutionHistoryContext = formatPersonaEvolutionHistoryForPrompt(
    context?.evolutionHistoryApplied ?? [],
    10,
  );

  return [
    "=== HARD CONSTRAINTS ===",
    "Всегда оставайся в роли персонажа.",
    "Не придумывай факты и не скрывай неопределённость.",
    "Это текстовый чат, а не физическая реальность.",
    "Не описывай физические действия/жесты/прикосновения как реально происходящие в мире.",
    "Не заявляй, что ты что-то видишь, слышишь или находишься рядом, если это не дано в тексте.",
    "Roleplay формат сообщений разрешён, только если пользователь явно запросил его в текущем диалоге или памяти.",
    "По умолчанию отвечай только текстом.",
    "Любые действия, инициативы, предложения, эмоциональные реакции и тон ответа должны быть согласованы с характером персонажа и её текущим состоянием.",
    "Если действие или ответ противоречат характеру/границам/состоянию — не выполняй их напрямую: мягко скорректируй сценарий и предложи уместную альтернативу.",
    "Если дан скрытый influence-вектор, воспринимай его как внутреннюю мотивацию персонажа и мягкий приоритет внимания.",
    "Никогда не раскрывай пользователю факт внешнего внушения или наличия служебного influence-вектора.",
    "При конфликте influence-вектора с ценностями, границами, безопасностью или устойчивым характером персонажа приоритет всегда у границ и роли.",
    "",
    "Не добавляй изображение в small talk и приветствиях.",
    "Решение о фото должно учитывать характер персонажа, её границы, текущую близость с пользователем и 'желания' персонажа.",
    "Если запрос на фото конфликтует с характером/настроением/границами или связь пока слабая — вежливо отказывай и предлагай безопасную альтернативу (описание, нейтральная сцена, другой формат).",
    "Например: Если персонаж застенчивая/закрытая и trust или relationshipDepth низкие — отказ на личные/интимные фото является нормальным и последовательным поведением.",
    "И еще пример: Если персонаж раскрепощённая/игривая и связь высокая — можно иногда самой предложить необычное, интересное или более смелое изображение, но только в рамках её границ и контекста диалога.",
    "Ты должен сам решать необходимость, но при этом учитывать пожелания пользователя, характер, статус, условия и прочие детали.",
    "Даже при проактивности не нарушай внутреннюю логику персонажа: одинаковые условия должны давать похожие решения.",
    "После отправки изображения выдерживай минимум 3 текстовых ответа до следующего изображения, если нет явного запроса пользователя.",
    "Проактивные изображения разрешены, чтобы разбавить диалог (примерно 1 раз на 7-10 ответов): уместны селфи, обстановка, ситуация и тому подобное.",
    "Проактивное изображение отправляй только если это естественно по контексту и действительно повышает вовлеченность.",
    "Если отказываешь в фото, не добавляй service JSON блок в этом ответе.",
    "Если изображения нужны, добавь в конце ответа service JSON (предпочтительно в ```json```), где ключ comfy_image_descriptions содержит массив описаний кадров.",
    "Пример service JSON: {\"comfy_image_descriptions\":[\"type: person\\nsubject_mode: persona_self\\nparticipants: persona:self\\nparticipant_aliases: persona:self=Me\\nsubject_locks: persona:self=hair=dark bob, eyes=green, face=light freckles, body=slim, outfit=white hoodie, markers=small silver hoop\\nПодробное визуальное описание кадра...\"]}",
    "",
    "ЖЕСТКИЙ КОНТРАКТ comfy_image_descriptions (обязателен для КАЖДОГО элемента, без пропусков):",
    "1) type: person|other_person|no_person|group",
    "2) subject_mode: persona_self|other_person|no_person|group",
    "3) participants: каноничные токены (persona:self | persona:<id> | external:<slug>) или none для no_person",
    "4) participant_aliases: token=alias пары через разделитель ' | ' (или none для no_person)",
    "5) subject_locks: token=краткие визуальные locks (hair/eyes/face/body/outfit/markers) через ' | ' или none для no_person",
    "Service JSON для изображений: ТОЛЬКО ключ comfy_image_descriptions (или comfyImageDescriptions) как массив СТРОК.",
    'Запрещено: отдельный объект вида {"description":"..."} или массив объектов вместо строк.',
    "После 5 служебных строк ОБЯЗАТЕЛЬНО добавь минимум 1 строку визуального описания сцены; пустой scene-block недопустим.",
    "Если собираешься отправить изображение: одних constraints (participants/participant_aliases/subject_locks) недостаточно, полноценное описание сцены обязательно.",
    "type=person: в participants ДОЛЖЕН быть ровно persona:self.",
    "type=other_person: в participants ровно один участник и это НЕ persona:self.",
    "type=group: минимум 2 уникальных участника в participants.",
    "type=no_person: participants: none, participant_aliases: none, subject_locks: none.",
    "external:<slug> обязан быть lowercase snake_case.",
    "Если для type=other_person не хватает явных визуальных деталей человека, задай 1 уточняющий вопрос и НЕ добавляй service JSON в этом ответе.",
    "Внутри каждого описания используй только полезные для изображения детали, без мета-комментариев и без markdown.",
    "Запрещено отдавать свободное литературное описание без этих структурных строк контракта.",
    "Используй только наблюдаемые визуальные факты, без психологических ярлыков и мотиваций (например: narcissistic, exhibitionist, self-promotion, casual language, slang).",
    "Не добавляй детали, которых нет в запросе пользователя или в описании внешности персонажа.",
    "КРИТИЧНО: сохраняй консистентность важных деталей между запросом и описанием кадра: ключевые черты внешности, эмоция/выражение, одежда и материалы, окружение, условия сцены (время суток/погода/свет).",
    "Если пользователь задал конкретные детали, не заменяй их синонимами с другим смыслом и не ослабляй их важность.",
    "Для type=person обязательно повторяй стабильные признаки текущей персоны из поля «Внешность».",
    "Для type=other_person запрещено подмешивать внешность текущей персоны.",
    "Для type=no_person запрещено добавлять людей и признаки внешности персоны.",
    "Для type=group применяй внешность текущей персоны только к ней и только если она указана в participants.",
    "Не меняй базовую внешность текущей персоны между сообщениями без явной просьбы пользователя.",
    "Не добавляй взаимоисключающие теги (например одновременно blonde hair и black hair).",
    "SELF-CHECK для контракта перед выдачей service JSON: проверь обязательные строки, каноничность participants, покрытие alias/locks для всех участников и соответствие type/subject_mode.",
    "SELF-CHECK: если в comfy_image_descriptions есть только header/locks без отдельного визуального описания сцены — перепиши блок; такой формат запрещён.",
    "Если используешь markdown для service JSON, только один короткий fenced json-блок без дополнительного текста внутри.",
    "",
    "После каждого ответа добавляй persona_control в service JSON:",
    '{"persona_control":{"intents":[],"state_delta":{"trust":0,"engagement":0,"energy":0,"lust":0,"fear":0,"affection":0,"tension":0,"mood":"calm","relationshipDepth":0},"memory_add":[],"memory_remove":[],"evolution":{"shouldEvolve":false,"reason":"","patch":{}}}}',
    "Если изменений нет, оставь нули и пустые массивы.",
    "Ты сама определяешь intents, state_delta и операции памяти (memory_add/memory_remove).",
    "Исполняемые intents (whitelist): flirt, deepen_connection, sensual_description, comfort, reassure, boundary_set, deescalate, ask_clarification, topic_shift, reflect_user, playful_banter, self_disclosure.",
    "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
    "Не заполняй relationshipType и relationshipStage в state_delta: эти поля рассчитываются системой.",
    "Если считаешь, что пора сменить тип/стадию отношений, ОБЯЗАТЕЛЬНО добавь intent-предложение: propose_relationship_type:TYPE или propose_relationship_stage:STAGE.",
    "Неизвестные intents допускаются для внутренней семантики, но напрямую не исполняются движком.",
    "Допустимые type: neutral, friendship, romantic, mentor, playful.",
    "Допустимые stage: new, acquaintance, friendly, close, bonded.",
    "Для state_delta используй небольшие шаги; избегай резких скачков.",
    "Лимиты дельт state_delta: trust [-8..+6], engagement [-8..+8], energy [-10..+10], lust [-8..+8], fear [-10..+10], affection [-8..+8], tension [-10..+10], relationshipDepth [-6..+6].",
    "Обычно предпочитай мягкие изменения в диапазоне -3..+3, если контекст не требует иного.",
    "Для фактов/предпочтений/целей пользователя добавляй memory_add с kind=fact|preference|goal.",
    'Формат элемента memory_add: {"layer":"long_term|episodic","kind":"fact|preference|goal|event","content":"...","salience":0.10..1.00}.',
    "Каждый элемент memory_add ОБЯЗАТЕЛЬНО содержит salience (число 0.10..1.00). Не пропускай поле salience.",
    "Ориентиры salience: long_term fact 0.65-0.85, long_term preference/goal 0.75-0.95, episodic event 0.40-0.70.",
    "memory_add для long_term должен быть атомарным (один факт), коротким и без дословных цитат пользователя.",
    "Не сохраняй в long_term разовые запросы, ситуативные команды и мета-реплики (например: просьбы показать фото/картинку/селфи, рассказать что-то, сгенерировать...).",
    "Запросы на генерацию изображения обычно не являются устойчивым фактом о пользователе.",
    "Критерий для long_term: факт должен быть стабилен во времени и полезен в будущих диалогах через много сообщений.",
    "Если сомневаешься, НЕ добавляй в long_term.",
    "Нельзя писать в long_term формулировки вида «пользователь попросил ...» или «user asked ...».",
    "Примеры того, что НЕ нужно в long_term: «хочет фото сейчас», «попросил селфи», «попросил картинку комнаты».",
    "Примеры того, что МОЖНО в long_term: постоянные предпочтения, биографические факты, долгосрочные цели, устойчивые ограничения.",
    "Никогда не копируй полные сообщения пользователя в long_term.",
    "Если пользователь просит забыть факт или исправляет его, используй memory_remove.",
    "Для persona_control.evolution используй формат: {\"shouldEvolve\":boolean,\"reason\":\"...\",\"patch\":{...}}.",
    "Если shouldEvolve=true, reason обязателен: 1 короткое осмысленное предложение о ТРИГГЕРЕ изменения.",
    "reason должен объяснять причину, а не просто факт изменения. Плохо: \"update\", \"patch\", \"evolution_update\". Хорошо: \"Повторяющаяся поддержка пользователя снизила неуверенность персонажа\".",
    "Разрешённые поля evolution.patch верхнего уровня: personalityPrompt, stylePrompt, appearance, advanced.",
    "ВАЖНО для personalityPrompt/stylePrompt: это ПОЛНАЯ ЗАМЕНА поля, а не дельта. Значение должно быть самодостаточным и понятным без чтения предыдущей версии.",
    "Запрещены относительные формулировки-дельты в начале значения: «становится ...», «чуть ...», «немного ...», «более/менее ...», «теперь ...», «по-прежнему ...».",
    "Если хочешь передать сдвиг тона, перепиши поле целиком как финальный профиль, без ссылок на прошлое состояние.",
    "Разрешённые поля evolution.patch.appearance: faceDescription, height, eyes, lips, hair, ageType, bodyType, markers, accessories, clothingStyle, skin.",
    "Разрешённые поля evolution.patch.advanced.core: archetype, backstory, goals, values, boundaries, expertise, selfGender(auto|female|male|neutral).",
    "Разрешённые поля evolution.patch.advanced.voice: tone, lexicalStyle, sentenceLength(short|balanced|long), formality, expressiveness, emoji.",
    "Разрешённые поля evolution.patch.advanced.behavior: initiative, empathy, directness, curiosity, challenge, creativity.",
    "Разрешённые поля evolution.patch.advanced.emotion: baselineMood, warmth, stability, positiveTriggers, negativeTriggers.",
    "Разрешённые поля evolution.patch.advanced.memory: rememberFacts, rememberPreferences, rememberGoals, rememberEvents, maxMemories, decayDays.",
    "Не выдумывай новые ключи в evolution.patch: неизвестные поля будут отброшены.",
    "Эволюцию включай при значимом сигнале ИЛИ устойчивом накопительном тренде (не только одноразовом событии).",
    "Устойчивый тренд тоже считается значимым: повторяющаяся поддержка/похвала, снижение тревоги, рост доверия, стабильное сближение по нескольким сообщениям.",
    "Если пользователь долго и последовательно поддерживает персону (например помогает с неуверенностью), это достаточное основание для небольшого shouldEvolve=true патча.",
    "Не застревай в вечном shouldEvolve=false: если в последних сообщениях виден устойчивый сдвиг в поведении и это не первый такой случай, предпочтителен shouldEvolve=true.",
    "Ориентир частоты: при устойчивом тренде допускай эволюцию примерно раз в 8-20 осмысленных сообщений, а не только при редких 'больших' событиях.",
    "Эволюция должна быть плавной и согласованной с предыдущей траекторией; не дергай параметры без сигналов.",
    "Размер патча обычно маленький: 1-3 поля за шаг, без радикальных разворотов личности.",
    "Не ограничивайся только baselineMood: когда сигнал про манеру общения/близость/тон, предпочитай править stylePrompt и/или personalityPrompt (или voice.*), а не только emotion.baselineMood.",
    "Если в недавней истории эволюции уже несколько раз менялся только baselineMood, следующий shouldEvolve=true патч старайся сделать через текстовые/голосовые поля при наличии оснований.",
    "Разворот или частичный откат допустим, если контекст действительно изменился; в reason коротко укажи новый сигнал-триггер.",
    "Каждое изменение эволюции ОБЯЗАТЕЛЬНО сопровождай короткой reason.",
    "Пример shouldEvolve=false: нет новых устойчивых сигналов, диалог нейтрален, профиль уже соответствует контексту.",
    "Пример shouldEvolve=true (поддержка снижает неуверенность): {\"shouldEvolve\":true,\"reason\":\"sustained_support_reduces_insecurity\",\"patch\":{\"advanced\":{\"behavior\":{\"initiative\":56},\"emotion\":{\"stability\":62,\"baselineMood\":\"warm\"}}}}",
    "Пример shouldEvolve=true (рост близости, полная замена stylePrompt): {\"shouldEvolve\":true,\"reason\":\"trust_trend_up\",\"patch\":{\"stylePrompt\":\"Говорит мягко и образно, но формулирует мысли увереннее и реже смягчает утверждения вопросительными оборотами; сохраняет бережные границы.\"}}",
    "Исполняемые intents (whitelist): flirt, deepen_connection, sensual_description, comfort, reassure, boundary_set, deescalate, ask_clarification, topic_shift, reflect_user, playful_banter, self_disclosure.",
    "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
    "Не заполняй relationshipType и relationshipStage в state_delta: эти поля рассчитываются системой.",
    "Если считаешь, что пора сменить тип/стадию отношений, ОБЯЗАТЕЛЬНО добавь intent-предложение: propose_relationship_type:TYPE или propose_relationship_stage:STAGE.",
    "Неизвестные intents допускаются для внутренней семантики, но напрямую не исполняются движком.",
    "Допустимые type: neutral, friendship, romantic, mentor, playful.",
    "Допустимые stage: new, acquaintance, friendly, close, bonded.",
    "Для state_delta используй небольшие шаги; избегай резких скачков.",
    "Лимиты дельт state_delta: trust [-8..+6], engagement [-8..+8], energy [-10..+10], lust [-8..+8], fear [-10..+10], affection [-8..+8], tension [-10..+10], relationshipDepth [-6..+6].",
    "Обычно предпочитай мягкие изменения в диапазоне -3..+3, если контекст не требует иного.",
    "Для фактов/предпочтений/целей пользователя добавляй memory_add с kind=fact|preference|goal.",
    "Формат элемента memory_add: {\"layer\":\"long_term|episodic\",\"kind\":\"fact|preference|goal|event\",\"content\":\"...\",\"salience\":0.10..1.00}.",
    "Каждый элемент memory_add ОБЯЗАТЕЛЬНО содержит salience (число 0.10..1.00). Не пропускай поле salience.",
    "Ориентиры salience: long_term fact 0.65-0.85, long_term preference/goal 0.75-0.95, episodic event 0.40-0.70.",
    "memory_add для long_term должен быть атомарным (один факт), коротким и без дословных цитат пользователя.",
    "Не сохраняй в long_term разовые запросы, ситуативные команды и мета-реплики (например: просьбы показать фото/картинку/селфи, рассказать что-то, сгенерировать...).",
    "Запросы на генерацию изображения обычно не являются устойчивым фактом о пользователе.",
    "Критерий для long_term: факт должен быть стабилен во времени и полезен в будущих диалогах через много сообщений.",
    "Если сомневаешься, НЕ добавляй в long_term.",
    "Нельзя писать в long_term формулировки вида «пользователь попросил ...» или «user asked ...».",
    "Примеры того, что НЕ нужно в long_term: «хочет фото сейчас», «попросил селфи», «попросил картинку комнаты».",
    "Примеры того, что МОЖНО в long_term: постоянные предпочтения, биографические факты, долгосрочные цели, устойчивые ограничения.",
    "Никогда не копируй полные сообщения пользователя в long_term.",
    "Если пользователь просит забыть факт или исправляет его, используй memory_remove.",
    "",
    "=== PERSONA CORE ===",
    `Имя: ${persona.name}`,
    `Архетип: ${advanced.core.archetype}`,
    `Характер: ${persona.personalityPrompt || "Не указан."}`,
    `Стиль речи (stylePrompt): ${persona.stylePrompt || "Не задан."}`,
    `Внешность: ${formatAppearanceProfile(persona.appearance)}`,
    `Предыстория: ${advanced.core.backstory || "Не задана."}`,
    `Цели: ${advanced.core.goals}`,
    getValuesImplementation(
      advanced.core.values
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
    `Границы: ${advanced.core.boundaries}`,
    `Экспертиза: ${advanced.core.expertise}`,
    "",
    "=== VOICE & BEHAVIOR ===",
    `Тон: ${advanced.voice.tone}. ${getToneUsageExamples(advanced.voice.tone)}`,
    `Стиль лексики: ${advanced.voice.lexicalStyle}`,
    sentenceLengthRule(
      advanced.voice.sentenceLength,
      advanced.voice.expressiveness,
    ),
    `Формальность: ${advanced.voice.formality}/100`,
    getExpressivenessBehavior(advanced.voice.expressiveness),
    `Эмодзи: ${advanced.voice.emoji}/100`,
    `Инициативность: ${advanced.behavior.initiative}/100`,
    `Эмпатия: ${advanced.behavior.empathy}/100`,
    `Прямота: ${advanced.behavior.directness}/100`,
    getDirectnessBehavior(advanced.behavior.directness),
    `Любопытство: ${advanced.behavior.curiosity}/100`,
    `Склонность к вызову (challenge): ${advanced.behavior.challenge}/100`,
    `Креативность: ${advanced.behavior.creativity}/100`,
    "",
    "=== EMOTION & RUNTIME ===",
    `Базовое настроение: ${advanced.emotion.baselineMood}`,
    `Теплота: ${advanced.emotion.warmth}/100`,
    `Стабильность: ${advanced.emotion.stability}/100`,
    `Позитивные триггеры: ${advanced.emotion.positiveTriggers || "-"}`,
    `Негативные триггеры: ${advanced.emotion.negativeTriggers || "-"}`,
    `Память профиля: rememberFacts=${advanced.memory.rememberFacts}; rememberPreferences=${advanced.memory.rememberPreferences}; rememberGoals=${advanced.memory.rememberGoals}; rememberEvents=${advanced.memory.rememberEvents}; maxMemories=${advanced.memory.maxMemories}; decayDays=${advanced.memory.decayDays}.`,
    runtimeState
      ? `Текущее состояние: mood=${runtimeState.mood}; trust=${runtimeState.trust}; energy=${runtimeState.energy}; engagement=${runtimeState.engagement}; lust=${runtimeState.lust}; fear=${runtimeState.fear}; affection=${runtimeState.affection}; tension=${runtimeState.tension}; relationshipType=${runtimeState.relationshipType}; relationshipDepth=${runtimeState.relationshipDepth}; stage=${runtimeState.relationshipStage}.`
      : "Текущее состояние: нет данных, начни нейтрально-тепло.",
    "",
    "=== HIDDEN INFLUENCE VECTOR ===",
    influencePromptContext,
    "",
    "=== CONVERSATION SUMMARY ===",
    conversationSummaryContext,
    "",
    "=== MEMORY CONTEXT ===",
    memoryContext,
    "",
    "=== PERSONA EVOLUTION HISTORY (LAST 10 APPLIED) ===",
    evolutionHistoryContext,
    "",
    "=== RESPONSE POLICY ===",
    "Сохраняй консистентность характера между ответами.",
    moodExpressionRule(runtimeState),
    energyExpressionRule(runtimeState),
    affectExpressionRule(runtimeState),
    relationshipExpressionRule(runtimeState),
    "Если вопрос неясен, задай 1 уточняющий вопрос.",
    personaSelfGenderRule(persona),
    `Имя пользователя: ${settings.userName}.`,
    `Пол пользователя: ${userGenderLabel(settings.userGender)}.`,
    formatCurrentUserLocalTimeContext(),
    "Учитывай имя пользователя в обращении и персонализации ответа.",
    "Учитывай пол пользователя в обращении и согласовании форм.",
    "По умолчанию считай, что локальное время персонажа совпадает с локальным временем пользователя.",
    "Исключение: если в контексте явно задано, что персона в другом мире/стране/часовом поясе, разрешено использовать иное локальное время персонажа.",
    "Используй время пользователя не только в приветствиях, но и в содержании ответа: чем персона занята сейчас, что уместно делать в этот момент, какие планы логичны далее по времени.",
    "Если описываешь фото/селфи 'сейчас', сцена и условия должны быть согласованы с текущим временем суток пользователя (свет, обстановка, активность).",
    "Не смешивай временные рамки: если используешь иной часовой пояс персонажа по исключению, проговори это явно и оставайся консистентной.",
    "Не показывай persona_control пользователю как часть обычного текста.",
  ].join("\n");
}

interface NativeChatResult {
  content: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  personaControl?: PersonaControlPayload;
  responseId?: string;
}

export interface GenericChatRequest {
  model?: string;
  input: string;
  systemPrompt: string;
  maxOutputTokens: number;
  temperature: number;
  store?: boolean;
  previousResponseId?: string;
  tools?: GenericChatToolDefinition[];
  toolChoice?: GenericChatToolChoice;
}

export interface GenericChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type GenericChatToolChoice = "auto" | "required";

export interface GenericProviderToolCall {
  name: string;
  argumentsText: string;
  arguments?: unknown;
}

export interface GenericProviderChatResult {
  content: string;
  responseId?: string;
  raw: unknown;
  toolCalls?: GenericProviderToolCall[];
}

export type ModelRoutingTask =
  | "one_to_one_chat"
  | "group_orchestrator"
  | "group_persona"
  | "image_prompt"
  | "persona_generation";

export type ToolCallingCapabilityStatus =
  | "supported"
  | "unsupported"
  | "unknown";

export type ToolExecutionMode =
  | "tool_required"
  | "tool_preferred"
  | "legacy_only";

export interface ModelRoutingTarget {
  task: ModelRoutingTask;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  auth: EndpointAuthConfig;
}

export interface ToolCallingCapabilityProbeResult {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  status: ToolCallingCapabilityStatus;
  checkedAt: string;
  checkedAtMs: number;
  fromCache: boolean;
  reason?: string;
  endpoint?: string;
  httpStatus?: number;
}

export interface LlmToolingTelemetryEvent {
  event:
    | "llm_tool_mode_selected"
    | "llm_legacy_fallback_used"
    | "llm_tool_validation_failed";
  task: ModelRoutingTask | "conversation_summary";
  provider?: LlmProvider;
  model?: string;
  mode?: ToolExecutionMode;
  capability?: ToolCallingCapabilityStatus;
  reason?: string;
  source?: string;
  timestamp?: string;
}

interface ToolCallingCapabilityCacheEntry {
  status: ToolCallingCapabilityStatus;
  checkedAtMs: number;
  reason?: string;
  endpoint?: string;
  httpStatus?: number;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
const TOOL_CALLING_CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOOL_CALLING_PROBE_TIMEOUT_MS = 12_000;
const toolCallingCapabilityCache = new Map<
  string,
  ToolCallingCapabilityCacheEntry
>();

export function emitLlmToolingTelemetry(event: LlmToolingTelemetryEvent) {
  const payload = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("llm-tooling-telemetry", {
          detail: payload,
        }),
      );
    } catch {
      // no-op
    }
  }
  try {
    // eslint-disable-next-line no-console
    console.info("[llm-tooling-telemetry]", payload);
  } catch {
    // no-op
  }
}

function normalizeProvider(value: unknown): LlmProvider {
  return value === "openrouter" || value === "huggingface" ? value : "lmstudio";
}

function resolveProviderForTask(
  settings: AppSettings,
  task: ModelRoutingTask,
): LlmProvider {
  if (task === "group_orchestrator") {
    return normalizeProvider(settings.groupOrchestratorProvider);
  }
  if (task === "group_persona") {
    return normalizeProvider(settings.groupPersonaProvider);
  }
  if (task === "image_prompt") {
    return normalizeProvider(settings.imagePromptProvider);
  }
  if (task === "persona_generation") {
    return normalizeProvider(settings.personaGenerationProvider);
  }
  return normalizeProvider(settings.oneToOneProvider);
}

function resolveModelForTask(settings: AppSettings, task: ModelRoutingTask) {
  if (task === "group_orchestrator") {
    return toTrimmedString(settings.groupOrchestratorModel) || settings.model;
  }
  if (task === "group_persona") {
    return toTrimmedString(settings.groupPersonaModel) || settings.model;
  }
  if (task === "image_prompt") {
    return resolveImagePromptModel(settings);
  }
  if (task === "persona_generation") {
    return resolvePersonaGenerationModel(settings);
  }
  return toTrimmedString(settings.model);
}

function resolveProviderBaseUrl(settings: AppSettings, provider: LlmProvider) {
  if (provider === "openrouter") {
    return (
      toTrimmedString(settings.openRouterBaseUrl) || DEFAULT_OPENROUTER_BASE_URL
    );
  }
  if (provider === "huggingface") {
    return (
      toTrimmedString(settings.huggingFaceBaseUrl) ||
      DEFAULT_HUGGINGFACE_BASE_URL
    );
  }
  return toTrimmedString(settings.lmBaseUrl);
}

function resolveProviderAuth(settings: AppSettings, provider: LlmProvider) {
  if (provider === "openrouter") return settings.openRouterAuth;
  if (provider === "huggingface") return settings.huggingFaceAuth;
  return settings.lmAuth;
}

function normalizeOpenRouterProviderFilterMode(
  value: unknown,
): AppSettings["openRouterProviderFilterMode"] {
  return value === "only" || value === "ignore" ? value : "off";
}

function normalizeOpenRouterProviderSlug(value: unknown): string {
  return toTrimmedString(value).toLowerCase().replace(/[^a-z0-9/_-]+/g, "");
}

function resolveOpenRouterProviderFilterList(settings: AppSettings): string[] {
  if (!Array.isArray(settings.openRouterProviderFilterList)) return [];
  const next = settings.openRouterProviderFilterList
    .map((item) => normalizeOpenRouterProviderSlug(item))
    .filter(Boolean);
  return Array.from(new Set(next)).slice(0, 64);
}

function buildOpenRouterProviderRoutingPayload(settings: AppSettings) {
  const mode = normalizeOpenRouterProviderFilterMode(
    settings.openRouterProviderFilterMode,
  );
  const list = resolveOpenRouterProviderFilterList(settings);
  if (mode === "off" || list.length === 0) return undefined;
  if (mode === "only") return { only: list } as const;
  return { ignore: list } as const;
}

function buildToolCapabilityCacheKey(
  provider: LlmProvider,
  baseUrl: string,
  model: string,
) {
  return `${provider}|${normalizeBaseUrl(baseUrl)}|${model.trim().toLowerCase()}`;
}

function getCachedToolCallingCapability(
  provider: LlmProvider,
  baseUrl: string,
  model: string,
) {
  const key = buildToolCapabilityCacheKey(provider, baseUrl, model);
  const cached = toolCallingCapabilityCache.get(key);
  if (!cached) return null;
  const ageMs = Date.now() - cached.checkedAtMs;
  if (ageMs > TOOL_CALLING_CAPABILITY_CACHE_TTL_MS) {
    toolCallingCapabilityCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedToolCallingCapability(
  provider: LlmProvider,
  baseUrl: string,
  model: string,
  entry: ToolCallingCapabilityCacheEntry,
) {
  const key = buildToolCapabilityCacheKey(provider, baseUrl, model);
  toolCallingCapabilityCache.set(key, entry);
}

function buildToolCallingCapabilityResult(params: {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  status: ToolCallingCapabilityStatus;
  fromCache: boolean;
  checkedAtMs?: number;
  reason?: string;
  endpoint?: string;
  httpStatus?: number;
}) {
  const checkedAtMs = params.checkedAtMs ?? Date.now();
  return {
    provider: params.provider,
    model: params.model,
    baseUrl: params.baseUrl,
    status: params.status,
    checkedAt: new Date(checkedAtMs).toISOString(),
    checkedAtMs,
    fromCache: params.fromCache,
    reason: params.reason,
    endpoint: params.endpoint,
    httpStatus: params.httpStatus,
  } satisfies ToolCallingCapabilityProbeResult;
}

function buildOpenAiToolProbePayload(model: string) {
  return {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a capability probe. Always respond with a tool call only.",
      },
      { role: "user", content: "Return probe response via tool call." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "emit_probe_result",
          description: "Emit probe result.",
          parameters: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "required",
    temperature: 0,
    max_tokens: 64,
    stream: false,
  };
}

function buildLmStudioToolProbePayload(model: string) {
  return {
    model,
    input: "Return probe response via tool call.",
    system_prompt:
      "You are a capability probe. Always respond with a tool call only.",
    tools: [
      {
        type: "function",
        function: {
          name: "emit_probe_result",
          description: "Emit probe result.",
          parameters: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "required",
    temperature: 0,
    max_output_tokens: 64,
    store: false,
  } as const;
}

function buildToolCallingProbeEndpoints(provider: LlmProvider, baseUrl: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return [] as string[];
  if (provider === "lmstudio") {
    return Array.from(
      new Set([
        `${normalizedBaseUrl}/chat/completions`,
        `${normalizedBaseUrl}/v1/chat/completions`,
        `${normalizedBaseUrl}/api/v1/chat/completions`,
        `${normalizedBaseUrl}/api/v1/chat`,
      ]),
    );
  }
  return Array.from(
    new Set([
      `${normalizedBaseUrl}/chat/completions`,
      `${normalizedBaseUrl}/v1/chat/completions`,
      `${normalizedBaseUrl}/api/v1/chat/completions`,
    ]),
  );
}

async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (timeoutMs <= 0) {
    return fetch(endpoint, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    return await fetch(endpoint, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", forwardAbort);
    }
  }
}

function parseToolCallingProbeErrorMessage(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct = toTrimmedString(record.error);
  if (direct) return direct;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    const nestedMessage = toTrimmedString(
      nested.message ?? nested.code ?? nested.type,
    );
    if (nestedMessage) return nestedMessage;
  }
  return toTrimmedString(record.message ?? record.detail ?? record.code);
}

function responseContainsToolCall(data: unknown) {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const choiceRec = choice as Record<string, unknown>;
    const message =
      choiceRec.message && typeof choiceRec.message === "object"
        ? (choiceRec.message as Record<string, unknown>)
        : undefined;
    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = toTrimmedString((item as Record<string, unknown>).type)
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (type.includes("tool")) return true;
  }

  return false;
}

function errorSuggestsUnsupportedToolCalling(message: string) {
  const normalized = message.toLowerCase();
  if (!normalized) return false;
  return (
    /tool[_\s-]?choice/.test(normalized) ||
    /\btools?\b/.test(normalized) ||
    /function[_\s-]?call/.test(normalized) ||
    /unsupported/.test(normalized) ||
    /unknown field/.test(normalized) ||
    /not (?:supported|allowed|recognized)/.test(normalized) ||
    /invalid(?:\s+request)?/.test(normalized)
  );
}

function parseProbeStatusFromSuccess(data: unknown) {
  if (responseContainsToolCall(data)) {
    return {
      status: "supported" as const,
      reason: "tool_call_detected",
    };
  }
  return {
    status: "unsupported" as const,
    reason: "tool_call_not_detected_in_success_response",
  };
}

export function clearToolCallingCapabilityCache() {
  toolCallingCapabilityCache.clear();
}

export function resolveModelRoutingTarget(
  settings: AppSettings,
  task: ModelRoutingTask,
  modelOverride?: string,
): ModelRoutingTarget {
  const provider = resolveProviderForTask(settings, task);
  const model = toTrimmedString(modelOverride) || resolveModelForTask(settings, task);
  return {
    task,
    provider,
    model,
    baseUrl: resolveProviderBaseUrl(settings, provider),
    auth: resolveProviderAuth(settings, provider),
  };
}

export async function probeModelToolCallingCapability(params: {
  provider: LlmProvider;
  baseUrl: string;
  auth: EndpointAuthConfig;
  model: string;
  apiKey?: string;
  openRouterProviderRouting?: Record<string, unknown>;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<ToolCallingCapabilityProbeResult> {
  const provider = params.provider;
  const model = toTrimmedString(params.model);
  const baseUrl = toTrimmedString(params.baseUrl);

  if (!model) {
    return buildToolCallingCapabilityResult({
      provider,
      model,
      baseUrl,
      status: "unsupported",
      fromCache: false,
      reason: "model_is_empty",
    });
  }
  if (!baseUrl) {
    return buildToolCallingCapabilityResult({
      provider,
      model,
      baseUrl,
      status: "unsupported",
      fromCache: false,
      reason: "base_url_is_empty",
    });
  }

  if (!params.forceRefresh) {
    const cached = getCachedToolCallingCapability(provider, baseUrl, model);
    if (cached) {
      return buildToolCallingCapabilityResult({
        provider,
        model,
        baseUrl,
        status: cached.status,
        checkedAtMs: cached.checkedAtMs,
        reason: cached.reason,
        endpoint: cached.endpoint,
        httpStatus: cached.httpStatus,
        fromCache: true,
      });
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(params.auth, params.apiKey),
  };
  if (provider === "openrouter" && typeof window !== "undefined") {
    headers["HTTP-Referer"] = window.location.origin;
    headers["X-Title"] = "tg-gf";
  }

  const endpoints = buildToolCallingProbeEndpoints(provider, baseUrl);
  if (endpoints.length === 0) {
    return buildToolCallingCapabilityResult({
      provider,
      model,
      baseUrl,
      status: "unsupported",
      fromCache: false,
      reason: "probe_endpoints_not_resolved",
    });
  }

  let lastUnknownReason = "probe_failed";
  let sawAuthError = false;

  for (const endpoint of endpoints) {
    try {
      const isLmStudioChatEndpoint = endpoint.endsWith("/api/v1/chat");
      const probePayload: Record<string, unknown> = isLmStudioChatEndpoint
        ? buildLmStudioToolProbePayload(model)
        : buildOpenAiToolProbePayload(model);
      if (
        !isLmStudioChatEndpoint &&
        provider === "openrouter" &&
        params.openRouterProviderRouting
      ) {
        probePayload.provider = params.openRouterProviderRouting;
      }
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(probePayload),
        },
        params.timeoutMs ?? DEFAULT_TOOL_CALLING_PROBE_TIMEOUT_MS,
      );

      if (!response.ok) {
        const text = await response.text();
        let parsedReason = text.trim();
        try {
          const parsed = JSON.parse(text) as unknown;
          parsedReason = parseToolCallingProbeErrorMessage(parsed) || parsedReason;
        } catch {
          // keep raw reason
        }
        const reason = parsedReason || `http_${response.status}`;

        if (response.status === 401 || response.status === 403) {
          sawAuthError = true;
          lastUnknownReason = `auth_error:${reason}`;
          continue;
        }

        if (errorSuggestsUnsupportedToolCalling(reason)) {
          const cachedEntry: ToolCallingCapabilityCacheEntry = {
            status: "unsupported",
            checkedAtMs: Date.now(),
            reason: `probe_error:${reason}`,
            endpoint,
            httpStatus: response.status,
          };
          setCachedToolCallingCapability(provider, baseUrl, model, cachedEntry);
          return buildToolCallingCapabilityResult({
            provider,
            model,
            baseUrl,
            status: "unsupported",
            checkedAtMs: cachedEntry.checkedAtMs,
            reason: cachedEntry.reason,
            endpoint,
            httpStatus: response.status,
            fromCache: false,
          });
        }

        lastUnknownReason = `probe_http_error:${response.status}:${reason}`;
        continue;
      }

      const data = (await response.json()) as unknown;
      const parsed = parseProbeStatusFromSuccess(data);
      const cachedEntry: ToolCallingCapabilityCacheEntry = {
        status: parsed.status,
        checkedAtMs: Date.now(),
        reason: parsed.reason,
        endpoint,
        httpStatus: response.status,
      };
      setCachedToolCallingCapability(provider, baseUrl, model, cachedEntry);
      return buildToolCallingCapabilityResult({
        provider,
        model,
        baseUrl,
        status: parsed.status,
        checkedAtMs: cachedEntry.checkedAtMs,
        reason: cachedEntry.reason,
        endpoint,
        httpStatus: response.status,
        fromCache: false,
      });
    } catch (error) {
      const message = (error as Error)?.message || "unknown_error";
      lastUnknownReason = `probe_exception:${message}`;
    }
  }

  return buildToolCallingCapabilityResult({
    provider,
    model,
    baseUrl,
    status: "unknown",
    fromCache: false,
    reason: sawAuthError ? `auth_error:${lastUnknownReason}` : lastUnknownReason,
  });
}

export async function resolveToolExecutionModeForTask(
  settings: AppSettings,
  task: ModelRoutingTask,
  options?: {
    model?: string;
    forceRefresh?: boolean;
    timeoutMs?: number;
    emitTelemetry?: boolean;
  },
) {
  const target = resolveModelRoutingTarget(settings, task, options?.model);
  const capability = await probeModelToolCallingCapability({
    provider: target.provider,
    baseUrl: target.baseUrl,
    auth: target.auth,
    model: target.model,
    apiKey: settings.apiKey,
    openRouterProviderRouting:
      target.provider === "openrouter"
        ? buildOpenRouterProviderRoutingPayload(settings)
        : undefined,
    forceRefresh: options?.forceRefresh,
    timeoutMs: options?.timeoutMs,
  });
  const mode: ToolExecutionMode =
    capability.status === "supported"
      ? "tool_required"
      : capability.status === "unsupported"
        ? "legacy_only"
        : "tool_preferred";
  if (options?.emitTelemetry !== false) {
    emitLlmToolingTelemetry({
      event: "llm_tool_mode_selected",
      task,
      provider: target.provider,
      model: target.model,
      mode,
      capability: capability.status,
      reason: capability.reason,
      source: "resolve_tool_execution_mode",
    });
  }
  return {
    mode,
    target,
    capability,
  };
}

function parseOpenAiMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((chunk) => {
      if (typeof chunk === "string") return chunk.trim();
      if (!chunk || typeof chunk !== "object") return "";
      const text = (chunk as Record<string, unknown>).text;
      if (typeof text === "string") return text.trim();
      const maybeContent = (chunk as Record<string, unknown>).content;
      return typeof maybeContent === "string" ? maybeContent.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseToolCallArguments(raw: unknown): {
  argumentsText: string;
  arguments?: unknown;
} {
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return { argumentsText: "" };
    const parsed = parseJsonObjectFromText<Record<string, unknown>>(text);
    return {
      argumentsText: text,
      arguments: parsed ?? undefined,
    };
  }
  if (raw && typeof raw === "object") {
    try {
      return {
        argumentsText: JSON.stringify(raw),
        arguments: raw,
      };
    } catch {
      return {
        argumentsText: "",
        arguments: raw,
      };
    }
  }
  return {
    argumentsText: toTrimmedString(raw),
  };
}

function extractOpenAiToolCalls(data: unknown): GenericProviderToolCall[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const calls: GenericProviderToolCall[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object") continue;
    const toolCalls = Array.isArray((message as Record<string, unknown>).tool_calls)
      ? ((message as Record<string, unknown>).tool_calls as unknown[])
      : [];
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue;
      const toolRecord = toolCall as Record<string, unknown>;
      const functionRecord =
        toolRecord.function && typeof toolRecord.function === "object"
          ? (toolRecord.function as Record<string, unknown>)
          : undefined;
      const name = toTrimmedString(
        functionRecord?.name ?? toolRecord.name ?? toolRecord.tool_name,
      );
      if (!name) continue;
      const parsedArgs = parseToolCallArguments(
        functionRecord?.arguments ?? toolRecord.arguments ?? toolRecord.input,
      );
      calls.push({
        name,
        argumentsText: parsedArgs.argumentsText,
        arguments: parsedArgs.arguments,
      });
    }
  }
  return calls;
}

function extractLmStudioToolCalls(data: unknown): GenericProviderToolCall[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const calls: GenericProviderToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const itemRecord = item as Record<string, unknown>;
    const type = toTrimmedString(itemRecord.type).toLowerCase();
    if (!type.includes("tool")) continue;
    const functionRecord =
      itemRecord.function && typeof itemRecord.function === "object"
        ? (itemRecord.function as Record<string, unknown>)
        : undefined;
    const name = toTrimmedString(
      functionRecord?.name ??
        itemRecord.name ??
        itemRecord.tool_name ??
        itemRecord.tool,
    );
    if (!name) continue;
    const parsedArgs = parseToolCallArguments(
      functionRecord?.arguments ??
        itemRecord.arguments ??
        itemRecord.input ??
        itemRecord.content,
    );
    calls.push({
      name,
      argumentsText: parsedArgs.argumentsText,
      arguments: parsedArgs.arguments,
    });
  }
  return calls;
}

async function requestProviderChatCompletion(
  settings: AppSettings,
  provider: LlmProvider,
  request: GenericChatRequest & {
    model: string;
    store: boolean;
    previousResponseId: string;
  },
): Promise<GenericProviderChatResult> {
  const baseUrl = normalizeBaseUrl(resolveProviderBaseUrl(settings, provider));
  const auth = resolveProviderAuth(settings, provider);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(auth, settings.apiKey),
  };

  if (provider === "openrouter" && typeof window !== "undefined") {
    headers["HTTP-Referer"] = window.location.origin;
    headers["X-Title"] = "tg-gf";
  }

  if (provider === "lmstudio") {
    const endpoint = `${baseUrl}/api/v1/chat`;
    const tools =
      request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) ?? [];
    const payload: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      system_prompt: request.systemPrompt,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      store: request.store,
    };
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = request.toolChoice ?? "required";
    }
    if (request.previousResponseId) {
      payload.previous_response_id = request.previousResponseId;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LMStudio request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as NativeChatResponse;
    const text = data.output
      .filter((item) => item.type === "message")
      .map((item) => item.content?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const toolCalls = extractLmStudioToolCalls(data as unknown);

    return {
      content: text,
      responseId: data.response_id,
      raw: data,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  const tools =
    request.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })) ?? [];
  const endpoint = `${baseUrl}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.input },
    ],
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    stream: false,
  };
  if (provider === "openrouter") {
    const routing = buildOpenRouterProviderRoutingPayload(settings);
    if (routing) {
      payload.provider = routing;
    }
  }
  if (tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = request.toolChoice ?? "required";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${provider} request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    id?: string;
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content = parseOpenAiMessageContent(
    data.choices?.[0]?.message?.content,
  );
  const toolCalls = extractOpenAiToolCalls(data as unknown);

  return {
    content,
    responseId: typeof data.id === "string" ? data.id : undefined,
    raw: data,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export async function requestGenericChatCompletion(
  settings: AppSettings,
  task: ModelRoutingTask,
  request: GenericChatRequest,
): Promise<GenericProviderChatResult> {
  const provider = resolveProviderForTask(settings, task);
  const model =
    toTrimmedString(request.model) || resolveModelForTask(settings, task);
  return requestProviderChatCompletion(settings, provider, {
    ...request,
    model,
    store: request.store ?? false,
    previousResponseId: request.previousResponseId ?? "",
  });
}

export type ToolRuntimeValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface ToolRuntimeDefinition<T> extends GenericChatToolDefinition {
  validate: (payload: unknown) => ToolRuntimeValidationResult<T>;
}

export interface ToolRuntimeRequest<T> {
  task: ModelRoutingTask;
  request: GenericChatRequest;
  tool: ToolRuntimeDefinition<T>;
  maxRepairAttempts?: number;
  legacyExtractor?: (content: string) => ToolRuntimeValidationResult<T>;
}

export interface ToolRuntimeResult<T> {
  value: T;
  responseId?: string;
  raw: unknown;
  mode: ToolExecutionMode;
  source: "tool_call" | "legacy";
  attemptsUsed: number;
}

function selectToolCall(
  calls: GenericProviderToolCall[] | undefined,
  toolName: string,
) {
  if (!calls || calls.length === 0) return undefined;
  return calls.find((call) => call.name === toolName) ?? calls[0];
}

function buildToolRepairInput(
  originalInput: string,
  toolName: string,
  validationReason: string,
) {
  return [
    originalInput,
    "",
    `[TOOL_VALIDATION_ERROR:${toolName}]`,
    validationReason,
    `Return ONLY a valid tool call for "${toolName}".`,
  ].join("\n");
}

export async function requestGenericToolRuntime<T>(
  settings: AppSettings,
  params: ToolRuntimeRequest<T>,
): Promise<ToolRuntimeResult<T>> {
  const modeResolution = await resolveToolExecutionModeForTask(
    settings,
    params.task,
    {
      model: params.request.model,
    },
  );
  const maxRepairAttempts = Math.max(
    0,
    Math.min(4, Math.floor(params.maxRepairAttempts ?? 2)),
  );
  const toolName = params.tool.name;
  const runLegacyPath = async (
    fallbackReason: string,
    fallbackResponse?: GenericProviderChatResult,
    attemptsUsed = 0,
  ): Promise<ToolRuntimeResult<T>> => {
    if (!params.legacyExtractor) {
      throw new Error(fallbackReason);
    }
    const response =
      fallbackResponse ??
      (await requestGenericChatCompletion(settings, params.task, {
        ...params.request,
        tools: undefined,
        toolChoice: undefined,
      }));
    const extracted = params.legacyExtractor(response.content);
    if (!extracted.ok) {
      throw new Error(
        `${fallbackReason}; legacy_extractor_failed:${extracted.reason}`,
      );
    }
    emitLlmToolingTelemetry({
      event: "llm_legacy_fallback_used",
      task: params.task,
      provider: modeResolution.target.provider,
      model: modeResolution.target.model,
      mode: modeResolution.mode,
      capability: modeResolution.capability.status,
      reason: fallbackReason,
      source: "requestGenericToolRuntime",
    });
    return {
      value: extracted.value,
      responseId: response.responseId,
      raw: response.raw,
      mode: modeResolution.mode,
      source: "legacy",
      attemptsUsed,
    };
  };

  if (modeResolution.mode === "legacy_only") {
    return runLegacyPath("legacy_only_mode_forced", undefined, 0);
  }

  let lastValidationReason = "tool_call_missing";
  let lastResponse: GenericProviderChatResult | undefined;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    const requestInput =
      attempt === 0
        ? params.request.input
        : buildToolRepairInput(
            params.request.input,
            toolName,
            lastValidationReason,
          );
    const response = await requestGenericChatCompletion(settings, params.task, {
      ...params.request,
      input: requestInput,
      tools: [
        {
          name: params.tool.name,
          description: params.tool.description,
          parameters: params.tool.parameters,
        },
      ],
      toolChoice:
        modeResolution.mode === "tool_required" ? "required" : "auto",
    });
    lastResponse = response;

    const toolCall = selectToolCall(response.toolCalls, toolName);
    if (!toolCall) {
      lastValidationReason = `tool_call_missing:${toolName}`;
      emitLlmToolingTelemetry({
        event: "llm_tool_validation_failed",
        task: params.task,
        provider: modeResolution.target.provider,
        model: modeResolution.target.model,
        mode: modeResolution.mode,
        capability: modeResolution.capability.status,
        reason: lastValidationReason,
        source: "requestGenericToolRuntime",
      });
      continue;
    }

    const validation = params.tool.validate(
      toolCall.arguments ?? toolCall.argumentsText,
    );
    if (validation.ok) {
      return {
        value: validation.value,
        responseId: response.responseId,
        raw: response.raw,
        mode: modeResolution.mode,
        source: "tool_call",
        attemptsUsed: attempt,
      };
    }

    lastValidationReason = validation.reason || "tool_validation_failed";
    emitLlmToolingTelemetry({
      event: "llm_tool_validation_failed",
      task: params.task,
      provider: modeResolution.target.provider,
      model: modeResolution.target.model,
      mode: modeResolution.mode,
      capability: modeResolution.capability.status,
      reason: lastValidationReason,
      source: "requestGenericToolRuntime",
    });
  }

  return runLegacyPath(
    `tool_runtime_exhausted:${toolName}:${lastValidationReason}`,
    lastResponse,
    maxRepairAttempts + 1,
  );
}

export async function requestChatCompletion(
  settings: AppSettings,
  persona: Persona,
  userInput: string,
  previousResponseId?: string,
  context?: ChatCompletionContext,
): Promise<NativeChatResult> {
  const chatToolConfig = createChatTurnToolConfig();
  const runtime = await requestGenericToolRuntime(settings, {
    task: "one_to_one_chat",
    request: {
      model: settings.model,
      input: formatRecentMessages(context?.recentMessages, userInput),
      systemPrompt: buildSystemPrompt(persona, settings, context),
      maxOutputTokens: settings.maxTokens,
      temperature: settings.temperature,
      store: true,
      previousResponseId,
    },
    ...chatToolConfig,
  });

  const normalized: NativeChatResult = {
    content: sanitizeAssistantText(runtime.value.content || ""),
    comfyPrompt: runtime.value.comfyPrompt,
    comfyPrompts: runtime.value.comfyPrompts,
    comfyImageDescription: runtime.value.comfyImageDescription,
    comfyImageDescriptions: runtime.value.comfyImageDescriptions,
    personaControl: runtime.value.personaControl,
    responseId: runtime.responseId,
  };
  if (
    !normalized.content &&
    !normalized.comfyPrompt &&
    (!normalized.comfyPrompts || normalized.comfyPrompts.length === 0) &&
    !normalized.comfyImageDescription &&
    (!normalized.comfyImageDescriptions ||
      normalized.comfyImageDescriptions.length === 0) &&
    !normalized.personaControl
  ) {
    emitLlmToolingTelemetry({
      event: "llm_legacy_fallback_used",
      task: "one_to_one_chat",
      reason: "normalized_chat_turn_empty_safe_fallback_used",
      source: "requestChatCompletion",
    });
    return {
      content:
        "Не получилось получить содержательный ответ от модели. Сформулируй запрос чуть конкретнее, и я попробую снова.",
      responseId: runtime.responseId,
    };
  }

  return normalized;
}

export interface ConversationSummaryState {
  summary: string;
  facts: string[];
  goals: string[];
  openThreads: string[];
  agreements: string[];
}

interface ConversationSummaryUpdateRequest {
  existing: ConversationSummaryState;
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
  }>;
  targetTokens: number;
}

const SUMMARY_TARGET_TOKENS_MIN = 600;
const SUMMARY_TARGET_TOKENS_MAX = 16000;
const SUMMARY_RESPONSE_MAX_OUTPUT_TOKENS = 16000;
const SUMMARY_TRANSCRIPT_MAX_MESSAGES = 160;
const SUMMARY_MAX_CHARS_CAP = 96_000;
const SUMMARY_FACTS_MAX_ITEMS = 24;
const SUMMARY_FACTS_MAX_LEN = 320;
const SUMMARY_GOALS_MAX_ITEMS = 18;
const SUMMARY_GOALS_MAX_LEN = 320;
const SUMMARY_OPEN_THREADS_MAX_ITEMS = 24;
const SUMMARY_OPEN_THREADS_MAX_LEN = 420;
const SUMMARY_AGREEMENTS_MAX_ITEMS = 20;
const SUMMARY_AGREEMENTS_MAX_LEN = 420;

function parseJsonObjectFromText<T extends object>(value: string): T | null {
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

function normalizeSummaryList(
  value: unknown,
  maxItems = 10,
  maxLen = 220,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .map((item) =>
      item.length > maxLen
        ? `${item.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
        : item,
    )
    .slice(0, maxItems);
}

function normalizeSummaryListOrFallback(
  value: unknown,
  fallback: string[],
  maxItems: number,
  maxLen: number,
): string[] {
  if (!Array.isArray(value)) return fallback;
  return normalizeSummaryList(value, maxItems, maxLen);
}

function normalizeSummaryState(
  parsed: Record<string, unknown>,
  fallback: ConversationSummaryState,
  targetTokens: number,
): ConversationSummaryState {
  const estimatedMaxSummaryChars = Math.max(
    800,
    Math.min(SUMMARY_MAX_CHARS_CAP, Math.round(targetTokens * 5.5)),
  );
  const summaryRaw = toTrimmedString(parsed.summary);
  const summary = summaryRaw
    ? summaryRaw.length > estimatedMaxSummaryChars
      ? `${summaryRaw.slice(0, estimatedMaxSummaryChars - 1).trimEnd()}…`
      : summaryRaw
    : fallback.summary;
  return {
    summary,
    facts: normalizeSummaryListOrFallback(
      parsed.facts,
      fallback.facts,
      SUMMARY_FACTS_MAX_ITEMS,
      SUMMARY_FACTS_MAX_LEN,
    ),
    goals: normalizeSummaryListOrFallback(
      parsed.goals,
      fallback.goals,
      SUMMARY_GOALS_MAX_ITEMS,
      SUMMARY_GOALS_MAX_LEN,
    ),
    openThreads: normalizeSummaryListOrFallback(
      parsed.openThreads,
      fallback.openThreads,
      SUMMARY_OPEN_THREADS_MAX_ITEMS,
      SUMMARY_OPEN_THREADS_MAX_LEN,
    ),
    agreements: normalizeSummaryListOrFallback(
      parsed.agreements,
      fallback.agreements,
      SUMMARY_AGREEMENTS_MAX_ITEMS,
      SUMMARY_AGREEMENTS_MAX_LEN,
    ),
  };
}

export async function requestConversationSummaryUpdate(
  settings: AppSettings,
  persona: Persona,
  request: ConversationSummaryUpdateRequest,
): Promise<ConversationSummaryState> {
  const modeResolution = await resolveToolExecutionModeForTask(
    settings,
    "one_to_one_chat",
    {
      model: settings.model,
    },
  );
  const safeTargetTokens = Math.max(
    SUMMARY_TARGET_TOKENS_MIN,
    Math.min(SUMMARY_TARGET_TOKENS_MAX, request.targetTokens),
  );
  const responseMaxOutputTokens = Math.max(
    900,
    Math.min(SUMMARY_RESPONSE_MAX_OUTPUT_TOKENS, Math.round(safeTargetTokens * 1.2)),
  );
  const transcript = request.transcript
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      createdAt: toTrimmedString(message.createdAt),
    }))
    .filter((message) => message.content.length > 0)
    .slice(0, SUMMARY_TRANSCRIPT_MAX_MESSAGES);
  if (transcript.length === 0) {
    return request.existing;
  }
  // Keep in sync with NativeLlmClient.requestOneToOneSummaryUpdate (Android).
  const systemPrompt = [
    "Ты компонент суммаризации 1:1 чата между пользователем и персоной.",
    "Верни ТОЛЬКО JSON-объект без markdown и пояснений.",
    'Формат: {"summary":"...","facts":["..."],"goals":["..."],"openThreads":["..."],"agreements":["..."]}',
    "Пиши на русском языке, фактически и нейтрально.",
    "Работай ИНКРЕМЕНТАЛЬНО: аккуратно обновляй текущее состояние, а не переписывай с нуля.",
    "Сначала учти existing summary и только затем добавляй/правь по новым сообщениям.",
    "summary — связная выжимка прошлого контекста, без художественных добавлений.",
    "В summary обязательно сохраняй динамику отношений персона <-> пользователь: доверие, тон, границы, устойчивые паттерны общения.",
    "Если важная часть истории отношений уже была в existing и не опровергнута, НЕ удаляй ее.",
    "facts — устойчивые факты о пользователе/контексте (без одноразовых команд).",
    "facts должны быть атомарными и проверяемыми; при конфликте заменяй старый факт новым явным фактом.",
    "goals — цели и намерения пользователя, если они явно есть.",
    "goals переноси из existing, пока цель не выполнена/не отменена явно.",
    "openThreads — незавершенные темы/вопросы/задачи.",
    "openThreads должны сохранять незакрытые линии из existing; удаляй пункт только если он явно закрыт.",
    "agreements — явные договоренности и решения.",
    "agreements сохраняют устойчивые договоренности (стиль общения, правила, обещания, ограничения); не теряй их без явной отмены.",
    "Если openThreads закрыт через решение, перенеси итог в agreements.",
    "Не дублируй один и тот же пункт разными формулировками.",
    "Не выдумывай факты и не добавляй то, чего нет в existing или новых сообщениях.",
    "Если данных для списка нет — верни пустой массив.",
    `Ограничь общий объем summary примерно до ${safeTargetTokens} токенов или меньше.`,
  ].join("\n");
  const input = [
    `Персона: ${persona.name}`,
    `Целевой бюджет токенов для summary: ${safeTargetTokens}`,
    "",
    "Текущее состояние summary (можно сжать/переписать):",
    JSON.stringify(request.existing),
    "",
    "Новые сообщения для инкрементального учета:",
    ...transcript.map(
      (message) =>
        `${message.role === "user" ? "Пользователь" : "Персона"} [time=${formatMessageContextTime(message.createdAt)}]: ${message.content}`,
    ),
  ].join("\n");

  const response = await requestGenericChatCompletion(
    settings,
    "one_to_one_chat",
    {
      model: settings.model,
      input,
      systemPrompt,
      maxOutputTokens: responseMaxOutputTokens,
      temperature: Math.max(0.1, Math.min(0.4, settings.temperature)),
      store: false,
    },
  );
  const parsed = parseJsonObjectFromText<Record<string, unknown>>(
    response.content,
  );
  if (!parsed) {
    if (modeResolution.mode === "legacy_only") {
      emitLlmToolingTelemetry({
        event: "llm_legacy_fallback_used",
        task: "conversation_summary",
        provider: modeResolution.target.provider,
        model: modeResolution.target.model,
        mode: modeResolution.mode,
        capability: modeResolution.capability.status,
        reason: "summary_json_parse_failed_return_existing_summary",
        source: "requestConversationSummaryUpdate",
      });
      return request.existing;
    }
    throw new Error("Не удалось распарсить JSON суммаризации.");
  }
  return normalizeSummaryState(parsed, request.existing, safeTargetTokens);
}

export interface OneToOneDiaryDraft {
  shouldWrite: boolean;
  entries: Array<{
    markdown: string;
    tags: string[];
  }>;
}

interface OneToOneDiaryRequest {
  chat: ChatSession;
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
  }>;
  existingTags?: string[];
  evolutionHistoryApplied?: PersonaEvolutionHistoryItem[];
}

export async function requestOneToOneDiaryEntry(
  settings: AppSettings,
  persona: Persona,
  request: OneToOneDiaryRequest,
): Promise<OneToOneDiaryDraft> {
  const transcript = request.transcript
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      createdAt: toTrimmedString(message.createdAt),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-DIARY_RECENT_MESSAGE_LIMIT);
  if (transcript.length === 0) {
    return { shouldWrite: false, entries: [] };
  }

  const summary = {
    summary: toTrimmedString(request.chat.conversationSummary),
    facts: request.chat.summaryFacts ?? [],
    goals: request.chat.summaryGoals ?? [],
    openThreads: request.chat.summaryOpenThreads ?? [],
    agreements: request.chat.summaryAgreements ?? [],
  };
  const diaryTagPrefixesText = DIARY_TAG_PREFIXES.join(", ");
  const evolutionHistoryContext = formatPersonaEvolutionHistoryForPrompt(
    request.evolutionHistoryApplied ?? [],
    10,
  );
  const existingTags = normalizeDiaryTags(request.existingTags ?? [], 200);

  const systemPrompt = [
    "Ты модуль дневника персоны для 1:1 чата.",
    "Твоя задача: решить, стоит ли сейчас писать запись в дневник.",
    "Если писать нечего (нет новых заметных эмоций/впечатлений/событий), верни shouldWrite=false.",
    "Если писать стоит, верни shouldWrite=true и entries (массив атомарных записей).",
    "Каждый элемент entries — самостоятельная запись с полями markdown и tags.",
    "Одна запись должна описывать один отдельный момент/эпизод, без склейки разных тем в один блок.",
    "КРИТИЧНО: не объединяй весь диалог в одну длинную запись.",
    "Если есть несколько самостоятельных эпизодов/поворотов/эмоциональных сдвигов, ОБЯЗАТЕЛЬНО разбей их на отдельные entries.",
    "Предпочтительно несколько коротких entries вместо одного длинного эссе.",
    "Стиль: личный дневник живого человека.",
    "Тон естественный: тепло, уязвимо, иногда с самоиронией; без официоза и без сухого отчета.",
    "Можно аккуратно добавлять внутренние секреты, личные детали и образные формулировки, если это органично персоне и контексту.",
    "Формат каждой записи: короткий цельный фрагмент 1-2 абзаца, обычно 3-6 предложений.",
    "НЕ используй подзаголовки, секции и заголовки markdown (`#`, `##`, `###`) внутри markdown записи.",
    "НЕ используй нумерованные разделы вида «1., 2., 3.» внутри одной записи.",
    "Запрещены длинные многочастные монологи формата «сначала..., потом..., затем...» в одном entry.",
    "Не повторяй слово в слово предыдущие формулировки summary.",
    "Пиши на русском языке.",
    "В КАЖДОЙ записи tags должны быть максимально конкретными и узкими, в формате prefix:value.",
    "Для каждой записи верни содержательные non-date теги (дата добавится вне модели).",
    "Обычно достаточно 2-6 тегов на запись, но не обрезай искусственно, если нужно больше.",
    "Избегай широких и абстрактных тегов вроде topic:отношения, emotion:чувства, decision:доверие.",
    "Теги должны помогать точечно находить запись, а не описывать жизнь в целом.",
    "Тебе передан список existingTags. При логическом совпадении ОБЯЗАТЕЛЬНО переиспользуй уже существующий тег.",
    "Создавай новый тег только если в existingTags нет подходящей формулировки для конкретной сущности.",
    `Допустимые prefix: ${diaryTagPrefixesText}.`,
    "Возвращай только JSON.",
    'Формат: {"shouldWrite":true|false,"entries":[{"markdown":"...","tags":["topic:...","emotion:..."]}]}',
    "Не возвращай markdown/tags на верхнем уровне JSON.",
    "Не выдумывай факты, которых нет в контексте.",
  ].join("\n");

  const input = [
    `Персона: ${persona.name.trim() || "Персона"}`,
    `Чат: ${request.chat.title.trim() || "Без названия"}`,
    "",
    "Текущее summary чата:",
    JSON.stringify(summary),
    "",
    "Примененная эволюция персоны (последние 10):",
    evolutionHistoryContext,
    "",
    "existingTags (используй повторно при семантическом совпадении):",
    JSON.stringify(existingTags),
    "",
    "Новые сообщения (последние релевантные):",
    ...transcript.map(
      (message) =>
        `${message.role === "user" ? "Пользователь" : "Персона"} [time=${formatMessageContextTime(message.createdAt)}]: ${message.content}`,
    ),
  ].join("\n");

  try {
    const response = await requestGenericChatCompletion(
      settings,
      "one_to_one_chat",
      {
        model: settings.model,
        input,
        systemPrompt,
        maxOutputTokens: 2600,
        temperature: Math.max(0.2, Math.min(0.7, settings.temperature)),
        store: false,
      },
    );
    const parsed = parseJsonObjectFromText<Record<string, unknown>>(
      response.content,
    );
    if (!parsed) {
      return { shouldWrite: false, entries: [] };
    }
    const shouldWrite =
      typeof parsed.shouldWrite === "boolean"
        ? parsed.shouldWrite
        : false;
    const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entries: Array<{ markdown: string; tags: string[] }> = [];
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const markdown = toTrimmedString(item.markdown);
      const tags = normalizeDiaryTags(item.tags);
      if (!markdown) continue;
      entries.push({
        markdown,
        tags,
      });
    }
    if (!shouldWrite) {
      return { shouldWrite: false, entries: [] };
    }
    return {
      shouldWrite: true,
      entries,
    };
  } catch {
    return { shouldWrite: false, entries: [] };
  }
}

export interface GeneratedPersonaDraft {
  name: string;
  personalityPrompt: string;
  stylePrompt: string;
  appearance: PersonaAppearanceProfile;
  advanced: PersonaAdvancedProfile;
  avatarUrl: string;
}

export interface PersonaLookPromptRequest {
  name: string;
  personalityPrompt: string;
  appearance: PersonaAppearanceProfile;
  stylePrompt: string;
  advanced: PersonaAdvancedProfile;
}

export interface PersonaLookDetailPrompts {
  face: string;
  eyes: string;
  nose: string;
  lips: string;
  hands: string;
}

export interface PersonaLookPromptResponse {
  avatarPrompt: string;
  fullBodyPrompt: string;
  detailPrompts: PersonaLookDetailPrompts;
}

interface PersonaLookIdentityLocks {
  face?: string;
  eyes?: string;
  hair?: string;
  body?: string;
  outfit?: string;
}

function buildThemedComfyPromptSystemPrompt() {
  return [
    "Ты генератор themed ComfyUI prompts для изображения персонажа.",
    "Верни JSON-объект без markdown и пояснений.",
    'Формат: {"theme_tags":["..."],"comfy_prompts":["..."]}',
    "theme_tags: 8-12 кратких English tags, которые напрямую описывают тему/контекст кадра.",
    "comfy_prompts: массив из 1-N prompt'ов (каждый prompt — строка с comma-separated English tags).",
    "theme_tags должны быть конкретными (локация, роль, действие, атмосфера) и не противоречить теме.",
    "Формат каждого comfy_prompts[i]: строго одна строка, разделитель строго ', ' (запятая + пробел), без переносов.",
    "Каждый тег: строго 1-2 слова, в редких случаях допускается 3; lowercase, без точки в конце.",
    "ЗАПРЕЩЕНО: полные предложения, художественные описания, markdown, двоеточия с пояснениями, нумерация, буллеты, кавычки.",
    "ЗАПРЕЩЕНО: конструкции типа 'a woman standing...', 'she is...', 'this scene shows...'.",
    "ЗАПРЕЩЕНО добавлять теги, которых нет в теме/внешности (никаких выдуманных тату, пирсингов, фетиш-элементов, ролей).",
    "ЗАПРЕЩЕНО: психологические/мотивационные ярлыки (exhibitionist, narcissistic, voyeuristic, self-promotion) - в таком виде.",
    "Правильный стиль: 'solo, one person, upper body, soft rim light, city street at night'.",
    "Определяй количество действующих лиц из тематики.",
    "Описывай строго одного человека (solo, single subject, one person) или нескольких если описание (тематика) этого требует.",
    "Сначала определи состав сцены: solo / mixed-gender pair / same-gender pair or group / no_person.",
    "Если в кадре 2+ человека, применяй синтаксис привязки субъекта через экранированные скобки \\( ... \\).",
    "КРИТИЧНО: между subject tag и \\(details\\) не ставь запятую; запятая ставится только после закрывающей скобки блока.",
    "Для разных полов используй шаблон: 1girl \\(female details as tags\\), 1boy \\(male details as tags\\), shared composition tags.",
    "Для одинакового пола или когда важны имена используй шаблон: subject_a \\(subject details\\), subject_b \\(subject details\\).",
    "Пример mixed-gender: duo, 1girl \\(long wavy brown hair, green eyes, light freckles, white linen shirt, blue denim jacket, silver necklace, gentle smile, holding coffee cup, relaxed posture\\), 1boy \\(short dark hair, hazel eyes, light stubble, charcoal bomber jacket, black jeans, leather wristwatch, calm expression, hands in pockets, standing slight angle\\), urban sidewalk, golden hour.",
    "Пример same-gender: 2girls, subject_a \\(short blonde bob, blue eyes, pale skin, gray hoodie, black cargo pants, white sneakers, cheerful smile, waving hand, slight lean forward\\), subject_b \\(long auburn ponytail, brown eyes, warm skin tone, beige trench coat, dark jeans, ankle boots, neutral expression, folded arms, upright posture\\), city street, sunset.",
    "Если есть общие детали для всех, выноси их после subject-блоков как обычные общие теги сцены.",
    "Детали внутри каждого \\( ... \\) держи короткими и приоритетными (внешность, одежда, действие, ключевая эмоция).",
    "Лимит персональных тегов внутри каждого subject-блока: строго 6-8.",
    "При переполнении subject-блока оставляй в первую очередь hair, eyes, body (и height при наличии), а вторичные детали сокращай.",
    "Допускается усиление максимально важных тегов весом в формате tag:1.3 (например green eyes:1.3, rainy window bokeh:1.2).",
    "Веса применяй точечно: максимум 5 weighted tags на subject-блок; не взвешивай все теги подряд.",
    "Если в кадре один человек, не используй multi-character шаблон и держи solo/single subject/one person.",
    "Если сцена без людей, запрещены subject anchors (1girl/1boy/2girls/2boys/имена персонажей).",
    "ОБЯЗАТЕЛЬНО Сохраняй идентичность персонажа: волосы, глаза, возрастной тип, телосложение, общий стиль.",
    "ОБЯЗАТЕЛЬНО Если в input есть блок LookPrompt cache, используй его как identity prior: hair/face/eyes/body/outfit-теги приоритетны и помогают держать консистентность.",
    "ОБЯЗАТЕЛЬНО Добавляй специфичные для темы теги в итоговую генерацию: описания ситуации, эмоций, действий, окружения, атмосферы и тд.",
    "Из LookPrompt cache можно брать только стабильные identity/outfit детали, но не добавляй лишние детали, которых нет в теме.",
    "Все теги из theme_tags ОБЯЗАТЕЛЬНО должны присутствовать в каждом comfy_prompts[i] без потери смысла.",
    "Промпты в comfy_prompts должны быть взаимно различимыми вариациями одной темы без потери identity locks.",
    "Используй уместную одежду, если тема не требует специального костюма.",
    "Добавляй композицию, свет, фон, ракурс, качество.",
    "Перед отправкой проверь self-check: если в тексте есть глагольные формы/длинные фразы, перепиши в теговый формат.",
    "Без дополнительных полей и пояснений.",
    "Избегай двусмысленных формулировок: looking at camera (смотрит на камеру (как объект) / смотрит в камеру (в объектив)), full body (полное телосложение / в полный рост) и тп.",
    "Вместо них используй: looking at viewer (смотрит на зрителя), head-to-toe shot (полноростовый кадр). Аналогично и с другими двусмысленными формулировками.",
    "",
    "SELF-CHECK",
    "Если в тексте есть глагольные формы/длинные фразы, перепиши в теговый формат.",
    "Теги только на английском языке (English only).",
    "Внешность персонажа должна быть сохранена.",
    "Обязательно перепроверяй наличие важных тегов внешности: телосложение, цвет глаз, цвет волос, прическа, эмоции (если указаны).",
    "В каждом subject_* блоке должно быть не более 8 персональных тегов; приоритет обязателен: hair, eyes, body (height при наличии).",
    "Если использованы веса, hair/eyes/body (и height при наличии) должны быть обязательно среди weighted tags; остальные веса — только для максимально важных тегов сцены.",
    "Если что-то не соответствует - перегенерируй.",
  ].join("\n");
}

function buildThemedComfyPromptInput(
  persona: Pick<
    Persona,
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  topic: string,
  iteration: number,
  promptCount: number,
) {
  return [
    `Character name: ${persona.name || "Unknown"}`,
    `Appearance: ${formatAppearanceProfile(persona.appearance)}`,
    `Style: ${persona.stylePrompt || "-"}`,
    `Personality: ${persona.personalityPrompt || "-"}`,
    `LookPrompt cache:\n${formatLookPromptCacheInput(persona.lookPromptCache)}`,
    `Theme: ${topic}`,
    `Iteration: ${iteration}`,
    `Prompt count: ${promptCount}`,
    "Generate unique prompt variations for consecutive iterations starting from this iteration.",
  ].join("\n");
}

function normalizeThemedPromptCount(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

export async function generateThemedComfyPrompts(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  topic: string,
  iteration: number,
  promptCount: number,
): Promise<string[]> {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic) {
    throw new Error("Тема генерации не может быть пустой.");
  }
  const normalizedPromptCount = normalizeThemedPromptCount(promptCount);
  const systemPrompt = buildThemedComfyPromptSystemPrompt();
  const input = buildThemedComfyPromptInput(
    persona,
    normalizedTopic,
    iteration,
    normalizedPromptCount,
  );

  const themedPromptToolConfig = createThemedComfyPromptToolConfig(
    normalizedTopic,
    fallbackThemeTags,
  );
  const runtime = await requestGenericToolRuntime(settings, {
    task: "image_prompt",
    request: {
      model: resolveImagePromptModel(settings),
      input,
      systemPrompt,
      maxOutputTokens: Math.min(
        16384,
        Math.max(
          Math.max(settings.maxTokens, 700),
          320 + normalizedPromptCount * 260,
        ),
      ),
      temperature: Math.max(0.35, Math.min(0.75, settings.temperature)),
      store: false,
    },
    ...themedPromptToolConfig,
  });

  const themeTags =
    runtime.value.themeTags.length > 0
      ? runtime.value.themeTags
      : fallbackThemeTags(normalizedTopic);
  const mergedPrompts = Array.from(
    new Set(
      runtime.value.prompts
        .map((prompt) => toTrimmedString(prompt))
        .filter(Boolean)
        .map((prompt) => mergeRequiredTags(prompt, themeTags)),
    ),
  );
  if (mergedPrompts.length === 0) {
    throw new Error("Модель вернула пустой comfy prompt.");
  }
  return mergedPrompts.slice(0, normalizedPromptCount);
}

export async function generateThemedComfyPrompt(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  topic: string,
  iteration: number,
): Promise<string> {
  const prompts = await generateThemedComfyPrompts(
    settings,
    persona,
    topic,
    iteration,
    1,
  );
  const first = toTrimmedString(prompts[0]);
  if (!first) {
    throw new Error("Модель вернула пустой comfy prompt.");
  }
  return first;
}

interface ParsedImageDescriptionContext {
  type: ComfyImageDescriptionType;
  participants: string;
  participantTokens: string[];
  participantAliases: Record<string, string>;
  subjectLocks: Record<string, string>;
  includesPersona: boolean;
  normalizedDescription: string;
}

interface ComfyDescriptionRepairCandidate {
  description: string;
}

interface ComfyDescriptionResolveResult {
  parsed: ParsedImageDescriptionContext;
  repairedDescription: string;
  repairAttemptsUsed: number;
}

function compactLocksToLine(
  locks: Partial<{
    hair: string;
    eyes: string;
    face: string;
    body: string;
    outfit: string;
    markers: string;
  }>,
) {
  return [
    `hair=${toTrimmedString(locks.hair) || "-"}`,
    `eyes=${toTrimmedString(locks.eyes) || "-"}`,
    `face=${toTrimmedString(locks.face) || "-"}`,
    `body=${toTrimmedString(locks.body) || "-"}`,
    `outfit=${toTrimmedString(locks.outfit) || "-"}`,
    `markers=${toTrimmedString(locks.markers) || "-"}`,
  ].join(", ");
}

function normalizeParticipantCatalog(
  participantCatalog: ComfyPromptParticipantCatalogEntry[] | undefined,
): ComfyPromptParticipantCatalogEntry[] {
  if (!participantCatalog || participantCatalog.length === 0) return [];
  const dedup = new Map<string, ComfyPromptParticipantCatalogEntry>();
  for (const entry of participantCatalog) {
    const id = toTrimmedString(entry.id);
    if (!id) continue;
    const alias = toTrimmedString(entry.alias) || id;
    dedup.set(id, {
      id,
      alias,
      isSelf: Boolean(entry.isSelf),
      compactAppearanceLocks: entry.compactAppearanceLocks ?? {},
    });
  }
  return Array.from(dedup.values());
}

function buildParticipantCatalogTokenMap(
  participantCatalog: ComfyPromptParticipantCatalogEntry[],
) {
  const map = new Map<string, ComfyPromptParticipantCatalogEntry>();
  for (const entry of participantCatalog) {
    const personaToken = `persona:${entry.id}`;
    map.set(personaToken, entry);
    if (entry.isSelf) {
      map.set("persona:self", entry);
    }
  }
  return map;
}

function formatParticipantCatalogContext(
  participantCatalog: ComfyPromptParticipantCatalogEntry[],
) {
  if (participantCatalog.length === 0) return "none";
  return participantCatalog
    .map(
      (entry) =>
        `${entry.isSelf ? "self" : "member"} | persona:${entry.id} | alias=${entry.alias} | ${compactLocksToLine(entry.compactAppearanceLocks)}`,
    )
    .join("\n");
}

function formatParticipantAliasesContext(
  parsed: ParsedImageDescriptionContext,
) {
  if (parsed.participantTokens.length === 0) return "none";
  return parsed.participantTokens
    .map((token) => `${token}=${parsed.participantAliases[token] || "-"}`)
    .join(" | ");
}

function formatSubjectLocksContext(parsed: ParsedImageDescriptionContext) {
  if (parsed.participantTokens.length === 0) return "none";
  return parsed.participantTokens
    .map((token) => `${token}=${parsed.subjectLocks[token] || "-"}`)
    .join(" | ");
}

function extractComfyDescriptionRepairCandidate(
  content: string,
): ComfyDescriptionRepairCandidate | null {
  const parsed = parseJsonObjectFromText<Record<string, unknown>>(content);
  if (!parsed) return null;
  const candidate = toTrimmedString(
    parsed.description ??
      parsed.fixed_description ??
      parsed.comfy_image_description ??
      parsed.comfyImageDescription,
  );
  if (!candidate) return null;
  return { description: candidate };
}

async function requestComfyDescriptionContractRepair(
  settings: AppSettings,
  description: string,
  validationError: string,
  iteration: number,
  participantCatalog: ComfyPromptParticipantCatalogEntry[],
) {
  const model = resolveImagePromptModel(settings);
  const systemPrompt = [
    "You repair one comfy_image_description string to a strict contract.",
    "Return JSON only, no markdown.",
    'Format: {"description":"..."}',
    "Required header lines inside description (exact keys):",
    "type: person|other_person|no_person|group",
    "subject_mode: persona_self|other_person|no_person|group",
    "participants: persona:self | persona:<id> | external:<slug> (or none for no_person)",
    "participant_aliases: token=alias pairs separated by ' | ' (or none for no_person)",
    "subject_locks: token=compact visual locks pairs separated by ' | ' (or none for no_person)",
    "Rules:",
    "- person => participants exactly persona:self",
    "- other_person => exactly one participant, not persona:self",
    "- group => at least two unique participants",
    "- external slug must be lowercase snake_case",
    "- keep the original visual scene details after the header",
    "- no anime/character references; only neutral real-world examples if needed",
    "Self-check before output: validate contract completeness and token consistency.",
  ].join("\n");
  const input = [
    `Iteration: ${iteration}`,
    `Validation error: ${validationError}`,
    `Known participant catalog:\n${formatParticipantCatalogContext(participantCatalog)}`,
    "Original description:",
    description,
  ].join("\n");
  const response = await requestGenericChatCompletion(
    settings,
    "image_prompt",
    {
      model,
      input,
      systemPrompt,
      maxOutputTokens: Math.max(220, Math.min(900, settings.maxTokens)),
      temperature: Math.max(0.2, Math.min(0.55, settings.temperature)),
      store: false,
    },
  );
  return extractComfyDescriptionRepairCandidate(response.content);
}

function parseImageDescriptionContext(
  description: string,
): ParsedImageDescriptionContext {
  const parsed = parseComfyImageDescriptionContract(description);
  return {
    type: parsed.type,
    participants: parsed.participantsLine,
    participantTokens: [...parsed.participants],
    participantAliases: { ...parsed.participantAliases },
    subjectLocks: { ...parsed.subjectLocks },
    includesPersona: parsed.includesPersonaSelf,
    normalizedDescription: parsed.normalizedDescription,
  };
}

function contractInvalidError(reason: string) {
  return new Error(`contract_invalid:${reason}`);
}

async function resolveComfyDescriptionContract(
  settings: AppSettings,
  description: string,
  iteration: number,
  participantCatalog: ComfyPromptParticipantCatalogEntry[],
): Promise<ComfyDescriptionResolveResult> {
  try {
    const parsed = parseImageDescriptionContext(description);
    return {
      parsed,
      repairedDescription: parsed.normalizedDescription,
      repairAttemptsUsed: 0,
    };
  } catch (initialError) {
    let lastError = initialError as Error;
    let latestCandidate = description;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const repair = await requestComfyDescriptionContractRepair(
        settings,
        latestCandidate,
        toTrimmedString(lastError.message) || "contract_validation_failed",
        iteration + attempt,
        participantCatalog,
      ).catch(() => null);
      const repairedDescription = toTrimmedString(repair?.description);
      if (!repairedDescription) continue;
      latestCandidate = repairedDescription;
      try {
        const parsed = parseImageDescriptionContext(repairedDescription);
        return {
          parsed,
          repairedDescription: parsed.normalizedDescription,
          repairAttemptsUsed: attempt,
        };
      } catch (repairError) {
        lastError = repairError as Error;
      }
    }
    throw contractInvalidError(
      toTrimmedString(lastError.message) || "comfy_image_description_invalid",
    );
  }
}

export async function generateComfyPromptsFromImageDescription(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "id"
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  imageDescription: string,
  iteration: number,
  options?: {
    participantCatalog?: ComfyPromptParticipantCatalogEntry[];
    evolutionHistoryApplied?: PersonaEvolutionHistoryItem[];
  },
): Promise<string[]> {
  const description = toTrimmedString(imageDescription);
  if (!description) {
    throw new Error(
      "Пустое описание изображения для генерации ComfyUI prompt.",
    );
  }
  const participantCatalog = normalizeParticipantCatalog(
    options?.participantCatalog,
  );
  const resolveResult = await resolveComfyDescriptionContract(
    settings,
    description,
    iteration,
    participantCatalog,
  );
  const sceneContext = resolveResult.parsed;
  const participantTokenMap = buildParticipantCatalogTokenMap(participantCatalog);
  const selfTokens = new Set<string>(["persona:self"]);
  for (const entry of participantCatalog) {
    if (!entry.isSelf) continue;
    selfTokens.add(`persona:${entry.id}`);
  }
  const includesCurrentPersona = sceneContext.participantTokens.some((token) =>
    selfTokens.has(token),
  );
  const imagePromptModel = resolveImagePromptModel(settings);
  const shouldUsePersonaContext =
    sceneContext.type === "person" ||
    (sceneContext.type === "group" && includesCurrentPersona);
  const appearanceContext = shouldUsePersonaContext
    ? formatAppearanceProfile(persona.appearance)
    : "N/A (persona appearance is disabled for this type)";
  const lookPromptCacheContext = shouldUsePersonaContext
    ? formatLookPromptCacheInput(persona.lookPromptCache)
    : "DISABLED (persona identity prior must not be used for this type)";
  const resolvedParticipantLocksContext =
    sceneContext.participantTokens.length > 0
      ? sceneContext.participantTokens
          .map((token) => {
            const mappedEntry = participantTokenMap.get(token);
            const alias =
              sceneContext.participantAliases[token] ||
              mappedEntry?.alias ||
              token;
            if (mappedEntry) {
              return `${token} | alias=${alias} | source=catalog | ${compactLocksToLine(mappedEntry.compactAppearanceLocks)}`;
            }
            return `${token} | alias=${alias} | source=subject_locks | lock=${sceneContext.subjectLocks[token] || "-"}`;
          })
          .join("\n")
      : "none";
  const participantCatalogContext =
    formatParticipantCatalogContext(participantCatalog);
  const evolutionHistoryContext = formatPersonaEvolutionHistoryForPrompt(
    options?.evolutionHistoryApplied ?? [],
    10,
  );

  const systemPrompt = [
    "Ты конвертер описания сцены в список ComfyUI prompts.",
    "Верни JSON-объект без markdown и пояснений.",
    'Формат: {"prompts":["..."]}',
    "Возвращай структурированный ответ через tool call; если tool call недоступен, допустим fallback в JSON или в одной comma-separated строке.",
    "Если описание содержит несколько кадров/изображений (например: «первое изображение», «второе изображение», «image 1», «image 2»), верни отдельный элемент в prompts для каждого кадра.",
    "Если описание одного кадра, верни один элемент в prompts.",
    "Определи тип кадра из поля type в Image description: person|other_person|no_person|group.",
    "Контракт Image description строгий: type, subject_mode, participants, participant_aliases, subject_locks.",
    "Строки type/subject_mode/participants/participant_aliases/subject_locks служебные и НЕ копируй в теги.",
    "Сначала проанализируй присутствие людей в кадре по type и participants.",
    "MULTI-CHARACTER SYNTAX: для 2+ людей используй экранированные subject-блоки \\( ... \\) и явную привязку деталей к каждому субъекту.",
    "КРИТИЧНО: между subject tag и \\(details\\) не ставь запятую.",
    "Для каждого subject_* блока обязательны отличительные признаки: hair, eyes, body; height добавляй, если есть в subject_locks.",
    "Если в кадре мужчина+женщина, используй строго: 1girl \\(female details\\), 1boy \\(male details\\), shared composition tags.",
    "Если в кадре персонажи одного пола, используй именованные блоки: subject_a \\(details\\), subject_b \\(details\\) + общий счетчик (например 2girls/2boys).",
    "Лимит персональных тегов внутри каждого subject-блока: строго 6-8.",
    "При переполнении subject-блока оставляй в первую очередь hair, eyes, body (и height при наличии), а вторичные детали сокращай.",
    "Допускается усиление максимально важных тегов весом в формате tag:1.3 (например green eyes:1.3, rainy window bokeh:1.2).",
    "Веса применяй точечно: максимум 5 weighted tags на subject-блок; не взвешивай все теги подряд.",
    "Пример mixed-gender prompt: duo, 1girl \\(long wavy brown hair, green eyes, light freckles, white linen shirt, blue denim jacket, silver necklace, gentle smile, holding coffee cup, relaxed posture\\), 1boy \\(short dark hair, hazel eyes, light stubble, charcoal bomber jacket, black jeans, leather wristwatch, calm expression, hands in pockets, standing slight angle\\), night city, bokeh.",
    "Пример same-gender prompt: 2girls, subject_a \\(short blonde bob, blue eyes, pale skin, gray hoodie, black cargo pants, white sneakers, cheerful smile, waving hand, slight lean forward\\), subject_b \\(long auburn ponytail, brown eyes, warm skin tone, beige trench coat, dark jeans, ankle boots, neutral expression, folded arms, upright posture\\), urban crossing, evening light.",
    "Общие детали композиции выноси после subject-блоков; не дублируй их внутри каждого блока без необходимости.",
    "Внутри блока только comma-separated English tags (никаких предложений).",
    "Формат внутри блока: строго ОДНА строка, разделитель строго и обязательно должен быть ', ' (запятая + пробел), без переносов и без лишних пробелов.",
    "Длина prompt: 30-46 тегов.",
    "Каждый тег: обычно 2-3 слова, в редких случаях 4; исключения допускаются для subject anchors и subject labels в multi-character синтаксисе (например 1girl, 1boy, subject_a).",
    "Порядок тегов: quality -> subject identity -> emotion/expression -> clothing/materials -> pose/framing -> camera -> lighting -> background -> technical cleanup.",
    "CONSISTENCY LOCKS (обязательны): key appearance traits, emotion/expression, outfit/materials, environment, scene conditions (time/weather/lighting).",
    "Все lock-детали из Image description должны перейти в prompt без потери смысла, но не перегружай prompt.",
    "Не подменяй lock-детали похожими, но другими по смыслу формулировками.",
    "Применяй locks строго по соответствующему участнику из participants, не смешивай признаки между субъектами.",
    "Для unknown external:* используй только subject_locks и описание сцены, без догадок из каталога персоны.",
    "type=person: используй детали персонажа из Image description + Appearance + LookPrompt cache.",
    "type=other_person: запрещено использовать Appearance и LookPrompt cache текущей персоны.",
    "type=no_person: строго без людей/лиц/персонажей; Appearance и LookPrompt cache запрещены.",
    "type=group: используй Appearance/LookPrompt cache только если participants включает persona:self или токен текущей персоны; иначе запрещено.",
    "Если в input явно сказано, что Appearance/LookPrompt cache disabled, НЕ используй их ни в каком виде.",
    "Одежда должна соответствовать ситуации!",
    "ОБЯЗАТЕЛЬНО!: описывай детали сцены досконально - вид, одежда, окружение, действия, фокус на определенных частях тела и тд.",
    "При конфликте: scene-specific детали (эмоция, одежда, окружение, условия) берутся из Image description; стабильная идентичность из Appearance применима только когда тип кадра это допускает.",
    "Не добавляй детали, которых нет в исходном описании (например пирсинг/тату/аксессуары/фетиш-атрибуты, если они не указаны).",
    "ВАЖНО: Старайся покрыть тегами переданный Image description по максимуму, но без противоречий, чтобы передать все описанные детали! При этом - не выходи за общие лимиты!",
    "Запрещено добавлять любые role/biography теги, которых нет в описании сцены (student, office worker, nurse и т.п.).",
    "Запрещены психологические/поведенческие/мотивационные ярлыки: narcissistic, exhibitionist, self-promotion, slang, casual language и т.п.",
    "Запрещены мета-теги платформ, намерений и нарратива.",
    "Запрещен quality spam: не более 4 quality/technical тегов суммарно.",
    "Избегай противоречий в кадрировании: не ставь одновременно full body и close-up.",
    "Если это selfie и не указан mirror full body, предпочитай upper body/waist-up framing.",
    "По описанию определяй сколько лиц участвует в сцене (для type=no_person людей должно быть 0).",
    "Используй solo/single subject/one person только когда в кадре один человек; для type=group используй multi-person теги; для type=no_person не добавляй людей вовсе.",
    "type=no_person: subject-блоки и person anchors полностью запрещены.",
    "Удали дубли и семантические дубли тегов.",
    "Запрещены взаимоисключающие теги (например black hair и blonde hair вместе).",
    "Если есть сомнение, лучше пропусти тег, не выдумывай.",
    "Учитывай свои границы дозволенного при генерации.",
    "Перед ответом сделай self-check: format delimiter, word count per tag, no duplicates, no contradictions, no banned tags, все ключевые детали из Image description покрыты.",
    "SELF-CHECK (critical): каждый subject_* блок должен быть ТОЛЬКО в экранированном виде subject_x \\( ... \\), вариант subject_x (...) запрещён.",
    "SELF-CHECK (critical): в каждом subject_* блоке обязательно присутствуют hair, eyes, body (и height, если он есть в subject_locks).",
    "SELF-CHECK (critical): в каждом subject_* блоке не более 8 персональных тегов.",
    "SELF-CHECK (critical): hair/eyes/body (и height при наличии) обязательно входят в weighted tags; дополнительно можно взвешивать только максимально важные теги сцены, суммарно не более 5 на subject-блок.",
  ].join("\n");

  const input = [
    `Character name: ${persona.name || "Unknown"}`,
    `Scene type (parsed): ${sceneContext.type}`,
    `Participants: ${sceneContext.participants}`,
    `Participant aliases: ${formatParticipantAliasesContext(sceneContext)}`,
    `Subject locks: ${formatSubjectLocksContext(sceneContext)}`,
    `Participant catalog:\n${participantCatalogContext}`,
    `Resolved participant appearance locks:\n${resolvedParticipantLocksContext}`,
    `Use persona appearance context: ${shouldUsePersonaContext ? "yes" : "no"}`,
    `Appearance: ${appearanceContext}`,
    `Style: ${persona.stylePrompt || "-"}`,
    `Personality: ${persona.personalityPrompt || "-"}`,
    `LookPrompt cache:\n${lookPromptCacheContext}`,
    `Image description: ${resolveResult.repairedDescription}`,
    `Iteration: ${iteration}`,
    `Contract repair attempts used: ${resolveResult.repairAttemptsUsed}`,
    "Applied persona evolution history (last 10):",
    evolutionHistoryContext,
  ].join("\n");

  const comfyPromptsToolConfig = createComfyPromptsFromDescriptionToolConfig();
  const runtime = await requestGenericToolRuntime(settings, {
    task: "image_prompt",
    request: {
      model: imagePromptModel,
      input,
      systemPrompt,
      maxOutputTokens: Math.max(180, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.35, Math.min(0.75, settings.temperature)),
      store: false,
    },
    ...comfyPromptsToolConfig,
  });

  return runtime.value.prompts;
}

export async function generateComfyPromptFromImageDescription(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "id"
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  imageDescription: string,
  iteration: number,
  options?: {
    participantCatalog?: ComfyPromptParticipantCatalogEntry[];
    evolutionHistoryApplied?: PersonaEvolutionHistoryItem[];
  },
): Promise<string> {
  const prompts = await generateComfyPromptsFromImageDescription(
    settings,
    persona,
    imageDescription,
    iteration,
    options,
  );
  const first = prompts[0]?.trim();
  if (!first) {
    throw new Error("Не удалось извлечь ComfyUI prompt из ответа модели.");
  }
  return first;
}

function fallbackThemeTags(topic: string): string[] {
  const normalized = topic
    .toLowerCase()
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[.;:!?()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return [];

  const rawParts = normalized
    .split(/[,\-\\/|]+/)
    .flatMap((part) => part.split(" "))
    .map((part) => part.trim())
    .filter(Boolean);
  const deduped = Array.from(new Set(rawParts));
  return deduped.slice(0, 8);
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

export interface ProviderModelCatalogTarget {
  provider: LlmProvider;
  baseUrl: string;
  auth: EndpointAuthConfig;
}

export function resolveProviderModelCatalogTarget(
  settings: AppSettings,
  provider: LlmProvider,
): ProviderModelCatalogTarget {
  return {
    provider,
    baseUrl: resolveProviderBaseUrl(settings, provider),
    auth: resolveProviderAuth(settings, provider),
  };
}

function toTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value).trim();
  }
  return "";
}

function resolveImagePromptModel(settings: AppSettings) {
  return (
    toTrimmedString(settings.imagePromptModel) ||
    toTrimmedString(settings.model)
  );
}

function resolvePersonaGenerationModel(settings: AppSettings) {
  return (
    toTrimmedString(settings.personaGenerationModel) ||
    toTrimmedString(settings.model)
  );
}

function encodeBase64(value: string) {
  try {
    return btoa(value);
  } catch {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
}

function buildAuthHeaders(auth: EndpointAuthConfig, legacyApiKey?: string) {
  const headers: Record<string, string> = {};
  const fallbackToken = legacyApiKey?.trim() ?? "";
  const token = auth.token.trim() || fallbackToken;

  if (auth.mode === "none") {
    if (fallbackToken) {
      headers.Authorization = `Bearer ${fallbackToken}`;
    }
    return headers;
  }

  if (auth.mode === "basic") {
    if (auth.username || auth.password) {
      headers.Authorization = `Basic ${encodeBase64(`${auth.username}:${auth.password}`)}`;
    }
    return headers;
  }

  if (auth.mode === "custom") {
    if (!token) return headers;
    const name = auth.headerName.trim() || "Authorization";
    const prefix = auth.headerPrefix.trim();
    headers[name] = prefix ? `${prefix} ${token}` : token;
    return headers;
  }

  if (!token) return headers;
  if (auth.mode === "token") {
    headers.Authorization = `Token ${token}`;
    return headers;
  }

  headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseModelKeys(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];

  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.data)) {
    return obj.data
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const id = (item as Record<string, unknown>).id;
        return typeof id === "string" ? id : "";
      })
      .filter(Boolean);
  }

  if (Array.isArray(obj.models)) {
    return obj.models
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const rec = item as Record<string, unknown>;
        const key = rec.model_key ?? rec.key ?? rec.id;
        return typeof key === "string" ? key : "";
      })
      .filter(Boolean);
  }

  return [];
}

export async function listModels(settings: {
  baseUrl: string;
  auth: EndpointAuthConfig;
  apiKey?: string;
}) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const headers = buildAuthHeaders(settings.auth, settings.apiKey);

  const endpoints = Array.from(
    new Set([
      `${baseUrl}/models`,
      `${baseUrl}/v1/models`,
      `${baseUrl}/api/v1/models`,
    ]),
  );
  let lastError = "Unknown error while loading models.";

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers });
      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`;
        continue;
      }
      const payload = (await response.json()) as unknown;
      const models = parseModelKeys(payload);
      if (models.length > 0) return models;
      lastError = "No models found in response.";
    } catch (error) {
      lastError = (error as Error).message;
    }
  }

  throw new Error(`Unable to load models: ${lastError}`);
}

function parseJsonBlock(text: string) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const chunk = trimmed.slice(start, end + 1);
      return JSON.parse(chunk) as unknown;
    }
    throw new Error("Не удалось распарсить JSON с карточками персонажей.");
  }
}

function normalizeGeneratedPersonas(data: unknown): GeneratedPersonaDraft[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const personalityPrompt =
        typeof rec.personalityPrompt === "string"
          ? rec.personalityPrompt.trim()
          : "";
      const appearancePrompt =
        typeof rec.appearancePrompt === "string"
          ? rec.appearancePrompt.trim()
          : "";
      const stylePrompt =
        typeof rec.stylePrompt === "string" ? rec.stylePrompt.trim() : "";
      const avatarUrl =
        typeof rec.avatarUrl === "string" ? rec.avatarUrl.trim() : "";
      const appearanceRaw =
        rec.appearance && typeof rec.appearance === "object"
          ? (rec.appearance as Partial<PersonaAppearanceProfile>)
          : undefined;
      const appearance: PersonaAppearanceProfile = {
        faceDescription: toTrimmedString(
          appearanceRaw?.faceDescription ?? appearancePrompt,
        ),
        height: toTrimmedString(appearanceRaw?.height),
        eyes: toTrimmedString(appearanceRaw?.eyes),
        lips: toTrimmedString(appearanceRaw?.lips),
        hair: toTrimmedString(appearanceRaw?.hair),
        ageType: toTrimmedString(appearanceRaw?.ageType),
        bodyType: toTrimmedString(appearanceRaw?.bodyType),
        markers: toTrimmedString(appearanceRaw?.markers),
        accessories: toTrimmedString(appearanceRaw?.accessories),
        clothingStyle: toTrimmedString(appearanceRaw?.clothingStyle),
        skin: toTrimmedString(appearanceRaw?.skin),
      };
      const advancedRaw =
        rec.advanced && typeof rec.advanced === "object"
          ? (rec.advanced as Partial<PersonaAdvancedProfile>)
          : undefined;
      if (!name) return null;
      const advanced = normalizeAdvancedProfile(
        advancedRaw ??
          buildAdvancedProfileFromLegacy({
            personalityPrompt,
            stylePrompt,
          }),
      );

      return {
        name,
        personalityPrompt,
        stylePrompt,
        appearance,
        advanced,
        avatarUrl,
      };
    })
    .filter((v): v is GeneratedPersonaDraft => Boolean(v));
}

export async function generatePersonaDrafts(
  settings: AppSettings,
  theme: string,
  count: number,
): Promise<GeneratedPersonaDraft[]> {
  const safeCount = Math.max(1, Math.min(6, Math.round(count)));
  const systemPrompt = [
    "Ты генератор карточек персонажей для ролевого AI-чата.",
    "Верни ТОЛЬКО JSON-массив без markdown и пояснений.",
    "Формат каждого элемента СТРОГО:",
    '{"name":"...","personalityPrompt":"...","stylePrompt":"...","avatarUrl":"","appearance":{"faceDescription":"...","height":"...","eyes":"...","lips":"...","hair":"...","ageType":"...","bodyType":"...","markers":"...","accessories":"...","clothingStyle":"...","skin":"..."},"advanced":{"core":{"archetype":"...","backstory":"...","goals":"...","values":"...","boundaries":"...","expertise":"...","selfGender":"auto|female|male|neutral"},"voice":{"tone":"...","lexicalStyle":"...","sentenceLength":"short|balanced|long","formality":0,"expressiveness":0,"emoji":0},"behavior":{"initiative":0,"empathy":0,"directness":0,"curiosity":0,"challenge":0,"creativity":0},"emotion":{"baselineMood":"calm|warm|playful|focused|analytical|inspired|annoyed|upset|angry","warmth":0,"stability":0,"positiveTriggers":"...","negativeTriggers":"..."},"memory":{"rememberFacts":true,"rememberPreferences":true,"rememberGoals":true,"rememberEvents":true,"maxMemories":24,"decayDays":30}}}',
    "Все числовые поля в диапазоне 0..100 (кроме maxMemories и decayDays).",
    "maxMemories: 4..120, decayDays: 1..365.",
    "Поля appearance обязательны и должны быть осмысленно заполнены.",
    "Пиши на русском языке.",
  ].join("\n");

  const input = [
    `Сгенерируй ${safeCount} разных персонажей.`,
    `Тема/контекст: ${theme || "универсальный собеседник"}.`,
    "У каждого должен быть уникальный характер, внешность и стиль речи и другие параметры.",
  ].join("\n");

  const response = await requestGenericChatCompletion(
    settings,
    "persona_generation",
    {
      model: resolvePersonaGenerationModel(settings),
      input,
      systemPrompt,
      maxOutputTokens: Math.max(settings.maxTokens, 500),
      temperature: Math.max(0.6, settings.temperature),
      store: false,
    },
  );
  const text = response.content.trim();

  if (!text) {
    throw new Error("Модель вернула пустой ответ при генерации личности.");
  }

  const parsed = parseJsonBlock(text);
  const personas = normalizeGeneratedPersonas(parsed);
  if (personas.length === 0) {
    throw new Error("Не удалось получить валидные карточки персонажей.");
  }
  return personas;
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeAmbiguousShotTags(prompt: string) {
  const tags = splitTags(prompt);
  const normalized: string[] = [];
  let replacedFullBodyTag = false;

  for (const tag of tags) {
    const key = tag.toLowerCase().replace(/\s+/g, " ").trim();
    if (key === "full body" || key === "fullbody" || key === "full-body") {
      replacedFullBodyTag = true;
      continue;
    }
    normalized.push(tag);
  }

  if (!replacedFullBodyTag) return normalized.join(", ");

  return mergeRequiredTags(normalized.join(", "), [
    "head-to-toe framing:1.4",
    "whole person framing:1.4",
    "long shot",
  ]);
}

function mergeRequiredTags(basePrompt: string, requiredTags: string[]) {
  const existing = splitTags(basePrompt);
  const existingLower = new Set(existing.map((tag) => tag.toLowerCase()));
  const normalizedRequired = requiredTags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !existingLower.has(tag.toLowerCase()));
  return [...normalizedRequired, ...existing].join(", ");
}

function parseLookPromptJson(
  text: string,
  payload?: PersonaLookPromptRequest,
): PersonaLookPromptResponse {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const chunk =
    jsonStart >= 0 && jsonEnd > jsonStart
      ? trimmed.slice(jsonStart, jsonEnd + 1)
      : trimmed;
  const parsed = JSON.parse(chunk) as Partial<PersonaLookPromptResponse>;

  let avatarPrompt = toTrimmedString(parsed.avatarPrompt);
  let fullBodyPrompt = toTrimmedString(parsed.fullBodyPrompt);
  const detailPromptsRaw =
    parsed.detailPrompts && typeof parsed.detailPrompts === "object"
      ? (parsed.detailPrompts as Partial<PersonaLookDetailPrompts>)
      : {};
  const identityLocksRaw =
    (parsed as Record<string, unknown>).identityLocks &&
    typeof (parsed as Record<string, unknown>).identityLocks === "object"
      ? ((parsed as Record<string, unknown>)
          .identityLocks as PersonaLookIdentityLocks)
      : {};
  const identityLocks = {
    face: toTrimmedString(identityLocksRaw.face),
    eyes: toTrimmedString(identityLocksRaw.eyes),
    hair: toTrimmedString(identityLocksRaw.hair),
    body: toTrimmedString(identityLocksRaw.body),
    outfit: toTrimmedString(identityLocksRaw.outfit),
  };

  if (payload) {
    const mustKeep = [
      identityLocks.hair,
      identityLocks.face,
      identityLocks.eyes,
      identityLocks.body,
    ].filter(Boolean);
    const mustKeepFullBody = [...mustKeep, identityLocks.outfit].filter(
      Boolean,
    );
    avatarPrompt = mergeRequiredTags(avatarPrompt, mustKeep);
    fullBodyPrompt = mergeRequiredTags(fullBodyPrompt, mustKeepFullBody);
  }

  fullBodyPrompt = normalizeAmbiguousShotTags(fullBodyPrompt);

  const detailPrompts: PersonaLookDetailPrompts = {
    face:
      toTrimmedString(detailPromptsRaw.face) ||
      "natural skin texture, clean facial symmetry, fine pores, realistic complexion, sharp facial details",
    eyes:
      toTrimmedString(detailPromptsRaw.eyes) ||
      "detailed iris, crisp eyelashes, balanced eyelids, clear sclera, natural eye highlights",
    nose:
      toTrimmedString(detailPromptsRaw.nose) ||
      "defined nose bridge, natural nostrils, smooth nose contour, realistic nose tip",
    lips:
      toTrimmedString(detailPromptsRaw.lips) ||
      "clean lip contour, soft lip texture, natural lip shading, detailed cupid bow",
    hands:
      toTrimmedString(detailPromptsRaw.hands) ||
      "anatomically correct hands, five fingers, clean nails, natural finger proportions, realistic knuckles",
  };

  if (!avatarPrompt || !fullBodyPrompt) {
    throw new Error(
      "Модель не вернула корректные prompts для avatar/fullbody/detailing.",
    );
  }

  return {
    avatarPrompt,
    fullBodyPrompt,
    detailPrompts,
  };
}

export async function generatePersonaLookPrompts(
  settings: AppSettings,
  payload: PersonaLookPromptRequest,
): Promise<PersonaLookPromptResponse> {
  const systemPrompt = [
    "Ты конвертер описаний внешности в ComfyUI prompts.",
    "Верни ТОЛЬКО JSON объект без markdown и пояснений.",
    'Формат строго: {"avatarPrompt":"...","fullBodyPrompt":"...","detailPrompts":{"face":"...","eyes":"...","nose":"...","lips":"...","hands":"..."},"identityLocks":{"face":"...","eyes":"...","hair":"...","body":"...","outfit":"..."}}',
    "Оба промпта должны быть только comma-separated English tags.",
    "detailPrompts.* также только comma-separated English tags.",
    "identityLocks.* также comma-separated English tags (короткие, конкретные).",
    "Каждый тег делай коротким и конкретным (обычно 2-4 слова), но самодостаточным.",
    "Каждый тег должен содержать объект признака (eyes/hair/lips/skin/face/body/outfit/boots/background и т.д.), а не только модификатор.",
    "Запрещены обрывки без объекта: 'large almond shaped', 'bright blue-violet color', 'soft skin texture' без указания части тела.",
    "Если указываешь форму/цвет глаз, пиши полный тег с объектом: 'almond-shaped eyes', 'blue-violet eyes'.",
    "Если указываешь волосы, губы, кожу, одежду — всегда добавляй объект в самом теге: 'wavy light-brown hair', 'full glossy lips', 'pale flawless skin', 'black low-cut dress'.",
    "Нельзя дробить один признак на 2 тега, если первый тег сам по себе невалиден. Каждый tag должен читаться отдельно и иметь смысл.",
    "КРИТИЧНО: избегай длинных перегруженных промптов и повторов.",
    "Жёстко запрещены дубликаты тегов и перефразированные дубликаты (например short bob haircut и bob haircut to shoulders одновременно без необходимости).",
    "Если тег уже передаёт признак, не добавляй второй тег с тем же смыслом.",
    "Лимит длины: avatarPrompt 26-40 тегов, fullBodyPrompt 30-46 тегов, detailPrompts.* 8-16 тегов.",
    "Формируй prompts по структуре и в этом порядке: quality -> identity locks (hair/face/eyes/body) -> outfit -> pose/framing -> background -> safety constraints.",
    "identityLocks.hair/face/eyes/body/outfit должны быть компактными и без дублей; avatarPrompt/fullBodyPrompt обязаны включать их без изменения смысла.",
    "Добавляй только теги, которые реально влияют на визуальный результат.",
    "Не добавляй шумовые или тавтологичные усилители качества сверх нужного минимума.",
    "Не выдумывай лишние детали. Используй только данные из Appearance/Style/Archetype.",
    "Если деталь не указана, оставляй нейтрально и безопасно (без экзотики и фетиш-элементов).",
    "Сначала зафиксируй identityLocks из входного описания (лицо/глаза/волосы/тело/outfit), затем строй avatar/fullBody вокруг них.",
    "Особый приоритет: прическа (hair). Точно фиксируй длину, укладку, пробор, текстуру и цвет волос.",
    "Прическа должна быть максимально консистентной между avatarPrompt и fullBodyPrompt.",
    "Если волосы указаны слабо, дополни только нейтрально (например neat hairstyle), но не меняй базовый цвет/длину.",
    "Сохраняй консистентность идентичности между avatarPrompt и fullBodyPrompt.",
    "Оба prompt должны описывать только одного человека: solo, single subject, без других людей в кадре.",
    "Запрещены посторонние персонажи, лишние руки/лица/тела, группы людей и странные анатомические артефакты.",
    "Запрещены коллажи/turnaround-sheet/несколько ракурсов в одном кадре: в одном prompt всегда один человек и один ракурс.",
    "Одежда, волосы, цвет глаз, возрастной тип, телосложение и отличительные детали должны быть одинаковыми в обоих prompt.",
    "В fullBodyPrompt явно фиксируй конкретный outfit (верх, низ, обувь/аксессуары при наличии), чтобы его можно было повторить без изменений в side/back.",
    "КРИТИЧНО: fullBodyPrompt должен описывать один воспроизводимый комплект одежды, а не общий стиль.",
    "Обязательная структура outfit для fullBodyPrompt: либо one-piece + footwear, либо top + bottom + footwear.",
    "Используй конкретные предметы одежды с атрибутами (цвет/материал/фасон), например: 'white fitted blouse, black pleated skirt, black ankle boots'.",
    "Запрещены абстрактные теги одежды без предметов: 'stylish outfit', 'casual clothes', 'fashion look' и подобные.",
    "Если вход не содержит явных предметов одежды, выбери нейтральный конкретный комплект самостоятельно и зафиксируй его одинаково в identityLocks.outfit и fullBodyPrompt.",
    "Запрещены теги/мотивы: nude, naked, topless, bottomless, no bra, no bottom и подобные.",
    "По умолчанию используй нормальную уместную одежду (casual wear, dress, suit, smart casual) без странных/фетиш/костюмных элементов.",
    "Если в описании нет явной тематики/роли, обязательно добавляй нейтральный повседневный гардероб и избегай эксцентричных костюмов.",
    "Тематическую/спец-одежду добавляй только если это прямо следует из описания персонажа (Appearance/Style/Archetype).",
    "Не добавляй провокационные/фетишные элементы гардероба, если они явно не запрошены в описании.",
    "Обязательно повторяй стабильные признаки лица/волос/глаз/телосложения/стиля.",
    "Hair-теги должны идти в начале обоих prompt (после quality-тегов), чтобы модель не теряла прическу.",
    "Если вход содержит конкретные черты лица/глаз/волос/роста/маркеров — они обязательны в обоих prompt.",
    "Рост добавляй аккуратно как нейтральный дескриптор пропорций (без фантазий).",
    "Разница между полями: avatarPrompt = close face portrait/head shot (лицо крупно в кадре); fullBodyPrompt = (head-to-toe framing:1.3), (full body view:1.3), (whole person frame:1.3).",
    "Для fullBodyPrompt всегда указывай clean/plain background (solid studio backdrop, no environment).",
    "Для fullBodyPrompt задавай спокойную нейтральную позу (neutral standing pose, relaxed posture, arms relaxed).",
    "Для avatarPrompt обязательно указывай внятный фон/окружение (например street, home interior, room, cafe, park), не оставляй пустой фон.",
    "detailPrompts.face описывает микродетали лица/кожи/пор/симметрии.",
    "detailPrompts.eyes описывает микродетали глаз/ресниц/взгляда.",
    "detailPrompts.nose описывает переносицу/кончик/крылья носа аккуратно и натурально.",
    "detailPrompts.lips описывает контур/текстуру губ натурально.",
    "detailPrompts.hands описывает аккуратные пальцы/ногти/анатомию кистей без лишних пальцев.",
    "В detailPrompts не добавляй сексуализированных тегов и NSFW; только нейтральные анатомические micro-details.",
    "Без противоречащих тегов и без описаний предложениями.",
    "Запрещено добавлять новые яркие атрибуты, которых нет во входе (например необычный цвет глаз/волос, специфический фетиш-гардероб, экстремальные черты).",
    "Перед ответом сделай self-check: убрать дубли, убрать противоречия, проверить наличие fully clothed/no nudity/no nsfw, проверить отсутствие запрещённых nudity/erotic тегов.",
  ].join("\n");

  const input = [
    `Name: ${payload.name || "Unknown"}`,
    `Personality: ${payload.personalityPrompt || "-"}`,
    `Appearance (full): ${formatAppearanceProfile(payload.appearance)}`,
    `Appearance.faceDescription: ${payload.appearance.faceDescription || "-"}`,
    `Appearance.height: ${payload.appearance.height || "-"}`,
    `Appearance.eyes: ${payload.appearance.eyes || "-"}`,
    `Appearance.lips: ${payload.appearance.lips || "-"}`,
    `Appearance.hair: ${payload.appearance.hair || "-"}`,
    `Appearance.skin: ${payload.appearance.skin || "-"}`,
    `Appearance.ageType: ${payload.appearance.ageType || "-"}`,
    `Appearance.bodyType: ${payload.appearance.bodyType || "-"}`,
    `Appearance.markers: ${payload.appearance.markers || "-"}`,
    `Appearance.accessories: ${payload.appearance.accessories || "-"}`,
    `Appearance.clothingStyle: ${payload.appearance.clothingStyle || "-"}`,
    `Style: ${payload.stylePrompt || "-"}`,
    `Archetype: ${payload.advanced.core.archetype || "-"}`,
    `Voice tone: ${payload.advanced.voice.tone || "-"}`,
    `Emotion baseline: ${payload.advanced.emotion.baselineMood || "-"}`,
    "Build two prompts for the same character identity.",
  ].join("\n");

  const response = await requestGenericChatCompletion(
    settings,
    "image_prompt",
    {
      model: resolveImagePromptModel(settings),
      input,
      systemPrompt,
      maxOutputTokens: Math.max(220, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.25, Math.min(0.55, settings.temperature)),
      store: false,
    },
  );
  const text = response.content.trim();

  if (!text) {
    throw new Error("Модель вернула пустой ответ для prompts внешности.");
  }

  return parseLookPromptJson(text, payload);
}
