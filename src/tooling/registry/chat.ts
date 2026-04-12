import type { PersonaControlPayload } from "../../personaDynamics";
import { splitAssistantContent } from "../../messageContent";
import { parseRecordFromUnknown } from "./common";
import type { RuntimeToolConfig, ToolValidationResult } from "./types";

export interface ChatTurnToolPayload {
  content: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  personaControl?: PersonaControlPayload;
}

export function createChatTurnToolConfig(): RuntimeToolConfig<ChatTurnToolPayload> {
  return {
    tool: {
      name: "emit_chat_turn",
      description:
        "Return the assistant turn and optional image/control service payload.",
      parameters: {
        type: "object",
        properties: {
          visible_text: { type: "string" },
          visibleText: { type: "string" },
          comfy_prompts: {
            type: "array",
            items: { type: "string" },
          },
          comfyPrompts: {
            type: "array",
            items: { type: "string" },
          },
          comfy_image_descriptions: {
            type: "array",
            items: { type: "string" },
          },
          comfyImageDescriptions: {
            type: "array",
            items: { type: "string" },
          },
          persona_control: { type: "object" },
          personaControl: { type: "object" },
        },
        additionalProperties: true,
      },
      validate: normalizeChatTurnFromUnknown,
    },
    maxRepairAttempts: 2,
    legacyExtractor: (content) =>
      normalizeChatTurnFromParts(splitAssistantContent(content)),
  };
}

function normalizeChatTurnFromUnknown(
  payload: unknown,
): ToolValidationResult<ChatTurnToolPayload> {
  const record = parseRecordFromUnknown(payload);
  if (!record) {
    return {
      ok: false,
      reason: "chat_turn_payload_not_object",
    };
  }
  return normalizeChatTurnFromParts(
    splitAssistantContent(JSON.stringify({ service: record })),
  );
}

function normalizeChatTurnFromParts(
  parts: ReturnType<typeof splitAssistantContent>,
): ToolValidationResult<ChatTurnToolPayload> {
  const content = (parts.visibleText || "").trim();
  const comfyPrompts =
    parts.comfyPrompts && parts.comfyPrompts.length > 0
      ? parts.comfyPrompts
      : parts.comfyPrompt
        ? [parts.comfyPrompt]
        : [];
  const comfyImageDescriptions =
    parts.comfyImageDescriptions && parts.comfyImageDescriptions.length > 0
      ? parts.comfyImageDescriptions
      : parts.comfyImageDescription
        ? [parts.comfyImageDescription]
        : [];

  if (
    !content &&
    comfyPrompts.length === 0 &&
    comfyImageDescriptions.length === 0 &&
    !parts.personaControl
  ) {
    return {
      ok: false,
      reason: "chat_turn_is_empty",
    };
  }

  return {
    ok: true,
    value: {
      content,
      comfyPrompt: comfyPrompts[0],
      comfyPrompts: comfyPrompts.length > 0 ? comfyPrompts : undefined,
      comfyImageDescription: comfyImageDescriptions[0],
      comfyImageDescriptions:
        comfyImageDescriptions.length > 0 ? comfyImageDescriptions : undefined,
      personaControl: parts.personaControl,
    },
  };
}
