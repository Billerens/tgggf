import { type ComfyGenerationItem, type ComfyImageGenerationMeta } from "../../comfy";
import { dbApi } from "../../db";
import { generatePersonaLookPrompts } from "../../lmstudio";
import type { AppSettings, Persona, PersonaLookPromptCache } from "../../types";
import type { LookEnhanceTarget } from "../../ui/types";

export type LookMetaKind = "avatar" | "fullbody" | "side" | "back";
export type ComfyDetailTarget = NonNullable<
  NonNullable<ComfyGenerationItem["detailing"]>["targets"]
>[number];
export type PersonaLookPromptBundle = Awaited<
  ReturnType<typeof generatePersonaLookPrompts>
>;

export const LOOK_META_SLOT_KEY: Record<LookMetaKind, string> = {
  avatar: "__slot__:avatar",
  fullbody: "__slot__:fullbody",
  side: "__slot__:side",
  back: "__slot__:back",
};

export function stableSeedFromText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash || 1;
}

export function resolveLookPromptModel(
  settings: Pick<AppSettings, "imagePromptModel" | "model">,
) {
  const imagePromptModel = settings.imagePromptModel.trim();
  if (imagePromptModel) return imagePromptModel;
  return settings.model.trim();
}

function normalizeAppearanceFragment(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildLookPromptCacheFingerprint(appearance: Persona["appearance"]) {
  const serialized = [
    `face=${normalizeAppearanceFragment(appearance.faceDescription)}`,
    `height=${normalizeAppearanceFragment(appearance.height)}`,
    `eyes=${normalizeAppearanceFragment(appearance.eyes)}`,
    `lips=${normalizeAppearanceFragment(appearance.lips)}`,
    `hair=${normalizeAppearanceFragment(appearance.hair)}`,
    `age=${normalizeAppearanceFragment(appearance.ageType)}`,
    `body=${normalizeAppearanceFragment(appearance.bodyType)}`,
    `markers=${normalizeAppearanceFragment(appearance.markers)}`,
    `accessories=${normalizeAppearanceFragment(appearance.accessories)}`,
    `clothing=${normalizeAppearanceFragment(appearance.clothingStyle)}`,
    `skin=${normalizeAppearanceFragment(appearance.skin)}`,
  ].join("|");
  return stableSeedFromText(serialized);
}

export function toLookPromptBundle(cache: PersonaLookPromptCache): PersonaLookPromptBundle {
  return {
    avatarPrompt: cache.avatarPrompt,
    fullBodyPrompt: cache.fullBodyPrompt,
    detailPrompts: cache.detailPrompts,
  };
}

export function waitMs(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function splitPromptTags(prompt: string) {
  return prompt
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function mergePromptTags(basePrompt: string, additionalTags: string[]) {
  const existing = splitPromptTags(basePrompt);
  const seen = new Set(existing.map((tag) => tag.toLowerCase()));
  const merged = [...existing];
  for (const tag of additionalTags.map((item) => item.trim()).filter(Boolean)) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.unshift(tag);
  }
  return merged.join(", ");
}

function readImageArea(url: string, timeoutMs = 2500) {
  return new Promise<number>((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (area: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(area);
    };
    const timeoutId = window.setTimeout(() => finish(0), timeoutMs);
    image.onload = () =>
      finish(Math.max(0, image.naturalWidth) * Math.max(0, image.naturalHeight));
    image.onerror = () => finish(0);
    image.decoding = "async";
    image.src = url;
  });
}

export async function pickPreferredEnhancedUrl(
  candidates: string[],
  sourceUrl: string,
) {
  const source = sourceUrl.trim();
  const normalizedCandidates = Array.from(
    new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)),
  );
  if (normalizedCandidates.length === 0) return "";
  const nonSourceCandidates = source
    ? normalizedCandidates.filter((candidate) => candidate !== source)
    : normalizedCandidates;
  const pool =
    nonSourceCandidates.length > 0 ? nonSourceCandidates : normalizedCandidates;
  if (pool.length === 1) return pool[0];

  const ranked = await Promise.all(
    pool.map(async (url, index) => ({
      url,
      index,
      area: await readImageArea(url),
    })),
  );
  ranked.sort((left, right) => right.area - left.area || left.index - right.index);
  return ranked[0]?.url ?? pool[0];
}

