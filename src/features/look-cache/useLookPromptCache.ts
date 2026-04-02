import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { generatePersonaLookPrompts } from "../../lmstudio";
import type { AppSettings } from "../../types";
import type { PersonaDraft } from "../../ui/types";
import {
  buildLookPromptCacheFingerprint,
  resolveLookPromptModel,
  toLookPromptBundle,
  type PersonaLookPromptBundle,
} from "../look/lookHelpers";

interface UseLookPromptCacheParams {
  settings: AppSettings;
  personaDraft: PersonaDraft;
  setPersonaDraft: Dispatch<SetStateAction<PersonaDraft>>;
  cacheRef: MutableRefObject<{
    key: string;
    bundle: PersonaLookPromptBundle;
  } | null>;
}

export function useLookPromptCache({
  settings,
  personaDraft,
  setPersonaDraft,
  cacheRef,
}: UseLookPromptCacheParams) {
  const getCachedLookPromptBundle = useCallback(async () => {
    const cacheKey = buildLookPromptCacheFingerprint(personaDraft.appearance);
    const persistedCache = personaDraft.lookPromptCache;
    const shouldKeepLockedCache = Boolean(persistedCache?.locked);
    const runtimeCacheKey = shouldKeepLockedCache
      ? `locked:${persistedCache?.fingerprint ?? cacheKey}`
      : `appearance:${cacheKey}`;
    const promptModel = resolveLookPromptModel(settings);
    const cached = cacheRef.current;
    if (cached?.key === runtimeCacheKey) {
      return cached.bundle;
    }
    if (
      persistedCache &&
      (persistedCache.locked || persistedCache.fingerprint === cacheKey)
    ) {
      const bundle = toLookPromptBundle(persistedCache);
      cacheRef.current = { key: runtimeCacheKey, bundle };
      return bundle;
    }
    const bundle = await generatePersonaLookPrompts(settings, {
      name: personaDraft.name,
      personalityPrompt: personaDraft.personalityPrompt,
      appearance: personaDraft.appearance,
      stylePrompt: personaDraft.stylePrompt,
      advanced: personaDraft.advanced,
    });
    cacheRef.current = {
      key: `appearance:${cacheKey}`,
      bundle,
    };
    const nowIso = new Date().toISOString();
    setPersonaDraft((prev) => {
      if (prev.lookPromptCache?.locked) {
        return prev;
      }
      const nextFingerprint = buildLookPromptCacheFingerprint(prev.appearance);
      if (nextFingerprint !== cacheKey) {
        return prev;
      }
      return {
        ...prev,
        lookPromptCache: {
          fingerprint: cacheKey,
          locked: prev.lookPromptCache?.locked ?? false,
          model: promptModel,
          generatedAt: nowIso,
          avatarPrompt: bundle.avatarPrompt,
          fullBodyPrompt: bundle.fullBodyPrompt,
          detailPrompts: {
            ...bundle.detailPrompts,
          },
        },
      };
    });
    return bundle;
  }, [cacheRef, personaDraft, setPersonaDraft, settings]);

  return {
    getCachedLookPromptBundle,
  };
}
