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
  type ComfyImageGenerationMeta,
} from "./comfy";
import { dbApi } from "./db";
import { localizeImageUrls } from "./imageStorage";
import { useAppStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ChatDetailsModal } from "./components/ChatDetailsModal";
import { EnhanceCompareModal } from "./components/EnhanceCompareModal";
import { ErrorToast } from "./components/ErrorToast";
import { GenerationPane } from "./components/GenerationPane";
import { PersonaModal } from "./components/PersonaModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import type { GeneratorSession, Persona } from "./types";
import {
  createEmptyPersonaDraft,
  type LookDetailLevel,
  type LookEnhanceTarget,
  type PersonaLookPack,
  type PersonaModalTab,
  type SidebarTab,
} from "./ui/types";

type PersonaLookPromptBundle = Awaited<ReturnType<typeof generatePersonaLookPrompts>>;
type PwaInstallStatus = "installed" | "available" | "unavailable";
type LookMetaKind = "avatar" | "fullbody" | "side" | "back";

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
    merged.push(tag);
  }
  return merged.join(", ");
}

const LOOK_META_SLOT_KEY: Record<LookMetaKind, string> = {
  avatar: "__slot__:avatar",
  fullbody: "__slot__:fullbody",
  side: "__slot__:side",
  back: "__slot__:back",
};

