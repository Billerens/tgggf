import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { GeneratedPersonaDraft } from "./lmstudio";
import {
  generatePersonaDrafts,
  generatePersonaLookPrompts,
  generateThemedComfyPrompt,
  listModels,
} from "./lmstudio";
import { generateComfyImages, listComfyCheckpoints } from "./comfy";
import { dbApi } from "./db";
import { localizeImageUrls } from "./imageStorage";
import { useAppStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ChatDetailsModal } from "./components/ChatDetailsModal";
import { ErrorToast } from "./components/ErrorToast";
import { GenerationPane } from "./components/GenerationPane";
import { PersonaModal } from "./components/PersonaModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import type { GeneratorSession, Persona } from "./types";
import {
  createEmptyPersonaDraft,
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

export default function App() {
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

  const startEditPersona = (persona: Persona) => {
    setEditingPersonaId(persona.id);
    setGeneratedLookPacks([]);
    setPersonaDraft({
      name: persona.name,
      personalityPrompt: persona.personalityPrompt,
      appearancePrompt: persona.appearancePrompt,
      stylePrompt: persona.stylePrompt,
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
    if (!personaDraft.appearancePrompt.trim()) {
      useAppStore.setState({ error: "Сначала заполни поле внешности (appearance prompt)." });
      return;
    }

    setLookGenerationLoading(true);
    setGeneratedLookPacks([]);
    try {
      const promptBundle = await generatePersonaLookPrompts(settings, {
        name: personaDraft.name,
        personalityPrompt: personaDraft.personalityPrompt,
        appearancePrompt: personaDraft.appearancePrompt,
        stylePrompt: personaDraft.stylePrompt,
        advanced: personaDraft.advanced,
      });
      const sharedSeed = stableSeedFromText(
        [
          personaDraft.name,
          personaDraft.appearancePrompt,
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
        const packSeed = sharedSeed + packIndex * 997;
        const patchPack = (patch: Partial<PersonaLookPack>) => {
          setGeneratedLookPacks((prev) =>
            prev.map((pack, idx) => (idx === packIndex ? { ...pack, ...patch } : pack)),
          );
        };
        const fullBodyUrls = await generateComfyImages(
          [
            {
              prompt: `${promptBundle.fullBodyPrompt}, full body, neutral standing pose, calm pose, relaxed posture, hands at sides, arms relaxed, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`,
              width: 832,
              height: 1216,
              seed: packSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleStrength: 0,
              compositionStrength: 0,
              forceHiResFix: true,
              enableUpscaler: true,
              upscaleFactor: 1.5,
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
        );
        const localizedFullBody = await localizeImageUrls(fullBodyUrls);
        const fullBodyRef = localizedFullBody[0];
        if (!fullBodyRef) {
          throw new Error(`Не удалось сгенерировать fullbody reference для пакета #${packIndex + 1}.`);
        }
        patchPack({ fullBodyUrl: fullBodyRef });

        let sideRef = "";
        if (generateSideView) {
          const sideUrls = await generateComfyImages(
            [
              {
                prompt: `${promptBundle.fullBodyPrompt}, full body, side view, profile view, neutral standing pose, calm pose, relaxed posture, hands at sides, arms relaxed, same person as reference, same hairstyle, same hair color, same outfit as reference image, same clothing details, same accessories, no outfit change, no hairstyle change, same body type, consistent character identity, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`,
                width: 832,
                height: 1216,
                seed: packSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodyRef,
                styleStrength: 1,
                compositionStrength: 0,
                forceHiResFix: true,
                enableUpscaler: true,
                upscaleFactor: 1.5,
              },
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
          );
          const localizedSide = await localizeImageUrls(sideUrls);
          sideRef = localizedSide[0] ?? "";
          if (sideRef) {
            patchPack({ fullBodySideUrl: sideRef });
          }
        }

        let backRef = "";
        if (generateBackView) {
          const backUrls = await generateComfyImages(
            [
              {
                prompt: `${promptBundle.fullBodyPrompt}, full body, back view, from behind, neutral standing pose, calm pose, relaxed posture, hands at sides, arms relaxed, same person as reference, same hairstyle, same hair color, same outfit as reference image, same clothing details, same accessories, no outfit change, no hairstyle change, same body type, consistent character identity, solo, single subject, exactly one person, no other people, no crowd, no duplicate body, no extra limbs, no collage, plain background, solid background, studio backdrop, isolated subject, clean background, no environment`,
                width: 832,
                height: 1216,
                seed: packSeed,
                checkpointName: personaDraft.imageCheckpoint || undefined,
                styleReferenceImage: fullBodyRef,
                styleStrength: 1,
                compositionStrength: 0,
                forceHiResFix: true,
                enableUpscaler: true,
                upscaleFactor: 1.5,
              },
            ],
            settings.comfyBaseUrl,
            settings.comfyAuth,
          );
          const localizedBack = await localizeImageUrls(backUrls);
          backRef = localizedBack[0] ?? "";
          if (backRef) {
            patchPack({ fullBodyBackUrl: backRef });
          }
        }

        const avatarUrls = await generateComfyImages(
          [
            {
              prompt: `${promptBundle.avatarPrompt}, close-up, close face, headshot, face focus, looking at viewer, solo, single subject, one person, no other people, no crowd, detailed background, environmental context, realistic location`,
              width: 1024,
              height: 1024,
              seed: packSeed,
              checkpointName: personaDraft.imageCheckpoint || undefined,
              styleReferenceImage: fullBodyRef,
              styleStrength: 1,
              compositionStrength: 0,
            },
          ],
          settings.comfyBaseUrl,
          settings.comfyAuth,
        );
        const localizedAvatar = await localizeImageUrls(avatarUrls);
        const avatarRef = localizedAvatar[0] ?? "";
        if (!avatarRef) {
          throw new Error(`Не удалось сгенерировать avatar для пакета #${packIndex + 1}.`);
        }
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
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setLookGenerationLoading(false);
    }
  };

  const onSaveGenerated = async (draft: GeneratedPersonaDraft) => {
    await savePersona({
      name: draft.name,
      personalityPrompt: draft.personalityPrompt,
      appearancePrompt: draft.appearancePrompt,
      stylePrompt: draft.stylePrompt,
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
      appearancePrompt: draft.appearancePrompt,
      stylePrompt: draft.stylePrompt,
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
          generationSessions={generationSessions}
          activeGenerationSessionId={generationSessionId || null}
          onOpenPersonas={() => setShowPersonaModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onCreateChat={() => void createChat()}
          onCreateGenerationSession={() => void createGenerationSession()}
          onSelectChat={(chatId) => void selectChat(chatId)}
          onSelectGenerationSession={setGenerationSessionId}
          onSelectPersona={(personaId) => void selectPersona(personaId)}
          onEditPersona={startEditPersona}
          isMobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onToggleMobileTab={onToggleMobileTab}
        />

        {sidebarTab === "generation" ? (
          <GenerationPane
            personas={personas}
            selectedPersonaId={generationPersonaId}
            onSelectPersona={setGenerationPersonaId}
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
          lookPackageCount={lookPackageCount}
          setLookPackageCount={setLookPackageCount}
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
      </div>
    </>
  );
}
