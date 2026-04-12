export type ToolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface RuntimeToolDefinition<T> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  validate: (payload: unknown) => ToolValidationResult<T>;
}

export interface RuntimeToolConfig<T> {
  tool: RuntimeToolDefinition<T>;
  maxRepairAttempts?: number;
  legacyExtractor?: (content: string) => ToolValidationResult<T>;
}

export type ToolRegistryTask =
  | "one_to_one_chat"
  | "group_orchestrator"
  | "group_persona"
  | "image_prompt"
  | "persona_generation";

export interface ToolRegistryEntry {
  key: string;
  task: ToolRegistryTask;
  toolName: string;
  owner: string;
  description: string;
}
