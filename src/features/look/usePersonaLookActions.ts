import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  generateComfyImages,
  readComfyImageGenerationMeta,
  type ComfyImageGenerationMeta,
} from "../../comfy";
import { localizeImageUrls } from "../../imageStorage";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";
import type {
  LookDetailLevel,
  LookEnhanceDetailKey,
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
  PersonaDraft,
  PersonaLookPack,
} from "../../ui/types";
import {
  LOOK_META_SLOT_KEY,
  mapEnhanceTargetToDetailTargets,
  mergePromptTags,
  parseImageAssetId,
  pickPreferredEnhancedUrl,
  resolveImageSource,
  stableSeedFromText,
  stringifyAppearance,
  withLookMeta,
  type PersonaLookPromptBundle,
} from "./lookHelpers";

type LookKind = "avatar" | "fullbody" | "side" | "back";

export type LookEnhanceReview = {
  packIndex: number | null;
  kind: LookKind;
  beforeUrl: string;
  afterUrl: string;
  beforePreviewUrl: string;
  afterPreviewUrl: string;
  afterMeta: ComfyImageGenerationMeta;
  afterImageId: string;
};

interface UsePersonaLookActionsParams {
  settings: AppSettings;
  personaDraft: PersonaDraft;
  setPersonaDraft: Dispatch<SetStateAction<PersonaDraft>>;
  generatedLookPacks: PersonaLookPack[];
  setGeneratedLookPacks: Dispatch<SetStateAction<PersonaLookPack[]>>;
  lookImageMetaByUrl: Record<string, ComfyImageGenerationMeta>;
  setLookImageMetaByUrl: Dispatch<
    SetStateAction<Record<string, ComfyImageGenerationMeta>>
  >;
  lookPackageCount: number;
  lookDetailLevel: LookDetailLevel;
  lookEnhanceTarget: LookEnhanceTarget;
  lookFastMode: boolean;
  generateSideView: boolean;
  generateBackView: boolean;
  getCachedLookPromptBundle: () => Promise<PersonaLookPromptBundle>;
  saveLookImageAndGetRef: (
    imageUrl: string,
    meta: ComfyImageGenerationMeta,
  ) => Promise<{ imageId: string; imageUrl: string }>;
}

const SHARED_TAGS = [
  "clean white background",
  "no environment",
  "solo:1.4",
  "long shot",
  "head-to-toe view:1.3",
  "whole person view:1.3",
];
const FRONT_FULLBODY_ADDITIONAL_TAGS = [
  "neutral standing pose",
  ...SHARED_TAGS,
];
const ADDITIONAL_SHARED_TAGS = [
  "same person as reference",
  "same character identity",
  "same face and body features",
  "same hairstyle and hair color",
  "same outfit and accessories",
  "preserve clothing design and colors:1.3",
  "do not change gender",
  "do not remove clothes",
  ...SHARED_TAGS,
];
const SIDE_FULLBODY_ADDITIONAL_TAGS = [
  ...ADDITIONAL_SHARED_TAGS,
  "strict side profile view:1.4",
  "exact 90 degree side view:1.4",
  "face turned 90 degrees away from camera",
  "profile silhouette",
];
const BACK_FULLBODY_ADDITIONAL_TAGS = [
  ...ADDITIONAL_SHARED_TAGS,
  "strict back view:1.4",
  "back facing camera:1.4",
  "subject facing away from camera",
  "back of head visible",
];
const AVATAR_ADDITIONAL_TAGS = [
  "close-up",
  "face focus",
  "looking at viewer",
  "solo",
  "detailed background",
  "environmental context",
  "realistic location",
];

