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

const personaEvolutionPatchSchema = {
  type: "object",
  properties: {
    personalityPrompt: { type: "string" },
    stylePrompt: { type: "string" },
    appearance: {
      type: "object",
      properties: {
        faceDescription: { type: "string" },
        height: { type: "string" },
        eyes: { type: "string" },
        lips: { type: "string" },
        hair: { type: "string" },
        ageType: { type: "string" },
        bodyType: { type: "string" },
        markers: { type: "string" },
        accessories: { type: "string" },
        clothingStyle: { type: "string" },
        skin: { type: "string" },
      },
      additionalProperties: false,
    },
    advanced: {
      type: "object",
      properties: {
        core: {
          type: "object",
          properties: {
            archetype: { type: "string" },
            backstory: { type: "string" },
            goals: { type: "string" },
            values: { type: "string" },
            boundaries: { type: "string" },
            expertise: { type: "string" },
            selfGender: { type: "string", enum: ["auto", "female", "male", "neutral"] },
          },
          additionalProperties: false,
        },
        voice: {
          type: "object",
          properties: {
            tone: { type: "string" },
            lexicalStyle: { type: "string" },
            sentenceLength: { type: "string", enum: ["short", "balanced", "long"] },
            formality: { type: "number" },
            expressiveness: { type: "number" },
            emoji: { type: "number" },
          },
          additionalProperties: false,
        },
        behavior: {
          type: "object",
          properties: {
            initiative: { type: "number" },
            empathy: { type: "number" },
            directness: { type: "number" },
            curiosity: { type: "number" },
            challenge: { type: "number" },
            creativity: { type: "number" },
          },
          additionalProperties: false,
        },
        emotion: {
          type: "object",
          properties: {
            baselineMood: { type: "string" },
            warmth: { type: "number" },
            stability: { type: "number" },
            positiveTriggers: { type: "string" },
            negativeTriggers: { type: "string" },
          },
          additionalProperties: false,
        },
        memory: {
          type: "object",
          properties: {
            rememberFacts: { type: "boolean" },
            rememberPreferences: { type: "boolean" },
            rememberGoals: { type: "boolean" },
            rememberEvents: { type: "boolean" },
            maxMemories: { type: "number" },
            decayDays: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

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
          persona_control: {
            type: "object",
            properties: {
              intents: {
                type: "array",
                items: { type: "string" },
              },
              state_delta: {
                type: "object",
                properties: {
                  trust: { type: "number" },
                  engagement: { type: "number" },
                  energy: { type: "number" },
                  lust: { type: "number" },
                  fear: { type: "number" },
                  affection: { type: "number" },
                  tension: { type: "number" },
                  mood: { type: "string" },
                  relationshipDepth: { type: "number" },
                },
                additionalProperties: true,
              },
              memory_add: {
                type: "array",
                items: { type: "object" },
              },
              memory_remove: {
                type: "array",
                items: { type: "object" },
              },
              evolution: {
                type: "object",
                properties: {
                  shouldEvolve: { type: "boolean" },
                  reason: { type: "string" },
                  patch: personaEvolutionPatchSchema,
                },
                additionalProperties: false,
              },
            },
            additionalProperties: true,
          },
          personaControl: {
            type: "object",
            properties: {
              evolution: {
                type: "object",
                properties: {
                  shouldEvolve: { type: "boolean" },
                  reason: { type: "string" },
                  patch: personaEvolutionPatchSchema,
                },
                additionalProperties: false,
              },
            },
            additionalProperties: true,
          },
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
