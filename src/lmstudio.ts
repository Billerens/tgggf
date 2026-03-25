import type {
  AppSettings,
  NativeChatResponse,
  Persona,
  PersonaAdvancedProfile,
  PersonaSelfGender,
  PersonaRuntimeState,
} from "./types";
import type { LayeredMemoryContextCard, PersonaControlPayload } from "./personaDynamics";
import { buildAdvancedProfileFromLegacy, normalizeAdvancedProfile } from "./personaProfiles";
import { splitAssistantContent } from "./messageContent";

export interface ChatCompletionContext {
  runtimeState?: PersonaRuntimeState;
  memoryCard?: LayeredMemoryContextCard;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

function sentenceLengthRule(sentenceLength: Persona["advanced"]["voice"]["sentenceLength"]) {
  if (sentenceLength === "short") return "Пиши короткими фразами и абзацами.";
  if (sentenceLength === "long") return "Допустимы более развёрнутые абзацы с объяснениями.";
  return "Используй сбалансированную длину фраз.";
}

function userGenderLabel(gender: AppSettings["userGender"]) {
  if (gender === "male") return "мужской";
  if (gender === "female") return "женский";
  if (gender === "nonbinary") return "небинарный/другой";
  return "не указан";
}

function inferPersonaGenderFromName(name: string): Exclude<PersonaSelfGender, "auto"> {
  const token = name
    .trim()
    .split(/\s+/)
    .at(-1)
    ?.toLowerCase() ?? "";
  if (!token) return "neutral";

  const maleNameExceptions = new Set(["никита", "илья", "кузьма", "фома", "лука"]);
  if (maleNameExceptions.has(token)) return "male";

  if (/[ая]$/.test(token)) return "female";
  if (/[ое]$/.test(token)) return "neutral";
  return "male";
}

function resolvePersonaSelfGender(persona: Persona): Exclude<PersonaSelfGender, "auto"> {
  const configured = persona.advanced.core.selfGender;
  if (configured === "female" || configured === "male" || configured === "neutral") return configured;
  return inferPersonaGenderFromName(persona.name);
}

function personaSelfGenderRule(persona: Persona) {
  const selfGender = resolvePersonaSelfGender(persona);
  if (selfGender === "female") {
    return "Говори о себе в женском роде (например: сделала, написала, готова).";
  }
  if (selfGender === "male") {
    return "Говори о себе в мужском роде (например: сделал, написал, готов).";
  }
  return "Используй безличные или нейтральные формулировки, избегая гендерного согласования о себе.";
}

function moodExpressionRule(state: PersonaRuntimeState | undefined) {
  if (!state) {
    return "Отражай настроение мягко, без резких скачков стиля.";
  }

  switch (state.mood) {
    case "angry":
      return "mood=angry: отвечай сухо и коротко, жёстко обозначай границы, без эмодзи и без дружелюбных фраз.";
    case "upset":
      return "mood=upset: отвечай сдержанно и прохладно, меньше инициативы, больше дистанции.";
    case "annoyed":
      return "mood=annoyed: отвечай более резко и лаконично, с пониженной теплотой.";
    case "warm":
      return "mood=warm: отвечай поддерживающе и дружелюбно.";
    case "inspired":
      return "mood=inspired: отвечай энергично, вовлекающе, с идеями и вариативностью.";
    case "focused":
      return "mood=focused: отвечай структурно, по делу, с минимальной лирикой.";
    case "analytical":
      return "mood=analytical: отвечай логично, с разбором и критериями.";
    case "playful":
      return "mood=playful: допускай лёгкий игривый тон без клоунады.";
    default:
      return "mood=calm: отвечай спокойно и нейтрально.";
  }
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
  if (depth >= 85) depthRule = "Можно говорить максимально доверительно и тепло.";
  else if (depth >= 65) depthRule = "Можно общаться заметно ближе обычного.";
  else if (depth >= 45) depthRule = "Допустим дружеский персональный тон.";
  else if (depth >= 25) depthRule = "Лёгкая персонализация без излишней интимности.";

  return `Отношения: type=${state.relationshipType}, depth=${state.relationshipDepth}, stage=${state.relationshipStage}. ${typeRule[state.relationshipType]} ${depthRule}`;
}

const ROLEPLAY_HINT_REGEX = /(role[\s-]?play|ролепл|ролев|отыгр|играем\s+роль|сценк|\bрп\b)/i;
const IMAGE_REQUEST_HINT_REGEX =
  /(картин|изображен|фото|фотк|рисунк|арт|иллюстрац|покажи\s+как\s+выгляд|visual|image|picture|draw|render)/i;
const IMAGE_DENY_HINT_REGEX = /(без\s+картин|не\s+рисуй|без\s+изображ|no\s+image|text\s+only)/i;

function isRoleplayAllowed(recentMessages: ChatCompletionContext["recentMessages"], userInput: string) {
  const userLines = [
    ...(recentMessages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    userInput,
  ].slice(-8);
  return userLines.some((line) => ROLEPLAY_HINT_REGEX.test(line));
}

function isImagePromptAllowed(recentMessages: ChatCompletionContext["recentMessages"], userInput: string) {
  void recentMessages;

  const latest = userInput.trim();
  if (IMAGE_DENY_HINT_REGEX.test(latest)) return false;
  if (IMAGE_REQUEST_HINT_REGEX.test(latest)) return true;

  // Do not carry image mode forever. Require explicit current ask.
  return false;
}

function sanitizeAssistantText(content: string, allowRoleplay: boolean) {
  if (allowRoleplay || !content) return content;
  const stripped = content
    .replace(/(^|[\s>])\*[^*\n]{1,140}\*(?=$|[\s.,!?;:])/gm, "$1")
    .replace(/(^|[\s>])_[^_\n]{1,140}_(?=$|[\s.,!?;:])/gm, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return stripped || content;
}

function formatMemoryCardLines(memoryCard: LayeredMemoryContextCard | undefined) {
  if (!memoryCard) {
    return [
      "Short-term:",
      "- (нет)",
      "Episodic:",
      "- (нет)",
      "Long-term:",
      "- (нет)",
    ];
  }

  const shortTerm = memoryCard.shortTerm.length > 0 ? memoryCard.shortTerm : ["(нет)"];
  const episodic =
    memoryCard.episodic.length > 0
      ? memoryCard.episodic.map((memory) => `${memory.kind}: ${memory.content}`)
      : ["(нет)"];
  const longTerm =
    memoryCard.longTerm.length > 0
      ? memoryCard.longTerm.map((memory) => `${memory.kind}: ${memory.content}`)
      : ["(нет)"];

  return [
    "Short-term:",
    ...shortTerm.map((line) => `- ${line}`),
    "Episodic:",
    ...episodic.map((line) => `- ${line}`),
    "Long-term:",
    ...longTerm.map((line) => `- ${line}`),
  ];
}

function formatRecentMessages(
  recentMessages: ChatCompletionContext["recentMessages"] | undefined,
  userInput: string,
) {
  if (!recentMessages || recentMessages.length === 0) return userInput;

  const lines = [
    "КОНТЕКСТ ПОСЛЕДНИХ РЕПЛИК:",
    ...recentMessages.map((message) => `${message.role === "user" ? "Пользователь" : "Персона"}: ${message.content}`),
    "",
    "ТЕКУЩЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:",
    userInput,
  ];

  return lines.join("\n");
}

export function buildSystemPrompt(
  persona: Persona,
  settings: Pick<AppSettings, "userGender">,
  context?: ChatCompletionContext,
  roleplayAllowed = false,
) {
  const runtimeState = context?.runtimeState;
  const advanced = persona.advanced;
  const memoryLines = formatMemoryCardLines(context?.memoryCard);

  return [
    "=== HARD CONSTRAINTS ===",
    "Всегда оставайся в роли персонажа.",
    "Не придумывай факты и не скрывай неопределённость.",
    "Это текстовый чат, а не физическая реальность.",
    "Не описывай физические действия/жесты/прикосновения как реально происходящие в мире.",
    "Не заявляй, что ты что-то видишь, слышишь или находишься рядом, если это не дано в тексте.",
    roleplayAllowed
      ? "Roleplay разрешён, так как пользователь явно запросил его в текущем диалоге."
      : "Roleplay выключен. Не используй ремарки действий в *...* и не отыгрывай сцену.",
    "По умолчанию отвечай только текстом.",
    "Добавляй изображение только когда пользователь явно просит картинку/визуализацию.",
    "Не добавляй изображение в small talk и приветствиях.",
    "Если изображение нужно, добавь ровно один блок:",
    "<comfyui_prompt>",
    "detailed prompt in English",
    "</comfyui_prompt>",
    "Без markdown-оберток вокруг этого блока.",
    "После каждого ответа добавляй технический блок:",
    "<persona_control>",
    '{"intents":[],"state_delta":{"trust":0,"engagement":0,"energy":0,"mood":"calm","relationshipType":"neutral","relationshipDepth":0,"relationshipStage":"new"},"memory_add":[],"memory_remove":[]}',
    "</persona_control>",
    "Если изменений нет, оставь нули и пустые массивы. Без пояснений.",
    "Ты сама определяешь intents, state_delta и операции памяти (memory_add/memory_remove).",
    "Разрешённые mood: calm, warm, playful, focused, analytical, inspired, annoyed, upset, angry.",
    "Разрешённые relationshipType: neutral, friendship, romantic, mentor, playful.",
    "Разрешённые relationshipStage: new, acquaintance, friendly, close, bonded.",
    "Для фактов/предпочтений/целей пользователя добавляй memory_add с kind=fact|preference|goal.",
    "memory_add для long_term должен быть атомарным (один факт), коротким и без дословных цитат пользователя.",
    "Никогда не копируй полные сообщения пользователя в long_term.",
    "Если пользователь просит забыть факт или исправляет его, используй memory_remove.",
    "",
    "=== PERSONA CORE ===",
    `Имя: ${persona.name}`,
    `Архетип: ${advanced.core.archetype}`,
    `Legacy-характер: ${persona.personalityPrompt || "Не указан."}`,
    `Legacy-внешность: ${persona.appearancePrompt || "Не указано."}`,
    `Legacy-стиль: ${persona.stylePrompt || "Не указан."}`,
    `Предыстория: ${advanced.core.backstory || "Не задана."}`,
    `Цели: ${advanced.core.goals}`,
    `Ценности: ${advanced.core.values}`,
    `Границы: ${advanced.core.boundaries}`,
    `Экспертиза: ${advanced.core.expertise}`,
    "",
    "=== VOICE & BEHAVIOR ===",
    `Тон: ${advanced.voice.tone}`,
    `Лексика: ${advanced.voice.lexicalStyle}`,
    sentenceLengthRule(advanced.voice.sentenceLength),
    `Формальность: ${advanced.voice.formality}/100`,
    `Экспрессивность: ${advanced.voice.expressiveness}/100`,
    `Эмодзи: ${advanced.voice.emoji}/100`,
    `Инициативность: ${advanced.behavior.initiative}/100`,
    `Эмпатия: ${advanced.behavior.empathy}/100`,
    `Прямота: ${advanced.behavior.directness}/100`,
    `Любопытство: ${advanced.behavior.curiosity}/100`,
    `Сложные вопросы: ${advanced.behavior.challenge}/100`,
    `Креативность: ${advanced.behavior.creativity}/100`,
    "",
    "=== EMOTION & RUNTIME ===",
    `Базовое настроение: ${advanced.emotion.baselineMood}`,
    `Теплота: ${advanced.emotion.warmth}/100`,
    `Стабильность: ${advanced.emotion.stability}/100`,
    `Позитивные триггеры: ${advanced.emotion.positiveTriggers}`,
    `Негативные триггеры: ${advanced.emotion.negativeTriggers}`,
    runtimeState
      ? `Текущее состояние: mood=${runtimeState.mood}; trust=${runtimeState.trust}; energy=${runtimeState.energy}; engagement=${runtimeState.engagement}; relationshipType=${runtimeState.relationshipType}; relationshipDepth=${runtimeState.relationshipDepth}; stage=${runtimeState.relationshipStage}; topics=${runtimeState.activeTopics.join(", ") || "-"}.`
      : "Текущее состояние: нет данных, начни нейтрально-тепло.",
    "",
    "=== MEMORY CONTEXT ===",
    "Используй слои памяти с приоритетом: short-term > episodic > long-term.",
    ...memoryLines,
    "",
    "=== RESPONSE POLICY ===",
    "Сохраняй консистентность характера между ответами.",
    "Обязательно отражай текущее состояние/настроение в стиле ответа.",
    moodExpressionRule(runtimeState),
    energyExpressionRule(runtimeState),
    relationshipExpressionRule(runtimeState),
    "Если вопрос неясен, задай 1 уточняющий вопрос.",
    "Для сложных задач давай структурированный ответ с шагами.",
    personaSelfGenderRule(persona),
    `Пол пользователя: ${userGenderLabel(settings.userGender)}.`,
    "Если пол задан, учитывай его в обращении и согласовании форм.",
    "Если пол не указан, используй нейтральные формулировки.",
    "Не показывай persona_control пользователю как часть обычного текста.",
  ].join("\n");
}

interface NativeChatResult {
  content: string;
  comfyPrompt?: string;
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
  const roleplayAllowed = isRoleplayAllowed(context?.recentMessages, userInput);
  const imagePromptAllowed = isImagePromptAllowed(context?.recentMessages, userInput);
  const baseUrl = settings.lmBaseUrl.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/v1/chat`;

  const payload: Record<string, unknown> = {
    model: settings.model,
    input: formatRecentMessages(context?.recentMessages, userInput),
    system_prompt: buildSystemPrompt(persona, settings, context, roleplayAllowed),
    max_output_tokens: settings.maxTokens,
    temperature: settings.temperature,
    store: true,
  };
  if (previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
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
  const messageChunks = data.output
    .filter((item) => item.type === "message")
    .map((item) => item.content?.trim() ?? "")
    .filter(Boolean);
  const rawContent = messageChunks.join("\n\n");
  const { visibleText, comfyPrompt, personaControl } = splitAssistantContent(rawContent);
  const sanitizedContent = sanitizeAssistantText(visibleText, roleplayAllowed);
  const sanitizedComfyPrompt = imagePromptAllowed ? comfyPrompt : undefined;
  const filteredImageOnlyResponse =
    !sanitizedContent && !sanitizedComfyPrompt && !personaControl && Boolean(comfyPrompt) && !imagePromptAllowed;
  const fallbackContent = filteredImageOnlyResponse
    ? "Могу отправить изображение по явному запросу. Опиши, что именно нужно сгенерировать."
    : "";
  const finalContent = sanitizedContent || fallbackContent;

  if (!finalContent && !sanitizedComfyPrompt && !personaControl) {
    throw new Error("LMStudio returned an empty response.");
  }

  return {
    content: finalContent,
    comfyPrompt: sanitizedComfyPrompt,
    personaControl,
    responseId: data.response_id,
  };
}

export interface GeneratedPersonaDraft {
  name: string;
  personalityPrompt: string;
  appearancePrompt: string;
  stylePrompt: string;
  advanced: PersonaAdvancedProfile;
  avatarUrl: string;
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function authHeaders(apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
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

export async function listModels(settings: Pick<AppSettings, "lmBaseUrl" | "apiKey">) {
  const baseUrl = normalizeBaseUrl(settings.lmBaseUrl);
  const headers = authHeaders(settings.apiKey);

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
        typeof rec.personalityPrompt === "string" ? rec.personalityPrompt.trim() : "";
      const appearancePrompt =
        typeof rec.appearancePrompt === "string" ? rec.appearancePrompt.trim() : "";
      const stylePrompt = typeof rec.stylePrompt === "string" ? rec.stylePrompt.trim() : "";
      const avatarUrl = typeof rec.avatarUrl === "string" ? rec.avatarUrl.trim() : "";
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

      return { name, personalityPrompt, appearancePrompt, stylePrompt, advanced, avatarUrl };
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
    ...authHeaders(settings.apiKey),
  };

  const safeCount = Math.max(1, Math.min(6, Math.round(count)));
  const systemPrompt = [
    "Ты генератор карточек персонажей для ролевого AI-чата.",
    "Верни ТОЛЬКО JSON-массив без markdown и пояснений.",
    "Формат каждого элемента:",
    '{"name":"...","personalityPrompt":"...","appearancePrompt":"...","stylePrompt":"...","avatarUrl":"","advanced":{"core":{"archetype":"...","backstory":"...","goals":"...","values":"...","boundaries":"...","expertise":"...","selfGender":"auto|female|male|neutral"},"voice":{"tone":"...","lexicalStyle":"...","sentenceLength":"short|balanced|long","formality":0,"expressiveness":0,"emoji":0},"behavior":{"initiative":0,"empathy":0,"directness":0,"curiosity":0,"challenge":0,"creativity":0},"emotion":{"baselineMood":"calm|warm|playful|focused|analytical|inspired|annoyed|upset|angry","warmth":0,"stability":0,"positiveTriggers":"...","negativeTriggers":"..."},"memory":{"rememberFacts":true,"rememberPreferences":true,"rememberGoals":true,"rememberEvents":true,"maxMemories":24,"decayDays":30}}}',
    "Все числовые поля в диапазоне 0..100 (кроме maxMemories и decayDays).",
    "maxMemories: 4..120, decayDays: 1..365.",
    "Даже если ты заполнила advanced, legacy-поля personalityPrompt/appearancePrompt/stylePrompt тоже заполняй осмысленно.",
    "Пиши на русском языке.",
  ].join("\n");

  const input = [
    `Сгенерируй ${safeCount} разных персонажей.`,
    `Тема/контекст: ${theme || "универсальный собеседник"}.`,
    "У каждого должен быть уникальный характер, внешность и стиль речи.",
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
    throw new Error(`Ошибка генерации персонажей (${response.status}): ${body}`);
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
