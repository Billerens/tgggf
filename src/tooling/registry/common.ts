import { splitAssistantContent } from "../../messageContent";

export function toTrimmedString(value: unknown): string {
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

export function parseJsonObjectFromText<T extends object>(value: string): T | null {
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

export function parseRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  return parseJsonObjectFromText<Record<string, unknown>>(value);
}

export function normalizeStringListValue(
  value: unknown,
  max = 8,
  objectKeys: string[] = ["text", "content", "value"],
) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value.slice(0, max)) {
    if (typeof item === "string") {
      const normalized = item.trim();
      if (normalized) values.push(normalized);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    for (const key of objectKeys) {
      const candidate = toTrimmedString((item as Record<string, unknown>)[key]);
      if (candidate) {
        values.push(candidate);
        break;
      }
    }
  }
  return values;
}

export function dedupeStringList(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function extractComfyPromptsFromStructuredRecord(record: Record<string, unknown>) {
  const service =
    (record.service && typeof record.service === "object"
      ? (record.service as Record<string, unknown>)
      : null) ??
    record;
  return dedupeStringList([
    ...normalizeStringListValue(
      service.comfy_prompts ?? service.comfyPrompts ?? service.prompts,
      8,
      ["prompt", "text", "content", "value"],
    ),
    ...normalizeStringListValue(
      service.comfy_prompt ?? service.comfyPrompt ?? service.prompt,
      8,
      ["prompt", "text", "content", "value"],
    ),
  ]);
}

export function extractThemeTagsFromStructuredRecord(record: Record<string, unknown>) {
  const service =
    (record.service && typeof record.service === "object"
      ? (record.service as Record<string, unknown>)
      : null) ??
    record;
  return dedupeStringList([
    ...normalizeStringListValue(
      service.theme_tags ?? service.themeTags ?? service.tags,
      12,
      ["tag", "text", "content", "value"],
    ),
  ]);
}

export function extractThemeTagsFromContent(
  text: string,
  fallback: (topic: string) => string[],
  topic: string,
) {
  const structured = parseJsonObjectFromText<Record<string, unknown>>(text);
  if (structured) {
    const fromStructured = extractThemeTagsFromStructuredRecord(structured);
    if (fromStructured.length > 0) return fromStructured;
  }
  const direct = extractTaggedBlock(text, "theme_tags");
  const parsedDirect = splitTags(direct || "");
  if (parsedDirect.length > 0) return parsedDirect;
  return fallback(topic);
}

export function extractComfyPromptsFromContent(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [] as string[];

  const structured = parseJsonObjectFromText<Record<string, unknown>>(trimmed);
  if (structured) {
    const structuredPrompts = extractComfyPromptsFromStructuredRecord(structured);
    if (structuredPrompts.length > 0) return structuredPrompts;
  }

  const parsed = splitAssistantContent(trimmed);
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
    trimmed.matchAll(/<comfyui_prompt\b[^>]*>([\s\S]*?)<\/comfyui_prompt>/gi),
  )
    .map((match) => toTrimmedString(match[1]))
    .filter(Boolean);
  if (tagMatches.length > 0) return tagMatches;

  const fallbackPrompt = trimmed
    .replace(/<\/?comfyui_prompt>/gi, "")
    .replace(/<\/?comfyui_image_description>/gi, "")
    .replace(/<\/?theme_tags>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return fallbackPrompt ? [fallbackPrompt] : [];
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractTaggedBlock(text: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(pattern);
  return toTrimmedString(match?.[1]);
}
