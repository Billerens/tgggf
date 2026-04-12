import type { PersonaControlPayload } from "../../personaDynamics";
import { splitAssistantContent } from "../../messageContent";
import { parseRecordFromUnknown, toTrimmedString } from "./common";
import type { RuntimeToolConfig, ToolValidationResult } from "./types";

export interface GroupOrchestratorDecisionPayload {
  status?: string;
  speakerPersonaId?: string;
  waitForUser?: boolean;
  waitReason?: string;
  reason?: string;
  intent?: string;
  userContextAction?: string;
}

export interface GroupPersonaTurnPayload {
  visibleText: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  personaControl?: PersonaControlPayload;
}

export function createGroupOrchestratorToolConfig(): RuntimeToolConfig<GroupOrchestratorDecisionPayload> {
  return {
    tool: {
      name: "select_group_turn_action",
      description:
        "Select the next group turn action and speaking persona in structured form.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["speak", "wait", "skip"],
          },
          speakerPersonaId: { type: "string" },
          waitForUser: { type: "boolean" },
          waitReason: { type: "string" },
          reason: { type: "string" },
          intent: { type: "string" },
          userContextAction: {
            type: "string",
            enum: ["keep", "clear"],
          },
        },
        required: ["status"],
        additionalProperties: true,
      },
      validate: normalizeOrchestratorDecisionPayload,
    },
    maxRepairAttempts: 2,
    legacyExtractor: (content) => normalizeOrchestratorDecisionPayload(content),
  };
}

export function createGroupPersonaTurnToolConfig(): RuntimeToolConfig<GroupPersonaTurnPayload> {
  return {
    tool: {
      name: "emit_group_persona_turn",
      description:
        "Return the active persona reply and optional service payload for images/control.",
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
      validate: normalizeGroupPersonaTurnPayload,
    },
    maxRepairAttempts: 2,
    legacyExtractor: (content) => normalizeGroupPersonaTurnFromText(content),
  };
}

function normalizeOrchestratorDecisionPayload(
  payload: unknown,
): ToolValidationResult<GroupOrchestratorDecisionPayload> {
  const record = parseRecordFromUnknown(payload);
  if (!record) {
    return { ok: false, reason: "orchestrator_payload_not_object" };
  }

  const status = toTrimmedString(record.status).toLowerCase();
  if (status !== "speak" && status !== "wait" && status !== "skip") {
    return { ok: false, reason: "orchestrator_status_invalid" };
  }

  return {
    ok: true,
    value: {
      status,
      speakerPersonaId: toTrimmedString(record.speakerPersonaId),
      waitForUser:
        typeof record.waitForUser === "boolean"
          ? record.waitForUser
          : undefined,
      waitReason: toTrimmedString(record.waitReason),
      reason: toTrimmedString(record.reason),
      intent: toTrimmedString(record.intent),
      userContextAction: toTrimmedString(record.userContextAction),
    },
  };
}

function normalizeGroupPersonaTurnPayload(
  payload: unknown,
): ToolValidationResult<GroupPersonaTurnPayload> {
  const record = parseRecordFromUnknown(payload);
  if (!record) {
    return { ok: false, reason: "group_persona_payload_not_object" };
  }
  return normalizeGroupPersonaParts(
    splitAssistantContent(JSON.stringify({ service: record })),
  );
}

function normalizeGroupPersonaTurnFromText(
  content: string,
): ToolValidationResult<GroupPersonaTurnPayload> {
  return normalizeGroupPersonaParts(splitAssistantContent(content));
}

function normalizeGroupPersonaParts(
  parts: ReturnType<typeof splitAssistantContent>,
): ToolValidationResult<GroupPersonaTurnPayload> {
  const visibleText = (parts.visibleText || "").trim();
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
    !visibleText &&
    comfyPrompts.length === 0 &&
    comfyImageDescriptions.length === 0 &&
    !parts.personaControl
  ) {
    return { ok: false, reason: "group_persona_turn_is_empty" };
  }
  return {
    ok: true,
    value: {
      visibleText,
      comfyPrompt: comfyPrompts[0],
      comfyPrompts: comfyPrompts.length > 0 ? comfyPrompts : undefined,
      comfyImageDescription: comfyImageDescriptions[0],
      comfyImageDescriptions:
        comfyImageDescriptions.length > 0 ? comfyImageDescriptions : undefined,
      personaControl: parts.personaControl,
    },
  };
}
