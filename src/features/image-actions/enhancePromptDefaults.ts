import type { ImageGenerationMeta, Persona } from "../../types";
import type { LookEnhancePromptOverrides } from "../../ui/types";

export function resolveSharedEnhancePromptDefaults(
  persona: Persona | null,
  sourceMeta?: ImageGenerationMeta,
): LookEnhancePromptOverrides | undefined {
  const cache = persona?.lookPromptCache;
  const cachedSourcePrompt =
    cache?.fullBodyPrompt?.trim() || cache?.avatarPrompt?.trim() || "";
  const sourcePrompt = cachedSourcePrompt || sourceMeta?.prompt?.trim() || "";
  const detailPrompts = cache?.detailPrompts
    ? { ...cache.detailPrompts }
    : undefined;

  if (!sourcePrompt && !detailPrompts) {
    return undefined;
  }

  return {
    ...(sourcePrompt ? { sourcePrompt } : {}),
    ...(detailPrompts ? { detailPrompts } : {}),
  };
}
