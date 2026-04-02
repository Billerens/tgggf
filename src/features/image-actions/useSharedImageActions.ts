import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { generateComfyImages, type ComfyImageGenerationMeta } from "../../comfy";
import { dbApi } from "../../db";
import { localizeImageUrlOrThrow, localizeImageUrls } from "../../imageStorage";
import { useAppStore } from "../../store";
import type { AppSettings, GeneratorSession, Persona } from "../../types";
import type {
  LookEnhanceDetailKey,
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
} from "../../ui/types";
import { resolveSharedEnhancePromptDefaults } from "./enhancePromptDefaults";
import {
  mapEnhanceTargetToDetailTargets,
  mergePromptTags,
  normalizeComfyDimension,
  pickPreferredEnhancedUrl,
  readImageSize,
  resolveImageSource,
  stableSeedFromText,
} from "../look/lookHelpers";

export type ChatImageActionContext = {
  messageId: string;
  sourceUrl: string;
  meta?: ComfyImageGenerationMeta;
};

export type GeneratorImageActionContext = {
  sessionId: string;
  sourceUrl: string;
  meta?: ComfyImageGenerationMeta;
};

export type SharedImageActionContext =
  | ChatImageActionContext
  | GeneratorImageActionContext;

export type SharedImageEnhanceReview = {
  context: SharedImageActionContext;
  beforeUrl: string;
  afterUrl: string;
  afterMeta: ComfyImageGenerationMeta;
  target: LookEnhanceTarget;
};

interface UseSharedImageActionsParams {
  activePersona: Persona | null;
  settings: AppSettings;
  chatImageMetaByUrl: Record<string, ComfyImageGenerationMeta>;
  setGenerationSessions: Dispatch<SetStateAction<GeneratorSession[]>>;
}