export function usePersonaLookActions({
  settings,
  personaDraft,
  setPersonaDraft,
  generatedLookPacks,
  setGeneratedLookPacks,
  lookImageMetaByUrl,
  setLookImageMetaByUrl,
  lookPackageCount,
  lookDetailLevel,
  lookEnhanceTarget,
  lookFastMode,
  generateSideView,
  generateBackView,
  getCachedLookPromptBundle,
  saveLookImageAndGetRef,
}: UsePersonaLookActionsParams) {
  const [enhanceReview, setEnhanceReview] = useState<LookEnhanceReview | null>(
    null,
  );
  const [lookGenerationLoading, setLookGenerationLoading] = useState(false);
  const [enhancingLookImageKey, setEnhancingLookImageKey] = useState<
    string | null
  >(null);
  const [regeneratingLookImageKey, setRegeneratingLookImageKey] = useState<
    string | null
  >(null);

  const lookGenerationRunRef = useRef(0);
  const lookGenerationAbortRef = useRef<AbortController | null>(null);
  const lookEnhanceRunRef = useRef(0);
  const lookEnhanceAbortRef = useRef<AbortController | null>(null);
  const lookRegenerateRunRef = useRef(0);
  const lookRegenerateAbortRef = useRef<AbortController | null>(null);

  const resolveLookUrlForKind = (packIndex: number | null, kind: LookKind) => {
    if (packIndex === null) {
      if (kind === "avatar") return personaDraft.avatarUrl;
      if (kind === "side") return personaDraft.fullBodySideUrl;
      if (kind === "back") return personaDraft.fullBodyBackUrl;
      return personaDraft.fullBodyUrl;
    }
    const pack = generatedLookPacks[packIndex];
    if (!pack) return "";
    if (kind === "avatar") return pack.avatarUrl;
    if (kind === "side") return pack.fullBodySideUrl;
    if (kind === "back") return pack.fullBodyBackUrl;
    return pack.fullBodyUrl;
  };

  const applyEnhancedImage = (
    packIndex: number | null,
    kind: LookKind,
    beforeUrl: string,
    afterUrl: string,
    afterImageId: string,
  ) => {
    if (packIndex !== null) {
      setGeneratedLookPacks((prev) =>
        prev.map((pack, idx) => {
          if (idx !== packIndex) return pack;
          if (kind === "avatar")
            return {
              ...pack,
              avatarUrl: afterUrl,
              avatarImageId: afterImageId,
            };
          if (kind === "side")
            return {
              ...pack,
              fullBodySideUrl: afterUrl,
              fullBodySideImageId: afterImageId,
            };
          if (kind === "back")
            return {
              ...pack,
              fullBodyBackUrl: afterUrl,
              fullBodyBackImageId: afterImageId,
            };
          return {
            ...pack,
            fullBodyUrl: afterUrl,
            fullBodyImageId: afterImageId,
          };
        }),
      );
    }
    setPersonaDraft((prev) => ({
      ...prev,
      avatarUrl:
        kind === "avatar" && prev.avatarUrl === beforeUrl
          ? afterUrl
          : prev.avatarUrl,
      fullBodyUrl:
        kind === "fullbody" && prev.fullBodyUrl === beforeUrl
          ? afterUrl
          : prev.fullBodyUrl,
      fullBodySideUrl:
        kind === "side" && prev.fullBodySideUrl === beforeUrl
          ? afterUrl
          : prev.fullBodySideUrl,
      fullBodyBackUrl:
        kind === "back" && prev.fullBodyBackUrl === beforeUrl
          ? afterUrl
          : prev.fullBodyBackUrl,
      avatarImageId:
        kind === "avatar" && prev.avatarUrl === beforeUrl
          ? afterImageId || prev.avatarImageId
          : prev.avatarImageId,
      fullBodyImageId:
        kind === "fullbody" && prev.fullBodyUrl === beforeUrl
          ? afterImageId || prev.fullBodyImageId
          : prev.fullBodyImageId,
      fullBodySideImageId:
        kind === "side" && prev.fullBodySideUrl === beforeUrl
          ? afterImageId || prev.fullBodySideImageId
          : prev.fullBodySideImageId,
      fullBodyBackImageId:
        kind === "back" && prev.fullBodyBackUrl === beforeUrl
          ? afterImageId || prev.fullBodyBackImageId
          : prev.fullBodyBackImageId,
    }));
  };

  const onGeneratePersonaLook = async () => {
    const appearanceText = stringifyAppearance(personaDraft.appearance);
    if (!appearanceText) {
      useAppStore.setState({ error: "Сначала заполни поля внешности." });
      return;
    }

    const runId = lookGenerationRunRef.current + 1;
    lookGenerationRunRef.current = runId;
    lookGenerationAbortRef.current?.abort();
    const abortController = new AbortController();
    lookGenerationAbortRef.current = abortController;
    const ensureActive = () => {
      if (
        lookGenerationRunRef.current !== runId ||
        abortController.signal.aborted
      ) {
        throw new DOMException("Generation aborted", "AbortError");
      }
    };

    setLookGenerationLoading(true);
    setGeneratedLookPacks([]);
    try {
      ensureActive();
      const promptBundle = await getCachedLookPromptBundle();
      ensureActive();
      const detailPrompts = promptBundle.detailPrompts;
      const fullBodyWidth = lookFastMode ? 704 : 832;
      const fullBodyHeight = lookFastMode ? 1024 : 1216;
      const avatarSize = lookFastMode ? 768 : 1024;
      const useHiResFix = !lookFastMode;
      const useUpscaler = !lookFastMode;
      const useDetailing = !lookFastMode;
      const resolveDetailLevel = (
        view: "front" | "side" | "back",
      ): "soft" | "medium" | "strong" | null => {
        if (!useDetailing) return null;
        if (lookDetailLevel === "off") return null;
        if (view === "front") return lookDetailLevel;
        if (lookDetailLevel === "strong") return "medium";
        return "soft";
      };
      const generationSalt = crypto.randomUUID();
      const sharedSeed = stableSeedFromText(
        [
          personaDraft.name,
          appearanceText,
          personaDraft.stylePrompt,
          promptBundle.avatarPrompt,
          promptBundle.fullBodyPrompt,
          generationSalt,
        ].join("|"),
      );
      const packs: PersonaLookPack[] = [];
      const packageCount = Math.max(1, Math.min(4, lookPackageCount));
      setGeneratedLookPacks(
        Array.from({ length: packageCount }, () => ({
          status: "pending",
          avatarUrl: "",
          fullBodyUrl: "",
          fullBodySideUrl: "",
          fullBodyBackUrl: "",
        })),
      );

      for (let packIndex = 0; packIndex < packageCount; packIndex += 1) {
        ensureActive();
        const packSeed = sharedSeed + packIndex * 997;
        const patchPack = (patch: Partial<PersonaLookPack>) => {
          if (lookGenerationRunRef.current !== runId) return;
          setGeneratedLookPacks((prev) =>
            prev.map((pack, idx) =>
              idx === packIndex ? { ...pack, ...patch } : pack,
            ),
          );
        };
        const fullBodyPrompt = mergePromptTags(promptBundle.fullBodyPrompt, FRONT_FULLBODY_ADDITIONAL_TAGS);
        const fullBodyUrls = await generateComfyImages(
          [
            {
              prompt: fullBodyPrompt,
              width: fullBodyWidth,
              height: fullBodyHeight,
              seed: packSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleStrength: 0,
              compositionStrength: 0,
              forceHiResFix: useHiResFix,
              enableUpscaler: useUpscaler,
              upscaleFactor: 1.5,
              saveComfyOutputs: settings.saveComfyOutputs,
              detailing: resolveDetailLevel("front")
                ? {
                    enabled: true,
                    level: resolveDetailLevel("front") ?? undefined,
                    prompts: detailPrompts,
                    strengthTable: settings.enhanceDetailStrengthTable,
                  }
                : undefined,
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
          undefined,
          abortController.signal,
        );
        ensureActive();
        const localizedFullBody = await localizeImageUrls(fullBodyUrls);
        ensureActive();
        const fullBodySource = localizedFullBody[0];
        if (!fullBodySource) {
          throw new Error(
            `Не удалось сгенерировать fullbody reference для пакета #${packIndex + 1}.`,
          );
        }
        const fullBodyMeta: ComfyImageGenerationMeta = {
          seed: packSeed,
          prompt: fullBodyPrompt,
          model: personaDraft.imageCheckpoint || undefined,
          flow: "base",
        };
        const fullBodyAsset = await saveLookImageAndGetRef(
          fullBodySource,
          fullBodyMeta,
        );
        const fullBodyRef = fullBodyAsset.imageUrl;
        setLookImageMetaByUrl((prev) =>
          withLookMeta(prev, [
            {
              kind: "fullbody",
              url: fullBodyUrls[0],
              meta: fullBodyMeta,
            },
            {
              kind: "fullbody",
              url: fullBodyRef,
              meta: fullBodyMeta,
            },
          ]),
        );
        patchPack({
          fullBodyUrl: fullBodyRef,
          fullBodyImageId: fullBodyAsset.imageId,
        });

        let sideRef = "";
        if (generateSideView) {
          const sideSeed = packSeed + 101;
          const sideReferenceStrength = 1;
          const sideCompositionStrength = 0.08;
          const sidePrompt = mergePromptTags(promptBundle.fullBodyPrompt, SIDE_FULLBODY_ADDITIONAL_TAGS);
          const sideUrls = await generateComfyImages(
            [
              {
                flow: "base",
                prompt: sidePrompt,
                width: fullBodyWidth,
                height: fullBodyHeight,
                seed: sideSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodySource,
                styleStrength: sideReferenceStrength,
                compositionStrength: sideCompositionStrength,
                forceHiResFix: useHiResFix,
                enableUpscaler: useUpscaler,
                upscaleFactor: 1.5,
                saveComfyOutputs: settings.saveComfyOutputs,
                detailing: undefined,
              },
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
            undefined,
            abortController.signal,
          );
          ensureActive();
          const localizedSide = await localizeImageUrls(sideUrls);
          ensureActive();
          const sideSource = localizedSide[0] ?? "";
          const sideMeta: ComfyImageGenerationMeta = {
            seed: sideSeed,
            prompt: sidePrompt,
            model: personaDraft.imageCheckpoint || undefined,
            flow: "base",
          };
          const sideAsset = sideSource
            ? await saveLookImageAndGetRef(sideSource, sideMeta)
            : null;
          sideRef = sideAsset?.imageUrl ?? "";
          if (sideRef) {
            setLookImageMetaByUrl((prev) =>
              withLookMeta(prev, [
                {
                  kind: "side",
                  url: sideUrls[0],
                  meta: sideMeta,
                },
                {
                  kind: "side",
                  url: sideRef,
                  meta: sideMeta,
                },
              ]),
            );
            patchPack({
              fullBodySideUrl: sideRef,
              fullBodySideImageId: sideAsset?.imageId,
            });
          }
        }

        let backRef = "";
        if (generateBackView) {
          const backSeed = packSeed + 211;
          const backReferenceStrength = 1;
          const backCompositionStrength = 0.08;
          const backPrompt = mergePromptTags(promptBundle.fullBodyPrompt, BACK_FULLBODY_ADDITIONAL_TAGS);
          const backUrls = await generateComfyImages(
            [
              {
                flow: "base",
                prompt: backPrompt,
                width: fullBodyWidth,
                height: fullBodyHeight,
                seed: backSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodySource,
                styleStrength: backReferenceStrength,
                compositionStrength: backCompositionStrength,
                forceHiResFix: useHiResFix,
                enableUpscaler: useUpscaler,
                upscaleFactor: 1.5,
                saveComfyOutputs: settings.saveComfyOutputs,
                detailing: undefined,
              },
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
            undefined,
            abortController.signal,
          );
          ensureActive();
          const localizedBack = await localizeImageUrls(backUrls);
          ensureActive();
          const backSource = localizedBack[0] ?? "";
          const backMeta: ComfyImageGenerationMeta = {
            seed: backSeed,
            prompt: backPrompt,
            model: personaDraft.imageCheckpoint || undefined,
            flow: "base",
          };
          const backAsset = backSource
            ? await saveLookImageAndGetRef(backSource, backMeta)
            : null;
          backRef = backAsset?.imageUrl ?? "";
          if (backRef) {
            setLookImageMetaByUrl((prev) =>
              withLookMeta(prev, [
                {
                  kind: "back",
                  url: backUrls[0],
                  meta: backMeta,
                },
                {
                  kind: "back",
                  url: backRef,
                  meta: backMeta,
                },
              ]),
            );
            patchPack({
              fullBodyBackUrl: backRef,
              fullBodyBackImageId: backAsset?.imageId,
            });
          }
        }

        const avatarPrompt = mergePromptTags(promptBundle.avatarPrompt, AVATAR_ADDITIONAL_TAGS);
        const avatarUrls = await generateComfyImages(
          [
            {
              flow: "base",
              prompt: avatarPrompt,
              width: avatarSize,
              height: avatarSize,
              seed: packSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleReferenceImage: fullBodySource,
              styleStrength: 1,
              compositionStrength: 0,
              saveComfyOutputs: settings.saveComfyOutputs,
              detailing: resolveDetailLevel("front")
                ? {
                    enabled: true,
                    level: resolveDetailLevel("front") ?? undefined,
                    prompts: detailPrompts,
                    strengthTable: settings.enhanceDetailStrengthTable,
                  }
                : undefined,
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
          undefined,
          abortController.signal,
        );
        ensureActive();
        const localizedAvatar = await localizeImageUrls(avatarUrls);
        ensureActive();
        const avatarSource = localizedAvatar[0] ?? "";
        const avatarMeta: ComfyImageGenerationMeta = {
          seed: packSeed,
          prompt: avatarPrompt,
          model: personaDraft.imageCheckpoint || undefined,
          flow: "base",
        };
        const avatarAsset = avatarSource
          ? await saveLookImageAndGetRef(avatarSource, avatarMeta)
          : null;
        const avatarRef = avatarAsset?.imageUrl ?? "";
        if (!avatarRef) {
          throw new Error(
            `Не удалось сгенерировать avatar для пакета #${packIndex + 1}.`,
          );
        }
        setLookImageMetaByUrl((prev) =>
          withLookMeta(prev, [
            {
              kind: "avatar",
              url: avatarUrls[0],
              meta: avatarMeta,
            },
            {
              kind: "avatar",
              url: avatarRef,
              meta: avatarMeta,
            },
          ]),
        );
        patchPack({
          avatarUrl: avatarRef,
          avatarImageId: avatarAsset?.imageId,
        });

        const readyPack: PersonaLookPack = {
          status: "ready",
          avatarUrl: avatarRef,
          fullBodyUrl: fullBodyRef,
          fullBodySideUrl: sideRef,
          fullBodyBackUrl: backRef,
          avatarImageId: avatarAsset?.imageId,
          fullBodyImageId: fullBodyAsset.imageId,
        };
        if (generateSideView) {
          readyPack.fullBodySideImageId = parseImageAssetId(sideRef);
        }
        if (generateBackView) {
          readyPack.fullBodyBackImageId = parseImageAssetId(backRef);
        }
        packs.push(readyPack);
        patchPack(readyPack);
      }

      setGeneratedLookPacks(packs);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        useAppStore.setState({ error: (e as Error).message });
      }
    } finally {
      if (lookGenerationRunRef.current === runId) {
        setLookGenerationLoading(false);
        lookGenerationAbortRef.current = null;
      }
    }
  };
  const regenerateLookImage = async (
    packIndex: number | null,
    kind: LookKind,
    imageUrl: string,
    promptOverride?: string,
  ) => {
    const normalizedImageUrl = imageUrl.trim();
    if (!normalizedImageUrl) return;
    const pack = packIndex === null ? null : generatedLookPacks[packIndex];
    if (packIndex !== null && (!pack || pack.status !== "ready")) return;

    const key = packIndex === null ? `draft:${kind}` : `${packIndex}:${kind}`;
    if (lookGenerationLoading) return;
    if (enhancingLookImageKey) return;
    if (regeneratingLookImageKey && regeneratingLookImageKey !== key) return;

    const runId = lookRegenerateRunRef.current + 1;
    lookRegenerateRunRef.current = runId;
    lookRegenerateAbortRef.current?.abort();
    const abortController = new AbortController();
    lookRegenerateAbortRef.current = abortController;
    const ensureActive = () => {
      if (
        lookRegenerateRunRef.current !== runId ||
        abortController.signal.aborted
      ) {
        throw new DOMException("Regeneration aborted", "AbortError");
      }
    };
    setRegeneratingLookImageKey(key);

    const patchPack = (patch: Partial<PersonaLookPack>) => {
      if (lookRegenerateRunRef.current !== runId) return;
      if (packIndex === null) {
        setPersonaDraft((prev) => ({
          ...prev,
          avatarUrl: patch.avatarUrl ?? prev.avatarUrl,
          fullBodyUrl: patch.fullBodyUrl ?? prev.fullBodyUrl,
          fullBodySideUrl: patch.fullBodySideUrl ?? prev.fullBodySideUrl,
          fullBodyBackUrl: patch.fullBodyBackUrl ?? prev.fullBodyBackUrl,
          avatarImageId: patch.avatarImageId ?? prev.avatarImageId,
          fullBodyImageId: patch.fullBodyImageId ?? prev.fullBodyImageId,
          fullBodySideImageId:
            patch.fullBodySideImageId ?? prev.fullBodySideImageId,
          fullBodyBackImageId:
            patch.fullBodyBackImageId ?? prev.fullBodyBackImageId,
        }));
        return;
      }
      setGeneratedLookPacks((prev) =>
        prev.map((candidate, index) =>
          index === packIndex ? { ...candidate, ...patch } : candidate,
        ),
      );
    };

    try {
      const promptBundle = await getCachedLookPromptBundle();
      ensureActive();
      const detailPrompts = promptBundle.detailPrompts;
      const fullBodyWidth = lookFastMode ? 704 : 832;
      const fullBodyHeight = lookFastMode ? 1024 : 1216;
      const avatarSize = lookFastMode ? 768 : 1024;
      const useHiResFix = !lookFastMode;
      const useUpscaler = !lookFastMode;
      const useDetailing = !lookFastMode;
      const resolveDetailLevel = (
        view: "front" | "side" | "back",
      ): "soft" | "medium" | "strong" | null => {
        if (!useDetailing) return null;
        if (lookDetailLevel === "off") return null;
        if (view === "front") return lookDetailLevel;
        if (lookDetailLevel === "strong") return "medium";
        return "soft";
      };
      const detailLevelForKind =
        kind === "side"
          ? resolveDetailLevel("side")
          : kind === "back"
            ? resolveDetailLevel("back")
            : resolveDetailLevel("front");

      const rawFullBodyReference =
        packIndex === null
          ? personaDraft.fullBodyUrl.trim()
          : (pack?.fullBodyUrl.trim() ?? "");
      const fullBodyReference = await resolveImageSource(
        rawFullBodyReference,
        packIndex === null
          ? personaDraft.fullBodyImageId
          : pack?.fullBodyImageId,
      );
      const resolvedSourceImage = await resolveImageSource(normalizedImageUrl);
      const avatarReference = fullBodyReference || resolvedSourceImage;
      if ((kind === "side" || kind === "back") && !fullBodyReference) {
        throw new Error("Для перегенерации side/back нужен fullbody в пакете.");
      }

      const currentSlotUrl = resolveLookUrlForKind(packIndex, kind);
      const sourceMeta =
        lookImageMetaByUrl[currentSlotUrl] ??
        lookImageMetaByUrl[normalizedImageUrl] ??
        lookImageMetaByUrl[resolvedSourceImage] ??
        lookImageMetaByUrl[LOOK_META_SLOT_KEY[kind]] ??
        null;
      const sourceSeed =
        typeof sourceMeta?.seed === "number" && Number.isFinite(sourceMeta.seed)
          ? sourceMeta.seed
          : stableSeedFromText(
              `${personaDraft.name}:${personaDraft.stylePrompt}:${packIndex}:${kind}`,
            );
      const nextSeed = stableSeedFromText(
        `${sourceSeed}:${kind}:regenerate:${Date.now()}`,
      );

      const fallbackPrompt =
        kind === "avatar"
          ? mergePromptTags(promptBundle.avatarPrompt, AVATAR_ADDITIONAL_TAGS)
          : kind === "side"
            ? mergePromptTags(promptBundle.fullBodyPrompt, SIDE_FULLBODY_ADDITIONAL_TAGS)
            : kind === "back"
              ? mergePromptTags(promptBundle.fullBodyPrompt, BACK_FULLBODY_ADDITIONAL_TAGS)
              : mergePromptTags(promptBundle.fullBodyPrompt, FRONT_FULLBODY_ADDITIONAL_TAGS);
      const prompt =
        promptOverride?.trim() ||
        (kind === "side" || kind === "back"
          ? fallbackPrompt
          : sourceMeta?.prompt?.trim() || fallbackPrompt);
      const checkpointName = personaDraft.imageCheckpoint || undefined;

      const detailConfig = detailLevelForKind
        ? {
            enabled: true,
            level: detailLevelForKind,
            prompts: detailPrompts,
            strengthTable: settings.enhanceDetailStrengthTable,
          }
        : undefined;

      const generationItem =
        kind === "avatar"
          ? {
              flow: "base" as const,
              prompt,
              width: avatarSize,
              height: avatarSize,
              seed: nextSeed,
              checkpointName,
              styleReferenceImage: avatarReference || undefined,
              styleStrength: 1,
              compositionStrength: 0,
              saveComfyOutputs: settings.saveComfyOutputs,
              detailing: detailConfig,
            }
          : kind === "side"
            ? {
                flow: "base" as const,
                prompt,
                width: fullBodyWidth,
                height: fullBodyHeight,
                seed: nextSeed,
                checkpointName,
                styleReferenceImage: fullBodyReference,
                styleStrength: 1,
                compositionStrength: 0.08,
                forceHiResFix: useHiResFix,
                enableUpscaler: useUpscaler,
                upscaleFactor: 1.5,
                saveComfyOutputs: settings.saveComfyOutputs,
                detailing: undefined,
              }
            : kind === "back"
              ? {
                  flow: "base" as const,
                  prompt,
                  width: fullBodyWidth,
                  height: fullBodyHeight,
                  seed: nextSeed,
                  checkpointName,
                  styleReferenceImage: fullBodyReference,
                  styleStrength: 1,
                  compositionStrength: 0.08,
                  forceHiResFix: useHiResFix,
                  enableUpscaler: useUpscaler,
                  upscaleFactor: 1.5,
                  saveComfyOutputs: settings.saveComfyOutputs,
                  detailing: undefined,
                }
              : {
                  flow: "base" as const,
                  prompt,
                  width: fullBodyWidth,
                  height: fullBodyHeight,
                  seed: nextSeed,
                  checkpointName,
                  styleStrength: 0,
                  compositionStrength: 0,
                  forceHiResFix: useHiResFix,
                  enableUpscaler: useUpscaler,
                  upscaleFactor: 1.5,
                  saveComfyOutputs: settings.saveComfyOutputs,
                  detailing: detailConfig,
                };

      const generatedUrls = await generateComfyImages(
        [generationItem],
        settings.comfyBaseUrl,
        settings.comfyAuth,
        undefined,
        abortController.signal,
      );
      ensureActive();
      const localized = await localizeImageUrls(generatedUrls);
      ensureActive();
      const nextSource = localized[0] ?? "";
      if (!nextSource) {
        throw new Error("Не удалось перегенерировать изображение.");
      }

      const nextMeta: ComfyImageGenerationMeta = {
        seed: nextSeed,
        prompt,
        model: checkpointName,
        flow: generationItem.flow,
      };
      const nextAsset = await saveLookImageAndGetRef(nextSource, nextMeta);
      const nextRef = nextAsset.imageUrl;
      if (!nextRef) {
        throw new Error("Не удалось сохранить перегенерированное изображение.");
      }

      setLookImageMetaByUrl((prev) =>
        withLookMeta(prev, [
          {
            kind,
            url: generatedUrls[0],
            meta: nextMeta,
          },
          {
            kind,
            url: nextRef,
            meta: nextMeta,
          },
        ]),
      );

      if (kind === "avatar") {
        patchPack({
          avatarUrl: nextRef,
          avatarImageId: nextAsset.imageId,
        });
      } else if (kind === "side") {
        patchPack({
          fullBodySideUrl: nextRef,
          fullBodySideImageId: nextAsset.imageId,
        });
      } else if (kind === "back") {
        patchPack({
          fullBodyBackUrl: nextRef,
          fullBodyBackImageId: nextAsset.imageId,
        });
      } else {
        patchPack({
          fullBodyUrl: nextRef,
          fullBodyImageId: nextAsset.imageId,
        });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        useAppStore.setState({ error: (error as Error).message });
      }
    } finally {
      if (lookRegenerateRunRef.current === runId) {
        setRegeneratingLookImageKey((prev) => (prev === key ? null : prev));
        lookRegenerateAbortRef.current = null;
      }
    }
  };
  const enhanceLookImage = async (
    packIndex: number | null,
    kind: LookKind,
    imageUrl: string,
    targetOverride?: LookEnhanceTarget,
    promptOverride?: string | LookEnhancePromptOverrides,
  ) => {
    if (!imageUrl.trim()) return;
    const key = packIndex === null ? `draft:${kind}` : `${packIndex}:${kind}`;
    if (enhancingLookImageKey && enhancingLookImageKey !== key) {
      return;
    }
    const runId = lookEnhanceRunRef.current + 1;
    lookEnhanceRunRef.current = runId;
    const abortController = new AbortController();
    lookEnhanceAbortRef.current = abortController;
    const ensureEnhanceActive = () => {
      if (
        lookEnhanceRunRef.current !== runId ||
        abortController.signal.aborted
      ) {
        throw new DOMException("Aborted", "AbortError");
      }
    };
    setEnhancingLookImageKey(key);
    try {
      const promptBundle = await getCachedLookPromptBundle();
      ensureEnhanceActive();
      const fullBodyWidth = lookFastMode ? 704 : 832;
      const fullBodyHeight = lookFastMode ? 1024 : 1216;
      const avatarSize = lookFastMode ? 768 : 1024;
      const dims =
        kind === "avatar"
          ? { width: avatarSize, height: avatarSize }
          : { width: fullBodyWidth, height: fullBodyHeight };
      const detailLevel = lookDetailLevel === "off" ? "medium" : lookDetailLevel;
      const basePrompt =
        kind === "avatar"
          ? `${promptBundle.avatarPrompt}, close-up, close face, headshot, face focus, looking at viewer`
          : kind === "side"
            ? `head-to-toe framing:1.4, whole person framing:1.4, side view, profile view, ${promptBundle.fullBodyPrompt}`
            : kind === "back"
              ? `head-to-toe framing:1.4, whole person framing:1.4, back view, from behind, ${promptBundle.fullBodyPrompt}`
              : `head-to-toe framing:1.4, whole person framing:1.4, neutral standing pose, ${promptBundle.fullBodyPrompt}`;
      const metaFromCache = lookImageMetaByUrl[imageUrl];
      const metaFromSource = metaFromCache
        ? null
        : await readComfyImageGenerationMeta(
            imageUrl,
            settings.comfyBaseUrl,
            settings.comfyAuth,
            abortController.signal,
          );
      ensureEnhanceActive();
      const sourceMeta = metaFromCache ?? metaFromSource ?? null;
      const normalizedPromptOverride: LookEnhancePromptOverrides =
        typeof promptOverride === "string"
          ? { sourcePrompt: promptOverride }
          : promptOverride ?? {};
      const overrideSourcePrompt =
        normalizedPromptOverride.sourcePrompt?.trim() ?? "";
      const defaultSourcePrompt = sourceMeta?.prompt?.trim() || basePrompt;
      const hasCustomSourcePromptOverride = Boolean(
        overrideSourcePrompt && overrideSourcePrompt !== defaultSourcePrompt,
      );
      const sourcePrompt =
        overrideSourcePrompt || defaultSourcePrompt;
      const overrideDetailPrompts = normalizedPromptOverride.detailPrompts;
      const detailPromptKeys: LookEnhanceDetailKey[] = [
        "face",
        "eyes",
        "nose",
        "lips",
        "hands",
        "chest",
        "vagina",
      ];
      const effectiveDetailPrompts: Partial<
        Record<LookEnhanceDetailKey | "nipples", string>
      > = {
        ...(!hasCustomSourcePromptOverride ? promptBundle.detailPrompts : {}),
      };
      if (overrideDetailPrompts) {
        for (const key of detailPromptKeys) {
          const nextValue = overrideDetailPrompts[key]?.trim();
          if (nextValue) {
            effectiveDetailPrompts[key] = nextValue;
          }
        }
      }
      const sourceSeed =
        sourceMeta?.seed !== undefined
          ? sourceMeta.seed
          : stableSeedFromText(`${imageUrl}:${kind}`);
      const requestedTarget = targetOverride ?? lookEnhanceTarget;
      console.debug("[tg-gf][enhance][request]", {
        ts: new Date().toISOString(),
        packIndex,
        kind,
        targetOverride: targetOverride ?? null,
        lookEnhanceTarget,
        requestedTarget,
      });
      const isHandsEnhance = requestedTarget === "hands";
      const isEyesEnhance = requestedTarget === "eyes";
      const detailTargets = mapEnhanceTargetToDetailTargets(requestedTarget);
      const hasIntimateTargets = detailTargets.some(
        (target) => target === "nipples" || target === "vagina",
      );
      const enhanceSeed = stableSeedFromText(
        `${sourceSeed}:${imageUrl}:${kind}:${requestedTarget}:${Date.now()}`,
      );
      const enhancePrompt = mergePromptTags(sourcePrompt, [
        "same person",
        "same identity",
        "same outfit",
        "same framing",
        "highly detailed",
        "preserve composition",
      ]);

      const runEnhancePass = async (
        passSeed: number,
        passPrompt: string,
        options?: {
          styleStrength?: number;
          compositionStrength?: number;
          hiresFixDenoise?: number;
          colorFixStrength?: number;
          detailLevel?: LookDetailLevel;
          strictOutputNodeMatch?: boolean;
        },
      ) => {
        const effectiveDetailLevel = options?.detailLevel ?? detailLevel;
        const comfyDetailPrompts: Partial<
          Record<
            "face" | "eyes" | "nose" | "lips" | "hands" | "nipples" | "vagina" | "chest",
            string
          >
        > = {
          ...effectiveDetailPrompts,
        };
        const chestPrompt = effectiveDetailPrompts.chest?.trim();
        if (chestPrompt) {
          comfyDetailPrompts.nipples = chestPrompt;
        }
        const preferredOutputTitles = [
          "Preview after Detailing",
          "Preview after Upscale/HiRes Fix",
        ];
        return generateComfyImages(
          [
            {
              flow: "i2i",
              prompt: passPrompt,
              width: dims.width,
              height: dims.height,
              seed: passSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleReferenceImage: imageUrl,
              styleStrength: options?.styleStrength ?? (isHandsEnhance ? 0.9 : isEyesEnhance ? 0.95 : 1),
              compositionStrength:
                options?.compositionStrength ??
                (isHandsEnhance ? 0.7 : isEyesEnhance ? 0.82 : 1),
              forceHiResFix: true,
              enableUpscaler: true,
              upscaleFactor: 1.4,
              hiresFixDenoise:
                options?.hiresFixDenoise ?? (isHandsEnhance ? 0.45 : 0.36),
              colorFixStrength:
                options?.colorFixStrength ?? (isHandsEnhance ? 0.5 : 0.4),
              saveComfyOutputs: settings.saveComfyOutputs,
              outputNodeTitleIncludes: preferredOutputTitles,
              strictOutputNodeMatch: options?.strictOutputNodeMatch ?? false,
              pickLatestImageOnly: false,
              debugEnhanceOutputs: true,
              detailing: {
                enabled: true,
                level:
                  effectiveDetailLevel === "off"
                    ? "strong"
                    : effectiveDetailLevel,
                targets: detailTargets,
                prompts: comfyDetailPrompts,
                strengthTable: settings.enhanceDetailStrengthTable,
                disableIntimateDetailers: !hasIntimateTargets,
              },
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
          undefined,
          abortController.signal,
        );
      };

      const enhancedUrls = await runEnhancePass(enhanceSeed, enhancePrompt);
      ensureEnhanceActive();
      let localized = await localizeImageUrls(enhancedUrls);
      ensureEnhanceActive();
      let improvedSource = await pickPreferredEnhancedUrl(localized, imageUrl);
      let effectiveSeed = enhanceSeed;
      const enhanceMeta: ComfyImageGenerationMeta = {
        seed: effectiveSeed,
        prompt: enhancePrompt,
        model: personaDraft.imageCheckpoint || undefined,
        flow: "i2i",
      };
      const improvedAsset = improvedSource
        ? await saveLookImageAndGetRef(improvedSource, enhanceMeta)
        : null;
      const improved = improvedAsset?.imageUrl ?? "";
      if (!improved) {
        throw new Error("Не удалось получить улучшенное изображение.");
      }
      setEnhanceReview({
        packIndex,
        kind,
        beforeUrl: resolveLookUrlForKind(packIndex, kind) || imageUrl,
        afterUrl: improved,
        beforePreviewUrl: imageUrl,
        afterPreviewUrl: improvedSource || improved,
        afterMeta: enhanceMeta,
        afterImageId: improvedAsset?.imageId ?? "",
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        useAppStore.setState({ error: (e as Error).message });
      }
    } finally {
      if (lookEnhanceRunRef.current === runId) {
        setEnhancingLookImageKey((prev) => (prev === key ? null : prev));
        lookEnhanceAbortRef.current = null;
      }
    }
  };

  const stopPersonaLookGeneration = () => {
    lookGenerationRunRef.current += 1;
    lookGenerationAbortRef.current?.abort();
    lookGenerationAbortRef.current = null;
    setLookGenerationLoading(false);
  };

  const stopLookEnhancement = () => {
    lookEnhanceRunRef.current += 1;
    lookEnhanceAbortRef.current?.abort();
    lookEnhanceAbortRef.current = null;
    setEnhancingLookImageKey(null);
  };

  const stopLookRegeneration = () => {
    lookRegenerateRunRef.current += 1;
    lookRegenerateAbortRef.current?.abort();
    lookRegenerateAbortRef.current = null;
    setRegeneratingLookImageKey(null);
  };

  return {
    enhanceReview,
    setEnhanceReview,
    lookGenerationLoading,
    enhancingLookImageKey,
    regeneratingLookImageKey,
    onGeneratePersonaLook,
    regenerateLookImage,
    enhanceLookImage,
    applyEnhancedImage,
    stopPersonaLookGeneration,
    stopLookEnhancement,
    stopLookRegeneration,
  };
}
