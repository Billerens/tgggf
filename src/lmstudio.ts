import type { AppSettings, NativeChatResponse, Persona } from "./types";

export function buildSystemPrompt(persona: Persona) {
  return [
    `Имя персонажа: ${persona.name}`,
    `Характер: ${persona.personalityPrompt || "Не указано."}`,
    `Внешность: ${persona.appearancePrompt || "Не указано."}`,
    `Стиль общения: ${persona.stylePrompt || "Не указано."}`,
    "Оставайся в роли этого персонажа на протяжении всего диалога.",
  ].join("\n");
}

interface NativeChatResult {
  content: string;
  responseId?: string;
}

export async function requestChatCompletion(
  settings: AppSettings,
  persona: Persona,
  userInput: string,
  previousResponseId?: string,
): Promise<NativeChatResult> {
  const baseUrl = settings.lmBaseUrl.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/v1/chat`;

  const payload: Record<string, unknown> = {
    model: settings.model,
    input: userInput,
    system_prompt: buildSystemPrompt(persona),
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
  const content = messageChunks.join("\n\n");

  if (!content) {
    throw new Error("LMStudio returned an empty response.");
  }

  return { content, responseId: data.response_id };
}

export interface GeneratedPersonaDraft {
  name: string;
  personalityPrompt: string;
  appearancePrompt: string;
  stylePrompt: string;
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
      if (!name) return null;
      return { name, personalityPrompt, appearancePrompt, stylePrompt };
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
    '{"name":"...","personalityPrompt":"...","appearancePrompt":"...","stylePrompt":"..."}',
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
