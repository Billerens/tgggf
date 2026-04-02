import type { FormEvent } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ComfyImageGenerationMeta } from "../../comfy";
import { dbApi } from "../../db";
import type { GeneratedPersonaDraft } from "../../lmstudio";
import type { Persona } from "../../types";
import {
  createEmptyPersonaDraft,
  type PersonaDraft,
  type PersonaLookPack,
  type PersonaModalTab,
} from "../../ui/types";
import {
  LOOK_META_SLOT_KEY,
  parseImageAssetId,
  synchronizeLookMetaWithUrls,
  toImageAssetLink,
  type LookMetaKind,
} from "../look/lookHelpers";

interface UsePersonaDraftActionsParams {
  savePersona: (
    input: Omit<Persona, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ) => Promise<void>;
  personaDraft: PersonaDraft;
  setPersonaDraft: Dispatch<SetStateAction<PersonaDraft>>;
  editingPersonaId: string | null;
  setEditingPersonaId: Dispatch<SetStateAction<string | null>>;
  lookImageMetaByUrl: Record<string, ComfyImageGenerationMeta>;
  setLookImageMetaByUrl: Dispatch<
    SetStateAction<Record<string, ComfyImageGenerationMeta>>
  >;
  setGeneratedLookPacks: Dispatch<SetStateAction<PersonaLookPack[]>>;
  lookSessionAssetIdsRef: MutableRefObject<Set<string>>;
  setShowPersonaModal: Dispatch<SetStateAction<boolean>>;
  setPersonaModalTab: Dispatch<SetStateAction<PersonaModalTab>>;
}

