import type {
  AppSettings,
  EndpointAuthConfig,
  LlmProvider,
  NativeChatResponse,
  Persona,
  PersonaAdvancedProfile,
  PersonaAppearanceProfile,
  PersonaLookPromptCache,
  PersonaRuntimeState,
} from "./types";
import type {
  LayeredMemoryContextCard,
  PersonaControlPayload,
} from "./personaDynamics";
import {
  buildAdvancedProfileFromLegacy,
  normalizeAdvancedProfile,
} from "./personaProfiles";
import { splitAssistantContent } from "./messageContent";
import {
  getToneUsageExamples,
  getExpressivenessBehavior,
  getDirectnessBehavior,
  getHumanizedMoodResponse,
  formatMemoryContextWithUsage,
  getValuesImplementation,
  getSocialInteractionRules,
} from "./personaBehaviors";

export interface ChatCompletionContext {
  runtimeState?: PersonaRuntimeState;
  memoryCard?: LayeredMemoryContextCard;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
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

function formatRecentMessages(
  recentMessages: ChatCompletionContext["recentMessages"] | undefined,
  userInput: string,
) {
  if (!recentMessages || recentMessages.length === 0) return userInput;

  const lines = [
    "КОНТЕКСТ ПОСЛЕДНИХ РЕПЛИК:",
    ...recentMessages.map(
      (message) =>
        `${message.role === "user" ? "Пользователь" : "Персона"}: ${message.content}`,
    ),
    "",
    "ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:",
    userInput,
  ];

  return lines.join("\n");
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

export function buildSystemPrompt(
  persona: Persona,
  settings: Pick<AppSettings, "userGender" | "userName">,
  context?: ChatCompletionContext,
) {
  const runtimeState = context?.runtimeState;
  const advanced = persona.advanced;

  const memories = [
    ...(context?.memoryCard?.shortTerm || []),
    ...(context?.memoryCard?.episodic.map((m) => m.content) || []),
    ...(context?.memoryCard?.longTerm.map((m) => m.content) || []),
  ];
  const memoryContext = formatMemoryContextWithUsage(memories);

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
    "",
    "Добавляй изображение только когда пользователь явно просит картинку/визуализацию.",
    "Не добавляй изображение в small talk и приветствиях.",
    "Решение о фото должно учитывать характер персонажа, её границы и текущую близость с пользователем.",
    "Если запрос на фото конфликтует с характером/настроением/границами или связь пока слабая — вежливо отказывай и предлагай безопасную альтернативу (описание, нейтральная сцена, другой формат).",
    "Например: Если персонаж застенчивая/закрытая и trust или relationshipDepth низкие — отказ на личные/интимные фото является нормальным и последовательным поведением.",
    "И еще пример: Если персонаж раскрепощённая/игривая и связь высокая — можно иногда самой предложить необычное, интересное или более смелое изображение, но только в рамках её границ и контекста диалога.",
    "Ты должен сам решать необходимость, но при этом учитывать пожелания пользователя, характер, статус, условия и прочие детали.",
    "Даже при проактивности не нарушай внутреннюю логику персонажа: одинаковые условия должны давать похожие решения.",
    "Частота изображений: не отправляй изображения слишком часто.",
    "Запрещено отправлять изображения в трех ответах подряд, если пользователь явно не попросил об этом.",
    "После отправки изображения выдерживай минимум 3 текстовых ответа до следующего изображения, если нет явного запроса пользователя.",
    "Проактивные изображения разрешены редко, чтобы разбавить диалог (примерно 1 раз на 7-10 ответов): уместны селфи, обстановка, ситуация и тому подобное.",
    "Проактивное изображение отправляй только если это естественно по контексту и действительно повышает вовлеченность.",
    "Если отказываешь в фото, не добавляй <comfyui_image_description> в этом ответе.",
    "Если изображения нужны, добавь по одному блоку <comfyui_image_description>...</comfyui_image_description> для каждого изображения (если их несколько) или один (если изображение нужно одно):",
    "<comfyui_image_description>",
    "Подробное описание желаемого кадра: кто в кадре, поза, выражение, одежда/материалы, фон, свет, ракурс, композиция, настроение, важные визуальные ограничения.",
    "</comfyui_image_description>",
    "",
    "Внутри comfyui_image_description используй только полезные для изображения детали, без мета-комментариев и без markdown.",
    "Используй только наблюдаемые визуальные факты, без психологических ярлыков и мотиваций (например: narcissistic, exhibitionist, self-promotion, casual language, slang).",
    "Не добавляй детали, которых нет в запросе пользователя или в описании внешности персонажа.",
    "КРИТИЧНО: сохраняй консистентность важных деталей между запросом и описанием кадра: ключевые черты внешности, эмоция/выражение, одежда и материалы, окружение, условия сцены (время суток/погода/свет).",
    "Если пользователь задал конкретные детали, не заменяй их синонимами с другим смыслом и не ослабляй их важность.",
    "Для консистентности внешности в каждом comfyui_image_description обязательно повторяй стабильные признаки персонажа из поля «Внешность» (волосы, цвет волос, глаза, возрастной тип, телосложение, отличительные детали).",
    "Не меняй базовую внешность между сообщениями без явной просьбы пользователя.",
    "Не добавляй взаимоисключающие теги (например одновременно blonde hair и black hair).",
    "Без markdown-оберток вокруг этого блока.",
    "",
    "После каждого ответа добавляй технический блок:",
    "<persona_control>",
    '{"intents":[],"state_delta":{"trust":0,"engagement":0,"energy":0,"lust":0,"fear":0,"affection":0,"tension":0,"mood":"calm","relationshipType":"neutral","relationshipDepth":0,"relationshipStage":"new"},"memory_add":[],"memory_remove":[]}',
    "</persona_control>",
    "Если изменений нет, оставь нули и пустые массивы. Без пояснений.",
    "Ты сама определяешь intents, state_delta и операции памяти (memory_add/memory_remove).",
    "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
    "Разрешённые relationshipType: neutral, friendship, romantic, mentor, playful.",
    "Разрешённые relationshipStage: new, acquaintance, friendly, close, bonded.",
    "Для state_delta используй небольшие шаги; избегай резких скачков.",
    "Лимиты дельт state_delta: trust [-8..+6], engagement [-8..+8], energy [-10..+10], lust [-8..+8], fear [-10..+10], affection [-8..+8], tension [-10..+10], relationshipDepth [-6..+6].",
    "Обычно предпочитай мягкие изменения в диапазоне -3..+3, если контекст не требует иного.",
    "relationshipType и relationshipStage меняй редко и только при явных основаниях в диалоге.",
    "Для фактов/предпочтений/целей пользователя добавляй memory_add с kind=fact|preference|goal.",
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
    getDirectnessBehavior(advanced.behavior.directness),
    `Любопытство: ${advanced.behavior.curiosity}/100`,
    `Креативность: ${advanced.behavior.creativity}/100`,
    "",
    "=== EMOTION & RUNTIME ===",
    `Базовое настроение: ${advanced.emotion.baselineMood}`,
    `Теплота: ${advanced.emotion.warmth}/100`,
    `Стабильность: ${advanced.emotion.stability}/100`,
    runtimeState
      ? `Текущее состояние: mood=${runtimeState.mood}; trust=${runtimeState.trust}; energy=${runtimeState.energy}; engagement=${runtimeState.engagement}; lust=${runtimeState.lust}; fear=${runtimeState.fear}; affection=${runtimeState.affection}; tension=${runtimeState.tension}; relationshipType=${runtimeState.relationshipType}; relationshipDepth=${runtimeState.relationshipDepth}; stage=${runtimeState.relationshipStage}.`
      : "Текущее состояние: нет данных, начни нейтрально-тепло.",
    "",
    "=== MEMORY CONTEXT ===",
    memoryContext,
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
    "Учитывай имя пользователя в обращении и персонализации ответа.",
    "Учитывай пол пользователя в обращении и согласовании форм.",
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
}

export type ModelRoutingTask =
  | "one_to_one_chat"
  | "group_orchestrator"
  | "group_persona"
  | "image_prompt"
  | "persona_generation";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";

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

async function requestProviderChatCompletion(
  settings: AppSettings,
  provider: LlmProvider,
  request: Required<GenericChatRequest>,
) {
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
    const payload: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      system_prompt: request.systemPrompt,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      store: request.store,
    };
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

    return {
      content: text,
      responseId: data.response_id,
      raw: data,
    };
  }

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

