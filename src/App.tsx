import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { GeneratedPersonaDraft } from "./lmstudio";
import {
  generatePersonaDrafts,
  generatePersonaLookPrompts,
  generateThemedComfyPrompt,
  listModels,
} from "./lmstudio";
import {
  generateComfyImages,
  listComfyCheckpoints,
  readComfyImageGenerationMeta,
  type ComfyGenerationItem,
  type ComfyImageGenerationMeta,
} from "./comfy";
import { dbApi } from "./db";
import { localizeImageUrlOrThrow, localizeImageUrls } from "./imageStorage";
import { useAppStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ChatDetailsModal } from "./components/ChatDetailsModal";
import { EnhanceCompareModal } from "./components/EnhanceCompareModal";
import { ErrorToast } from "./components/ErrorToast";
import { GenerationPane } from "./components/GenerationPane";
import { PersonaModal } from "./components/PersonaModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import type {
  AppSettings,
  GeneratorSession,
  Persona,
  PersonaLookPromptCache,
} from "./types";
import {
  createEmptyPersonaDraft,
  type LookDetailLevel,
  type LookEnhanceTarget,
  type PersonaLookPack,
  type PersonaModalTab,
  type SidebarTab,
} from "./ui/types";

type PersonaLookPromptBundle = Awaited<
  ReturnType<typeof generatePersonaLookPrompts>
>;
type PwaInstallStatus = "installed" | "available" | "unavailable";
type LookMetaKind = "avatar" | "fullbody" | "side" | "back";
type ChatImageActionContext = {
  messageId: string;
  sourceUrl: string;
  meta?: ComfyImageGenerationMeta;
};
type GeneratorImageActionContext = {
  sessionId: string;
  sourceUrl: string;
  meta?: ComfyImageGenerationMeta;
};
type SharedImageEnhanceReview = {
  context: ChatImageActionContext | GeneratorImageActionContext;
  beforeUrl: string;
  afterUrl: string;
  afterMeta: ComfyImageGenerationMeta;
  target: LookEnhanceTarget;
};
type ComfyDetailTarget = NonNullable<
  NonNullable<ComfyGenerationItem["detailing"]>["targets"]
