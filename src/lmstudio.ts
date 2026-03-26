import type {
  AppSettings,
  EndpointAuthConfig,
  NativeChatResponse,
  Persona,
  PersonaAdvancedProfile,
  PersonaAppearanceProfile,
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

export function buildSystemPrompt(
  persona: Persona,
  settings: Pick<AppSettings, "userGender">,
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
    "Если отказываешь в фото, не добавляй <comfyui_prompt> в этом ответе.",
    "Если изображения нужны, добавь по одному блоку <comfyui_prompt>...</comfyui_prompt> для каждого изображения (если их несколько) или один (если изображение нужно одно):",
    "<comfyui_prompt>",
    'ultra detailed comma-separated tags in English (1-2 words per tag), e.g. "1girl, blonde hair, long hair, blue eyes, white dress, soft lighting, looking at viewer, close-up"',
    "describe as much of details (clothes, no clothes, expressions, poses, background, lighting, camera angle, etc.) as possible",
    "</comfyui_prompt>",
    "",
    "Формат ComfyUI prompt: только теги через запятую, без предложений и без пояснений.",
    "Каждый тег должен быть коротким (обычно 1-2 слова), конкретным и визуально наблюдаемым.",
    "Добавляй много деталей: субъект, поза, ракурс, композиция, свет, фон, стиль, материалы, эмоция, качество.",
    "Для консистентности внешности в каждом comfyui_prompt обязательно повторяй стабильные признаки персонажа из поля «Внешность» (волосы, цвет волос, глаза, возрастной тип, телосложение, отличительные детали).",
    "Не меняй базовую внешность между сообщениями без явной просьбы пользователя.",
    "Не добавляй взаимоисключающие теги (например одновременно blonde hair и black hair).",
    "Без markdown-оберток вокруг этого блока.",
    "",
    "После каждого ответа добавляй технический блок:",
    "<persona_control>",
    '{"intents":[],"state_delta":{"trust":0,"engagement":0,"energy":0,"mood":"calm","relationshipType":"neutral","relationshipDepth":0,"relationshipStage":"new"},"memory_add":[],"memory_remove":[]}',
    "</persona_control>",
    "Если изменений нет, оставь нули и пустые массивы. Без пояснений.",
    "Ты сама определяешь intents, state_delta и операции памяти (memory_add/memory_remove).",
    "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
    "Разрешённые relationshipType: neutral, friendship, romantic, mentor, playful.",
    "Разрешённые relationshipStage: new, acquaintance, friendly, close, bonded.",
    "Для state_delta используй небольшие шаги; избегай резких скачков.",
    "Лимиты дельт state_delta: trust [-8..+6], engagement [-8..+8], energy [-10..+10], relationshipDepth [-6..+6].",
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
      ? `Текущее состояние: mood=${runtimeState.mood}; trust=${runtimeState.trust}; energy=${runtimeState.energy}; engagement=${runtimeState.engagement}; relationshipType=${runtimeState.relationshipType}; relationshipDepth=${runtimeState.relationshipDepth}; stage=${runtimeState.relationshipStage}.`
      : "Текущее состояние: нет данных, начни нейтрально-тепло.",
    "",
    "=== MEMORY CONTEXT ===",
    memoryContext,
    "",
    "=== RESPONSE POLICY ===",
    "Сохраняй консистентность характера между ответами.",
    moodExpressionRule(runtimeState),
    energyExpressionRule(runtimeState),
    relationshipExpressionRule(runtimeState),
    "Если вопрос неясен, задай 1 уточняющий вопрос.",
    personaSelfGenderRule(persona),
    `Пол пользователя: ${userGenderLabel(settings.userGender)}.`,
    "Учитывай пол пользователя в обращении и согласовании форм.",
    "Не показывай persona_control пользователю как часть обычного текста.",
  ].join("\n");
}

interface NativeChatResult {
  content: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  personaControl?: PersonaControlPayload;
  responseId?: string;
}