export function usePersonaDraftActions({
  savePersona,
  personaDraft,
  setPersonaDraft,
  editingPersonaId,
  setEditingPersonaId,
  lookImageMetaByUrl,
  setLookImageMetaByUrl,
  setGeneratedLookPacks,
  lookSessionAssetIdsRef,
  setShowPersonaModal,
  setPersonaModalTab,
}: UsePersonaDraftActionsParams) {
  const buildLookSlotMeta = (
    kind: LookMetaKind,
    syncedLookMeta: Record<string, ComfyImageGenerationMeta>,
    url: string,
  ) => {
    const normalizedUrl = url.trim();
    if (normalizedUrl && syncedLookMeta[normalizedUrl]) {
      return syncedLookMeta[normalizedUrl];
    }
    return syncedLookMeta[LOOK_META_SLOT_KEY[kind]];
  };

  const createLookAsset = async (
    imageUrl: string,
    meta: ComfyImageGenerationMeta | undefined,
  ) => {
    const normalizedUrl = imageUrl.trim();
    if (!normalizedUrl) return "";
    if (normalizedUrl.startsWith("idb://")) {
      const existingId = normalizedUrl.slice("idb://".length).trim();
      if (!existingId) return "";
      if (meta) {
        const existing = await dbApi.getImageAsset(existingId);
        if (existing) {
          await dbApi.saveImageAsset({
            ...existing,
            meta,
          });
        }
      }
      return existingId;
    }
    const imageId = crypto.randomUUID();
    await dbApi.saveImageAsset({
      id: imageId,
      dataUrl: normalizedUrl,
      meta,
      createdAt: new Date().toISOString(),
    });
    lookSessionAssetIdsRef.current.add(imageId);
    return imageId;
  };

  const saveLookImageAndGetRef = async (
    imageUrl: string,
    meta: ComfyImageGenerationMeta,
  ) => {
    const imageId = await createLookAsset(imageUrl, meta);
    return {
      imageId,
      imageUrl: toImageAssetLink(imageId),
    };
  };

  const startEditPersona = async (persona: Persona) => {
    const avatarImageIdFromLink = parseImageAssetId(persona.avatarUrl);
    const fullBodyImageIdFromLink = parseImageAssetId(persona.fullBodyUrl);
    const sideImageIdFromLink = parseImageAssetId(persona.fullBodySideUrl);
    const backImageIdFromLink = parseImageAssetId(persona.fullBodyBackUrl);

    const initialAvatarImageId =
      persona.avatarImageId.trim() || avatarImageIdFromLink;
    const initialFullBodyImageId =
      persona.fullBodyImageId.trim() || fullBodyImageIdFromLink;
    const initialSideImageId =
      persona.fullBodySideImageId.trim() || sideImageIdFromLink;
    const initialBackImageId =
      persona.fullBodyBackImageId.trim() || backImageIdFromLink;

    const imageAssets = await dbApi.getImageAssets([
      initialAvatarImageId,
      initialFullBodyImageId,
      initialSideImageId,
      initialBackImageId,
    ]);
    const assetById = Object.fromEntries(
      imageAssets.map((asset) => [asset.id, asset]),
    );
    const personaMetaByUrl = Object.fromEntries(
      Object.entries(persona.imageMetaByUrl ?? {}).map(([key, value]) => [
        key.trim(),
        value,
      ]),
    ) as Record<string, ComfyImageGenerationMeta>;
    const resolvedAvatarUrl =
      assetById[initialAvatarImageId]?.dataUrl ||
      (persona.avatarUrl.startsWith("idb://") ? "" : persona.avatarUrl) ||
      "";
    const resolvedFullBodyUrl =
      assetById[initialFullBodyImageId]?.dataUrl ||
      (persona.fullBodyUrl.startsWith("idb://") ? "" : persona.fullBodyUrl) ||
      "";
    const resolvedSideUrl =
      assetById[initialSideImageId]?.dataUrl ||
      (persona.fullBodySideUrl.startsWith("idb://")
        ? ""
        : persona.fullBodySideUrl) ||
      "";
    const resolvedBackUrl =
      assetById[initialBackImageId]?.dataUrl ||
      (persona.fullBodyBackUrl.startsWith("idb://")
        ? ""
        : persona.fullBodyBackUrl) ||
      "";
    const syncedLookMeta = synchronizeLookMetaWithUrls(persona.imageMetaByUrl, {
      avatar: resolvedAvatarUrl,
      fullbody: resolvedFullBodyUrl,
      side: resolvedSideUrl,
      back: resolvedBackUrl,
    });
    const resolveLegacyLookMeta = (
      kind: LookMetaKind,
      resolvedUrl: string,
      originalUrl: string,
      imageId: string,
      assetMeta?: ComfyImageGenerationMeta,
    ) => {
      if (assetMeta) return assetMeta;
      const normalizedResolved = resolvedUrl.trim();
      const normalizedOriginal = originalUrl.trim();
      const normalizedImageId = imageId.trim();
      const idbLink = normalizedImageId ? toImageAssetLink(normalizedImageId) : "";
      return (
        personaMetaByUrl[LOOK_META_SLOT_KEY[kind]] ??
        (normalizedResolved ? personaMetaByUrl[normalizedResolved] : undefined) ??
        (normalizedOriginal ? personaMetaByUrl[normalizedOriginal] : undefined) ??
        (idbLink ? personaMetaByUrl[idbLink] : undefined)
      );
    };
    const avatarMeta = resolveLegacyLookMeta(
      "avatar",
      resolvedAvatarUrl,
      persona.avatarUrl,
      initialAvatarImageId,
      initialAvatarImageId ? assetById[initialAvatarImageId]?.meta : undefined,
    );
    if (avatarMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.avatar] = avatarMeta;
      if (resolvedAvatarUrl) syncedLookMeta[resolvedAvatarUrl] = avatarMeta;
    }
    const fullBodyMeta = resolveLegacyLookMeta(
      "fullbody",
      resolvedFullBodyUrl,
      persona.fullBodyUrl,
      initialFullBodyImageId,
      initialFullBodyImageId
        ? assetById[initialFullBodyImageId]?.meta
        : undefined,
    );
    if (fullBodyMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.fullbody] = fullBodyMeta;
      if (resolvedFullBodyUrl) syncedLookMeta[resolvedFullBodyUrl] = fullBodyMeta;
    }
    const sideMeta = resolveLegacyLookMeta(
      "side",
      resolvedSideUrl,
      persona.fullBodySideUrl,
      initialSideImageId,
      initialSideImageId ? assetById[initialSideImageId]?.meta : undefined,
    );
    if (sideMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.side] = sideMeta;
      if (resolvedSideUrl) syncedLookMeta[resolvedSideUrl] = sideMeta;
    }
    const backMeta = resolveLegacyLookMeta(
      "back",
      resolvedBackUrl,
      persona.fullBodyBackUrl,
      initialBackImageId,
      initialBackImageId ? assetById[initialBackImageId]?.meta : undefined,
    );
    if (backMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.back] = backMeta;
      if (resolvedBackUrl) syncedLookMeta[resolvedBackUrl] = backMeta;
    }

    const ensureImageId = async (
      kind: LookMetaKind,
      existingImageId: string,
      resolvedUrl: string,
    ) => {
      const normalizedExisting = existingImageId.trim();
      if (normalizedExisting) return normalizedExisting;
      const normalizedUrl = resolvedUrl.trim();
      if (!normalizedUrl || normalizedUrl.startsWith("idb://")) return "";
      return createLookAsset(
        normalizedUrl,
        buildLookSlotMeta(kind, syncedLookMeta, normalizedUrl),
      );
    };

    const avatarImageId = await ensureImageId(
      "avatar",
      initialAvatarImageId,
      resolvedAvatarUrl,
    );
    const fullBodyImageId = await ensureImageId(
      "fullbody",
      initialFullBodyImageId,
      resolvedFullBodyUrl,
    );
    const fullBodySideImageId = await ensureImageId(
      "side",
      initialSideImageId,
      resolvedSideUrl,
    );
    const fullBodyBackImageId = await ensureImageId(
      "back",
      initialBackImageId,
      resolvedBackUrl,
    );
    setEditingPersonaId(persona.id);
    setGeneratedLookPacks([]);
    setLookImageMetaByUrl(syncedLookMeta);
    setPersonaDraft({
      name: persona.name,
      personalityPrompt: persona.personalityPrompt,
      stylePrompt: persona.stylePrompt,
      appearance: persona.appearance,
      imageCheckpoint: persona.imageCheckpoint,
      advanced: persona.advanced,
      avatarUrl: avatarImageId ? toImageAssetLink(avatarImageId) : resolvedAvatarUrl,
      fullBodyUrl: fullBodyImageId
        ? toImageAssetLink(fullBodyImageId)
        : resolvedFullBodyUrl,
      fullBodySideUrl: fullBodySideImageId
        ? toImageAssetLink(fullBodySideImageId)
        : resolvedSideUrl,
      fullBodyBackUrl: fullBodyBackImageId
        ? toImageAssetLink(fullBodyBackImageId)
        : resolvedBackUrl,
      avatarImageId,
      fullBodyImageId,
      fullBodySideImageId,
      fullBodyBackImageId,
      imageMetaByUrl: syncedLookMeta,
      lookPromptCache: persona.lookPromptCache,
    });
    setShowPersonaModal(true);
    setPersonaModalTab("editor");
  };

  const onPersonaSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!personaDraft.name.trim()) return;
    const syncedLookMeta = synchronizeLookMetaWithUrls(lookImageMetaByUrl, {
      avatar: personaDraft.avatarUrl,
      fullbody: personaDraft.fullBodyUrl,
      side: personaDraft.fullBodySideUrl,
      back: personaDraft.fullBodyBackUrl,
    });
    const avatarImageId = await createLookAsset(
      personaDraft.avatarUrl,
      buildLookSlotMeta("avatar", syncedLookMeta, personaDraft.avatarUrl),
    );
    const fullBodyImageId = await createLookAsset(
      personaDraft.fullBodyUrl,
      buildLookSlotMeta("fullbody", syncedLookMeta, personaDraft.fullBodyUrl),
    );
    const fullBodySideImageId = await createLookAsset(
      personaDraft.fullBodySideUrl,
      buildLookSlotMeta("side", syncedLookMeta, personaDraft.fullBodySideUrl),
    );
    const fullBodyBackImageId = await createLookAsset(
      personaDraft.fullBodyBackUrl,
      buildLookSlotMeta("back", syncedLookMeta, personaDraft.fullBodyBackUrl),
    );
    await savePersona({
      ...personaDraft,
      avatarUrl: toImageAssetLink(avatarImageId),
      fullBodyUrl: toImageAssetLink(fullBodyImageId),
      fullBodySideUrl: toImageAssetLink(fullBodySideImageId),
      fullBodyBackUrl: toImageAssetLink(fullBodyBackImageId),
      imageMetaByUrl: syncedLookMeta,
      avatarImageId,
      fullBodyImageId,
      fullBodySideImageId,
      fullBodyBackImageId,
      id: editingPersonaId ?? undefined,
    });
    for (const retainedId of [
      avatarImageId,
      fullBodyImageId,
      fullBodySideImageId,
      fullBodyBackImageId,
    ]) {
      if (retainedId) {
        lookSessionAssetIdsRef.current.delete(retainedId);
      }
    }
    setEditingPersonaId(null);
    setLookImageMetaByUrl({});
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const onResetDraft = () => {
    setEditingPersonaId(null);
    setGeneratedLookPacks([]);
    setLookImageMetaByUrl({});
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const applyLookPack = (pack: PersonaLookPack) => {
    setLookImageMetaByUrl((prev) =>
      synchronizeLookMetaWithUrls(prev, {
        avatar: pack.avatarUrl,
        fullbody: pack.fullBodyUrl,
        side: pack.fullBodySideUrl,
        back: pack.fullBodyBackUrl,
      }),
    );
    setPersonaDraft((prev) => ({
      ...prev,
      avatarUrl: pack.avatarUrl,
      fullBodyUrl: pack.fullBodyUrl,
      fullBodySideUrl: pack.fullBodySideUrl,
      fullBodyBackUrl: pack.fullBodyBackUrl,
      avatarImageId: pack.avatarImageId ?? parseImageAssetId(pack.avatarUrl),
      fullBodyImageId:
        pack.fullBodyImageId ?? parseImageAssetId(pack.fullBodyUrl),
      fullBodySideImageId:
        pack.fullBodySideImageId ?? parseImageAssetId(pack.fullBodySideUrl),
      fullBodyBackImageId:
        pack.fullBodyBackImageId ?? parseImageAssetId(pack.fullBodyBackUrl),
    }));
  };

  const onSaveGenerated = async (draft: GeneratedPersonaDraft) => {
    const avatarImageId = await createLookAsset(draft.avatarUrl || "", undefined);
    await savePersona({
      name: draft.name,
      personalityPrompt: draft.personalityPrompt,
      stylePrompt: draft.stylePrompt,
      appearance: draft.appearance,
      imageCheckpoint: "",
      advanced: draft.advanced,
      avatarUrl: toImageAssetLink(avatarImageId),
      fullBodyUrl: "",
      fullBodySideUrl: "",
      fullBodyBackUrl: "",
      avatarImageId,
      fullBodyImageId: "",
      fullBodySideImageId: "",
      fullBodyBackImageId: "",
    });
  };

  const onMoveGeneratedToEditor = (draft: GeneratedPersonaDraft) => {
    setLookImageMetaByUrl({});
    setPersonaDraft({
      name: draft.name,
      personalityPrompt: draft.personalityPrompt,
      stylePrompt: draft.stylePrompt,
      appearance: draft.appearance,
      imageCheckpoint: "",
      advanced: draft.advanced,
      avatarUrl: draft.avatarUrl || "",
      fullBodyUrl: "",
      fullBodySideUrl: "",
      fullBodyBackUrl: "",
      avatarImageId: "",
      fullBodyImageId: "",
      fullBodySideImageId: "",
      fullBodyBackImageId: "",
      imageMetaByUrl: {},
      lookPromptCache: undefined,
    });
    setEditingPersonaId(null);
    setPersonaModalTab("editor");
  };

  return {
    createLookAsset,
    saveLookImageAndGetRef,
    startEditPersona,
    onPersonaSubmit,
    onResetDraft,
    applyLookPack,
    onSaveGenerated,
    onMoveGeneratedToEditor,
  };
}
