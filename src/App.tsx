import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { GeneratedPersonaDraft } from "./lmstudio";
import {
  generatePersonaDrafts,
} from "./lmstudio";
import {
  type ComfyImageGenerationMeta,
} from "./comfy";
import { dbApi } from "./db";
import { useAppStore } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ChatDetailsModal } from "./components/ChatDetailsModal";
import { EnhanceCompareModal } from "./components/EnhanceCompareModal";
import { ErrorToast } from "./components/ErrorToast";
import { GenerationPane } from "./components/GenerationPane";
import { PersonaModal } from "./components/PersonaModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import {
  createEmptyPersonaDraft,
  type LookDetailLevel,
  type LookEnhanceTarget,
  type PersonaLookPack,
  type PersonaModalTab,
  type SidebarTab,
} from "./ui/types";
import {
  withLookMeta,
  type PersonaLookPromptBundle,
} from "./features/look/lookHelpers";
import { useLookPromptCache } from "./features/look-cache/useLookPromptCache";
import { useTopicGenerator } from "./features/generator/useTopicGenerator";
import { useGenerationSessionManager } from "./features/generator/useGenerationSessionManager";
import {
  useSharedImageActions,
} from "./features/image-actions/useSharedImageActions";
import { usePersonaLookActions } from "./features/look/usePersonaLookActions";
import { usePersonaDraftActions } from "./features/persona-editor/usePersonaDraftActions";
import { useAppInstallPrompt } from "./features/settings/useAppInstallPrompt";
import { useModelCheckpointCatalog } from "./features/settings/useModelCheckpointCatalog";
import {
  buildBackupPayload,
  exportBackupFile,
  type BackupImportMode,
  importBackupPayload,
  parseBackupFile,
} from "./features/backup/dataTransfer";
import type { ChatSession } from "./types";

