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

async function getImageDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = Math.max(256, Math.min(2048, img.naturalWidth || 1024));
      const height = Math.max(256, Math.min(2048, img.naturalHeight || 1024));
      resolve({ width, height });
    };
    img.onerror = () => resolve({ width: 1024, height: 1024 });
    img.src = url;
  });
}

export default function App() {
  const [enhanceReview, setEnhanceReview] = useState<{
    packIndex: number | null;
    kind: "avatar" | "fullbody" | "side" | "back";
    beforeUrl: string;
    afterUrl: string;
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
  const generationRunRef = useRef(0);
  const lookGenerationRunRef = useRef(0);
  const lookGenerationAbortRef = useRef<AbortController | null>(null);
  const lookEnhanceRunRef = useRef(0);
  const lookEnhanceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

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

  const startEditPersona = (persona: Persona) => {
    setEditingPersonaId(persona.id);
    setGeneratedLookPacks([]);
    setPersonaDraft({
      name: persona.name,
      personalityPrompt: persona.personalityPrompt,
      stylePrompt: persona.stylePrompt,
      appearance: persona.appearance,
      imageCheckpoint: persona.imageCheckpoint,
      advanced: persona.advanced,
      avatarUrl: persona.avatarUrl,
      fullBodyUrl: persona.fullBodyUrl,
      fullBodySideUrl: persona.fullBodySideUrl,
      fullBodyBackUrl: persona.fullBodyBackUrl,
    });
    setShowPersonaModal(true);
    setPersonaModalTab("editor");
  };

  const onPersonaSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!personaDraft.name.trim()) return;
    await savePersona({ ...personaDraft, id: editingPersonaId ?? undefined });
    setEditingPersonaId(null);
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const onResetDraft = () => {
    setEditingPersonaId(null);
    setGeneratedLookPacks([]);
    setPersonaDraft(createEmptyPersonaDraft());
  };

  const applyLookPack = (pack: PersonaLookPack) => {
    setPersonaDraft((prev) => ({
      ...prev,
      avatarUrl: pack.avatarUrl,
      fullBodyUrl: pack.fullBodyUrl,
      fullBodySideUrl: pack.fullBodySideUrl,
      fullBodyBackUrl: pack.fullBodyBackUrl,
    }));
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
      const promptBundle = await generatePersonaLookPrompts(settings, {
        name: personaDraft.name,
        personalityPrompt: personaDraft.personalityPrompt,
        appearance: personaDraft.appearance,
        stylePrompt: personaDraft.stylePrompt,
        advanced: personaDraft.advanced,
      });
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
      const sharedSeed = stableSeedFromText(
        [
          personaDraft.name,
          appearanceText,
          personaDraft.stylePrompt,
          promptBundle.avatarPrompt,
          promptBundle.fullBodyPrompt,
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
        const fullBodyPrompt = `${promptBundle.fullBodyPrompt}, full body, neutral standing pose, calm pose, relaxed posture, hands at sides, arms relaxed, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`;
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
        const fullBodyRef = localizedFullBody[0];
        if (!fullBodyRef) {
          throw new Error(`Не удалось сгенерировать fullbody reference для пакета #${packIndex + 1}.`);
        }
        setLookImageMetaByUrl((prev) => ({
          ...prev,
          ...(fullBodyUrls[0] ? { [fullBodyUrls[0]]: { seed: packSeed, prompt: fullBodyPrompt } } : {}),
          [fullBodyRef]: { seed: packSeed, prompt: fullBodyPrompt },
        }));
        patchPack({ fullBodyUrl: fullBodyRef });

        let sideRef = "";
        if (generateSideView) {
          const sideSeed = packSeed + 101;
          const sideReferenceStrength = 0.72;
          const sideCompositionStrength = 0.22;
          const sidePrompt = `${promptBundle.fullBodyPrompt}, full body, strict side profile, exact 90 degree side view, body fully rotated sideways, profile silhouette, single eye visible, single cheek visible, shoulder line in profile, hips in profile, no frontal pose, no three-quarter pose, no back pose, neutral standing pose, relaxed posture, arms relaxed, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`;
          const sideUrls = await generateComfyImages(
            [
              {
                flow: "base",
                prompt: sidePrompt,
                width: fullBodyWidth,
                height: fullBodyHeight,
                seed: sideSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodyRef,
                styleStrength: sideReferenceStrength,
                compositionStrength: sideCompositionStrength,
                forceHiResFix: useHiResFix,
                enableUpscaler: useUpscaler,
                upscaleFactor: 1.5,
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
          sideRef = localizedSide[0] ?? "";
          if (sideRef) {
            setLookImageMetaByUrl((prev) => ({
              ...prev,
              ...(sideUrls[0] ? { [sideUrls[0]]: { seed: sideSeed, prompt: sidePrompt } } : {}),
              [sideRef]: { seed: sideSeed, prompt: sidePrompt },
            }));
            patchPack({ fullBodySideUrl: sideRef });
          }
        }

        let backRef = "";
        if (generateBackView) {
          const backSeed = packSeed + 211;
          const backReferenceStrength = 0.72;
          const backCompositionStrength = 0.22;
          const backPrompt = `${promptBundle.fullBodyPrompt}, full body, strict back view, rear view, exactly from behind, back facing camera, face not visible, no frontal pose, no side pose, no three-quarter pose, shoulder blades visible from behind, back silhouette centered, neutral standing pose, relaxed posture, arms relaxed, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`;
          const backUrls = await generateComfyImages(
            [
              {
                flow: "base",
                prompt: backPrompt,
                width: fullBodyWidth,
                height: fullBodyHeight,
                seed: backSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodyRef,
                styleStrength: backReferenceStrength,
                compositionStrength: backCompositionStrength,
                forceHiResFix: useHiResFix,
                enableUpscaler: useUpscaler,
                upscaleFactor: 1.5,
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
          backRef = localizedBack[0] ?? "";
          if (backRef) {
            setLookImageMetaByUrl((prev) => ({
              ...prev,
              ...(backUrls[0] ? { [backUrls[0]]: { seed: backSeed, prompt: backPrompt } } : {}),
              [backRef]: { seed: backSeed, prompt: backPrompt },
            }));
            patchPack({ fullBodyBackUrl: backRef });
          }
        }

        const avatarPrompt = `${promptBundle.avatarPrompt}, close-up, close face, headshot, face focus, looking at viewer, solo, single subject, one person, no other people, no crowd, detailed background, environmental context, realistic location`;
        const avatarUrls = await generateComfyImages(
          [
            {
              prompt: avatarPrompt,
              width: avatarSize,
              height: avatarSize,
              seed: packSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleReferenceImage: fullBodyRef,
              styleStrength: 1,
              compositionStrength: 0,
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
        const avatarRef = localizedAvatar[0] ?? "";
        if (!avatarRef) {
          throw new Error(`Не удалось сгенерировать avatar для пакета #${packIndex + 1}.`);
        }
        setLookImageMetaByUrl((prev) => ({
          ...prev,
          ...(avatarUrls[0] ? { [avatarUrls[0]]: { seed: packSeed, prompt: avatarPrompt } } : {}),
          [avatarRef]: { seed: packSeed, prompt: avatarPrompt },
        }));
        patchPack({ avatarUrl: avatarRef });

        const readyPack: PersonaLookPack = {
          status: "ready",
          avatarUrl: avatarRef,
          fullBodyUrl: fullBodyRef,
          fullBodySideUrl: sideRef,
          fullBodyBackUrl: backRef,
        };
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
      const promptBundle = await generatePersonaLookPrompts(settings, {
        name: personaDraft.name,
        personalityPrompt: personaDraft.personalityPrompt,
        appearance: personaDraft.appearance,
        stylePrompt: personaDraft.stylePrompt,
        advanced: personaDraft.advanced,
      });
      ensureEnhanceActive();
      const dims = await getImageDimensions(imageUrl);
      ensureEnhanceActive();
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
      const enhancePrompt = `${sourcePrompt}, same person, same identity, same outfit, same framing, preserve composition, highly detailed`;
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
            upscaleFactor: 1.25,
            outputNodeTitleIncludes: [
              "Preview after Detailing",
              "Preview after Upscale/HiRes Fix",
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
      const improved = localized[0];
      if (!improved) {
        throw new Error("Не удалось получить улучшенное изображение.");
      }
      setLookImageMetaByUrl((prev) => ({
        ...prev,
        ...(enhancedUrls[0] ? { [enhancedUrls[0]]: { seed: enhanceSeed, prompt: sourcePrompt } } : {}),
        [improved]: { seed: enhanceSeed, prompt: sourcePrompt },
      }));
      setEnhanceReview({
        packIndex,
        kind,
        beforeUrl: imageUrl,
        afterUrl: improved,
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
  ) => {
    if (packIndex !== null) {
      setGeneratedLookPacks((prev) =>
        prev.map((pack, idx) => {
          if (idx !== packIndex) return pack;
          if (kind === "avatar") return { ...pack, avatarUrl: afterUrl };
          if (kind === "side") return { ...pack, fullBodySideUrl: afterUrl };
          if (kind === "back") return { ...pack, fullBodyBackUrl: afterUrl };
          return { ...pack, fullBodyUrl: afterUrl };
        }),
      );
    }
    setPersonaDraft((prev) => ({
      ...prev,
      avatarUrl: kind === "avatar" && prev.avatarUrl === beforeUrl ? afterUrl : prev.avatarUrl,
      fullBodyUrl: kind === "fullbody" && prev.fullBodyUrl === beforeUrl ? afterUrl : prev.fullBodyUrl,
      fullBodySideUrl: kind === "side" && prev.fullBodySideUrl === beforeUrl ? afterUrl : prev.fullBodySideUrl,
      fullBodyBackUrl: kind === "back" && prev.fullBodyBackUrl === beforeUrl ? afterUrl : prev.fullBodyBackUrl,
    }));
  };

  const onSaveGenerated = async (draft: GeneratedPersonaDraft) => {
    await savePersona({
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
    });
  };

  const onMoveGeneratedToEditor = (draft: GeneratedPersonaDraft) => {
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
        try {
          const imageUrls = await generateComfyImages(
            [
              {
                prompt,
                checkpointName: persona.imageCheckpoint || undefined,
                seed: stableSeedFromText(`${session.id}:${iteration}:${generationTopic}`),
                styleReferenceImage:
                  persona.avatarUrl.trim() || persona.fullBodyUrl.trim() || undefined,
                styleStrength:
                  persona.avatarUrl.trim() || persona.fullBodyUrl.trim()
                    ? settings.chatStyleStrength
                    : undefined,
                compositionStrength: 0,
              },
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
          );
          localized = await localizeImageUrls(imageUrls);
        } finally {
          setGenerationPendingImageCount((prev) => Math.max(0, prev - 1));
        }
        const entry = {
          id: crypto.randomUUID(),
          iteration,
          prompt,
          imageUrls: localized,
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
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          setSettingsDraft={setSettingsDraft}
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
          onClose={() => setShowPersonaModal(false)}
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
          onApplyLookPack={applyLookPack}
          generateSideView={generateSideView}
          setGenerateSideView={setGenerateSideView}
          generateBackView={generateBackView}
          setGenerateBackView={setGenerateBackView}
          comfyCheckpoints={comfyCheckpoints}
          checkpointsLoading={checkpointsLoading}
          onRefreshCheckpoints={() => void loadComfyCheckpoints(settingsDraft.comfyBaseUrl)}
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