export function useSharedImageActions({
  activePersona,
  settings,
  chatImageMetaByUrl,
  setGenerationSessions,
}: UseSharedImageActionsParams) {
  const [imageActionBusy, setImageActionBusy] = useState(false);
  const [sharedEnhanceReview, setSharedEnhanceReview] =
    useState<SharedImageEnhanceReview | null>(null);
  const imageActionRunRef = useRef(0);
  const imageActionAbortRef = useRef<AbortController | null>(null);

  const replaceChatMessageImage = async (
    context: ChatImageActionContext,
    nextUrl: string,
    nextMeta: ComfyImageGenerationMeta,
  ) => {
    const currentState = useAppStore.getState();
    const target = currentState.messages.find(
      (message) => message.id === context.messageId,
    );
    if (!target) return;
    const sourceUrl = context.sourceUrl.trim();
    if (!sourceUrl) return;
    const nextContent = target.content.includes(sourceUrl)
      ? target.content.split(sourceUrl).join(nextUrl)
      : target.content;
    const nextImageUrls = (target.imageUrls ?? []).map((url) =>
      url === sourceUrl ? nextUrl : url,
    );
    const updated = {
      ...target,
      content: nextContent,
      imageUrls: nextImageUrls,
      imageMetaByUrl: {
        ...(target.imageMetaByUrl ?? {}),
        [nextUrl]: nextMeta,
      },
    };
    await dbApi.saveMessage(updated);
    useAppStore.setState((prev) => ({
      messages: prev.messages.map((message) =>
        message.id === updated.id ? updated : message,
      ),
    }));
  };

  const replaceGeneratorSessionImage = async (
    context: GeneratorImageActionContext,
    nextUrl: string,
    nextMeta: ComfyImageGenerationMeta,
  ) => {
    const sourceUrl = context.sourceUrl.trim();
    if (!sourceUrl) return;
    const now = new Date().toISOString();
    let persisted: GeneratorSession | null = null;
    setGenerationSessions((prev) =>
      prev.map((session) => {
        if (session.id !== context.sessionId) return session;
        let touched = false;
        const nextEntries = session.entries.map((entry) => {
          const nextImageUrls = (entry.imageUrls ?? []).map((url) =>
            url === sourceUrl ? nextUrl : url,
          );
          const changed = nextImageUrls.some(
            (url, index) => url !== (entry.imageUrls ?? [])[index],
          );
          if (!changed) return entry;
          touched = true;
          return {
            ...entry,
            imageUrls: nextImageUrls,
            imageMetaByUrl: {
              ...(entry.imageMetaByUrl ?? {}),
              [nextUrl]: nextMeta,
            },
          };
        });
        if (!touched) return session;
        persisted = {
          ...session,
          entries: nextEntries,
          updatedAt: now,
        };
        return persisted;
      }),
    );
    if (persisted) {
      await dbApi.saveGeneratorSession(persisted);
    }
  };

  const applySharedImageReplacement = async (
    context: SharedImageActionContext,
    nextUrl: string,
    nextMeta: ComfyImageGenerationMeta,
  ) => {
    if ("messageId" in context) {
      await replaceChatMessageImage(context, nextUrl, nextMeta);
      return;
    }
    await replaceGeneratorSessionImage(context, nextUrl, nextMeta);
  };

  const runSharedImageAction = async (
    context: SharedImageActionContext,
    mode: "enhance" | "regenerate",
    targetOverride: LookEnhanceTarget = "all",
    promptOverride?: string | LookEnhancePromptOverrides,
  ) => {
    const sourceUrl = context.sourceUrl.trim();
    if (!sourceUrl) return;
    if (imageActionBusy) return;

    const runId = imageActionRunRef.current + 1;
    imageActionRunRef.current = runId;
    imageActionAbortRef.current?.abort();
    const abortController = new AbortController();
    imageActionAbortRef.current = abortController;
    const ensureActive = () => {
      if (
        imageActionRunRef.current !== runId ||
        abortController.signal.aborted
      ) {
        throw new DOMException("Shared image action aborted", "AbortError");
      }
    };

    setImageActionBusy(true);
    if (mode === "enhance") {
      setSharedEnhanceReview(null);
    }
    try {
      const sourceMeta = context.meta ?? chatImageMetaByUrl[sourceUrl] ?? null;
      const promptDefaults = resolveSharedEnhancePromptDefaults(
        activePersona,
        sourceMeta ?? undefined,
      );
      const sourceImage = await resolveImageSource(sourceUrl);
      ensureActive();
      const localizedSourceList = await localizeImageUrls([
        sourceImage || sourceUrl,
      ]);
      ensureActive();
      const sourceForGeneration =
        localizedSourceList[0] || sourceImage || sourceUrl;
      const sourceSeed =
        typeof sourceMeta?.seed === "number" && Number.isFinite(sourceMeta.seed)
          ? sourceMeta.seed
          : stableSeedFromText(sourceForGeneration);
      const nextSeed = stableSeedFromText(
        `${sourceSeed}:${mode}:${Date.now()}`,
      );
      const fallbackPrompt =
        sourceMeta?.prompt?.trim() ||
        "one person, neutral standing pose, clean background, high quality";
      const sourcePromptOverride =
        typeof promptOverride === "string"
          ? promptOverride
          : promptOverride?.sourcePrompt;
      const normalizedSourcePromptOverride = sourcePromptOverride?.trim() || "";
      const defaultSourcePrompt =
        promptDefaults?.sourcePrompt?.trim() || fallbackPrompt;
      const hasCustomSourcePromptOverride = Boolean(
        normalizedSourcePromptOverride &&
          normalizedSourcePromptOverride !== defaultSourcePrompt,
      );
      const basePrompt = normalizedSourcePromptOverride || defaultSourcePrompt;
      const detailPromptKeys: LookEnhanceDetailKey[] = [
        "face",
        "eyes",
        "nose",
        "lips",
        "hands",
        "chest",
        "vagina",
      ];
      const detailPrompts: Partial<Record<LookEnhanceDetailKey, string>> = {};
      if (!hasCustomSourcePromptOverride && promptDefaults?.detailPrompts) {
        for (const key of detailPromptKeys) {
          const cachedValue = promptDefaults.detailPrompts[key]?.trim();
          if (cachedValue) {
            detailPrompts[key] = cachedValue;
          }
        }
      }
      if (
        typeof promptOverride !== "string" &&
        promptOverride?.detailPrompts
      ) {
        for (const key of detailPromptKeys) {
          const overrideValue = promptOverride.detailPrompts[key]?.trim();
          if (overrideValue) {
            detailPrompts[key] = overrideValue;
          }
        }
      }
      const hasDetailPrompts = Object.keys(detailPrompts).length > 0;
      const targetTags: Record<LookEnhanceTarget, string[]> = {
        all: ["full body details", "balanced details"],
        face: ["focus on face", "facial details"],
        eyes: [
          "focus on eyes",
          "sharp eyes",
          "allow eye color update if requested",
        ],
        nose: ["focus on nose", "clean nose shape"],
        lips: ["focus on lips", "lip details"],
        hands: ["focus on hands", "correct fingers", "natural hand anatomy"],
        chest: ["focus on chest", "natural breast details"],
        vagina: ["focus on intimate area", "natural anatomy details"],
      };
      const isHandsEnhance = targetOverride === "hands";
      const isEyesEnhance = targetOverride === "eyes";
      const enhanceDetailLevel =
        targetOverride === "all"
          ? settings.enhanceDetailLevelAll
          : settings.enhanceDetailLevelPart;
      const size = await readImageSize(sourceForGeneration);
      ensureActive();
      const width = normalizeComfyDimension(size.width, 1024);
      const height = normalizeComfyDimension(size.height, 1024);
      const checkpointName =
        sourceMeta?.model?.trim() ||
        activePersona?.imageCheckpoint ||
        undefined;
      let prompt = "";
      let nextSource = "";
      let effectiveSeed = nextSeed;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptSeed = stableSeedFromText(
          `${nextSeed}:${targetOverride}:attempt:${attempt}:${Date.now()}`,
        );
        const attemptPrompt =
          mode === "enhance"
            ? mergePromptTags(basePrompt, [
                "same subject",
                "preserve composition",
                "sharper details",
                "high quality",
                ...targetTags[targetOverride],
                ...(attempt > 0 ? ["noticeable improvement"] : []),
              ])
            : mergePromptTags(basePrompt, [
                "same subject",
                "new variation",
                "different framing details",
                "high quality",
                "clean background",
                ...(attempt > 0 ? ["strong variation"] : []),
              ]);
        const enhanceDetailing =
          mode === "enhance"
            ? {
                enabled: true as const,
                level: enhanceDetailLevel,
                targets: mapEnhanceTargetToDetailTargets(targetOverride),
                prompts: hasDetailPrompts ? detailPrompts : undefined,
                strengthTable: settings.enhanceDetailStrengthTable,
              }
            : undefined;
        const generationFlow = mode === "regenerate" ? "base" : "i2i";
        const styleStrength =
          mode === "enhance"
            ? isHandsEnhance
              ? 0.9
              : isEyesEnhance
                ? 0.95
                : 1
            : 0.78;
        const compositionStrength =
          mode === "enhance"
            ? isHandsEnhance
              ? 0.72
              : isEyesEnhance
                ? 0.82
                : 0.95
            : 0;
        const generatedUrls = await generateComfyImages(
          [
            {
              flow: generationFlow,
              prompt: attemptPrompt,
              width,
              height,
              seed: attemptSeed,
              checkpointName,
              styleReferenceImage: sourceForGeneration,
              styleStrength,
              compositionStrength,
              forceHiResFix: true,
              enableUpscaler: true,
              upscaleFactor: 1.4,
              saveComfyOutputs: settings.saveComfyOutputs,
              ...(enhanceDetailing ? { detailing: enhanceDetailing } : {}),
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
          undefined,
          abortController.signal,
        );
        ensureActive();
        const localized = await localizeImageUrls(generatedUrls);
        ensureActive();
        const candidate =
          mode === "enhance"
            ? await pickPreferredEnhancedUrl(localized, sourceForGeneration)
            : (localized.find(
                (value) =>
                  value.trim() !== sourceForGeneration.trim() &&
                  value.trim() !== sourceUrl,
              ) ??
              localized[0] ??
              "");
        if (!candidate) continue;
        prompt = attemptPrompt;
        effectiveSeed = attemptSeed;
        nextSource = candidate;
        if (
          candidate.trim() !== sourceForGeneration.trim() &&
          candidate.trim() !== sourceUrl
        ) {
          break;
        }
      }
      if (
        !nextSource ||
        nextSource.trim() === sourceForGeneration.trim() ||
        nextSource.trim() === sourceUrl
      ) {
        throw new Error(
          "Перегенерация вернула слишком похожий кадр. Попробуйте изменить prompt.",
        );
      }
      const localizedNextSource = await localizeImageUrlOrThrow(nextSource);
      ensureActive();
      const nextMeta: ComfyImageGenerationMeta = {
        seed: effectiveSeed,
        prompt,
        model: checkpointName,
        flow: mode === "regenerate" ? "base" : "i2i",
      };
      await dbApi.saveImageAsset({
        id: crypto.randomUUID(),
        dataUrl: localizedNextSource,
        meta: nextMeta,
        createdAt: new Date().toISOString(),
      });
      if (mode === "enhance") {
        setSharedEnhanceReview({
          context,
          beforeUrl: sourceUrl,
          afterUrl: localizedNextSource,
          afterMeta: nextMeta,
          target: targetOverride,
        });
      } else {
        await applySharedImageReplacement(
          context,
          localizedNextSource,
          nextMeta,
        );
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        useAppStore.setState({ error: (error as Error).message });
      }
    } finally {
      if (imageActionRunRef.current === runId) {
        setImageActionBusy(false);
        imageActionAbortRef.current = null;
      }
    }
  };

  const enhanceSharedImage = (
    context: SharedImageActionContext,
    targetOverride: LookEnhanceTarget = "all",
    promptOverride?: string | LookEnhancePromptOverrides,
  ) => {
    void runSharedImageAction(
      context,
      "enhance",
      targetOverride,
      promptOverride,
    );
  };

  const regenerateSharedImage = (
    context: SharedImageActionContext,
    promptOverride?: string,
  ) => {
    void runSharedImageAction(context, "regenerate", "all", promptOverride);
  };

  return {
    imageActionBusy,
    sharedEnhanceReview,
    setSharedEnhanceReview,
    applySharedImageReplacement,
    runSharedImageAction,
    enhanceSharedImage,
    regenerateSharedImage,
  };
}
