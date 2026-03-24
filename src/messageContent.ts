const COMFY_UI_PROMPT_BLOCK_REGEX = /<comfyui_prompt>([\s\S]*?)<\/comfyui_prompt>/gi;

export interface AssistantContentParts {
  visibleText: string;
  comfyPrompt?: string;
}

export function splitAssistantContent(rawContent: string): AssistantContentParts {
  let comfyPrompt: string | undefined;
  const visibleText = rawContent
    .replace(COMFY_UI_PROMPT_BLOCK_REGEX, (_, inner: string) => {
      const candidate = inner.trim();
      if (!comfyPrompt && candidate) {
        comfyPrompt = candidate;
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { visibleText, comfyPrompt };
}