export default function App() {
  const {
    personas,
    chats,
    messages,
    activeChatEvents,
    activeChatParticipants,
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
    createGroupChat,
    createAdventureChat,
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
  const [exportBusy, setExportBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [dataTransferMessage, setDataTransferMessage] = useState<string | null>(
    null,
  );
  const [readyExportFile, setReadyExportFile] = useState<{
    fileName: string;
    url: string;
  } | null>(null);
  const [exportableChats, setExportableChats] = useState<ChatSession[]>([]);

  const [personaDraft, setPersonaDraft] = useState(createEmptyPersonaDraft);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [settingsDraft, setSettingsDraft] = useState(settings);

  const [generationTheme, setGenerationTheme] = useState("");
  const [generationCount, setGenerationCount] = useState(3);
  const [generatedDrafts, setGeneratedDrafts] = useState<
    GeneratedPersonaDraft[]
  >([]);
  const [generationLoading, setGenerationLoading] = useState(false);
  const [generateSideView, setGenerateSideView] = useState(false);
  const [generateBackView, setGenerateBackView] = useState(false);
  const [lookPackageCount, setLookPackageCount] = useState(1);
  const [lookDetailLevel, setLookDetailLevel] =
    useState<LookDetailLevel>("off");
  const [lookEnhanceTarget, setLookEnhanceTarget] =
    useState<LookEnhanceTarget>("all");
  const [lookFastMode, setLookFastMode] = useState(false);
  const [lookImageMetaByUrl, setLookImageMetaByUrl] = useState<
    Record<string, ComfyImageGenerationMeta>
  >({});
  const [generatedLookPacks, setGeneratedLookPacks] = useState<
    PersonaLookPack[]
  >([]);
  const [generationTopic, setGenerationTopic] = useState("");
  const [generationInfinite, setGenerationInfinite] = useState(false);
  const [generationCountLimit, setGenerationCountLimit] = useState(5);
  const [generationDelaySeconds, setGenerationDelaySeconds] = useState(2);
  const [generationIsRunning, setGenerationIsRunning] = useState(false);
  const [generationPendingImageCount, setGenerationPendingImageCount] =
    useState(0);
  const generationRunRef = useRef(0);
  const lookSessionAssetIdsRef = useRef<Set<string>>(new Set());
  const lookPromptBundleCacheRef = useRef<{
    key: string;
    bundle: PersonaLookPromptBundle;
  } | null>(null);
  const { getCachedLookPromptBundle } = useLookPromptCache({
    settings,
    personaDraft,
    setPersonaDraft,
    cacheRef: lookPromptBundleCacheRef,
  });

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  const { pwaInstallStatus, onInstallPwa } = useAppInstallPrompt();
  const {
    availableModels,
    modelsLoading,
    comfyCheckpoints,
    checkpointsLoading,
    loadModels,
    loadComfyCheckpoints,
  } = useModelCheckpointCatalog({
    initialized,
    settings,
    settingsDraft,
    setSettingsDraft,
  });

  const activePersona = useMemo(
    () => personas.find((p) => p.id === activePersonaId) ?? null,
    [personas, activePersonaId],
  );

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  const {
    generationPersonaId,
    setGenerationPersonaId,
    generationSessions,
    setGenerationSessions,
    generationSessionId,
    setGenerationSessionId,
    generationCompletedCount,
    setGenerationCompletedCount,
    generationSession,
    createGenerationSession,
    deleteGenerationSession,
  } = useGenerationSessionManager({
    personas,
    activePersonaId,
    generationTopic,
    generationInfinite,
    generationCountLimit,
    generationDelaySeconds,
    generationIsRunning,
    setGenerationTopic,
    setGenerationInfinite,
    setGenerationCountLimit,
    setGenerationDelaySeconds,
    setSidebarTab,
  });
  const generationActivePersona = useMemo(() => {
    const personaId = generationSession?.personaId || generationPersonaId;
    if (!personaId) return null;
    return personas.find((persona) => persona.id === personaId) ?? null;
  }, [generationPersonaId, generationSession?.personaId, personas]);

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
  const {
    imageActionBusy,
    sharedEnhanceReview,
    setSharedEnhanceReview,
    applySharedImageReplacement,
    runSharedImageAction,
    enhanceSharedImage,
    regenerateSharedImage,
  } = useSharedImageActions({
    activePersona,
    settings,
    chatImageMetaByUrl,
    setGenerationSessions,
  });
  const { startGeneration, stopGeneration } = useTopicGenerator({
    settings,
    personas,
    generationPersonaId,
    generationTopic,
    generationInfinite,
    generationCountLimit,
    generationDelaySeconds,
    generationSessionId,
    generationSessions,
    generationSession,
    generationRunRef,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
    setGenerationSessions,
    setGenerationSessionId,
    setGenerationCompletedCount,
  });

  const {
    saveLookImageAndGetRef,
    startEditPersona,
    onPersonaSubmit,
    onResetDraft,
    applyLookPack,
    onSaveGenerated,
    onMoveGeneratedToEditor,
  } = usePersonaDraftActions({
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
  });

  const {
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
  } = usePersonaLookActions({
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
  });

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

  const onToggleMobileTab = (tab: SidebarTab) => {
    if (sidebarTab === tab && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    } else {
      setSidebarTab(tab);
      setMobileSidebarOpen(true);
    }
  };

  const onResetLookPromptCache = () => {
    lookPromptBundleCacheRef.current = null;
    setPersonaDraft((prev) => ({
      ...prev,
      lookPromptCache: undefined,
    }));
  };

  useEffect(() => {
    if (!showSettingsModal) return;
    setDataTransferMessage(null);
    let cancelled = false;
    void (async () => {
      try {
        const rows = await dbApi.getAllChats();
        if (!cancelled) {
          setExportableChats(rows);
        }
      } catch (error) {
        if (!cancelled) {
          useAppStore.setState({ error: (error as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showSettingsModal]);

  useEffect(() => {
    return () => {
      if (readyExportFile) {
        URL.revokeObjectURL(readyExportFile.url);
      }
    };
  }, [readyExportFile]);

  const exportableChatOptions = useMemo(() => {
    const personaNameById = new Map(personas.map((persona) => [persona.id, persona.name]));
    return exportableChats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      personaName: personaNameById.get(chat.personaId) ?? "Неизвестная персона",
    }));
  }, [exportableChats, personas]);

  const onExportData = async (params: {
    scope: "all" | "personas" | "all_chats" | "chat" | "generation_sessions";
    format: "json" | "zip";
    chatId?: string;
  }) => {
    setExportBusy(true);
    setDataTransferMessage(null);
    setReadyExportFile((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev.url);
      }
      return null;
    });
    try {
      const payload = await buildBackupPayload({
        scope: params.scope,
        chatId: params.chatId,
      });
      const preparedFile = await exportBackupFile(payload, params.format);
      const downloadUrl = URL.createObjectURL(preparedFile.blob);
      setReadyExportFile({
        fileName: preparedFile.fileName,
        url: downloadUrl,
      });
      const meta = payload.meta;
      setDataTransferMessage(
        [
          `Экспорт готов: ${payload.exportScope}`,
          `Файл подготовлен: ${preparedFile.fileName}. Нажми "Скачать экспорт".`,
          `personas=${meta.personas}, chats=${meta.chats}, messages=${meta.messages}, states=${meta.personaStates}, memories=${meta.memories}, sessions=${meta.generatorSessions}, imageAssets=${meta.imageAssets}`,
        ].join("\n"),
      );
    } catch (error) {
      useAppStore.setState({ error: (error as Error).message });
    } finally {
      setExportBusy(false);
    }
  };

  const onImportData = async (file: File, mode: BackupImportMode) => {
    setImportBusy(true);
    setDataTransferMessage(null);
    try {
      const payload = await parseBackupFile(file);
      const meta = await importBackupPayload(payload, mode);
      await initialize();
      setDataTransferMessage(
        [
          `Импорт завершен из "${file.name}"`,
          `Режим: ${mode === "replace" ? "замена текущих данных" : "добавление/объединение"}`,
          `personas=${meta.personas}, chats=${meta.chats}, messages=${meta.messages}, states=${meta.personaStates}, memories=${meta.memories}, sessions=${meta.generatorSessions}, imageAssets=${meta.imageAssets}, settings=${meta.includesSettings ? "yes" : "no"}`,
        ].join("\n"),
      );
    } catch (error) {
      useAppStore.setState({ error: (error as Error).message });
    } finally {
      setImportBusy(false);
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
          onCreateGroupChat={(personaIds, title) =>
            void createGroupChat(personaIds, title)
          }
          onCreateAdventureChat={(personaIds, scenario) =>
            void createAdventureChat(personaIds, scenario)
          }
          onCreateGenerationSession={() => void createGenerationSession()}
          onDeleteGenerationSession={(sessionId) =>
            void deleteGenerationSession(sessionId)
          }
          onSelectChat={(chatId) => void selectChat(chatId)}
          onSelectGenerationSession={setGenerationSessionId}
          onSelectPersona={(personaId) => void selectPersona(personaId)}
          onSelectGenerationPersona={setGenerationPersonaId}
          onEditPersona={startEditPersona}
          enableGroupChats={settings.enableGroupChats}
          isMobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onToggleMobileTab={onToggleMobileTab}
        />

        {sidebarTab === "generation" ? (
          <GenerationPane
            activePersona={generationActivePersona}
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
            chatParticipants={activeChatParticipants}
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
          chatEvents={activeChatEvents}
          chatParticipants={activeChatParticipants}
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
          exportableChats={exportableChatOptions}
          exportBusy={exportBusy}
          importBusy={importBusy}
          dataTransferMessage={dataTransferMessage}
          exportDownloadUrl={readyExportFile?.url ?? null}
          exportDownloadFileName={readyExportFile?.fileName ?? null}
          setSettingsDraft={setSettingsDraft}
          onInstallPwa={() => void onInstallPwa()}
          onRefreshModels={() =>
            void loadModels(
              settingsDraft.lmBaseUrl,
              settingsDraft.apiKey,
              settingsDraft.lmAuth,
            )
          }
          onExportData={onExportData}
          onImportData={onImportData}
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
          onResetLookPromptCache={onResetLookPromptCache}
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
            void runSharedImageAction(
              next.context,
              "enhance",
              next.target,
            );
          }}
        />
      </div>
    </>
  );
}