  return {
    content,
    responseId: typeof data.id === "string" ? data.id : undefined,
    raw: data,
  };
}

export async function requestGenericChatCompletion(
  settings: AppSettings,
  task: ModelRoutingTask,
  request: GenericChatRequest,
) {
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

export async function requestChatCompletion(
  settings: AppSettings,
  persona: Persona,
  userInput: string,
  previousResponseId?: string,
  context?: ChatCompletionContext,
): Promise<NativeChatResult> {
  const response = await requestGenericChatCompletion(
    settings,
    "one_to_one_chat",
    {
      model: settings.model,
      input: formatRecentMessages(context?.recentMessages, userInput),
      systemPrompt: buildSystemPrompt(persona, settings, context),
      maxOutputTokens: settings.maxTokens,
      temperature: settings.temperature,
      store: true,
      previousResponseId,
    },
  );

  const rawContent = response.content.trim();
  const {
    visibleText,
    comfyPrompt,
    comfyPrompts,
    comfyImageDescription,
    comfyImageDescriptions,
    personaControl,
  } = splitAssistantContent(rawContent);
  const sanitizedContent = sanitizeAssistantText(visibleText);
  const sanitizedComfyPrompts =
    comfyPrompts && comfyPrompts.length > 0
      ? comfyPrompts
      : comfyPrompt
        ? [comfyPrompt]
        : [];
  const sanitizedImageDescriptions =
    comfyImageDescriptions && comfyImageDescriptions.length > 0
      ? comfyImageDescriptions
      : comfyImageDescription
        ? [comfyImageDescription]
        : [];
  const sanitizedComfyPrompt = sanitizedComfyPrompts[0];
  const sanitizedImageDescription = sanitizedImageDescriptions[0];
  const filteredImageOnlyResponse =
    !sanitizedContent &&
    sanitizedComfyPrompts.length === 0 &&
    sanitizedImageDescriptions.length === 0 &&
    !personaControl &&
    Boolean(
      comfyPrompt ||
      (comfyPrompts && comfyPrompts.length > 0) ||
      comfyImageDescription ||
      (comfyImageDescriptions && comfyImageDescriptions.length > 0),
    );
  const fallbackContent = filteredImageOnlyResponse
    ? "Могу отправить изображение по явному запросу. Опиши, что именно нужно сгенерировать."
    : "";
  const finalContent = sanitizedContent || fallbackContent;

  if (
    !finalContent &&
    sanitizedComfyPrompts.length === 0 &&
    sanitizedImageDescriptions.length === 0 &&
    !personaControl
  ) {
    throw new Error("LMStudio returned an empty response.");
  }

  return {
    content: finalContent,
    comfyPrompt: sanitizedComfyPrompt,
    comfyPrompts:
      sanitizedComfyPrompts.length > 0 ? sanitizedComfyPrompts : undefined,
    comfyImageDescription: sanitizedImageDescription,
    comfyImageDescriptions:
      sanitizedImageDescriptions.length > 0
        ? sanitizedImageDescriptions
        : undefined,
    personaControl,
    responseId: response.responseId,
  };
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
  const systemPrompt = [
    "Ты генератор одного ComfyUI prompt для изображения персонажа.",
    "Ответ должен содержать ровно два блока без markdown: сначала <theme_tags>...</theme_tags>, затем <comfyui_prompt>...</comfyui_prompt>.",
    "В блоке <theme_tags> верни 8-12 кратких comma-separated English tags, которые напрямую описывают тему/контекст кадра.",
    "theme_tags должны быть конкретными (локация, роль, действие, атмосфера) и не противоречить теме.",
    "Внутри ОБОИХ блоков разрешены ТОЛЬКО comma-separated English tags.",
    "Формат внутри блоков: строго одна строка, разделитель строго ', ' (запятая + пробел), без переносов.",
    "Каждый тег: строго 1-2 слова, в редких случаях допускается 3; lowercase, без точки в конце.",
    "ЗАПРЕЩЕНО: полные предложения, художественные описания, markdown, двоеточия с пояснениями, нумерация, буллеты, кавычки.",
    "ЗАПРЕЩЕНО: конструкции типа 'a woman standing...', 'she is...', 'this scene shows...'.",
    "ЗАПРЕЩЕНО добавлять теги, которых нет в теме/внешности (никаких выдуманных тату, пирсингов, фетиш-элементов, ролей).",
    "ЗАПРЕЩЕНО: психологические/мотивационные ярлыки (exhibitionist, narcissistic, voyeuristic, self-promotion).",
    "Правильный стиль: 'solo, one person, upper body, soft rim light, city street at night'.",
    "Определяй количество действующих лиц из тематики.",
    "Описывай строго одного человека (solo, single subject, one person) или нескольких если описание (тематика) этого требует.",
    "Сохраняй идентичность персонажа: волосы, глаза, возрастной тип, телосложение, общий стиль.",
    "Если в input есть блок LookPrompt cache, используй его как identity prior: hair/face/eyes/body/outfit-теги приоритетны и помогают держать консистентность.",
    "Из LookPrompt cache можно брать только стабильные identity/outfit детали, но не добавляй лишние детали, которых нет в теме.",
    "Все теги из <theme_tags> ОБЯЗАТЕЛЬНО должны присутствовать в <comfyui_prompt> без потери смысла.",
    "Используй уместную одежду, если тема не требует специального костюма.",
    "Добавляй композицию, свет, фон, ракурс, качество.",
    "Перед отправкой проверь self-check: если в тексте есть глагольные формы/длинные фразы, перепиши в теговый формат.",
    "Без пояснений вне блока.",
  ].join("\n");

  const input = [
    `Character name: ${persona.name || "Unknown"}`,
    `Appearance: ${formatAppearanceProfile(persona.appearance)}`,
    `Style: ${persona.stylePrompt || "-"}`,
    `Personality: ${persona.personalityPrompt || "-"}`,
    `LookPrompt cache:\n${formatLookPromptCacheInput(persona.lookPromptCache)}`,
    `Theme: ${topic}`,
    `Iteration: ${iteration}`,
    "Generate one unique prompt variation for this iteration.",
  ].join("\n");

  const response = await requestGenericChatCompletion(
    settings,
    "image_prompt",
    {
      model: resolveImagePromptModel(settings),
      input,
      systemPrompt,
      maxOutputTokens: Math.max(180, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.35, Math.min(0.75, settings.temperature)),
      store: false,
    },
  );
  const text = response.content.trim();

  if (!text) {
    throw new Error("Модель вернула пустой comfy prompt.");
  }

  const parsed = splitAssistantContent(text);
  const prompt = toTrimmedString(
    parsed.comfyPrompts?.[0] ?? parsed.comfyPrompt,
  );
  const themeTags = extractThemeTags(text, topic);
  if (prompt) {
    return mergeRequiredTags(prompt, themeTags);
  }

  const fallbackPrompt = text
    .replace(/<\/?comfyui_prompt>/gi, "")
    .replace(/<\/?theme_tags>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return mergeRequiredTags(fallbackPrompt, themeTags);
}

export async function generateComfyPromptsFromImageDescription(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  imageDescription: string,
  iteration: number,
): Promise<string[]> {
  const description = toTrimmedString(imageDescription);
  if (!description) {
    throw new Error(
      "Пустое описание изображения для генерации ComfyUI prompt.",
    );
  }

  const systemPrompt = [
    "Ты конвертер описания сцены в список ComfyUI prompts.",
    "Верни один или несколько блоков <comfyui_prompt>...</comfyui_prompt> без markdown и пояснений.",
    "Если описание содержит несколько кадров/изображений (например: «первое изображение», «второе изображение», «image 1», «image 2»), верни отдельный <comfyui_prompt> для каждого кадра.",
    "Если описание одного кадра, верни только один блок.",
    "Внутри блока только comma-separated English tags (никаких предложений).",
    "Формат внутри блока: строго ОДНА строка, разделитель строго и обязательно должен быть ', ' (запятая + пробел), без переносов и без лишних пробелов.",
    "Длина prompt: 30-46 тегов.",
    "Каждый тег: строго 2-3 слова, в редких случаях допускается 4; тег должен быть визуально наблюдаемым.",
    "Порядок тегов: quality -> subject identity -> emotion/expression -> clothing/materials -> pose/framing -> camera -> lighting -> background -> technical cleanup.",
    "CONSISTENCY LOCKS (обязательны): key appearance traits, emotion/expression, outfit/materials, environment, scene conditions (time/weather/lighting).",
    "Все lock-детали из Image description должны перейти в prompt без потери смысла, но не перегружай prompt.",
    "Не подменяй lock-детали похожими, но другими по смыслу формулировками.",
    "Для персонажа используй ТОЛЬКО детали из Image description + Appearance.",
    "Если в input есть LookPrompt cache, используй его как identity prior для стабильных черт (hair/face/eyes/body/outfit), но scene-specific детали бери из Image description.",
    "LookPrompt cache НЕ должен ломать требования Image description по эмоции/сцене/условиям.",
    "Одежда должна соответствовать ситуации!",
    "ОБЯЗАТЕЛЬНО!: описывай детали сцены досконально - вид, одежда, окружение, действия, фокус на определенных частях тела и тд.",
    "При конфликте: scene-specific детали (эмоция, одежда, окружение, условия) берутся из Image description; стабильная идентичность (волосы/глаза/возрастной тип/телосложение) — из Appearance.",
    "Не добавляй детали, которых нет в исходном описании (например пирсинг/тату/аксессуары/фетиш-атрибуты, если они не указаны).",
    "ВАЖНО: Старайся покрыть тегами переданный Image description по максимуму, но без противоречий, чтобы передать все описанные детали! При этом - не выходи за общие лимиты!",
    "Запрещено добавлять любые role/biography теги, которых нет в описании сцены (student, office worker, nurse и т.п.).",
    "Запрещены психологические/поведенческие/мотивационные ярлыки: narcissistic, exhibitionist, self-promotion, slang, casual language и т.п.",
    "Запрещены мета-теги платформ, намерений и нарратива.",
    "Запрещен quality spam: не более 4 quality/technical тегов суммарно.",
    "Избегай противоречий в кадрировании: не ставь одновременно full body и close-up.",
    "Если это selfie и не указан mirror full body, предпочитай upper body/waist-up framing.",
    "По описанию определяй сколько лиц участвует в сцене.",
    "Описывай одного человека (solo, single subject, one person), или сразу нескольких если описание этого требует.",
    "Удали дубли и семантические дубли тегов.",
    "Запрещены взаимоисключающие теги (например black hair и blonde hair вместе).",
    "Если есть сомнение, лучше пропусти тег, не выдумывай.",
    "Перед ответом сделай self-check: format delimiter, word count per tag, no duplicates, no contradictions, no banned tags, все ключевые детали из Image description покрыты.",
  ].join("\n");

  const input = [
    `Character name: ${persona.name || "Unknown"}`,
    `Appearance: ${formatAppearanceProfile(persona.appearance)}`,
    `Style: ${persona.stylePrompt || "-"}`,
    `Personality: ${persona.personalityPrompt || "-"}`,
    `LookPrompt cache:\n${formatLookPromptCacheInput(persona.lookPromptCache)}`,
    `Image description: ${description}`,
    `Iteration: ${iteration}`,
  ].join("\n");

  const response = await requestGenericChatCompletion(
    settings,
    "image_prompt",
    {
      model: resolveImagePromptModel(settings),
      input,
      systemPrompt,
      maxOutputTokens: Math.max(180, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.35, Math.min(0.75, settings.temperature)),
      store: false,
    },
  );
  const text = response.content.trim();
  if (!text) {
    throw new Error("Модель вернула пустой comfy prompt из описания.");
  }

  const parsed = splitAssistantContent(text);
  const parsedPrompts = (
    parsed.comfyPrompts && parsed.comfyPrompts.length > 0
      ? parsed.comfyPrompts
      : parsed.comfyPrompt
        ? [parsed.comfyPrompt]
        : []
  )
    .map((item) => toTrimmedString(item))
    .filter(Boolean);
  if (parsedPrompts.length > 0) return parsedPrompts;

  const tagMatches = Array.from(
    text.matchAll(/<comfyui_prompt\b[^>]*>([\s\S]*?)<\/comfyui_prompt>/gi),
  )
    .map((match) => toTrimmedString(match[1]))
    .filter(Boolean);
  if (tagMatches.length > 0) return tagMatches;

  const fallbackPrompt = text
    .replace(/<\/?comfyui_prompt>/gi, "")
    .replace(/<\/?comfyui_image_description>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (fallbackPrompt) return [fallbackPrompt];

  throw new Error("Не удалось извлечь ComfyUI prompt из ответа модели.");
}

export async function generateComfyPromptFromImageDescription(
  settings: AppSettings,
  persona: Pick<
    Persona,
    | "name"
    | "appearance"
    | "stylePrompt"
    | "personalityPrompt"
    | "lookPromptCache"
  >,
  imageDescription: string,
  iteration: number,
): Promise<string> {
  const prompts = await generateComfyPromptsFromImageDescription(
    settings,
    persona,
    imageDescription,
    iteration,
  );
  const first = prompts[0]?.trim();
  if (!first) {
    throw new Error("Не удалось извлечь ComfyUI prompt из ответа модели.");
  }
  return first;
}

function extractThemeTags(text: string, topic: string): string[] {
  const direct = extractTaggedBlock(text, "theme_tags");
  const parsedDirect = splitTags(direct || "");
  if (parsedDirect.length > 0) return parsedDirect;
  return fallbackThemeTags(topic);
}

function extractTaggedBlock(text: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(pattern);
  return toTrimmedString(match?.[1]);
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