export async function readImageSize(url: string, timeoutMs = 2500) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (size: { width: number; height: number }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(size);
    };
    const timeoutId = window.setTimeout(
      () => finish({ width: 1024, height: 1024 }),
      timeoutMs,
    );
    image.onload = () =>
      finish({
        width: Math.max(1, image.naturalWidth),
        height: Math.max(1, image.naturalHeight),
      });
    image.onerror = () => finish({ width: 1024, height: 1024 });
    image.decoding = "async";
    image.src = url;
  });
}

export function normalizeComfyDimension(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const rounded = Math.round(value / 64) * 64;
  return Math.max(512, Math.min(1536, rounded || fallback));
}

export function withLookMeta(
  prev: Record<string, ComfyImageGenerationMeta>,
  updates: Array<{
    kind: LookMetaKind;
    url?: string;
    meta: ComfyImageGenerationMeta;
  }>,
) {
  const next = { ...prev };
  for (const update of updates) {
    if (update.url) {
      next[update.url] = update.meta;
    }
    next[LOOK_META_SLOT_KEY[update.kind]] = update.meta;
  }
  return next;
}

export function synchronizeLookMetaWithUrls(
  metaByUrl: Record<string, ComfyImageGenerationMeta> | undefined,
  urls: Partial<Record<LookMetaKind, string>>,
) {
  const next: Record<string, ComfyImageGenerationMeta> = {
    ...(metaByUrl ?? {}),
  };
  for (const kind of Object.keys(LOOK_META_SLOT_KEY) as LookMetaKind[]) {
    const slotKey = LOOK_META_SLOT_KEY[kind];
    const url = (urls[kind] ?? "").trim();
    const slotMeta = next[slotKey];
    const urlMeta = url ? next[url] : undefined;
    const resolved = slotMeta ?? urlMeta;
    if (!resolved) continue;
    next[slotKey] = resolved;
    if (url) {
      next[url] = resolved;
    }
  }
  return next;
}

export function mapEnhanceTargetToDetailTargets(
  target: LookEnhanceTarget,
): ComfyDetailTarget[] {
  if (target === "all") {
    return ["face", "eyes", "nose", "lips", "hands", "nipples", "vagina"];
  }
  if (target === "chest") return ["nipples"];
  if (target === "vagina") return ["vagina"];
  return [target];
}

export function stringifyAppearance(appearance: Persona["appearance"]) {
  return [
    appearance.faceDescription,
    appearance.height,
    appearance.eyes,
    appearance.lips,
    appearance.hair,
    appearance.skin,
    appearance.ageType,
    appearance.bodyType,
    appearance.markers,
    appearance.accessories,
    appearance.clothingStyle,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(", ");
}

export function toImageAssetLink(imageId: string) {
  const normalized = imageId.trim();
  return normalized ? `idb://${normalized}` : "";
}

export function parseImageAssetId(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

export async function resolveImageSource(source: string, imageIdHint?: string) {
  const normalized = source.trim();
  if (!normalized) return "";
  const hintedId = (imageIdHint ?? "").trim();
  if (hintedId) {
    const hintedAsset = await dbApi.getImageAsset(hintedId);
    if (hintedAsset?.dataUrl) return hintedAsset.dataUrl;
  }
  const parsedId = parseImageAssetId(normalized);
  if (!parsedId) return normalized;
  const asset = await dbApi.getImageAsset(parsedId);
  return asset?.dataUrl ?? "";
}