export async function requestChatCompletion(
  settings: AppSettings,
  persona: Persona,
  userInput: string,
  previousResponseId?: string,
  context?: ChatCompletionContext,
): Promise<NativeChatResult> {
  const baseUrl = settings.lmBaseUrl.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/v1/chat`;

  const payload: Record<string, unknown> = {
    model: settings.model,
    input: formatRecentMessages(context?.recentMessages, userInput),
    system_prompt: buildSystemPrompt(persona, settings, context),
    max_output_tokens: settings.maxTokens,
    temperature: settings.temperature,
    store: true,
  };
  if (previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(settings.lmAuth, settings.apiKey),
  };

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
  const messageChunks = data.output
    .filter((item) => item.type === "message")
    .map((item) => item.content?.trim() ?? "")
    .filter(Boolean);
  const rawContent = messageChunks.join("\n\n");
  const { visibleText, comfyPrompt, comfyPrompts, personaControl } =
    splitAssistantContent(rawContent);
  const sanitizedContent = sanitizeAssistantText(visibleText);
  const sanitizedComfyPrompts =
    comfyPrompts && comfyPrompts.length > 0
      ? comfyPrompts
      : comfyPrompt
        ? [comfyPrompt]
        : [];
  const sanitizedComfyPrompt = sanitizedComfyPrompts[0];
  const filteredImageOnlyResponse =
    !sanitizedContent &&
    sanitizedComfyPrompts.length === 0 &&
    !personaControl &&
    Boolean(comfyPrompt || (comfyPrompts && comfyPrompts.length > 0));
  const fallbackContent = filteredImageOnlyResponse
    ? "Могу отправить изображение по явному запросу. Опиши, что именно нужно сгенерировать."
    : "";
  const finalContent = sanitizedContent || fallbackContent;

  if (!finalContent && sanitizedComfyPrompts.length === 0 && !personaControl) {
    throw new Error("LMStudio returned an empty response.");
  }

  return {
    content: finalContent,
    comfyPrompt: sanitizedComfyPrompt,
    comfyPrompts:
      sanitizedComfyPrompts.length > 0 ? sanitizedComfyPrompts : undefined,
    personaControl,
    responseId: data.response_id,
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

export interface PersonaLookPromptResponse {
  avatarPrompt: string;
  fullBodyPrompt: string;
}

export async function generateThemedComfyPrompt(
  settings: AppSettings,
  persona: Pick<
    Persona,
    "name" | "appearance" | "stylePrompt" | "personalityPrompt"
  >,
  topic: string,
  iteration: number,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.lmBaseUrl);
  const endpoint = `${baseUrl}/api/v1/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(settings.lmAuth, settings.apiKey),
  };

  const systemPrompt = [
    "Ты генератор одного ComfyUI prompt для изображения персонажа.",
    "Ответ должен содержать только один блок <comfyui_prompt>...</comfyui_prompt> без markdown.",
    "Внутри блока только comma-separated English tags.",
    "Описывай строго одного человека (solo, single subject, one person).",
    "Сохраняй идентичность персонажа: волосы, глаза, возрастной тип, телосложение, общий стиль.",
    "Используй уместную одежду, если тема не требует специального костюма.",
    "Добавляй композицию, свет, фон, ракурс, качество.",
    "Без пояснений вне блока.",
  ].join("\n");

  const input = [
    `Character name: ${persona.name || "Unknown"}`,
    `Appearance: ${formatAppearanceProfile(persona.appearance)}`,
    `Style: ${persona.stylePrompt || "-"}`,
    `Personality: ${persona.personalityPrompt || "-"}`,
    `Theme: ${topic}`,
    `Iteration: ${iteration}`,
    "Generate one unique prompt variation for this iteration.",
  ].join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      input,
      system_prompt: systemPrompt,
      max_output_tokens: Math.max(180, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.5, Math.min(1, settings.temperature)),
      store: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ошибка генерации comfy prompt (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as NativeChatResponse;
  const text = data.output
    .filter((item) => item.type === "message")
    .map((item) => item.content ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Модель вернула пустой comfy prompt.");
  }

  const parsed = splitAssistantContent(text);
  const prompt = (parsed.comfyPrompts?.[0] ?? parsed.comfyPrompt ?? "").trim();
  if (prompt) return prompt;

  return text
    .replace(/<\/?comfyui_prompt>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
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

export async function listModels(
  settings: Pick<AppSettings, "lmBaseUrl" | "apiKey" | "lmAuth">,
) {
  const baseUrl = normalizeBaseUrl(settings.lmBaseUrl);
  const headers = buildAuthHeaders(settings.lmAuth, settings.apiKey);

  const endpoints = [`${baseUrl}/api/v1/models`, `${baseUrl}/v1/models`];
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
        faceDescription: (
          appearanceRaw?.faceDescription ??
          appearancePrompt ??
          ""
        ).trim(),
        eyes: (appearanceRaw?.eyes ?? "").trim(),
        lips: (appearanceRaw?.lips ?? "").trim(),
        hair: (appearanceRaw?.hair ?? "").trim(),
        ageType: (appearanceRaw?.ageType ?? "").trim(),
        bodyType: (appearanceRaw?.bodyType ?? "").trim(),
        markers: (appearanceRaw?.markers ?? "").trim(),
        accessories: (appearanceRaw?.accessories ?? "").trim(),
        clothingStyle: (appearanceRaw?.clothingStyle ?? "").trim(),
        skin: (appearanceRaw?.skin ?? "").trim(),
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
  const baseUrl = normalizeBaseUrl(settings.lmBaseUrl);
  const endpoint = `${baseUrl}/api/v1/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(settings.lmAuth, settings.apiKey),
  };

  const safeCount = Math.max(1, Math.min(6, Math.round(count)));
  const systemPrompt = [
    "Ты генератор карточек персонажей для ролевого AI-чата.",
    "Верни ТОЛЬКО JSON-массив без markdown и пояснений.",
    "Формат каждого элемента:",
    '{"name":"...","personalityPrompt":"...","stylePrompt":"...","avatarUrl":"","appearance":{"faceDescription":"...","eyes":"...","lips":"...","hair":"...","ageType":"...","bodyType":"...","markers":"...","accessories":"...","clothingStyle":"...","skin":"..."},"advanced":{"core":{"archetype":"...","backstory":"...","goals":"...","values":"...","boundaries":"...","expertise":"...","selfGender":"auto|female|male|neutral"},"voice":{"tone":"...","lexicalStyle":"...","sentenceLength":"short|balanced|long","formality":0,"expressiveness":0,"emoji":0},"behavior":{"initiative":0,"empathy":0,"directness":0,"curiosity":0,"challenge":0,"creativity":0},"emotion":{"baselineMood":"calm|warm|playful|focused|analytical|inspired|annoyed|upset|angry","warmth":0,"stability":0,"positiveTriggers":"...","negativeTriggers":"..."},"memory":{"rememberFacts":true,"rememberPreferences":true,"rememberGoals":true,"rememberEvents":true,"maxMemories":24,"decayDays":30}}}',
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      input,
      system_prompt: systemPrompt,
      max_output_tokens: Math.max(settings.maxTokens, 500),
      temperature: Math.max(0.6, settings.temperature),
      store: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ошибка генерации персонажей (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as NativeChatResponse;
  const text = data.output
    .filter((item) => item.type === "message")
    .map((item) => item.content ?? "")
    .join("\n")
    .trim();

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

function parseLookPromptJson(text: string): PersonaLookPromptResponse {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const chunk =
    jsonStart >= 0 && jsonEnd > jsonStart
      ? trimmed.slice(jsonStart, jsonEnd + 1)
      : trimmed;
  const parsed = JSON.parse(chunk) as Partial<PersonaLookPromptResponse>;

  const avatarPrompt = (parsed.avatarPrompt ?? "").trim();
  const fullBodyPrompt = (parsed.fullBodyPrompt ?? "").trim();

  if (!avatarPrompt || !fullBodyPrompt) {
    throw new Error(
      "Модель не вернула корректные prompts для avatar/fullbody.",
    );
  }

  return {
    avatarPrompt,
    fullBodyPrompt,
  };
}

export async function generatePersonaLookPrompts(
  settings: AppSettings,
  payload: PersonaLookPromptRequest,
): Promise<PersonaLookPromptResponse> {
  const baseUrl = normalizeBaseUrl(settings.lmBaseUrl);
  const endpoint = `${baseUrl}/api/v1/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(settings.lmAuth, settings.apiKey),
  };

  const systemPrompt = [
    "Ты конвертер описаний внешности в ComfyUI prompts.",
    "Верни ТОЛЬКО JSON объект без markdown и пояснений.",
    'Формат строго: {"avatarPrompt":"...","fullBodyPrompt":"..."}',
    "Оба промпта должны быть только comma-separated English tags.",
    "Каждый тег короткий (1-2 слова), конкретный и визуальный.",
    "Сохраняй консистентность идентичности между avatarPrompt и fullBodyPrompt.",
    "Оба prompt должны описывать только одного человека: solo, single subject, без других людей в кадре.",
    "Запрещены посторонние персонажи, лишние руки/лица/тела, группы людей и странные анатомические артефакты.",
    "Запрещены коллажи/turnaround-sheet/несколько ракурсов в одном кадре: в одном prompt всегда один человек и один ракурс.",
    "Одежда, волосы, цвет глаз, возрастной тип, телосложение и отличительные детали должны быть одинаковыми в обоих prompt.",
    "В fullBodyPrompt явно фиксируй конкретный outfit (верх, низ, обувь/аксессуары при наличии), чтобы его можно было повторить без изменений в side/back.",
    "По умолчанию используй нормальную уместную одежду (casual wear, dress, suit, smart casual) без странных/фетиш/костюмных элементов.",
    "Если в описании нет явной тематики/роли, обязательно добавляй нейтральный повседневный гардероб и избегай эксцентричных костюмов.",
    "Тематическую/спец-одежду добавляй только если это прямо следует из описания персонажа (Appearance/Style/Archetype).",
    "Не добавляй провокационные/фетишные элементы гардероба, если они явно не запрошены в описании.",
    "Обязательно повторяй стабильные признаки лица/волос/глаз/телосложения/стиля.",
    "Разница между полями: avatarPrompt = close face portrait/headshot (лицо крупно в кадре); fullBodyPrompt = full body.",
    "Для fullBodyPrompt всегда указывай clean/plain background (solid studio backdrop, no environment).",
    "Для fullBodyPrompt задавай спокойную нейтральную позу (neutral standing pose, relaxed posture, arms relaxed).",
    "Для avatarPrompt обязательно указывай внятный фон/окружение (например street, home interior, room, cafe, park), не оставляй пустой фон.",
    "Без противоречащих тегов и без описаний предложениями.",
  ].join("\n");

  const input = [
    `Name: ${payload.name || "Unknown"}`,
    `Personality: ${payload.personalityPrompt || "-"}`,
    `Appearance: ${formatAppearanceProfile(payload.appearance)}`,
    `Style: ${payload.stylePrompt || "-"}`,
    `Archetype: ${payload.advanced.core.archetype || "-"}`,
    `Voice tone: ${payload.advanced.voice.tone || "-"}`,
    `Emotion baseline: ${payload.advanced.emotion.baselineMood || "-"}`,
    "Build two prompts for the same character identity.",
  ].join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      input,
      system_prompt: systemPrompt,
      max_output_tokens: Math.max(220, Math.min(700, settings.maxTokens)),
      temperature: Math.max(0.4, Math.min(0.9, settings.temperature)),
      store: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ошибка генерации prompt'ов внешности (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as NativeChatResponse;
  const text = data.output
    .filter((item) => item.type === "message")
    .map((item) => item.content ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Модель вернула пустой ответ для prompts внешности.");
  }

  return parseLookPromptJson(text);
}
