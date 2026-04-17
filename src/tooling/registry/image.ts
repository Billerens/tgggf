import {
  extractComfyPromptsFromContent,
  extractComfyPromptsFromStructuredRecord,
  extractThemeTagsFromContent,
  extractThemeTagsFromStructuredRecord,
  parseRecordFromUnknown,
  toTrimmedString,
} from "./common";
import type { RuntimeToolConfig, ToolValidationResult } from "./types";

export interface ThemedPromptToolPayload {
  prompt: string;
  prompts: string[];
  themeTags: string[];
}

export interface ComfyPromptsToolPayload {
  prompts: string[];
}

export function createThemedComfyPromptToolConfig(
  topic: string,
  fallbackThemeTags: (topic: string) => string[],
): RuntimeToolConfig<ThemedPromptToolPayload> {
  return {
    tool: {
      name: "emit_themed_comfy_prompt",
      description:
        "Return one themed ComfyUI prompt and matching theme tags in structured form.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          comfy_prompt: { type: "string" },
          comfyPrompt: { type: "string" },
          comfy_prompts: {
            type: "array",
            items: { type: "string" },
          },
          comfyPrompts: {
            type: "array",
            items: { type: "string" },
          },
          theme_tags: {
            type: "array",
            items: { type: "string" },
          },
          themeTags: {
            type: "array",
            items: { type: "string" },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: true,
      },
      validate: normalizeThemedPromptToolPayload,
    },
    maxRepairAttempts: 2,
    legacyExtractor: (content) =>
      normalizeThemedPromptFromContent(content, topic, fallbackThemeTags),
  };
}

export function createComfyPromptsFromDescriptionToolConfig(): RuntimeToolConfig<ComfyPromptsToolPayload> {
  return {
    tool: {
      name: "emit_comfy_prompts_from_description",
      description:
        "Return one or more ComfyUI prompt strings generated from the scene description.",
      parameters: {
        type: "object",
        properties: {
          prompts: {
            type: "array",
            items: { type: "string" },
          },
          comfy_prompts: {
            type: "array",
            items: { type: "string" },
          },
          comfyPrompts: {
            type: "array",
            items: { type: "string" },
          },
          prompt: { type: "string" },
          comfy_prompt: { type: "string" },
          comfyPrompt: { type: "string" },
        },
        additionalProperties: true,
      },
      validate: normalizeComfyPromptsToolPayload,
    },
    maxRepairAttempts: 2,
    legacyExtractor: (content) => {
      const prompts = extractComfyPromptsFromContent(content);
      if (prompts.length === 0) {
        return {
          ok: false,
          reason: "comfy_prompts_missing",
        };
      }
      return {
        ok: true,
        value: { prompts },
      };
    },
  };
}

function normalizeThemedPromptToolPayload(
  payload: unknown,
): ToolValidationResult<ThemedPromptToolPayload> {
  const record = parseRecordFromUnknown(payload);
  if (!record) {
    return { ok: false, reason: "themed_prompt_payload_not_object" };
  }

  const promptCandidates = [
    toTrimmedString(record.prompt),
    toTrimmedString(record.comfy_prompt),
    toTrimmedString(record.comfyPrompt),
  ].filter(Boolean);
  const structuredPrompts = extractComfyPromptsFromStructuredRecord(record);
  const prompts = Array.from(
    new Set([...promptCandidates, ...structuredPrompts].map((item) => item.trim())),
  ).filter(Boolean);
  const prompt = toTrimmedString(prompts[0]);
  if (!prompt) {
    return { ok: false, reason: "themed_prompt_missing_prompt" };
  }

  return {
    ok: true,
    value: {
      prompt,
      prompts,
      themeTags: extractThemeTagsFromStructuredRecord(record),
    },
  };
}

function normalizeThemedPromptFromContent(
  content: string,
  topic: string,
  fallbackThemeTags: (topic: string) => string[],
): ToolValidationResult<ThemedPromptToolPayload> {
  const prompts = extractComfyPromptsFromContent(content);
  const prompt = toTrimmedString(prompts[0]);
  if (!prompt) {
    return { ok: false, reason: "themed_prompt_missing_prompt" };
  }
  const normalizedPrompts = Array.from(new Set(prompts.map((item) => item.trim()))).filter(
    Boolean,
  );
  return {
    ok: true,
    value: {
      prompt,
      prompts: normalizedPrompts.length > 0 ? normalizedPrompts : [prompt],
      themeTags: extractThemeTagsFromContent(content, fallbackThemeTags, topic),
    },
  };
}

function normalizeComfyPromptsToolPayload(
  payload: unknown,
): ToolValidationResult<ComfyPromptsToolPayload> {
  const record = parseRecordFromUnknown(payload);
  if (!record) {
    return { ok: false, reason: "comfy_prompts_payload_not_object" };
  }
  const prompts = extractComfyPromptsFromStructuredRecord(record);
  if (prompts.length === 0) {
    return { ok: false, reason: "comfy_prompts_missing" };
  }
  return {
    ok: true,
    value: {
      prompts,
    },
  };
}