function withLookMeta(
  prev: Record<string, ComfyImageGenerationMeta>,
  updates: Array<{ kind: LookMetaKind; url?: string; meta: ComfyImageGenerationMeta }>,
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
  const next: Record<string, ComfyImageGenerationMeta> = { ...(metaByUrl ?? {}) };
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
): Array<"face" | "eyes" | "nose" | "lips" | "hands"> {
  if (target === "all") return ["face", "eyes", "nose", "lips", "hands"];
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

export default function App() {
  const [enhanceReview, setEnhanceReview] = useState<{
    packIndex: number | null;
    kind: "avatar" | "fullbody" | "side" | "back";
    beforeUrl: string;
    afterUrl: string;
    afterImageId: string;
  } | null>(null);

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
  const [personaModalTab, setPersonaModalTab] = useState<PersonaModalTab>("editor");
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
  const [generatedDrafts, setGeneratedDrafts] = useState<GeneratedPersonaDraft[]>([]);
  const [generationLoading, setGenerationLoading] = useState(false);
  const [lookGenerationLoading, setLookGenerationLoading] = useState(false);
  const [generateSideView, setGenerateSideView] = useState(false);
  const [generateBackView, setGenerateBackView] = useState(false);
  const [lookPackageCount, setLookPackageCount] = useState(1);
  const [lookDetailLevel, setLookDetailLevel] = useState<LookDetailLevel>("off");
  const [lookEnhanceTarget, setLookEnhanceTarget] = useState<LookEnhanceTarget>("all");
  const [lookFastMode, setLookFastMode] = useState(false);
  const [enhancingLookImageKey, setEnhancingLookImageKey] = useState<string | null>(null);
  const [lookImageMetaByUrl, setLookImageMetaByUrl] = useState<Record<string, ComfyImageGenerationMeta>>({});
  const [generatedLookPacks, setGeneratedLookPacks] = useState<PersonaLookPack[]>([]);
  const [generationPersonaId, setGenerationPersonaId] = useState("");
  const [generationTopic, setGenerationTopic] = useState("");
  const [generationInfinite, setGenerationInfinite] = useState(false);
  const [generationCountLimit, setGenerationCountLimit] = useState(5);
  const [generationDelaySeconds, setGenerationDelaySeconds] = useState(2);
  const [generationIsRunning, setGenerationIsRunning] = useState(false);
  const [generationCompletedCount, setGenerationCompletedCount] = useState(0);
  const [generationPendingImageCount, setGenerationPendingImageCount] = useState(0);
  const [generationSessions, setGenerationSessions] = useState<GeneratorSession[]>([]);
  const [generationSessionId, setGenerationSessionId] = useState("");
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [pwaInstallStatus, setPwaInstallStatus] = useState<PwaInstallStatus>("unavailable");
  const generationRunRef = useRef(0);
  const lookGenerationRunRef = useRef(0);
  const lookGenerationAbortRef = useRef<AbortController | null>(null);
  const lookEnhanceRunRef = useRef(0);
  const lookEnhanceAbortRef = useRef<AbortController | null>(null);
  const lookSessionAssetIdsRef = useRef<Set<string>>(new Set());
  const lookPromptBundleCacheRef = useRef<{
    key: string;
    bundle: PersonaLookPromptBundle;
  } | null>(null);

  const getCachedLookPromptBundle = async () => {
    const cacheKey = JSON.stringify({
      lmBaseUrl: settings.lmBaseUrl,
      model: settings.model,
      temperature: settings.temperature,
      lmAuth: settings.lmAuth,
      persona: {
        name: personaDraft.name,
        personalityPrompt: personaDraft.personalityPrompt,
        appearance: personaDraft.appearance,
        stylePrompt: personaDraft.stylePrompt,
        advanced: personaDraft.advanced,
      },
    });
    const cached = lookPromptBundleCacheRef.current;
    if (cached?.key === cacheKey) {
      return cached.bundle;
    }
    const bundle = await generatePersonaLookPrompts(settings, {
      name: personaDraft.name,
      personalityPrompt: personaDraft.personalityPrompt,
      appearance: personaDraft.appearance,
      stylePrompt: personaDraft.stylePrompt,
      advanced: personaDraft.advanced,
    });
    lookPromptBundleCacheRef.current = { key: cacheKey, bundle };
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
      ((window.navigator as Navigator & { standalone?: boolean }).standalone === true);
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
      ((window.navigator as Navigator & { standalone?: boolean }).standalone === true);
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
      if (!models.includes(settingsDraft.model) && models.length > 0) {
        setSettingsDraft((v) => ({ ...v, model: models[0] }));
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
      const next = await listComfyCheckpoints(comfyBaseUrl, settingsDraft.comfyAuth);
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
    () => generationSessions.find((session) => session.id === generationSessionId) ?? null,
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
          if (prev && sessions.some((session) => session.id === prev)) return prev;
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
    const fallbackPersonaId = generationPersonaId || activePersonaId || personas[0]?.id || "";
    if (!fallbackPersonaId) {
      useAppStore.setState({ error: "Нет доступной персоны для создания сессии генератора." });
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
      requestedCount: generationInfinite ? null : Math.max(1, Math.floor(generationCountLimit)),
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
    setGenerationSessionId((prev) => (prev === sessionId ? nextSessionId : prev));
  };

  const buildLookSlotMeta = (
    kind: LookMetaKind,
    syncedLookMeta: Record<string, ComfyImageGenerationMeta>,
    url: string,
  ) => {
    const normalizedUrl = url.trim();
    if (normalizedUrl && syncedLookMeta[normalizedUrl]) return syncedLookMeta[normalizedUrl];
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
    const imageAssets = await dbApi.getImageAssets([
      persona.avatarImageId,
      persona.fullBodyImageId,
      persona.fullBodySideImageId,
      persona.fullBodyBackImageId,
    ]);
    const assetById = Object.fromEntries(imageAssets.map((asset) => [asset.id, asset]));
    const resolvedAvatarUrl =
      assetById[persona.avatarImageId]?.dataUrl ||
      (persona.avatarUrl.startsWith("idb://") ? "" : persona.avatarUrl) ||
      "";
    const resolvedFullBodyUrl =
      assetById[persona.fullBodyImageId]?.dataUrl ||
      (persona.fullBodyUrl.startsWith("idb://") ? "" : persona.fullBodyUrl) ||
      "";
    const resolvedSideUrl =
      assetById[persona.fullBodySideImageId]?.dataUrl ||
      (persona.fullBodySideUrl.startsWith("idb://") ? "" : persona.fullBodySideUrl) ||
      "";
    const resolvedBackUrl =
      assetById[persona.fullBodyBackImageId]?.dataUrl ||
      (persona.fullBodyBackUrl.startsWith("idb://") ? "" : persona.fullBodyBackUrl) ||
      "";
    const syncedLookMeta = synchronizeLookMetaWithUrls(persona.imageMetaByUrl, {
      avatar: resolvedAvatarUrl,
      fullbody: resolvedFullBodyUrl,
      side: resolvedSideUrl,
      back: resolvedBackUrl,
    });
    const avatarMeta = persona.avatarImageId ? assetById[persona.avatarImageId]?.meta : undefined;
    if (avatarMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.avatar] = avatarMeta;
      if (resolvedAvatarUrl) syncedLookMeta[resolvedAvatarUrl] = avatarMeta;
    }
    const fullBodyMeta = persona.fullBodyImageId ? assetById[persona.fullBodyImageId]?.meta : undefined;
    if (fullBodyMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.fullbody] = fullBodyMeta;
      if (resolvedFullBodyUrl) syncedLookMeta[resolvedFullBodyUrl] = fullBodyMeta;
    }
    const sideMeta = persona.fullBodySideImageId ? assetById[persona.fullBodySideImageId]?.meta : undefined;
    if (sideMeta) {
      syncedLookMeta[LOOK_META_SLOT_KEY.side] = sideMeta;
      if (resolvedSideUrl) syncedLookMeta[resolvedSideUrl] = sideMeta;
    }
    const backMeta = persona.fullBodyBackImageId ? assetById[persona.fullBodyBackImageId]?.meta : undefined;
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
      return createLookAsset(normalizedUrl, buildLookSlotMeta(kind, syncedLookMeta, normalizedUrl));
    };

    const avatarImageId = await ensureImageId("avatar", persona.avatarImageId, resolvedAvatarUrl);
    const fullBodyImageId = await ensureImageId("fullbody", persona.fullBodyImageId, resolvedFullBodyUrl);
    const fullBodySideImageId = await ensureImageId("side", persona.fullBodySideImageId, resolvedSideUrl);
    const fullBodyBackImageId = await ensureImageId("back", persona.fullBodyBackImageId, resolvedBackUrl);
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
      fullBodyUrl: fullBodyImageId ? toImageAssetLink(fullBodyImageId) : resolvedFullBodyUrl,
      fullBodySideUrl: fullBodySideImageId ? toImageAssetLink(fullBodySideImageId) : resolvedSideUrl,
      fullBodyBackUrl: fullBodyBackImageId ? toImageAssetLink(fullBodyBackImageId) : resolvedBackUrl,
      avatarImageId,
      fullBodyImageId,
      fullBodySideImageId,
      fullBodyBackImageId,
      imageMetaByUrl: syncedLookMeta,
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
    for (const retainedId of [avatarImageId, fullBodyImageId, fullBodySideImageId, fullBodyBackImageId]) {
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
      fullBodyImageId: pack.fullBodyImageId ?? parseImageAssetId(pack.fullBodyUrl),
      fullBodySideImageId: pack.fullBodySideImageId ?? parseImageAssetId(pack.fullBodySideUrl),
      fullBodyBackImageId: pack.fullBodyBackImageId ?? parseImageAssetId(pack.fullBodyBackUrl),
    }));
  };

  const closePersonaModal = async () => {
    stopPersonaLookGeneration();
    stopLookEnhancement();
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
    const orphans = Array.from(lookSessionAssetIdsRef.current).filter((id) => !referencedIds.has(id));
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
      const drafts = await generatePersonaDrafts(settings, generationTheme, generationCount);
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
      if (lookGenerationRunRef.current !== runId || abortController.signal.aborted) {
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
            prev.map((pack, idx) => (idx === packIndex ? { ...pack, ...patch } : pack)),
          );
        };
        const fullBodyPrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
          "full body",
          "neutral standing pose",
          "calm pose",
          "relaxed posture",
          "hands at sides",
          "arms relaxed",
          "solo",
          "single subject",
          "exactly one person",
          "no other people",
          "no crowd",
          "no duplicate body",
          "no extra limbs",
          "no collage",
          "plain background",
          "solid background",
          "studio backdrop",
          "isolated subject",
          "clean background",
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
          throw new Error(`Не удалось сгенерировать fullbody reference для пакета #${packIndex + 1}.`);
        }
        const fullBodyMeta: ComfyImageGenerationMeta = {
          seed: packSeed,
          prompt: fullBodyPrompt,
          model: personaDraft.imageCheckpoint || undefined,
          flow: "base",
        };
        const fullBodyAsset = await saveLookImageAndGetRef(fullBodySource, fullBodyMeta);
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
        patchPack({ fullBodyUrl: fullBodyRef, fullBodyImageId: fullBodyAsset.imageId });

        let sideRef = "";
        if (generateSideView) {
          const sideSeed = packSeed + 101;
          const sideReferenceStrength = 0.72;
          const sideCompositionStrength = 0.22;
          const sidePrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
            "full body",
            "strict side profile",
            "exact 90 degree side view",
            "body fully rotated sideways",
            "profile silhouette",
            "single eye visible",
            "single cheek visible",
            "shoulder line in profile",
            "hips in profile",
            "no frontal pose",
            "no three-quarter pose",
            "no back pose",
            "neutral standing pose",
            "relaxed posture",
            "arms relaxed",
            "solo",
            "single subject",
            "exactly one person",
            "no other people",
            "no crowd",
            "no duplicate body",
            "no extra limbs",
            "no collage",
            "plain background",
            "solid background",
            "studio backdrop",
            "isolated subject",
            "clean background",
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
                detailing: resolveDetailLevel("side")
                  ? {
                      enabled: true,
                      level: resolveDetailLevel("side") ?? undefined,
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
          const localizedSide = await localizeImageUrls(sideUrls);
          ensureActive();
          const sideSource = localizedSide[0] ?? "";
          const sideMeta: ComfyImageGenerationMeta = {
            seed: sideSeed,
            prompt: sidePrompt,
            model: personaDraft.imageCheckpoint || undefined,
            flow: "i2i",
          };
          const sideAsset = sideSource ? await saveLookImageAndGetRef(sideSource, sideMeta) : null;
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
            patchPack({ fullBodySideUrl: sideRef, fullBodySideImageId: sideAsset?.imageId });
          }
        }

        let backRef = "";
        if (generateBackView) {
          const backSeed = packSeed + 211;
          const backReferenceStrength = 0.72;
          const backCompositionStrength = 0.22;
          const backPrompt = mergePromptTags(promptBundle.fullBodyPrompt, [
            "full body",
            "strict back view",
            "rear view",
            "exactly from behind",
            "back facing camera",
            "face not visible",
            "no frontal pose",
            "no side pose",
            "no three-quarter pose",
            "shoulder blades visible from behind",
            "back silhouette centered",
            "neutral standing pose",
            "relaxed posture",
            "arms relaxed",
            "solo",
            "single subject",
            "exactly one person",
            "no other people",
            "no crowd",
            "no duplicate body",
            "no extra limbs",
            "no collage",
            "plain background",
            "solid background",
            "studio backdrop",
            "isolated subject",
            "clean background",
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
                detailing: resolveDetailLevel("back")
                  ? {
                      enabled: true,
                      level: resolveDetailLevel("back") ?? undefined,
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
          const localizedBack = await localizeImageUrls(backUrls);
          ensureActive();
          const backSource = localizedBack[0] ?? "";
          const backMeta: ComfyImageGenerationMeta = {
            seed: backSeed,
            prompt: backPrompt,
            model: personaDraft.imageCheckpoint || undefined,
            flow: "i2i",
          };
          const backAsset = backSource ? await saveLookImageAndGetRef(backSource, backMeta) : null;
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
            patchPack({ fullBodyBackUrl: backRef, fullBodyBackImageId: backAsset?.imageId });
          }
        }

        const avatarPrompt = mergePromptTags(promptBundle.avatarPrompt, [
          "close-up",
          "close face",
          "headshot",
          "face focus",
          "looking at viewer",
          "solo",
          "single subject",
          "one person",
          "no other people",
          "no crowd",
          "detailed background",
          "environmental context",
          "realistic location",
        ]);
        const avatarUrls = await generateComfyImages(
          [
            {
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
          flow: "i2i",
        };
        const avatarAsset = avatarSource ? await saveLookImageAndGetRef(avatarSource, avatarMeta) : null;
        const avatarRef = avatarAsset?.imageUrl ?? "";
        if (!avatarRef) {
          throw new Error(`Не удалось сгенерировать avatar для пакета #${packIndex + 1}.`);
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
        patchPack({ avatarUrl: avatarRef, avatarImageId: avatarAsset?.imageId });

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
        if (packIndex === 0) {
          applyLookPack(readyPack);
        }
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
      if (lookEnhanceRunRef.current !== runId || abortController.signal.aborted) {
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
            ? `${promptBundle.fullBodyPrompt}, full body, side view, profile view`
            : kind === "back"
            ? `${promptBundle.fullBodyPrompt}, full body, back view, from behind`
            : `${promptBundle.fullBodyPrompt}, full body, neutral standing pose`;
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
      const enhanceSeed = stableSeedFromText(
        `${sourceSeed}:${imageUrl}:${kind}:${targetOverride ?? lookEnhanceTarget}:${Date.now()}`,
      );
      const enhancePrompt = mergePromptTags(sourcePrompt, [
        "same person",
        "same identity",
        "same outfit",
        "same framing",
        "preserve composition",
        "highly detailed",
      ]);
      const enhancedUrls = await generateComfyImages(
        [
          {
            flow: "i2i",
            prompt: enhancePrompt,
            width: dims.width,
            height: dims.height,
            seed: enhanceSeed,
            checkpointName: personaDraft.imageCheckpoint || undefined,
            styleReferenceImage: imageUrl,
            styleStrength: 1,
            compositionStrength: 1,
            forceHiResFix: true,
            enableUpscaler: true,
            upscaleFactor: 2,
            hiresFixDenoise: 0.3,
            colorFixStrength: 0.4,
            saveComfyOutputs: settings.saveComfyOutputs,
            outputNodeTitleIncludes: [
              "Preview after Detailing",
            ],
            strictOutputNodeMatch: true,
            pickLatestImageOnly: true,
            detailing: {
              enabled: true,
              level: detailLevel,
              targets: mapEnhanceTargetToDetailTargets(targetOverride ?? lookEnhanceTarget),
              prompts: promptBundle.detailPrompts,
            },
          },
        ],
        settings.comfyBaseUrl,
        settings.comfyAuth,
        undefined,
        abortController.signal,
      );
      ensureEnhanceActive();
      const localized = await localizeImageUrls(enhancedUrls);
      ensureEnhanceActive();
      const enhanceMeta: ComfyImageGenerationMeta = {
        seed: enhanceSeed,
        prompt: sourcePrompt,
        model: personaDraft.imageCheckpoint || undefined,
        flow: "i2i",
      };
      const improvedSource = localized[0];
      const improvedAsset = improvedSource ? await saveLookImageAndGetRef(improvedSource, enhanceMeta) : null;
      const improved = improvedAsset?.imageUrl ?? "";
      if (!improved) {
        throw new Error("Не удалось получить улучшенное изображение.");
      }
      setLookImageMetaByUrl((prev) =>
        withLookMeta(prev, [
          {
            kind,
            url: enhancedUrls[0],
            meta: enhanceMeta,
          },
          {
            kind,
            url: improved,
            meta: enhanceMeta,
          },
        ]),
      );
      setEnhanceReview({
        packIndex,
        kind,
        beforeUrl: imageUrl,
        afterUrl: improved,
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
            if (kind === "avatar") return { ...pack, avatarUrl: afterUrl, avatarImageId: afterImageId };
            if (kind === "side") return { ...pack, fullBodySideUrl: afterUrl, fullBodySideImageId: afterImageId };
            if (kind === "back") return { ...pack, fullBodyBackUrl: afterUrl, fullBodyBackImageId: afterImageId };
            return { ...pack, fullBodyUrl: afterUrl, fullBodyImageId: afterImageId };
          }),
        );
      }
      setPersonaDraft((prev) => ({
        ...prev,
        avatarUrl: kind === "avatar" && prev.avatarUrl === beforeUrl ? afterUrl : prev.avatarUrl,
        fullBodyUrl: kind === "fullbody" && prev.fullBodyUrl === beforeUrl ? afterUrl : prev.fullBodyUrl,
        fullBodySideUrl: kind === "side" && prev.fullBodySideUrl === beforeUrl ? afterUrl : prev.fullBodySideUrl,
        fullBodyBackUrl: kind === "back" && prev.fullBodyBackUrl === beforeUrl ? afterUrl : prev.fullBodyBackUrl,
        avatarImageId:
          kind === "avatar" && prev.avatarUrl === beforeUrl
            ? (afterImageId || prev.avatarImageId)
            : prev.avatarImageId,
        fullBodyImageId:
          kind === "fullbody" && prev.fullBodyUrl === beforeUrl
            ? (afterImageId || prev.fullBodyImageId)
            : prev.fullBodyImageId,
        fullBodySideImageId:
          kind === "side" && prev.fullBodySideUrl === beforeUrl
            ? (afterImageId || prev.fullBodySideImageId)
            : prev.fullBodySideImageId,
        fullBodyBackImageId:
          kind === "back" && prev.fullBodyBackUrl === beforeUrl
            ? (afterImageId || prev.fullBodyBackImageId)
            : prev.fullBodyBackImageId,
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
        prev.map((session) => (session.id === nextSession.id ? nextSession : session)),
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
      useAppStore.setState({ error: "Создайте сессию генератора в меню слева." });
      return;
    }

    const total = generationInfinite ? null : Math.max(1, Math.floor(generationCountLimit));
    const delayMs = Math.max(0, Math.floor(generationDelaySeconds * 1000));
    const runId = generationRunRef.current + 1;
    const persona = personas.find((item) => item.id === generationPersonaId);
    if (!persona) {
      useAppStore.setState({ error: "Выбранная персона не найдена." });
      return;
    }

    const now = new Date().toISOString();
    const selected = generationSessions.find((candidate) => candidate.id === generationSessionId);
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
      return prev.map((candidate) => (candidate.id === session.id ? session : candidate));
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
          const seed = stableSeedFromText(`${session.id}:${iteration}:${generationTopic}`);
          const styleReferenceImage =
            persona.avatarUrl.trim() || persona.fullBodyUrl.trim() || undefined;
          const generationItem = {
            flow: "base" as const,
            prompt,
            checkpointName: persona.imageCheckpoint || undefined,
            seed,
            styleReferenceImage,
            styleStrength: styleReferenceImage ? settings.chatStyleStrength : undefined,
            compositionStrength: 0,
            saveComfyOutputs: settings.saveComfyOutputs,
          };
          const imageUrls = await generateComfyImages(
            [
              generationItem,
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
          );
          const extractedMeta =
            imageUrls[0]
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
          prev.map((candidate) => (candidate.id === mutableSession.id ? mutableSession : candidate)),
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
        prev.map((candidate) => (candidate.id === mutableSession.id ? mutableSession : candidate)),
      );
    } catch (error) {
      mutableSession = {
        ...mutableSession,
        status: "error",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(mutableSession);
      setGenerationSessions((prev) =>
        prev.map((candidate) => (candidate.id === mutableSession.id ? mutableSession : candidate)),
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
          onDeleteGenerationSession={(sessionId) => void deleteGenerationSession(sessionId)}
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
            topic={generationTopic}
            onTopicChange={setGenerationTopic}
            isInfinite={generationInfinite}
            onInfiniteChange={setGenerationInfinite}
            countLimit={generationCountLimit}
            onCountLimitChange={(value) =>
              setGenerationCountLimit(Math.max(1, Math.min(100000, Math.floor(value || 1))))
            }
            delaySeconds={generationDelaySeconds}
            onDelaySecondsChange={(value) => setGenerationDelaySeconds(Math.max(0, Math.min(120, value || 0)))}
            isRunning={generationIsRunning}
            completedCount={generationCompletedCount}
            generatedImageUrls={generatedImageUrls}
            imageMetaByUrl={generationImageMetaByUrl}
            pendingImageCount={generationPendingImageCount}
            onStart={() => void startGeneration()}
            onStop={stopGeneration}
          />
        ) : (
          <ChatPane
            activeChat={activeChat}
            activePersona={activePersona}
            activeChatId={activeChatId}
            messages={messages}
            imageMetaByUrl={Object.fromEntries(
              messages.flatMap((message) => Object.entries(message.imageMetaByUrl ?? {})),
            )}
            messageInput={messageInput}
            setMessageInput={setMessageInput}
            isLoading={isLoading}
            activePersonaState={activePersonaState}
            memoryCount={activeMemories.length}
            showSystemImageBlock={settings.showSystemImageBlock}
            showStatusChangeDetails={settings.showStatusChangeDetails}
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
          imageMetaByUrl={Object.fromEntries(
            messages.flatMap((message) => Object.entries(message.imageMetaByUrl ?? {})),
          )}
          memories={activeMemories}
          runtimeState={activePersonaState}
          settings={settings}
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
          onEnhanceLookImage={enhanceLookImage}
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
          onRefreshCheckpoints={() => void loadComfyCheckpoints(settingsDraft.comfyBaseUrl)}
          imageMetaByUrl={lookImageMetaByUrl}
        />

        <ErrorToast error={error} onClose={clearError} />
        <EnhanceCompareModal
          open={Boolean(enhanceReview)}
          beforeUrl={enhanceReview?.beforeUrl ?? ""}
          afterUrl={enhanceReview?.afterUrl ?? ""}
          onClose={() => setEnhanceReview(null)}
          onKeepOld={() => setEnhanceReview(null)}
          onAccept={() => {
            if (!enhanceReview) return;
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
            void enhanceLookImage(next.packIndex, next.kind, next.beforeUrl);
          }}
        />
      </div>
    </>
  );
}
