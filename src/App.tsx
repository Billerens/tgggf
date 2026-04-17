import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  GeneratedPersonaDraft,
  ModelRoutingTask,
  ToolCallingCapabilityStatus,
} from "./lmstudio";
import {
  generatePersonaDrafts,
  probeModelToolCallingCapability,
  resolveModelRoutingTarget,
  resolveProviderModelCatalogTarget,
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
import { GroupChatPane } from "./components/GroupChatPane";
import { GroupChatDetailsModal } from "./components/GroupChatDetailsModal";
import { GroupRoomModal } from "./components/GroupRoomModal";
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
  getForegroundServiceStatus,
  setForegroundServiceEnabled,
  type ForegroundServiceHealth,
  type ForegroundServiceStatus,
} from "./features/mobile/foregroundService";
import { useGroupIterationBackgroundWorker } from "./features/mobile/useGroupIterationBackgroundWorker";
import { useTopicGenerationBackgroundWorker } from "./features/mobile/useTopicGenerationBackgroundWorker";
import { downloadExportFileOnAndroid } from "./features/mobile/exportDownload";
import { useGroupStore } from "./groupStore";
import {
  type BackupExportSelection,
  buildBackupPayload,
  exportBackupFile,
  exportRawBackupFile,
  type BackupExportFormat,
  type BackupImportMode,
  importBackupPayload,
  parseBackupFile,
} from "./features/backup/dataTransfer";
import { useGoogleDriveBackupSync } from "./features/backup/useGoogleDriveBackupSync";
import {
  pushSystemLog,
  useSystemLogStore,
} from "./features/system-logs/systemLogStore";
import { getRuntimeContext } from "./platform/runtimeContext";
import type { ChatSession, LlmProvider } from "./types";

type ToolCapabilityMatrixStatus =
  | "idle"
  | "checking"
  | ToolCallingCapabilityStatus;

type ToolCapabilityProviderField =
  | "oneToOneProvider"
  | "groupOrchestratorProvider"
  | "groupPersonaProvider"
  | "imagePromptProvider"
  | "personaGenerationProvider";

type ToolCapabilityModelField =
  | "model"
  | "groupOrchestratorModel"
  | "groupPersonaModel"
  | "imagePromptModel"
  | "personaGenerationModel";

interface ToolCapabilityRoleConfig {
  task: ModelRoutingTask;
  title: string;
  providerField: ToolCapabilityProviderField;
  modelField: ToolCapabilityModelField;
}

interface ToolCapabilityRowState {
  fingerprint: string;
  status: ToolCapabilityMatrixStatus;
  checkedAt?: string;
  reason?: string;
  fromCache?: boolean;
}

interface ForegroundServiceUiState {
  loading: boolean;
  enabled: boolean;
  running: boolean;
  health: ForegroundServiceHealth;
  queueDepth: number;
  staleJobs: number;
  staleWorkers: number;
  activeTopicScopes: number;
  activeGroupScopes: number;
  lastError: string | null;
  error: string | null;
}

function buildForegroundServiceUiState(
  status: ForegroundServiceStatus,
): ForegroundServiceUiState {
  return {
    loading: false,
    enabled: status.enabled,
    running: status.running,
    health: status.health,
    queueDepth: status.queue.totalDepth,
    staleJobs: status.staleJobs,
    staleWorkers: status.staleWorkers,
    activeTopicScopes: status.activeScopes.topicGeneration,
    activeGroupScopes: status.activeScopes.groupIteration,
    lastError: status.lastError,
    error: null,
  };
}

const DEFAULT_WINDOWS_ARTIFACT_URL =
  "./downloads/windows/tg-gf-windows.exe";
const DEFAULT_ANDROID_ARTIFACT_URL =
  "./downloads/android/tg-gf-android-debug.apk";

const TOOL_CAPABILITY_ROLE_CONFIGS: ToolCapabilityRoleConfig[] = [
  {
    task: "one_to_one_chat",
    title: "1:1 чат",
    providerField: "oneToOneProvider",
    modelField: "model",
  },
  {
    task: "group_orchestrator",
    title: "Группы: оркестратор",
    providerField: "groupOrchestratorProvider",
    modelField: "groupOrchestratorModel",
  },
  {
    task: "group_persona",
    title: "Группы: персона",
    providerField: "groupPersonaProvider",
    modelField: "groupPersonaModel",
  },
  {
    task: "image_prompt",
    title: "Генератор prompt изображений",
    providerField: "imagePromptProvider",
    modelField: "imagePromptModel",
  },
  {
    task: "persona_generation",
    title: "Генератор карточек персон",
    providerField: "personaGenerationProvider",
    modelField: "personaGenerationModel",
  },
];

