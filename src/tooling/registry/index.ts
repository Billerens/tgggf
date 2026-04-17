import type { ToolRegistryEntry } from "./types";
import { createChatTurnToolConfig } from "./chat";
import {
  createThemedComfyPromptToolConfig,
  createComfyPromptsFromDescriptionToolConfig,
} from "./image";
import {
  createGroupOrchestratorToolConfig,
  createGroupPersonaTurnToolConfig,
} from "./group";

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    key: "chat.emit_chat_turn",
    task: "one_to_one_chat",
    toolName: "emit_chat_turn",
    owner: "chat",
    description:
      "Primary 1:1 turn emission tool with optional image/control payload.",
  },
  {
    key: "image.emit_themed_comfy_prompt",
    task: "image_prompt",
    toolName: "emit_themed_comfy_prompt",
    owner: "image",
    description: "One or many themed ComfyUI prompts + theme tags.",
  },
  {
    key: "image.emit_comfy_prompts_from_description",
    task: "image_prompt",
    toolName: "emit_comfy_prompts_from_description",
    owner: "image",
    description: "One or many ComfyUI prompts derived from scene description.",
  },
  {
    key: "group.select_group_turn_action",
    task: "group_orchestrator",
    toolName: "select_group_turn_action",
    owner: "group",
    description: "Group orchestrator action selection.",
  },
  {
    key: "group.emit_group_persona_turn",
    task: "group_persona",
    toolName: "emit_group_persona_turn",
    owner: "group",
    description: "Group persona turn payload emission.",
  },
];

export function getToolRegistryEntry(toolName: string) {
  return TOOL_REGISTRY.find((entry) => entry.toolName === toolName);
}

export {
  createChatTurnToolConfig,
  createThemedComfyPromptToolConfig,
  createComfyPromptsFromDescriptionToolConfig,
  createGroupOrchestratorToolConfig,
  createGroupPersonaTurnToolConfig,
};