>[number];

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function stableSeedFromText(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

function resolveLookPromptModel(
  settings: Pick<AppSettings, "imagePromptModel" | "model">,
) {
  const imagePromptModel = settings.imagePromptModel.trim();
  if (imagePromptModel) return imagePromptModel;
  return settings.model.trim();
}

function normalizeAppearanceFragment(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildLookPromptCacheFingerprint(appearance: Persona["appearance"]) {
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

function toLookPromptBundle(
  cache: PersonaLookPromptCache,
): PersonaLookPromptBundle {
  return {
    avatarPrompt: cache.avatarPrompt,
    fullBodyPrompt: cache.fullBodyPrompt,
    detailPrompts: cache.detailPrompts,
  };
}

function waitMs(ms: number) {
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

function mergePromptTags(basePrompt: string, additionalTags: string[]) {
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
      finish(
        Math.max(0, image.naturalWidth) * Math.max(0, image.naturalHeight),
      );
    image.onerror = () => finish(0);
    image.decoding = "async";
    image.src = url;
  });
}

async function pickPreferredEnhancedUrl(
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
  ranked.sort(
    (left, right) => right.area - left.area || left.index - right.index,
  );
  return ranked[0]?.url ?? pool[0];
}

async function readImageSize(url: string, timeoutMs = 2500) {
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

function normalizeComfyDimension(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const rounded = Math.round(value / 64) * 64;
  return Math.max(512, Math.min(1536, rounded || fallback));
}

const LOOK_META_SLOT_KEY: Record<LookMetaKind, string> = {
  avatar: "__slot__:avatar",
  fullbody: "__slot__:fullbody",
  side: "__slot__:side",
  back: "__slot__:back",
};

function withLookMeta(
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

function synchronizeLookMetaWithUrls(
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

function mapEnhanceTargetToDetailTargets(
  target: LookEnhanceTarget,
): ComfyDetailTarget[] {
  if (target === "all") {
    return ["face", "eyes", "nose", "lips", "hands", "nipples", "vagina"];
  }
  if (target === "chest") return ["nipples"];
  if (target === "vagina") return ["vagina"];
  return [target];
}

function stringifyAppearance(appearance: Persona["appearance"]) {
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

function toImageAssetLink(imageId: string) {
  const normalized = imageId.trim();
  return normalized ? `idb://${normalized}` : "";
}

function parseImageAssetId(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

async function resolveImageSource(source: string, imageIdHint?: string) {
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

export default function App() {
  const [enhanceReview, setEnhanceReview] = useState<{
    packIndex: number | null;
    kind: "avatar" | "fullbody" | "side" | "back";
    beforeUrl: string;
    afterUrl: string;
    beforePreviewUrl: string;
    afterPreviewUrl: string;
    afterMeta: ComfyImageGenerationMeta;
    afterImageId: string;
  } | null>(null);
  const [sharedEnhanceReview, setSharedEnhanceReview] =
    useState<SharedImageEnhanceReview | null>(null);

  const {
    personas,
    chats,
    messages,
    activePersonaState,
    activeMemories,
    activePersonaId,
    activeChatId,
    settings,
    initialized,
    isLoading,
    error,
    initialize,
    selectPersona,
    selectChat,
    savePersona,
    deletePersona,
    createChat,
    deleteChat,
    setChatStyleStrength,
    sendMessage,
    saveSettings,
    clearError,
  } = useAppStore();

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [showChatDetailsModal, setShowChatDetailsModal] = useState(false);
  const [personaModalTab, setPersonaModalTab] =
    useState<PersonaModalTab>("editor");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [personaDraft, setPersonaDraft] = useState(createEmptyPersonaDraft);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [comfyCheckpoints, setComfyCheckpoints] = useState<string[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);

  const [generationTheme, setGenerationTheme] = useState("");
  const [generationCount, setGenerationCount] = useState(3);
  const [generatedDrafts, setGeneratedDrafts] = useState<
    GeneratedPersonaDraft[]
  >([]);
  const [generationLoading, setGenerationLoading] = useState(false);
  const [lookGenerationLoading, setLookGenerationLoading] = useState(false);
  const [generateSideView, setGenerateSideView] = useState(false);
  const [generateBackView, setGenerateBackView] = useState(false);
  const [lookPackageCount, setLookPackageCount] = useState(1);
  const [lookDetailLevel, setLookDetailLevel] =
    useState<LookDetailLevel>("off");
  const [lookEnhanceTarget, setLookEnhanceTarget] =
    useState<LookEnhanceTarget>("all");
  const [lookFastMode, setLookFastMode] = useState(false);
  const [enhancingLookImageKey, setEnhancingLookImageKey] = useState<
    string | null
  >(null);
  const [regeneratingLookImageKey, setRegeneratingLookImageKey] = useState<
    string | null
  >(null);
  const [lookImageMetaByUrl, setLookImageMetaByUrl] = useState<
    Record<string, ComfyImageGenerationMeta>
  >({});
  const [generatedLookPacks, setGeneratedLookPacks] = useState<
    PersonaLookPack[]
  >([]);
  const [generationPersonaId, setGenerationPersonaId] = useState("");
  const [generationTopic, setGenerationTopic] = useState("");
  const [generationInfinite, setGenerationInfinite] = useState(false);
  const [generationCountLimit, setGenerationCountLimit] = useState(5);
  const [generationDelaySeconds, setGenerationDelaySeconds] = useState(2);
  const [generationIsRunning, setGenerationIsRunning] = useState(false);
  const [generationCompletedCount, setGenerationCompletedCount] = useState(0);
  const [generationPendingImageCount, setGenerationPendingImageCount] =
    useState(0);
  const [imageActionBusy, setImageActionBusy] = useState(false);
  const [generationSessions, setGenerationSessions] = useState<
    GeneratorSession[]
  >([]);
  const [generationSessionId, setGenerationSessionId] = useState("");
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [pwaInstallStatus, setPwaInstallStatus] =
    useState<PwaInstallStatus>("unavailable");
  const generationRunRef = useRef(0);
  const lookGenerationRunRef = useRef(0);
  const lookGenerationAbortRef = useRef<AbortController | null>(null);
  const lookEnhanceRunRef = useRef(0);
  const lookEnhanceAbortRef = useRef<AbortController | null>(null);
  const lookRegenerateRunRef = useRef(0);
  const lookRegenerateAbortRef = useRef<AbortController | null>(null);
  const imageActionRunRef = useRef(0);
  const imageActionAbortRef = useRef<AbortController | null>(null);
  const lookSessionAssetIdsRef = useRef<Set<string>>(new Set());
  const lookPromptBundleCacheRef = useRef<{
    key: string;
    bundle: PersonaLookPromptBundle;
  } | null>(null);

  const getCachedLookPromptBundle = async () => {
    const cacheKey = buildLookPromptCacheFingerprint(personaDraft.appearance);
    const persistedCache = personaDraft.lookPromptCache;
    const shouldKeepLockedCache = Boolean(persistedCache?.locked);
    const runtimeCacheKey = shouldKeepLockedCache
      ? `locked:${persistedCache?.fingerprint ?? cacheKey}`
      : `appearance:${cacheKey}`;
    const promptModel = resolveLookPromptModel(settings);
    const cached = lookPromptBundleCacheRef.current;
    if (cached?.key === runtimeCacheKey) {
      return cached.bundle;
    }
    if (
      persistedCache &&
      (persistedCache.locked || persistedCache.fingerprint === cacheKey)
    ) {
      const bundle = toLookPromptBundle(persistedCache);
      lookPromptBundleCacheRef.current = { key: runtimeCacheKey, bundle };
      return bundle;
    }
    const bundle = await generatePersonaLookPrompts(settings, {
      name: personaDraft.name,
      personalityPrompt: personaDraft.personalityPrompt,
      appearance: personaDraft.appearance,
      stylePrompt: personaDraft.stylePrompt,
      advanced: personaDraft.advanced,
    });
    lookPromptBundleCacheRef.current = {
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
  };

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  useEffect(() => {
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    if (isStandalone) {
      setPwaInstallStatus("installed");
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      const promptEvent = event as BeforeInstallPromptEvent;
      setDeferredInstallPrompt(promptEvent);
      setPwaInstallStatus("available");
    };
    const onInstalled = () => {
      setDeferredInstallPrompt(null);
      setPwaInstallStatus("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const onInstallPwa = async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch {
      // ignore
    }
    setDeferredInstallPrompt(null);
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    setPwaInstallStatus(isStandalone ? "installed" : "unavailable");
  };

  const loadModels = async (
    baseUrl: string,
    apiKey: string,
    lmAuth: typeof settingsDraft.lmAuth,
  ) => {
    setModelsLoading(true);
    try {
      const models = await listModels({ lmBaseUrl: baseUrl, apiKey, lmAuth });
      setAvailableModels(models);
      if (models.length > 0) {
        setSettingsDraft((v) => ({
          ...v,
          model: models.includes(v.model) ? v.model : models[0],
          imagePromptModel: models.includes(v.imagePromptModel)
            ? v.imagePromptModel
            : models.includes(v.model)
              ? v.model
              : models[0],
          personaGenerationModel: models.includes(v.personaGenerationModel)
            ? v.personaGenerationModel
            : models.includes(v.model)
              ? v.model
              : models[0],
        }));
      }
    } catch (e) {
      setAvailableModels([]);
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (!initialized) return;
    if (!settings.lmBaseUrl.trim()) return;
    void loadModels(settings.lmBaseUrl, settings.apiKey, settings.lmAuth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.lmBaseUrl, settings.apiKey, settings.lmAuth]);

  const loadComfyCheckpoints = async (comfyBaseUrl: string) => {
    setCheckpointsLoading(true);
    try {
      const next = await listComfyCheckpoints(
        comfyBaseUrl,
        settingsDraft.comfyAuth,
      );
      setComfyCheckpoints(next);
    } catch (e) {
      setComfyCheckpoints([]);
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setCheckpointsLoading(false);
    }
  };

  useEffect(() => {
    if (!initialized) return;
    if (!settings.comfyBaseUrl.trim()) return;
    void loadComfyCheckpoints(settings.comfyBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.comfyBaseUrl, settings.comfyAuth]);

  const activePersona = useMemo(
    () => personas.find((p) => p.id === activePersonaId) ?? null,
    [personas, activePersonaId],
  );

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  const generationSession = useMemo(
    () =>
      generationSessions.find(
        (session) => session.id === generationSessionId,
      ) ?? null,
    [generationSessionId, generationSessions],
  );

  const generatedImageUrls = useMemo(
    () =>
      (generationSession?.entries ?? [])
        .flatMap((entry) => entry.imageUrls ?? [])
        .filter((url, index, list) => list.indexOf(url) === index)
        .slice()
        .reverse(),
    [generationSession],
  );
  const generationImageMetaByUrl = useMemo(() => {
    const next: Record<string, ComfyImageGenerationMeta> = {};
    for (const entry of generationSession?.entries ?? []) {
      const metaMap = entry.imageMetaByUrl ?? {};
      for (const [url, meta] of Object.entries(metaMap)) {
        next[url] = meta;
      }
    }
    return next;
  }, [generationSession]);
  const chatImageMetaByUrl = useMemo(
    () =>
      Object.fromEntries(
        messages.flatMap((message) =>
          Object.entries(message.imageMetaByUrl ?? {}),
        ),
      ) as Record<string, ComfyImageGenerationMeta>,
    [messages],
  );

  useEffect(() => {
    if (!generationPersonaId && personas.length > 0) {
      setGenerationPersonaId(personas[0].id);
    }
  }, [generationPersonaId, personas]);

  useEffect(() => {
    if (!generationPersonaId) {
      setGenerationSessions([]);
      setGenerationSessionId("");
      setGenerationCompletedCount(0);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const sessions = await dbApi.getGeneratorSessions(generationPersonaId);
        if (cancelled) return;
        setGenerationSessions(sessions);
        if (sessions.length === 0) {
          setGenerationSessionId("");
          setGenerationCompletedCount(0);
          return;
        }
        setGenerationSessionId((prev) => {
          if (prev && sessions.some((session) => session.id === prev))
            return prev;
          return sessions[0].id;
        });
      } catch (error) {
        if (!cancelled) {
          useAppStore.setState({ error: (error as Error).message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [generationPersonaId]);

  useEffect(() => {
    setGenerationCompletedCount(generationSession?.completedCount ?? 0);
  }, [generationSession?.completedCount]);

  useEffect(() => {
    if (!generationSession || generationIsRunning) return;
    setGenerationTopic(generationSession.topic);
    setGenerationInfinite(generationSession.isInfinite);
    if (typeof generationSession.requestedCount === "number") {
      setGenerationCountLimit(generationSession.requestedCount);
    }
    setGenerationDelaySeconds(generationSession.delaySeconds);
  }, [generationIsRunning, generationSession]);

  const createGenerationSession = async () => {
    const fallbackPersonaId =
      generationPersonaId || activePersonaId || personas[0]?.id || "";
    if (!fallbackPersonaId) {
      useAppStore.setState({
        error: "Нет доступной персоны для создания сессии генератора.",
      });
      return;
    }
    if (fallbackPersonaId !== generationPersonaId) {
      setGenerationPersonaId(fallbackPersonaId);
    }

    const now = new Date().toISOString();
    const nextSession: GeneratorSession = {
      id: crypto.randomUUID(),
      personaId: fallbackPersonaId,
      topic: generationTopic.trim() || "Новая сессия",
      isInfinite: generationInfinite,
      requestedCount: generationInfinite
        ? null
        : Math.max(1, Math.floor(generationCountLimit)),
      delaySeconds: Math.max(0, generationDelaySeconds),
      status: "stopped",
      completedCount: 0,
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    await dbApi.saveGeneratorSession(nextSession);
    setGenerationSessions((prev) => [nextSession, ...prev]);
    setGenerationSessionId(nextSession.id);
    setGenerationCompletedCount(0);
    setSidebarTab("generation");
  };

  const deleteGenerationSession = async (sessionId: string) => {
    await dbApi.deleteGeneratorSession(sessionId);
    let nextSessionId = "";
    setGenerationSessions((prev) => {
      const filtered = prev.filter((session) => session.id !== sessionId);
      nextSessionId = filtered[0]?.id ?? "";
      return filtered;
    });
    setGenerationSessionId((prev) =>
      prev === sessionId ? nextSessionId : prev,
    );
  };

  const buildLookSlotMeta = (
    kind: LookMetaKind,
    syncedLookMeta: Record<string, ComfyImageGenerationMeta>,
    url: string,
  ) => {
    const normalizedUrl = url.trim();
    if (normalizedUrl && syncedLookMeta[normalizedUrl])
      return syncedLookMeta[normalizedUrl];
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
      const idbLink = normalizedImageId
        ? toImageAssetLink(normalizedImageId)
        : "";
      return (
        personaMetaByUrl[LOOK_META_SLOT_KEY[kind]] ??
        (normalizedResolved
          ? personaMetaByUrl[normalizedResolved]
          : undefined) ??
        (normalizedOriginal
          ? personaMetaByUrl[normalizedOriginal]
          : undefined) ??
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
      if (resolvedFullBodyUrl)
        syncedLookMeta[resolvedFullBodyUrl] = fullBodyMeta;
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
      avatarUrl: avatarImageId
        ? toImageAssetLink(avatarImageId)
        : resolvedAvatarUrl,
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

  const closePersonaModal = async () => {
    stopPersonaLookGeneration();
    stopLookEnhancement();
    stopLookRegeneration();
    const referencedIds = new Set(
      personas.flatMap((persona) =>
        [
          persona.avatarImageId,
          persona.fullBodyImageId,
          persona.fullBodySideImageId,
          persona.fullBodyBackImageId,
        ]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    const orphans = Array.from(lookSessionAssetIdsRef.current).filter(
      (id) => !referencedIds.has(id),
    );
    if (orphans.length > 0) {
      await dbApi.deleteImageAssets(orphans);
    }
    lookSessionAssetIdsRef.current.clear();
    setShowPersonaModal(false);
  };

  const onSettingsSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await saveSettings(settingsDraft);
    setShowSettingsModal(false);
  };

  const onMessageSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!messageInput.trim()) return;
    const value = messageInput;
    setMessageInput("");
    await sendMessage(value);
  };

  const onGenerateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setGenerationLoading(true);
    try {
      const drafts = await generatePersonaDrafts(
        settingsDraft,
        generationTheme,
        generationCount,
      );
      setGeneratedDrafts(drafts);
    } catch (e) {
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setGenerationLoading(false);
    }
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
        const fullBodyPrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
          "head-to-toe framing:1.3",
          "whole person framing:1.3",
          "long shot",
          "one person:1.3",
          "neutral standing pose",
          "clean white background",
          "no environment",
        ]);
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
          const sidePrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
            "same person as reference:1.4",
            "same character identity:1.4",
            "same face and body features",
            "same hairstyle and hair color",
            "same outfit and accessories:1.4",
            "preserve clothing design and colors:1.3",
            "do not change gender",
            "do not remove clothes",
            "head-to-toe framing:1.3",
            "whole person framing:1.3",
            "long shot",
            "one person:1.3",
            "strict side profile:1.4",
            "exact 90 degree side view:1.4",
            "side view only",
            "from left side",
            "face turned 90 degrees away from camera",
            "no frontal pose",
            "no back pose",
            "profile silhouette",
            "orthographic side framing",
            "clean white background",
            "no environment",
          ]);
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
          const backPrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
            "same person as reference:1.4",
            "same character identity:1.4",
            "same face and body features",
            "same hairstyle and hair color",
            "same outfit and accessories:1.4",
            "preserve clothing design and colors:1.3",
            "do not change gender",
            "do not remove clothes",
            "head-to-toe framing:1.3",
            "whole person framing:1.3",
            "long shot",
            "one person:1.3",
            "strict back view:1.4",
            "exactly from behind:1.4",
            "back facing camera:1.4",
            "back view only",
            "subject facing away from camera",
            "back of head visible",
            "no frontal pose",
            "no side pose",
            "orthographic rear framing:1.4",
            "clean white background",
            "no environment",
          ]);
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

        const avatarPrompt = mergePromptTags(promptBundle.avatarPrompt, [
          "close-up",
          "face focus",
          "looking at viewer",
          "solo",
          "single subject",
          "one person",
          "detailed background",
          "environmental context",
          "realistic location",
        ]);
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
      if (e instanceof DOMException && e.name === "AbortError") {
        // stopped by user
      } else {
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
    kind: "avatar" | "fullbody" | "side" | "back",
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

      const currentSlotUrl =
        packIndex === null
          ? kind === "avatar"
            ? personaDraft.avatarUrl
            : kind === "fullbody"
              ? personaDraft.fullBodyUrl
              : kind === "side"
                ? personaDraft.fullBodySideUrl
                : personaDraft.fullBodyBackUrl
          : kind === "avatar"
            ? (pack?.avatarUrl ?? "")
            : kind === "fullbody"
              ? (pack?.fullBodyUrl ?? "")
              : kind === "side"
                ? (pack?.fullBodySideUrl ?? "")
                : (pack?.fullBodyBackUrl ?? "");
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
          ? mergePromptTags(promptBundle.avatarPrompt, [
              "close-up",
              "face focus",
              "looking at viewer",
              "solo",
              "single subject",
              "one person",
              "detailed background",
              "environmental context",
              "realistic location",
            ])
          : kind === "side"
            ? mergePromptTags(promptBundle.fullBodyPrompt, [
                "same person as reference",
                "same character identity",
                "same face and body features",
                "same hairstyle and hair color",
                "same outfit and accessories",
                "preserve clothing design and colors",
                "do not change gender",
                "do not remove clothes",
                "head-to-toe framing:1.4",
                "whole person framing:1.4",
                "long shot",
                "one person",
                "strict side profile",
                "exact 90 degree side view",
                "side view only",
                "from left side",
                "face turned 90 degrees away from camera",
                "no frontal pose",
                "no back pose",
                "profile silhouette",
                "orthographic side framing:1.4",
                "clean white background",
                "no environment",
              ])
            : kind === "back"
              ? mergePromptTags(promptBundle.fullBodyPrompt, [
                  "same person as reference",
                  "same character identity",
                  "same face and body features",
                  "same hairstyle and hair color",
                  "same outfit and accessories",
                  "preserve clothing design and colors",
                  "do not change gender",
                  "do not remove clothes",
                  "head-to-toe framing:1.4",
                  "whole person framing:1.4",
                  "long shot",
                  "one person",
                  "strict back view",
                  "exactly from behind",
                  "back facing camera",
                  "back view only",
                  "subject facing away from camera",
                  "back of head visible",
                  "no frontal pose",
                  "no side pose",
                  "orthographic rear framing:1.4",
                  "clean white background",
                  "no environment",
                ])
              : mergePromptTags(promptBundle.fullBodyPrompt, [
                  "head-to-toe framing:1.4",
                  "whole person framing:1.4",
                  "long shot",
                  "one person:1.4",
                  "neutral standing pose",
                  "clean white background",
                  "no environment",
                ]);
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
    context: ChatImageActionContext | GeneratorImageActionContext,
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
    context: ChatImageActionContext | GeneratorImageActionContext,
    mode: "enhance" | "regenerate",
    targetOverride: LookEnhanceTarget = "all",
    promptOverride?: string,
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
      const basePrompt = promptOverride?.trim() || fallbackPrompt;
      const targetTags: Record<LookEnhanceTarget, string[]> = {
        all: ["full body details", "balanced details"],
        face: ["focus on face", "facial details"],
        eyes: ["focus on eyes", "sharp eyes"],
        nose: ["focus on nose", "clean nose shape"],
        lips: ["focus on lips", "lip details"],
        hands: ["focus on hands", "correct fingers", "natural hand anatomy"],
        chest: ["focus on chest", "natural breast details"],
        vagina: ["focus on intimate area", "natural anatomy details"],
      };
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
                level: "medium" as const,
                targets: mapEnhanceTargetToDetailTargets(targetOverride),
              }
            : undefined;
        const generationFlow = mode === "regenerate" ? "base" : "i2i";
        const styleStrength = mode === "enhance" ? 1 : 0.78;
        const compositionStrength = mode === "enhance" ? 0.95 : 0;
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
    context: ChatImageActionContext | GeneratorImageActionContext,
    targetOverride: LookEnhanceTarget = "all",
  ) => {
    void runSharedImageAction(context, "enhance", targetOverride);
  };

  const regenerateSharedImage = (
    context: ChatImageActionContext | GeneratorImageActionContext,
    promptOverride?: string,
  ) => {
    void runSharedImageAction(context, "regenerate", "all", promptOverride);
  };

  const enhanceLookImage = async (
    packIndex: number | null,
    kind: "avatar" | "fullbody" | "side" | "back",
    imageUrl: string,
    targetOverride?: LookEnhanceTarget,
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
      const detailLevel =
        lookDetailLevel === "off" ? "medium" : lookDetailLevel;
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
      const sourcePrompt = sourceMeta?.prompt?.trim() || basePrompt;
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
      const enhanceSeed = stableSeedFromText(
        `${sourceSeed}:${imageUrl}:${kind}:${requestedTarget}:${Date.now()}`,
      );
      const enhancePrompt = mergePromptTags(sourcePrompt, [
        "same person",
        "same identity",
        "same outfit",
        "same framing",
        "highly detailed",
        ...(isHandsEnhance
          ? [
              "focus on hands",
              "detailed fingers",
              "natural hand anatomy",
              "correct finger count",
              "no merged fingers",
            ]
          : ["preserve composition"]),
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
              styleStrength:
                options?.styleStrength ?? (isHandsEnhance ? 0.9 : 1),
              compositionStrength:
                options?.compositionStrength ?? (isHandsEnhance ? 0.7 : 1),
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
              detailing: {
                enabled: true,
                level:
                  effectiveDetailLevel === "off"
                    ? "strong"
                    : effectiveDetailLevel,
                targets: mapEnhanceTargetToDetailTargets(requestedTarget),
                prompts: promptBundle.detailPrompts,
                disableIntimateDetailers: true,
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
      const noVisibleChange =
        improvedSource && improvedSource === imageUrl.trim();
      if (noVisibleChange) {
        const retrySeed = stableSeedFromText(
          `${enhanceSeed}:nochange-retry:${Date.now()}`,
        );
        const retryPrompt = mergePromptTags(enhancePrompt, [
          ...(isHandsEnhance
            ? ["hands emphasized", "clean hand pose", "highly detailed hands"]
            : [
                "face emphasized",
                "sharper facial details",
                "improve skin and eyes clarity",
              ]),
        ]);
        const retryUrls = await runEnhancePass(retrySeed, retryPrompt, {
          styleStrength: isHandsEnhance ? 0.86 : 0.92,
          compositionStrength: isHandsEnhance ? 0.45 : 0.6,
          hiresFixDenoise: isHandsEnhance ? 0.52 : 0.45,
          colorFixStrength: isHandsEnhance ? 0.55 : 0.48,
          detailLevel: "strong",
          strictOutputNodeMatch: false,
        });
        ensureEnhanceActive();
        const retryLocalized = await localizeImageUrls(retryUrls);
        ensureEnhanceActive();
        const retryBest = await pickPreferredEnhancedUrl(
          retryLocalized,
          imageUrl,
        );
        if (retryBest) {
          improvedSource = retryBest;
          effectiveSeed = retrySeed;
          localized = retryLocalized;
        }
      }
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
      if (e instanceof DOMException && e.name === "AbortError") {
        // stopped by user
      } else {
        useAppStore.setState({ error: (e as Error).message });
      }
    } finally {
      if (lookEnhanceRunRef.current === runId) {
        setEnhancingLookImageKey((prev) => (prev === key ? null : prev));
        lookEnhanceAbortRef.current = null;
      }
    }
  };

  const applyEnhancedImage = (
    packIndex: number | null,
    kind: "avatar" | "fullbody" | "side" | "back",
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

  const resolveLookUrlForKind = (
    packIndex: number | null,
    kind: "avatar" | "fullbody" | "side" | "back",
  ) => {
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

  const onSaveGenerated = async (draft: GeneratedPersonaDraft) => {
    const avatarImageId = await createLookAsset(
      draft.avatarUrl || "",
      undefined,
    );
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

  const onToggleMobileTab = (tab: SidebarTab) => {
    if (sidebarTab === tab && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    } else {
      setSidebarTab(tab);
      setMobileSidebarOpen(true);
    }
  };

  const stopGeneration = () => {
    generationRunRef.current += 1;
    setGenerationIsRunning(false);
    setGenerationPendingImageCount(0);
    if (generationSession) {
      const nextSession: GeneratorSession = {
        ...generationSession,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      };
      void dbApi.saveGeneratorSession(nextSession);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === nextSession.id ? nextSession : session,
        ),
      );
    }
  };

  const startGeneration = async () => {
    if (!generationPersonaId) {
      useAppStore.setState({ error: "Выберите персону для генерации." });
      return;
    }
    if (!generationTopic.trim()) {
      useAppStore.setState({ error: "Укажите тематику генерации." });
      return;
    }
    if (!generationSessionId) {
      useAppStore.setState({
        error: "Создайте сессию генератора в меню слева.",
      });
      return;
    }

    const total = generationInfinite
      ? null
      : Math.max(1, Math.floor(generationCountLimit));
    const delayMs = Math.max(0, Math.floor(generationDelaySeconds * 1000));
    const runId = generationRunRef.current + 1;
    const persona = personas.find((item) => item.id === generationPersonaId);
    if (!persona) {
      useAppStore.setState({ error: "Выбранная персона не найдена." });
      return;
    }

    const now = new Date().toISOString();
    const selected = generationSessions.find(
      (candidate) => candidate.id === generationSessionId,
    );
    if (!selected) {
      useAppStore.setState({ error: "Активная сессия генератора не найдена." });
      return;
    }
    const session: GeneratorSession = {
      ...selected,
      topic: generationTopic.trim(),
      isInfinite: generationInfinite,
      requestedCount: total,
      delaySeconds: generationDelaySeconds,
      status: "running",
      updatedAt: now,
    };

    await dbApi.saveGeneratorSession(session);
    setGenerationSessions((prev) => {
      return prev.map((candidate) =>
        candidate.id === session.id ? session : candidate,
      );
    });
    setGenerationSessionId(session.id);
    generationRunRef.current = runId;
    setGenerationCompletedCount(session.completedCount);
    setGenerationIsRunning(true);
    setGenerationPendingImageCount(0);

    let completed = session.completedCount;
    let mutableSession = session;
    try {
      while (
        generationRunRef.current === runId &&
        (total === null || completed < total)
      ) {
        const iteration = completed + 1;
        const prompt = await generateThemedComfyPrompt(
          settings,
          persona,
          generationTopic.trim(),
          iteration,
        );
        setGenerationPendingImageCount((prev) => prev + 1);
        let localized: string[] = [];
        let localizedMetaByUrl: Record<string, ComfyImageGenerationMeta> = {};
        try {
          const seed = stableSeedFromText(
            `${session.id}:${iteration}:${generationTopic}`,
          );
          const styleReferenceImage =
            persona.avatarUrl.trim() || persona.fullBodyUrl.trim() || undefined;
          const generationItem = {
            flow: "base" as const,
            prompt,
            checkpointName: persona.imageCheckpoint || undefined,
            seed,
            styleReferenceImage,
            styleStrength: styleReferenceImage
              ? settings.chatStyleStrength
              : undefined,
            compositionStrength: 0,
            saveComfyOutputs: settings.saveComfyOutputs,
          };
          const imageUrls = await generateComfyImages(
            [generationItem],
            settings.comfyBaseUrl,
            settings.comfyAuth,
          );
          const extractedMeta = imageUrls[0]
            ? await readComfyImageGenerationMeta(
                imageUrls[0],
                settings.comfyBaseUrl,
                settings.comfyAuth,
              )
            : null;
          localized = await localizeImageUrls(imageUrls);
          const meta: ComfyImageGenerationMeta = {
            prompt: extractedMeta?.prompt ?? generationItem.prompt,
            seed: extractedMeta?.seed ?? generationItem.seed,
            model: extractedMeta?.model ?? generationItem.checkpointName,
            flow: extractedMeta?.flow ?? generationItem.flow,
          };
          await Promise.all(
            localized.map((url) =>
              dbApi.saveImageAsset({
                id: crypto.randomUUID(),
                dataUrl: url,
                meta,
                createdAt: new Date().toISOString(),
              }),
            ),
          );
          localizedMetaByUrl = Object.fromEntries(
            localized.map((url) => [url, meta]),
          );
        } finally {
          setGenerationPendingImageCount((prev) => Math.max(0, prev - 1));
        }
        const entry = {
          id: crypto.randomUUID(),
          iteration,
          prompt,
          imageUrls: localized,
          imageMetaByUrl: localizedMetaByUrl,
          createdAt: new Date().toISOString(),
        };
        completed = iteration;
        setGenerationCompletedCount(completed);
        mutableSession = {
          ...mutableSession,
          completedCount: completed,
          entries: [...mutableSession.entries, entry],
          updatedAt: new Date().toISOString(),
        };
        await dbApi.saveGeneratorSession(mutableSession);
        setGenerationSessions((prev) =>
          prev.map((candidate) =>
            candidate.id === mutableSession.id ? mutableSession : candidate,
          ),
        );

        if (generationRunRef.current !== runId) break;
        await waitMs(delayMs);
      }
      mutableSession = {
        ...mutableSession,
        status: generationRunRef.current === runId ? "completed" : "stopped",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(mutableSession);
      setGenerationSessions((prev) =>
        prev.map((candidate) =>
          candidate.id === mutableSession.id ? mutableSession : candidate,
        ),
      );
    } catch (error) {
      mutableSession = {
        ...mutableSession,
        status: "error",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(mutableSession);
      setGenerationSessions((prev) =>
        prev.map((candidate) =>
          candidate.id === mutableSession.id ? mutableSession : candidate,
        ),
      );
      useAppStore.setState({ error: (error as Error).message });
    } finally {
      if (generationRunRef.current === runId) {
        setGenerationIsRunning(false);
      }
      setGenerationPendingImageCount(0);
    }
  };

  return (
    <>
      <div className="aurora-bg" />
      <div className="messenger">
        <Sidebar
          sidebarTab={sidebarTab}
          setSidebarTab={setSidebarTab}
          chats={chats}
          personas={personas}
          activeChatId={activeChatId}
          activePersonaId={activePersonaId}
          generationPersonaId={generationPersonaId}
          generationSessions={generationSessions}
          activeGenerationSessionId={generationSessionId || null}
          onOpenPersonas={() => setShowPersonaModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onCreateChat={() => void createChat()}
          onCreateGenerationSession={() => void createGenerationSession()}
          onDeleteGenerationSession={(sessionId) =>
            void deleteGenerationSession(sessionId)
          }
          onSelectChat={(chatId) => void selectChat(chatId)}
          onSelectGenerationSession={setGenerationSessionId}
          onSelectPersona={(personaId) => void selectPersona(personaId)}
          onSelectGenerationPersona={setGenerationPersonaId}
          onEditPersona={startEditPersona}
          isMobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onToggleMobileTab={onToggleMobileTab}
        />

        {sidebarTab === "generation" ? (
          <GenerationPane
            generationSessionId={generationSessionId}
            topic={generationTopic}
            onTopicChange={setGenerationTopic}
            isInfinite={generationInfinite}
            onInfiniteChange={setGenerationInfinite}
            countLimit={generationCountLimit}
            onCountLimitChange={(value) =>
              setGenerationCountLimit(
                Math.max(1, Math.min(100000, Math.floor(value || 1))),
              )
            }
            delaySeconds={generationDelaySeconds}
            onDelaySecondsChange={(value) =>
              setGenerationDelaySeconds(Math.max(0, Math.min(120, value || 0)))
            }
            isRunning={generationIsRunning}
            completedCount={generationCompletedCount}
            generatedImageUrls={generatedImageUrls}
            imageMetaByUrl={generationImageMetaByUrl}
            pendingImageCount={generationPendingImageCount}
            imageActionBusy={imageActionBusy}
            onEnhanceImage={enhanceSharedImage}
            onRegenerateImage={regenerateSharedImage}
            onStart={() => void startGeneration()}
            onStop={stopGeneration}
          />
        ) : (
          <ChatPane
            activeChat={activeChat}
            activePersona={activePersona}
            activeChatId={activeChatId}
            messages={messages}
            imageMetaByUrl={chatImageMetaByUrl}
            messageInput={messageInput}
            setMessageInput={setMessageInput}
            isLoading={isLoading}
            activePersonaState={activePersonaState}
            memoryCount={activeMemories.length}
            showSystemImageBlock={settings.showSystemImageBlock}
            showStatusChangeDetails={settings.showStatusChangeDetails}
            imageActionBusy={imageActionBusy}
            onEnhanceImage={enhanceSharedImage}
            onRegenerateImage={regenerateSharedImage}
            onDeleteChat={() => {
              if (!activeChatId) return;
              void deleteChat(activeChatId);
            }}
            onSubmitMessage={onMessageSubmit}
            onOpenSidebar={() => {
              setSidebarTab("personas");
              setMobileSidebarOpen(true);
            }}
            onOpenChatDetails={() => setShowChatDetailsModal(true)}
          />
        )}

        <ChatDetailsModal
          open={showChatDetailsModal}
          chat={activeChat}
          persona={activePersona}
          messages={messages}
          imageMetaByUrl={chatImageMetaByUrl}
          memories={activeMemories}
          runtimeState={activePersonaState}
          settings={settings}
          imageActionBusy={imageActionBusy}
          onEnhanceImage={enhanceSharedImage}
          onRegenerateImage={regenerateSharedImage}
          onUpdateChatStyleStrength={(chatId, value) => {
            void setChatStyleStrength(chatId, value);
          }}
          onClose={() => setShowChatDetailsModal(false)}
        />

        <SettingsModal
          open={showSettingsModal}
          settingsDraft={settingsDraft}
          pwaInstallStatus={pwaInstallStatus}
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          setSettingsDraft={setSettingsDraft}
          onInstallPwa={() => void onInstallPwa()}
          onRefreshModels={() =>
            void loadModels(
              settingsDraft.lmBaseUrl,
              settingsDraft.apiKey,
              settingsDraft.lmAuth,
            )
          }
          onClose={() => setShowSettingsModal(false)}
          onSubmit={onSettingsSubmit}
        />

        <PersonaModal
          open={showPersonaModal}
          personas={personas}
          personaModalTab={personaModalTab}
          setPersonaModalTab={setPersonaModalTab}
          editingPersonaId={editingPersonaId}
          personaDraft={personaDraft}
          setPersonaDraft={setPersonaDraft}
          onClose={() => {
            void closePersonaModal();
          }}
          onEditPersona={startEditPersona}
          onDeletePersona={(personaId) => void deletePersona(personaId)}
          onSubmitPersona={onPersonaSubmit}
          onResetDraft={onResetDraft}
          generationTheme={generationTheme}
          setGenerationTheme={setGenerationTheme}
          generationCount={generationCount}
          setGenerationCount={setGenerationCount}
          generationLoading={generationLoading}
          generatedDrafts={generatedDrafts}
          onSubmitGenerate={onGenerateSubmit}
          onSaveGenerated={(draft) => void onSaveGenerated(draft)}
          onMoveGeneratedToEditor={onMoveGeneratedToEditor}
          lookGenerationLoading={lookGenerationLoading}
          onGeneratePersonaLook={onGeneratePersonaLook}
          onStopPersonaLookGeneration={stopPersonaLookGeneration}
          lookPackageCount={lookPackageCount}
          setLookPackageCount={setLookPackageCount}
          lookDetailLevel={lookDetailLevel}
          setLookDetailLevel={setLookDetailLevel}
          lookEnhanceTarget={lookEnhanceTarget}
          setLookEnhanceTarget={setLookEnhanceTarget}
          lookFastMode={lookFastMode}
          setLookFastMode={setLookFastMode}
          enhancingLookImageKey={enhancingLookImageKey}
          regeneratingLookImageKey={regeneratingLookImageKey}
          onEnhanceLookImage={enhanceLookImage}
          onRegenerateLookImage={regenerateLookImage}
          onStopLookEnhancement={stopLookEnhancement}
          generatedLookPacks={generatedLookPacks}
          onApplyLookPack={(pack) => {
            void applyLookPack(pack);
          }}
          generateSideView={generateSideView}
          setGenerateSideView={setGenerateSideView}
          generateBackView={generateBackView}
          setGenerateBackView={setGenerateBackView}
          comfyCheckpoints={comfyCheckpoints}
          checkpointsLoading={checkpointsLoading}
          onRefreshCheckpoints={() =>
            void loadComfyCheckpoints(settingsDraft.comfyBaseUrl)
          }
          imageMetaByUrl={lookImageMetaByUrl}
          imagePromptModel={settingsDraft.imagePromptModel}
          personaGenerationModel={settingsDraft.personaGenerationModel}
          availableModels={availableModels}
          onImagePromptModelChange={(nextModel) =>
            setSettingsDraft((prev) => ({
              ...prev,
              imagePromptModel: nextModel,
            }))
          }
          onPersonaGenerationModelChange={(nextModel) =>
            setSettingsDraft((prev) => ({
              ...prev,
              personaGenerationModel: nextModel,
            }))
          }
        />

        <ErrorToast error={error} onClose={clearError} />
        <EnhanceCompareModal
          open={Boolean(enhanceReview)}
          beforeUrl={enhanceReview?.beforePreviewUrl ?? ""}
          afterUrl={enhanceReview?.afterPreviewUrl ?? ""}
          onClose={() => setEnhanceReview(null)}
          onKeepOld={() => setEnhanceReview(null)}
          onAccept={() => {
            if (!enhanceReview) return;
            setLookImageMetaByUrl((prev) =>
              withLookMeta(prev, [
                {
                  kind: enhanceReview.kind,
                  url: enhanceReview.afterUrl,
                  meta: enhanceReview.afterMeta,
                },
              ]),
            );
            applyEnhancedImage(
              enhanceReview.packIndex,
              enhanceReview.kind,
              enhanceReview.beforeUrl,
              enhanceReview.afterUrl,
              enhanceReview.afterImageId,
            );
            setEnhanceReview(null);
          }}
          onRegenerate={() => {
            if (!enhanceReview) return;
            const next = enhanceReview;
            setEnhanceReview(null);
            void enhanceLookImage(
              next.packIndex,
              next.kind,
              next.beforePreviewUrl || next.beforeUrl,
            );
          }}
        />
        <EnhanceCompareModal
          open={Boolean(sharedEnhanceReview) && !enhanceReview}
          beforeUrl={sharedEnhanceReview?.beforeUrl ?? ""}
          afterUrl={sharedEnhanceReview?.afterUrl ?? ""}
          onClose={() => setSharedEnhanceReview(null)}
          onKeepOld={() => setSharedEnhanceReview(null)}
          onAccept={() => {
            if (!sharedEnhanceReview) return;
            const next = sharedEnhanceReview;
            setSharedEnhanceReview(null);
            void applySharedImageReplacement(
              next.context,
              next.afterUrl,
              next.afterMeta,
            );
          }}
          onRegenerate={() => {
            if (!sharedEnhanceReview) return;
            const next = sharedEnhanceReview;
            setSharedEnhanceReview(null);
            void runSharedImageAction(next.context, "enhance", next.target);
          }}
        />
      </div>
    </>
  );
}