function buildToolCapabilityFingerprint(
  provider: LlmProvider,
  baseUrl: string,
  model: string,
) {
  return `${provider}|${baseUrl.trim().replace(/\/+$/g, "")}|${model
    .trim()
    .toLowerCase()}`;
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
    renameChat,
    setChatStyleStrength,
    setActiveInfluenceProfile,
    updateActivePersonaState,
    addManualMemory,
    updateActiveMemory,
    deleteActiveMemory,
    sendMessage,
    regenerateMessageComfyPromptAtIndex,
    resolveRelationshipProposal,
    saveSettings,
    clearError,
  } = useAppStore();
  const {
    groupRooms,
    groupParticipants,
    groupMessages,
    groupEvents,
    groupPersonaStates,
    groupRelationEdges,
    groupSharedMemories,
    groupPrivateMemories,
    activeGroupRoomId,
    isLoading: isGroupLoading,
    initializeGroup,
    createGroupRoom,
    deleteGroupRoom,
    renameGroupRoom,
    selectGroupRoom,
    sendUserGroupMessage,
    setActiveGroupRoomStatus,
    setGroupPersonaInfluenceProfile,
    runActiveGroupIteration,
    retryGroupMessageImages,
    regenerateGroupMessageResponse,
    syncGroupStateFromDb,
  } = useGroupStore();

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [showGroupRoomModal, setShowGroupRoomModal] = useState(false);
  const [showChatDetailsModal, setShowChatDetailsModal] = useState(false);
  const [showGroupChatDetailsModal, setShowGroupChatDetailsModal] = useState(false);
  const [personaModalTab, setPersonaModalTab] =
    useState<PersonaModalTab>("editor");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [dataTransferMessage, setDataTransferMessage] = useState<string | null>(
    null,
  );
  const systemLogs = useSystemLogStore((state) => state.entries);
  const clearSystemLogs = useSystemLogStore((state) => state.clear);
  const runtimeMode = getRuntimeContext().mode;
  const isAndroidRuntime = runtimeMode === "android";
  const [foregroundServiceState, setForegroundServiceState] =
    useState<ForegroundServiceUiState>({
      loading: false,
      enabled: true,
      running: false,
      health: "fallback",
      queueDepth: 0,
      staleJobs: 0,
      staleWorkers: 0,
      activeTopicScopes: 0,
      activeGroupScopes: 0,
      lastError: null,
      error: null,
    });
  const [readyExportFile, setReadyExportFile] = useState<{
    fileName: string;
    url: string;
    blob: Blob;
  } | null>(null);
  const [exportableChats, setExportableChats] = useState<ChatSession[]>([]);

  const [personaDraft, setPersonaDraft] = useState(createEmptyPersonaDraft);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [groupMessageInput, setGroupMessageInput] = useState("");
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [toolCapabilityByTask, setToolCapabilityByTask] = useState<
    Partial<Record<ModelRoutingTask, ToolCapabilityRowState>>
  >({});
  const [toolCapabilityBatchChecking, setToolCapabilityBatchChecking] =
    useState(false);

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
  const [generationPromptMode, setGenerationPromptMode] = useState<
    "theme_llm" | "direct_prompt"
  >("theme_llm");
  const [generationDirectPromptSeed, setGenerationDirectPromptSeed] = useState<
    number | null
  >(null);
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
    if (!initialized) return;
    void initializeGroup(personas);
  }, [initialized, initializeGroup, personas]);

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (!isAndroidRuntime) return;
    pushSystemLog({
      level: "info",
      eventType: "group_iteration.flag_state",
      message: "android background runtime mode: native_always_on",
    });
  }, [isAndroidRuntime]);

  const { pwaInstallStatus, onInstallPwa } = useAppInstallPrompt();
  const windowsArtifactUrl =
    (typeof import.meta.env.VITE_WINDOWS_ARTIFACT_URL === "string"
      ? import.meta.env.VITE_WINDOWS_ARTIFACT_URL
      : ""
    ).trim() || DEFAULT_WINDOWS_ARTIFACT_URL;
  const androidArtifactUrl =
    (typeof import.meta.env.VITE_ANDROID_ARTIFACT_URL === "string"
      ? import.meta.env.VITE_ANDROID_ARTIFACT_URL
      : ""
    ).trim() || DEFAULT_ANDROID_ARTIFACT_URL;
  const refreshForegroundService = useCallback(async () => {
    if (!isAndroidRuntime) return;
    setForegroundServiceState((prev) => ({
      ...prev,
      loading: true,
      error: null,
    }));
    try {
      const status = await getForegroundServiceStatus();
      pushSystemLog({
        level: "info",
        eventType: "foreground_service.status",
        message:
          "Foreground service status: " +
          `enabled=${status.enabled}, running=${status.running}, health=${status.health}, ` +
          `queueDepth=${status.queue.totalDepth}, staleJobs=${status.staleJobs}, staleWorkers=${status.staleWorkers}`,
        details: status,
      });
      setForegroundServiceState(buildForegroundServiceUiState(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushSystemLog({
        level: "error",
        eventType: "foreground_service.status_error",
        message,
      });
      setForegroundServiceState((prev) => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  }, [isAndroidRuntime]);
  const toggleForegroundService = useCallback(
    async (enabled: boolean) => {
      if (!isAndroidRuntime) return;
      setForegroundServiceState((prev) => ({
        ...prev,
        loading: true,
        error: null,
      }));
      try {
        const status = await setForegroundServiceEnabled(enabled);
        pushSystemLog({
          level: "info",
          eventType: "foreground_service.toggled",
          message:
            "Foreground service toggled: " +
            `enabled=${status.enabled}, running=${status.running}, health=${status.health}, ` +
            `queueDepth=${status.queue.totalDepth}`,
          details: status,
        });
        setForegroundServiceState(buildForegroundServiceUiState(status));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushSystemLog({
          level: "error",
          eventType: "foreground_service.toggle_error",
          message,
        });
        setForegroundServiceState((prev) => ({
          ...prev,
          loading: false,
          error: message,
        }));
      }
    },
    [isAndroidRuntime],
  );
  const {
    availableModels,
    availableModelsByProvider,
    modelsLoadingByProvider,
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
  const activeGroupRoom = useMemo(
    () => groupRooms.find((room) => room.id === activeGroupRoomId) ?? null,
    [groupRooms, activeGroupRoomId],
  );
  useGroupIterationBackgroundWorker({
    activeGroupRoom,
    isAndroidRuntime,
    personas,
    settings,
    runActiveGroupIteration,
    syncGroupStateFromDb,
  });

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
    syncGenerationSessionsFromDb,
    createGenerationSession,
    deleteGenerationSession,
    renameGenerationSession,
  } = useGenerationSessionManager({
    personas,
    activePersonaId,
    generationTopic,
    generationPromptMode,
    generationDirectPromptSeed,
    generationInfinite,
    generationCountLimit,
    generationDelaySeconds,
    generationIsRunning,
    setGenerationTopic,
    setGenerationPromptMode,
    setGenerationDirectPromptSeed,
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
  useEffect(() => {
    if (!isAndroidRuntime) return;
    const shouldBeRunning = generationSession?.status === "running";
    setGenerationIsRunning((prev) => (prev === shouldBeRunning ? prev : shouldBeRunning));
    if (!shouldBeRunning) {
      setGenerationPendingImageCount(0);
    }
  }, [isAndroidRuntime, generationSession?.id, generationSession?.status]);
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
  const {
    runGenerationStep,
    startGeneration,
    startSingleGeneration,
    stopGeneration,
  } = useTopicGenerator({
    isAndroidRuntime,
    settings,
    personas,
    generationPersonaId,
    generationTopic,
    generationPromptMode,
    generationDirectPromptSeed,
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
  useTopicGenerationBackgroundWorker({
    isAndroidRuntime,
    generationSession,
    runGenerationStep,
    syncGenerationSessionsFromDb,
    onError: (message) => {
      useAppStore.setState({ error: message });
    },
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

  const onGroupMessageSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!groupMessageInput.trim()) return;
    const value = groupMessageInput;
    setGroupMessageInput("");
    await sendUserGroupMessage(value, settings.userName, personas);
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
    if (!showSettingsModal || !isAndroidRuntime) return;
    void refreshForegroundService();
  }, [showSettingsModal, isAndroidRuntime, refreshForegroundService]);

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
    format: BackupExportFormat;
    selection: BackupExportSelection;
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
      const isRaw = params.format === "raw_json" || params.format === "raw_zip";
      let preparedFile:
        | Awaited<ReturnType<typeof exportRawBackupFile>>
        | Awaited<ReturnType<typeof exportBackupFile>>;
      let payload: Awaited<ReturnType<typeof buildBackupPayload>> | null = null;

      if (isRaw) {
        preparedFile = await exportRawBackupFile(
          params.format as Extract<BackupExportFormat, "raw_json" | "raw_zip">,
        );
      } else {
        payload = await buildBackupPayload({
          selection: params.selection,
        });
        preparedFile = await exportBackupFile(
          payload,
          params.format as Extract<BackupExportFormat, "json" | "zip">,
        );
      }
      const downloadUrl = URL.createObjectURL(preparedFile.blob);
      setReadyExportFile({
        fileName: preparedFile.fileName,
        url: downloadUrl,
        blob: preparedFile.blob,
      });
      const meta = payload?.meta;
      setDataTransferMessage(
        [
          `Экспорт готов: ${isRaw ? "raw_idb_snapshot" : payload?.exportScope || "custom"}`,
          `Файл подготовлен: ${preparedFile.fileName}. Нажми "Скачать экспорт".`,
          isRaw
            ? "RAW snapshot: все stores из IndexedDB сохранены без логической нормализации."
            : `personas=${meta?.personas ?? 0}, chats=${meta?.chats ?? 0}, messages=${meta?.messages ?? 0}, states=${meta?.personaStates ?? 0}, memories=${meta?.memories ?? 0}, sessions=${meta?.generatorSessions ?? 0}, imageAssets=${meta?.imageAssets ?? 0}, groupRooms=${meta?.groupRooms ?? 0}, groupMessages=${meta?.groupMessages ?? 0}, groupEvents=${meta?.groupEvents ?? 0}`,
        ].join("\n"),
      );
    } catch (error) {
      useAppStore.setState({ error: (error as Error).message });
    } finally {
      setExportBusy(false);
    }
  };

  const onDownloadExport = useCallback(async () => {
    if (!readyExportFile) return;

    if (isAndroidRuntime) {
      try {
        const saved = await downloadExportFileOnAndroid({
          fileName: readyExportFile.fileName,
          blob: readyExportFile.blob,
        });
        const savedSuffix = saved.savedAs ? `\nСохранено: ${saved.savedAs}` : "";
        setDataTransferMessage((prev) =>
          [
            prev?.trim() || "",
            `Экспорт сохранен на устройстве.${savedSuffix}`,
          ]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
        );
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "android_export_download_failed";
        pushSystemLog({
          level: "warn",
          eventType: "backup.android_download_failed",
          message: "Android native export download failed, fallback to browser link",
          details: {
            fileName: readyExportFile.fileName,
            error: errorMessage,
          },
        });
      }
    }

    if (typeof document === "undefined") return;
    const anchor = document.createElement("a");
    anchor.href = readyExportFile.url;
    anchor.download = readyExportFile.fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, [isAndroidRuntime, readyExportFile]);

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
          `personas=${meta.personas}, chats=${meta.chats}, messages=${meta.messages}, states=${meta.personaStates}, memories=${meta.memories}, sessions=${meta.generatorSessions}, imageAssets=${meta.imageAssets}, groupRooms=${meta.groupRooms}, groupMessages=${meta.groupMessages}, groupEvents=${meta.groupEvents}, settings=${meta.includesSettings ? "yes" : "no"}, raw=${meta.rawSnapshot ? "yes" : "no"}`,
        ].join("\n"),
      );
    } catch (error) {
      console.error("[backup/import] ui handler failed", {
        fileName: file.name,
        mode,
        error,
      });
      useAppStore.setState({
        error: `Импорт "${file.name}" не выполнен (${mode}). ${(error as Error).message}`,
      });
    } finally {
      setImportBusy(false);
    }
  };

  const {
    driveBusy,
    googleDriveConfigured,
    googleDriveConnected,
    googleDriveAccountEmail,
    googleDriveBackups,
    selectedGoogleDriveBackupId,
    setSelectedGoogleDriveBackupId,
    driveBackupName,
    setDriveBackupName,
    onGoogleDriveConnect,
    onGoogleDriveDisconnect,
    onGoogleDriveRefreshBackups,
    onGoogleDriveSyncUpload,
    onGoogleDriveSyncDownload,
  } = useGoogleDriveBackupSync({
    settingsDraft,
    setSettingsDraft,
    saveSettings,
    initialize,
    isSettingsOpen: showSettingsModal,
    setDataTransferMessage,
    onError: (message) => useAppStore.setState({ error: message }),
  });

  const toolCapabilityMatrix = useMemo(
    () =>
      TOOL_CAPABILITY_ROLE_CONFIGS.map((role) => {
        const modelOverride = settingsDraft[role.modelField];
        const target = resolveModelRoutingTarget(
          settingsDraft,
          role.task,
          modelOverride,
        );
        const fingerprint = buildToolCapabilityFingerprint(
          target.provider,
          target.baseUrl,
          target.model,
        );
        const state = toolCapabilityByTask[role.task];
        const isSameRoute = Boolean(
          state && state.fingerprint === fingerprint,
        );

        return {
          task: role.task,
          title: role.title,
          provider: target.provider,
          model: target.model,
          status: isSameRoute ? state?.status ?? "idle" : ("idle" as const),
          checkedAt: isSameRoute ? state?.checkedAt : undefined,
          reason: isSameRoute ? state?.reason : undefined,
          fromCache: isSameRoute ? state?.fromCache : undefined,
        };
      }),
    [settingsDraft, toolCapabilityByTask],
  );

  const checkToolCapability = async (task: ModelRoutingTask) => {
    const role = TOOL_CAPABILITY_ROLE_CONFIGS.find((item) => item.task === task);
    if (!role) return;
    const modelOverride = settingsDraft[role.modelField];
    const target = resolveModelRoutingTarget(settingsDraft, task, modelOverride);
    const fingerprint = buildToolCapabilityFingerprint(
      target.provider,
      target.baseUrl,
      target.model,
    );

    setToolCapabilityByTask((prev) => ({
      ...prev,
      [task]: {
        fingerprint,
        status: "checking",
      },
    }));

    try {
      const result = await probeModelToolCallingCapability({
        provider: target.provider,
        baseUrl: target.baseUrl,
        auth: target.auth,
        model: target.model,
        apiKey: settingsDraft.apiKey,
        forceRefresh: true,
      });
      setToolCapabilityByTask((prev) => ({
        ...prev,
        [task]: {
          fingerprint,
          status: result.status,
          checkedAt: result.checkedAt,
          reason: result.reason,
          fromCache: result.fromCache,
        },
      }));
    } catch (error) {
      setToolCapabilityByTask((prev) => ({
        ...prev,
        [task]: {
          fingerprint,
          status: "unknown",
          checkedAt: new Date().toISOString(),
          reason: (error as Error).message,
          fromCache: false,
        },
      }));
    }
  };

  const checkAllToolCapabilities = async () => {
    setToolCapabilityBatchChecking(true);
    try {
      await Promise.all(
        TOOL_CAPABILITY_ROLE_CONFIGS.map((role) =>
          checkToolCapability(role.task),
        ),
      );
    } finally {
      setToolCapabilityBatchChecking(false);
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
          groupRooms={groupRooms}
          personas={personas}
          activeChatId={activeChatId}
          activeGroupRoomId={activeGroupRoomId}
          activePersonaId={activePersonaId}
          generationPersonaId={generationPersonaId}
          generationSessions={generationSessions}
          activeGenerationSessionId={generationSessionId || null}
          onOpenPersonas={() => setShowPersonaModal(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onCreateChat={() => void createChat()}
          onCreateGroupRoom={() => setShowGroupRoomModal(true)}
          onCreateGenerationSession={() => void createGenerationSession()}
          onDeleteGenerationSession={(sessionId) =>
            void deleteGenerationSession(sessionId)
          }
          onRenameChat={(chatId, title) => void renameChat(chatId, title)}
          onRenameGroupRoom={(roomId, title) =>
            void renameGroupRoom(roomId, title)
          }
          onRenameGenerationSession={(sessionId, title) =>
            void renameGenerationSession(sessionId, title)
          }
          onDeleteGroupRoom={(roomId) => void deleteGroupRoom(roomId)}
          onSelectChat={(chatId) => void selectChat(chatId)}
          onSelectGroupRoom={(roomId) => void selectGroupRoom(roomId)}
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
            activePersona={generationActivePersona}
            generationSessionId={generationSessionId}
            topic={generationTopic}
            onTopicChange={setGenerationTopic}
            promptMode={generationPromptMode}
            onPromptModeChange={setGenerationPromptMode}
            directPromptSeed={generationDirectPromptSeed}
            onDirectPromptSeedChange={setGenerationDirectPromptSeed}
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
            onSingleGenerate={() => void startSingleGeneration()}
            canSingleGenerate={Boolean(
              !generationIsRunning &&
                generationSessionId &&
                generationActivePersona &&
                generationTopic.trim(),
            )}
            onStop={stopGeneration}
          />
        ) : sidebarTab === "groups" ? (
          <GroupChatPane
            activeRoom={activeGroupRoom}
            participants={groupParticipants}
            personaStates={groupPersonaStates}
            messages={groupMessages}
            events={groupEvents}
            personas={personas}
            inputValue={groupMessageInput}
            setInputValue={setGroupMessageInput}
            isLoading={isGroupLoading}
            controlsDisabled={isGroupLoading}
            showSystemImageBlock={settings.showSystemImageBlock}
            showStatusChangeDetails={settings.showStatusChangeDetails}
            onStartRoom={() => void setActiveGroupRoomStatus("active")}
            onPauseRoom={() => void setActiveGroupRoomStatus("paused")}
            onRunIteration={() =>
              void runActiveGroupIteration(personas, settings, settings.userName)
            }
            onDeleteRoom={() => {
              if (!activeGroupRoomId) return;
              void deleteGroupRoom(activeGroupRoomId);
            }}
            onSubmitMessage={onGroupMessageSubmit}
            onRetryMessageImages={(messageId, blockIndexes) =>
              void retryGroupMessageImages({
                messageId,
                blockIndexes,
                personas,
                settings,
              })
            }
            onRegenerateMessageResponse={(messageId) =>
              void regenerateGroupMessageResponse({
                messageId,
                personas,
                settings,
                userName: settings.userName,
              })
            }
            onSetPersonaInfluenceProfile={(roomId, personaId, profile) =>
              void setGroupPersonaInfluenceProfile(roomId, personaId, profile)
            }
            onOpenChatDetails={() => setShowGroupChatDetailsModal(true)}
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
            activeInfluenceProfile={activePersonaState?.influenceProfile ?? null}
            activeCurrentIntent={activePersonaState?.currentIntent ?? null}
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
            onRegeneratePromptAtIndex={(messageId, promptIndex) => {
              void regenerateMessageComfyPromptAtIndex(messageId, promptIndex);
            }}
            onResolveRelationshipProposal={(messageId, decision) => {
              void resolveRelationshipProposal(messageId, decision);
            }}
            onSaveInfluenceProfile={(profile) => {
              void setActiveInfluenceProfile(profile);
            }}
            onResetInfluenceProfile={() => {
              void setActiveInfluenceProfile(null);
            }}
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
          onUpdateRuntimeState={(chatId, patch) => {
            if (chatId !== activeChatId) return;
            void updateActivePersonaState(patch);
          }}
          onAddMemory={(chatId, payload) => {
            if (chatId !== activeChatId) return;
            void addManualMemory(payload);
          }}
          onUpdateMemory={(chatId, memoryId, patch) => {
            if (chatId !== activeChatId) return;
            void updateActiveMemory(memoryId, patch);
          }}
          onDeleteMemory={(chatId, memoryId) => {
            if (chatId !== activeChatId) return;
            void deleteActiveMemory(memoryId);
          }}
          onClose={() => setShowChatDetailsModal(false)}
        />

        <GroupChatDetailsModal
          open={showGroupChatDetailsModal}
          room={activeGroupRoom}
          participants={groupParticipants}
          messages={groupMessages}
          events={groupEvents}
          personas={personas}
          personaStates={groupPersonaStates}
          relationEdges={groupRelationEdges}
          sharedMemories={groupSharedMemories}
          privateMemories={groupPrivateMemories}
          onClose={() => setShowGroupChatDetailsModal(false)}
        />

        <SettingsModal
          open={showSettingsModal}
          runtimeMode={runtimeMode}
          settingsDraft={settingsDraft}
          pwaInstallStatus={pwaInstallStatus}
          windowsArtifactUrl={windowsArtifactUrl}
          androidArtifactUrl={androidArtifactUrl}
          foregroundServiceLoading={foregroundServiceState.loading}
          foregroundServiceEnabled={foregroundServiceState.enabled}
          foregroundServiceRunning={foregroundServiceState.running}
          foregroundServiceHealth={foregroundServiceState.health}
          foregroundServiceQueueDepth={foregroundServiceState.queueDepth}
          foregroundServiceStaleJobs={foregroundServiceState.staleJobs}
          foregroundServiceStaleWorkers={foregroundServiceState.staleWorkers}
          foregroundServiceActiveTopicScopes={foregroundServiceState.activeTopicScopes}
          foregroundServiceActiveGroupScopes={foregroundServiceState.activeGroupScopes}
          foregroundServiceLastError={foregroundServiceState.lastError}
          foregroundServiceError={foregroundServiceState.error}
          availableModelsByProvider={availableModelsByProvider}
          modelsLoadingByProvider={modelsLoadingByProvider}
          toolCapabilityMatrix={toolCapabilityMatrix}
          toolCapabilityBatchChecking={toolCapabilityBatchChecking}
          exportableChats={exportableChatOptions}
          exportBusy={exportBusy}
          importBusy={importBusy}
          driveBusy={driveBusy}
          googleDriveConfigured={googleDriveConfigured}
          googleDriveConnected={googleDriveConnected}
          googleDriveAccountEmail={googleDriveAccountEmail}
          googleDriveBackups={googleDriveBackups}
          selectedGoogleDriveBackupId={selectedGoogleDriveBackupId}
          setSelectedGoogleDriveBackupId={setSelectedGoogleDriveBackupId}
          driveBackupName={driveBackupName}
          setDriveBackupName={setDriveBackupName}
          dataTransferMessage={dataTransferMessage}
          systemLogs={systemLogs}
          exportDownloadUrl={readyExportFile?.url ?? null}
          exportDownloadFileName={readyExportFile?.fileName ?? null}
          onDownloadExport={onDownloadExport}
          onClearSystemLogs={clearSystemLogs}
          setSettingsDraft={setSettingsDraft}
          onInstallPwa={() => void onInstallPwa()}
          onRefreshForegroundService={() => {
            void refreshForegroundService();
          }}
          onToggleForegroundService={(enabled) => {
            void toggleForegroundService(enabled);
          }}
          onRefreshModels={(provider) => {
            const target = resolveProviderModelCatalogTarget(
              settingsDraft,
              provider,
            );
            void loadModels(provider, target.baseUrl, target.auth);
          }}
          onCheckToolCapability={(task) => {
            void checkToolCapability(task);
          }}
          onCheckAllToolCapabilities={() => {
            void checkAllToolCapabilities();
          }}
          onGoogleDriveConnect={onGoogleDriveConnect}
          onGoogleDriveDisconnect={onGoogleDriveDisconnect}
          onGoogleDriveRefreshBackups={onGoogleDriveRefreshBackups}
          onGoogleDriveSyncUpload={onGoogleDriveSyncUpload}
          onGoogleDriveSyncDownload={onGoogleDriveSyncDownload}
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

        <GroupRoomModal
          open={showGroupRoomModal}
          personas={personas}
          onClose={() => setShowGroupRoomModal(false)}
          onCreate={async ({ title, mode, participantPersonaIds }) => {
            await createGroupRoom(personas, {
              title,
              mode,
              participantPersonaIds,
            });
            setShowGroupRoomModal(false);
            setSidebarTab("groups");
          }}
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
