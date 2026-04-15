import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  CloudDownload,
  CloudUpload,
  LogIn,
  LogOut,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  AppSettings,
  AuthMode,
  EndpointAuthConfig,
  LlmProvider,
} from "../types";
import type {
  ModelRoutingTask,
  ToolCallingCapabilityStatus,
} from "../lmstudio";
import type { RuntimeMode } from "../platform/runtimeMode";
import { Dropdown } from "./Dropdown";
import type {
  BackupExportFormat,
  BackupImportMode,
  BackupExportScope,
} from "../features/backup/dataTransfer";
import type { GoogleDriveFileMeta } from "../features/backup/googleDriveSync";
import type {
  SystemLogEntry,
  SystemLogLevel,
} from "../features/system-logs/systemLogStore";
import {
  clearBackgroundRuntimeEvents,
  listBackgroundRuntimeEvents,
  type BackgroundRuntimeEventRecord,
} from "../features/mobile/backgroundRuntime";

type PwaInstallStatus = "installed" | "available" | "unavailable";
type ToolCapabilityMatrixStatus =
  | "idle"
  | "checking"
  | ToolCallingCapabilityStatus;
type ForegroundServiceHealth = "active" | "degraded" | "fallback";

interface SettingsModalProps {
  open: boolean;
  runtimeMode: RuntimeMode;
  settingsDraft: AppSettings;
  pwaInstallStatus: PwaInstallStatus;
  windowsArtifactUrl: string;
  androidArtifactUrl: string;
  foregroundServiceLoading: boolean;
  foregroundServiceEnabled: boolean;
  foregroundServiceRunning: boolean;
  foregroundServiceHealth: ForegroundServiceHealth;
  foregroundServiceQueueDepth: number;
  foregroundServiceStaleJobs: number;
  foregroundServiceStaleWorkers: number;
  foregroundServiceActiveTopicScopes: number;
  foregroundServiceActiveGroupScopes: number;
  foregroundServiceLastError: string | null;
  foregroundServiceError: string | null;
  availableModelsByProvider: Record<LlmProvider, string[]>;
  modelsLoadingByProvider: Record<LlmProvider, boolean>;
  toolCapabilityMatrix: Array<{
    task: ModelRoutingTask;
    title: string;
    provider: LlmProvider;
    model: string;
    status: ToolCapabilityMatrixStatus;
    checkedAt?: string;
    reason?: string;
    fromCache?: boolean;
  }>;
  toolCapabilityBatchChecking: boolean;
  exportableChats: Array<{ id: string; title: string; personaName: string }>;
  exportBusy: boolean;
  importBusy: boolean;
  driveBusy: boolean;
  googleDriveConfigured: boolean;
  googleDriveConnected: boolean;
  googleDriveAccountEmail: string | null;
  googleDriveBackups: GoogleDriveFileMeta[];
  selectedGoogleDriveBackupId: string;
  setSelectedGoogleDriveBackupId: (backupId: string) => void;
  driveBackupName: string;
  setDriveBackupName: (name: string) => void;
  dataTransferMessage: string | null;
  systemLogs: SystemLogEntry[];
  exportDownloadUrl: string | null;
  exportDownloadFileName: string | null;
  onClearSystemLogs: () => void;
  setSettingsDraft: (updater: (prev: AppSettings) => AppSettings) => void;
  onInstallPwa: () => void;
  onRefreshForegroundService: () => void;
  onToggleForegroundService: (enabled: boolean) => void;
  onRefreshModels: (provider: LlmProvider) => void;
  onCheckToolCapability: (task: ModelRoutingTask) => void;
  onCheckAllToolCapabilities: () => void;
  onGoogleDriveConnect: () => Promise<void>;
  onGoogleDriveDisconnect: () => void;
  onGoogleDriveRefreshBackups: () => Promise<void>;
  onGoogleDriveSyncUpload: () => Promise<void>;
  onGoogleDriveSyncDownload: (mode: BackupImportMode) => Promise<void>;
  onExportData: (params: {
    scope: BackupExportScope;
    format: BackupExportFormat;
    chatId?: string;
  }) => Promise<void>;
  onImportData: (file: File, mode: BackupImportMode) => Promise<void>;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}

type SettingsTab = "system" | "models" | "personal" | "chat" | "data" | "logs";
type LogLevelFilter = "all" | SystemLogLevel;
type LogSourceFilter = "all" | "system" | "native_runtime";
type LogDetailTab = "status" | "request" | "response" | "error" | "raw";

interface DevtoolsLogEntry {
  id: string;
  timestamp: string;
  timestampMs: number;
  level: SystemLogLevel;
  eventType: string;
  message: string;
  source: "system" | "native_runtime";
  detailsRaw: unknown;
  runtimeMeta?: {
    taskType: string;
    scopeId: string;
    stage: string;
    jobId: string | null;
  };
}

interface DevtoolsLogPanels {
  status: unknown;
  request: unknown;
  response: unknown;
  error: unknown;
  raw: unknown;
}

const LOG_LEVEL_OPTIONS: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "all", label: "Все уровни" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];
const LOG_SOURCE_OPTIONS: Array<{ value: LogSourceFilter; label: string }> = [
  { value: "all", label: "Все источники" },
  { value: "system", label: "Web/System" },
  { value: "native_runtime", label: "Native Runtime" },
];
const LOG_DETAIL_TAB_OPTIONS: Array<{ value: LogDetailTab; label: string }> = [
  { value: "status", label: "Status" },
  { value: "request", label: "Request" },
  { value: "response", label: "Response" },
  { value: "error", label: "Error" },
  { value: "raw", label: "Raw" },
];

const AUTH_MODE_LABELS: Array<{ value: AuthMode; label: string }> = [
  { value: "none", label: "Без auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "token", label: "Token token" },
  { value: "basic", label: "Basic (user:pass)" },
  { value: "custom", label: "Custom header" },
];

const USER_GENDER_OPTIONS: Array<{ value: AppSettings["userGender"]; label: string }> = [
  { value: "unspecified", label: "Не указан" },
  { value: "male", label: "Мужской" },
  { value: "female", label: "Женский" },
  { value: "nonbinary", label: "Небинарный / другой" },
];
const LLM_PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: "lmstudio", label: "LMStudio" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "huggingface", label: "HuggingFace Router" },
];
const DETAILING_LEVEL_OPTIONS: Array<{
  value: AppSettings["enhanceDetailLevelAll"];
  label: string;
}> = [
  { value: "soft", label: "Soft" },
  { value: "medium", label: "Medium" },
  { value: "strong", label: "Strong" },
];
type DetailStrengthColumnKey =
  keyof AppSettings["enhanceDetailStrengthTable"]["soft"];
const DETAILING_STRENGTH_COLUMNS: Array<{
  key: DetailStrengthColumnKey;
  label: string;
  step: number;
}> = [
  { key: "i2iBase", label: "I2I Base", step: 0.01 },
  { key: "i2iHires", label: "I2I HiRes", step: 0.01 },
  { key: "face", label: "Face", step: 0.01 },
  { key: "eyes", label: "Eyes", step: 0.01 },
  { key: "nose", label: "Nose", step: 0.01 },
  { key: "lips", label: "Lips", step: 0.01 },
  { key: "hands", label: "Hands", step: 0.01 },
  { key: "chest", label: "Chest", step: 0.01 },
  { key: "vagina", label: "Vagina", step: 0.01 },
];
const EXPORT_SCOPE_OPTIONS: Array<{
  value: BackupExportScope;
  label: string;
}> = [
  { value: "all", label: "Все данные" },
  { value: "personas", label: "Только персоны" },
  { value: "all_chats", label: "Все чаты + персоны" },
  { value: "chat", label: "Один чат + персона" },
  { value: "generation_sessions", label: "Сессии генерации + персоны" },
];
const EXPORT_FORMAT_OPTIONS: Array<{ value: BackupExportFormat; label: string }> = [
  { value: "json", label: "JSON (.json)" },
  { value: "zip", label: "ZIP (.zip)" },
  { value: "raw_json", label: "RAW IDB JSON (.json)" },
  { value: "raw_zip", label: "RAW IDB ZIP (.zip)" },
];
const IMPORT_MODE_OPTIONS: Array<{ value: BackupImportMode; label: string }> = [
  { value: "merge", label: "Добавить / объединить" },
  { value: "replace", label: "Заменить текущие данные" },
];

function formatDriveBackupDate(value: string | undefined) {
  if (!value) return "время неизвестно";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDriveBackupSize(value: string | undefined) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "размер неизвестен";
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const TOOL_CAPABILITY_STATUS_LABEL: Record<ToolCapabilityMatrixStatus, string> = {
  idle: "Не проверено",
  checking: "Проверка…",
  supported: "Поддерживается",
  unsupported: "Не поддерживается",
  unknown: "Неизвестно",
};
const FOREGROUND_HEALTH_LABEL: Record<ForegroundServiceHealth, string> = {
  active: "native active",
  degraded: "native degraded",
  fallback: "bridge fallback",
};
const ANDROID_ROLLOUT_STAGE_OPTIONS: Array<{
  value: AppSettings["androidNativeRolloutStage"];
  label: string;
}> = [
  { value: "internal", label: "Internal" },
  { value: "beta", label: "Beta" },
  { value: "prod", label: "Prod" },
];

function formatToolCapabilityCheckedAt(value: string | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSystemLogTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonMaybe(value: string | undefined): unknown {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\"")) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function pickRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const candidate = record[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string" && !candidate.trim()) continue;
    return candidate;
  }
  return undefined;
}

function collectRecordValues(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const candidate = record[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string" && !candidate.trim()) continue;
    result[key] = candidate;
  }
  return result;
}

function formatDetailForView(value: unknown): string {
  if (value === undefined || value === null) return "Нет данных";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "Нет данных";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toSystemLogLevel(value: string): SystemLogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

function buildDevtoolsPanels(entry: DevtoolsLogEntry | null): DevtoolsLogPanels {
  if (!entry) {
    return {
      status: null,
      request: null,
      response: null,
      error: null,
      raw: null,
    };
  }

  const detailsRecord = isRecord(entry.detailsRaw) ? entry.detailsRaw : null;
  const request =
    detailsRecord == null
      ? null
      : pickRecordValue(detailsRecord, [
          "request",
          "requestBody",
          "requestPayload",
          "requestJson",
          "payload",
          "input",
          "toolInput",
          "systemPrompt",
          "userPrompt",
          "prompt",
        ]) ?? null;
  const response =
    detailsRecord == null
      ? null
      : pickRecordValue(detailsRecord, [
          "response",
          "responseBody",
          "responsePayload",
          "output",
          "result",
          "llmDebug",
          "content",
          "responseId",
          "comfyPrompt",
          "comfyPrompts",
          "comfyImageDescription",
          "comfyImageDescriptions",
        ]) ?? null;
  const errorCandidate =
    detailsRecord == null
      ? null
      : pickRecordValue(detailsRecord, [
          "error",
          "errors",
          "reason",
          "lastError",
          "exception",
          "stack",
        ]) ?? null;

  const status = {
    source: entry.source,
    level: entry.level,
    eventType: entry.eventType,
    timestamp: entry.timestamp,
    message: entry.message,
    ...(entry.runtimeMeta ?? {}),
    ...(detailsRecord
      ? collectRecordValues(detailsRecord, [
          "status",
          "state",
          "stage",
          "waitForUser",
          "waitReason",
          "scopeId",
          "taskType",
          "jobId",
          "httpStatus",
          "responseSource",
          "toolModeRequested",
          "toolModeActive",
          "expectedToolName",
          "actualToolName",
          "fallbackReason",
          "parsedField",
          "hasContent",
          "contentLength",
          "reason",
        ])
      : {}),
  };

  const error =
    errorCandidate ??
    (entry.level === "error" || entry.level === "warn"
      ? {
          message: entry.message,
        }
      : null);

  const raw = {
    ...(entry.runtimeMeta
      ? {
          runtime: entry.runtimeMeta,
        }
      : {}),
    details: entry.detailsRaw ?? null,
  };

  return {
    status,
    request,
    response,
    error,
    raw,
  };
}

function AuthSettingsSection({
  title,
  auth,
  onChange,
}: {
  title: string;
  auth: EndpointAuthConfig;
  onChange: (next: EndpointAuthConfig) => void;
}) {
  return (
    <div className="persona-section">
      <h5>{title}</h5>
      <label>
        Режим auth
        <Dropdown
          value={auth.mode}
          options={AUTH_MODE_LABELS}
          onChange={(nextMode) => onChange({ ...auth, mode: nextMode as AuthMode })}
        />
      </label>

      {auth.mode === "basic" ? (
        <>
          <label>
            Username
            <input
              value={auth.username}
              onChange={(e) => onChange({ ...auth, username: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={auth.password}
              onChange={(e) => onChange({ ...auth, password: e.target.value })}
              autoComplete="new-password"
            />
          </label>
        </>
      ) : null}

      {auth.mode === "custom" ? (
        <>
          <label>
            Header name
            <input
              value={auth.headerName}
              onChange={(e) => onChange({ ...auth, headerName: e.target.value })}
              placeholder="Authorization"
            />
          </label>
          <label>
            Header prefix (опционально)
            <input
              value={auth.headerPrefix}
              onChange={(e) => onChange({ ...auth, headerPrefix: e.target.value })}
              placeholder="Bearer"
            />
          </label>
        </>
      ) : null}

      {auth.mode === "bearer" || auth.mode === "token" || auth.mode === "custom" ? (
        <label>
          Token / API key
          <input
            type="password"
            value={auth.token}
            onChange={(e) => onChange({ ...auth, token: e.target.value })}
            autoComplete="new-password"
          />
        </label>
      ) : null}
    </div>
  );
}

export function SettingsModal({
  open,
  runtimeMode,
  settingsDraft,
  pwaInstallStatus,
  windowsArtifactUrl,
  androidArtifactUrl,
  foregroundServiceLoading,
  foregroundServiceEnabled,
  foregroundServiceRunning,
  foregroundServiceHealth,
  foregroundServiceQueueDepth,
  foregroundServiceStaleJobs,
  foregroundServiceStaleWorkers,
  foregroundServiceActiveTopicScopes,
  foregroundServiceActiveGroupScopes,
  foregroundServiceLastError,
  foregroundServiceError,
  availableModelsByProvider,
  modelsLoadingByProvider,
  toolCapabilityMatrix,
  toolCapabilityBatchChecking,
  exportableChats,
  exportBusy,
  importBusy,
  driveBusy,
  googleDriveConfigured,
  googleDriveConnected,
  googleDriveAccountEmail,
  googleDriveBackups,
  selectedGoogleDriveBackupId,
  setSelectedGoogleDriveBackupId,
  driveBackupName,
  setDriveBackupName,
  dataTransferMessage,
  systemLogs,
  exportDownloadUrl,
  exportDownloadFileName,
  onClearSystemLogs,
  setSettingsDraft,
  onInstallPwa,
  onRefreshForegroundService,
  onToggleForegroundService,
  onRefreshModels,
  onCheckToolCapability,
  onCheckAllToolCapabilities,
  onGoogleDriveConnect,
  onGoogleDriveDisconnect,
  onGoogleDriveRefreshBackups,
  onGoogleDriveSyncUpload,
  onGoogleDriveSyncDownload,
  onExportData,
  onImportData,
  onClose,
  onSubmit,
}: SettingsModalProps) {
  const detectCompactLogLayout = () =>
    typeof window !== "undefined" ? window.innerWidth <= 960 : false;
  const [activeTab, setActiveTab] = useState<SettingsTab>("system");
  const [exportScope, setExportScope] = useState<BackupExportScope>("all");
  const [exportFormat, setExportFormat] = useState<BackupExportFormat>("json");
  const [exportChatId, setExportChatId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<BackupImportMode>("merge");
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevelFilter>("all");
  const [logTypeFilter, setLogTypeFilter] = useState<string>("all");
  const [logSourceFilter, setLogSourceFilter] = useState<LogSourceFilter>("all");
  const [logSearchQuery, setLogSearchQuery] = useState("");
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [activeLogDetailTab, setActiveLogDetailTab] = useState<LogDetailTab>("status");
  const [isCompactLogLayout, setIsCompactLogLayout] = useState(detectCompactLogLayout);
  const [logMobilePane, setLogMobilePane] = useState<"list" | "detail">("list");
  const [nativeRuntimeEvents, setNativeRuntimeEvents] = useState<BackgroundRuntimeEventRecord[]>([]);
  const [nativeRuntimeEventsLoading, setNativeRuntimeEventsLoading] = useState(false);
  const [nativeRuntimeEventsClearing, setNativeRuntimeEventsClearing] = useState(false);
  const [nativeRuntimeEventsError, setNativeRuntimeEventsError] = useState<string | null>(null);
  const [nativeRuntimeEventsFetchedAtMs, setNativeRuntimeEventsFetchedAtMs] = useState<number | null>(
    null,
  );
  const googleDriveBackupOptions = useMemo(() => {
    if (googleDriveBackups.length === 0) {
      return [{ value: "", label: "Бэкапы в Drive не найдены" }];
    }
    return googleDriveBackups.map((backup, index) => {
      const versionPart = backup.versionTag ? `v${backup.versionTag}` : `#${index + 1}`;
      const labelPart = backup.backupLabel || "Без названия";
      return {
        value: backup.id,
        label: `${labelPart} • ${versionPart}`,
        description: `${formatDriveBackupDate(
          backup.modifiedTime || backup.exportedAt,
        )} • ${formatDriveBackupSize(backup.size)} • ${backup.name}`,
      };
    });
  }, [googleDriveBackups]);
  const selectedGoogleDriveBackup = useMemo(
    () =>
      googleDriveBackups.find((backup) => backup.id === selectedGoogleDriveBackupId) ??
      null,
    [googleDriveBackups, selectedGoogleDriveBackupId],
  );
  const canLoadNativeRuntimeEvents = runtimeMode === "android";
  const refreshNativeRuntimeEvents = useCallback(async () => {
    if (!canLoadNativeRuntimeEvents) {
      setNativeRuntimeEvents([]);
      setNativeRuntimeEventsError(null);
      setNativeRuntimeEventsFetchedAtMs(null);
      return;
    }
    setNativeRuntimeEventsLoading(true);
    try {
      const [groupRows, topicRows] = await Promise.all([
        listBackgroundRuntimeEvents({ taskType: "group_iteration", limit: 400 }),
        listBackgroundRuntimeEvents({ taskType: "topic_generation", limit: 400 }),
      ]);
      const mergedRows = [...groupRows, ...topicRows].sort((left, right) => {
        if (left.createdAtMs !== right.createdAtMs) {
          return right.createdAtMs - left.createdAtMs;
        }
        return right.id - left.id;
      });
      setNativeRuntimeEvents(mergedRows);
      setNativeRuntimeEventsError(null);
      setNativeRuntimeEventsFetchedAtMs(Date.now());
    } catch (error) {
      setNativeRuntimeEventsError(
        error instanceof Error ? error.message : "native_runtime_events_fetch_failed",
      );
    } finally {
      setNativeRuntimeEventsLoading(false);
    }
  }, [canLoadNativeRuntimeEvents]);
  const clearNativeRuntimeLogs = useCallback(async () => {
    if (!canLoadNativeRuntimeEvents) return;
    setNativeRuntimeEventsClearing(true);
    try {
      await clearBackgroundRuntimeEvents();
      setNativeRuntimeEvents([]);
      setNativeRuntimeEventsError(null);
      setNativeRuntimeEventsFetchedAtMs(Date.now());
      setSelectedLogId((previous) =>
        typeof previous === "string" && previous.startsWith("native:") ? null : previous,
      );
    } catch (error) {
      setNativeRuntimeEventsError(
        error instanceof Error ? error.message : "native_runtime_events_clear_failed",
      );
    } finally {
      setNativeRuntimeEventsClearing(false);
    }
  }, [canLoadNativeRuntimeEvents]);
  const allLogEntries = useMemo<DevtoolsLogEntry[]>(() => {
    const systemEntries: DevtoolsLogEntry[] = systemLogs.map((entry, index) => {
      const timestampMs = Number.isFinite(new Date(entry.timestamp).getTime())
        ? new Date(entry.timestamp).getTime()
        : Date.now() - index;
      return {
        id: `system:${entry.id}`,
        timestamp: entry.timestamp,
        timestampMs,
        level: entry.level,
        eventType: entry.eventType,
        message: entry.message,
        source: "system",
        detailsRaw: parseJsonMaybe(entry.details),
      };
    });
    const nativeEntries: DevtoolsLogEntry[] = nativeRuntimeEvents.map((entry, index) => {
      const timestampMs = Number.isFinite(entry.createdAtMs) ? entry.createdAtMs : Date.now() - index;
      const timestamp = new Date(timestampMs).toISOString();
      return {
        id: `native:${entry.id}`,
        timestamp,
        timestampMs,
        level: toSystemLogLevel(entry.level),
        eventType: `${entry.taskType}.${entry.stage}`,
        message: entry.message,
        source: "native_runtime",
        detailsRaw:
          typeof entry.details === "string"
            ? parseJsonMaybe(entry.details)
            : entry.details,
        runtimeMeta: {
          taskType: entry.taskType,
          scopeId: entry.scopeId,
          stage: entry.stage,
          jobId: entry.jobId,
        },
      };
    });
    return [...systemEntries, ...nativeEntries].sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
      return b.id.localeCompare(a.id);
    });
  }, [nativeRuntimeEvents, systemLogs]);
  const logTypeOptions = useMemo(() => {
    const typeSet = new Set<string>();
    for (const entry of allLogEntries) {
      if (entry.eventType.trim()) {
        typeSet.add(entry.eventType.trim());
      }
    }
    const sorted = Array.from(typeSet).sort((a, b) => a.localeCompare(b));
    return [
      { value: "all", label: "Все типы" },
      ...sorted.map((eventType) => ({ value: eventType, label: eventType })),
    ];
  }, [allLogEntries]);
  const filteredLogEntries = useMemo(() => {
    const normalizedSearch = logSearchQuery.trim().toLowerCase();
    return allLogEntries
      .filter((entry) => (logLevelFilter === "all" ? true : entry.level === logLevelFilter))
      .filter((entry) => (logTypeFilter === "all" ? true : entry.eventType === logTypeFilter))
      .filter((entry) => (logSourceFilter === "all" ? true : entry.source === logSourceFilter))
      .filter((entry) => {
        if (!normalizedSearch) return true;
        const payload =
          `${entry.eventType} ${entry.message} ${formatDetailForView(entry.detailsRaw)}`.toLowerCase();
        return payload.includes(normalizedSearch);
      });
  }, [allLogEntries, logLevelFilter, logSearchQuery, logSourceFilter, logTypeFilter]);
  const selectedLogEntry = useMemo(
    () => filteredLogEntries.find((entry) => entry.id === selectedLogId) ?? null,
    [filteredLogEntries, selectedLogId],
  );
  const selectedLogPanels = useMemo(() => buildDevtoolsPanels(selectedLogEntry), [selectedLogEntry]);
  const nativeRuntimeHealth: ForegroundServiceHealth =
    runtimeMode !== "android" || !settingsDraft.androidNativeGroupIterationV1
      ? "fallback"
      : foregroundServiceHealth;
  const applyAndroidRolloutPreset = (
    stage: AppSettings["androidNativeRolloutStage"],
  ) => {
    setSettingsDraft((prev) => {
      if (stage === "internal") {
        return {
          ...prev,
          androidNativeRolloutStage: stage,
          androidNativeGroupIterationV1: true,
          androidNativeGroupImagesV1: false,
          androidNativeGroupStructuredStorageV1: true,
          androidNativeGroupStructuredStorageDualWrite: true,
        };
      }
      if (stage === "beta") {
        return {
          ...prev,
          androidNativeRolloutStage: stage,
          androidNativeGroupIterationV1: true,
          androidNativeGroupImagesV1: true,
          androidNativeGroupStructuredStorageV1: true,
          androidNativeGroupStructuredStorageDualWrite: true,
        };
      }
      return {
        ...prev,
        androidNativeRolloutStage: stage,
        androidNativeGroupIterationV1: true,
        androidNativeGroupImagesV1: true,
        androidNativeGroupStructuredStorageV1: true,
        androidNativeGroupStructuredStorageDualWrite: false,
      };
    });
  };
  const rollbackAndroidNativeToFallback = () => {
    setSettingsDraft((prev) => ({
      ...prev,
      androidNativeRolloutStage: "internal",
      androidNativeGroupIterationV1: false,
      androidNativeGroupImagesV1: false,
      androidNativeGroupStructuredStorageV1: true,
      androidNativeGroupStructuredStorageDualWrite: true,
    }));
  };
  const updateDetailStrengthValue = (
    level: AppSettings["enhanceDetailLevelAll"],
    key: DetailStrengthColumnKey,
    rawValue: string,
  ) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0.01, Math.min(1, parsed));
    setSettingsDraft((prev) => ({
      ...prev,
      enhanceDetailStrengthTable: {
        ...prev.enhanceDetailStrengthTable,
        [level]: {
          ...prev.enhanceDetailStrengthTable[level],
          [key]: clamped,
        },
      },
    }));
  };

  useEffect(() => {
    const onResize = () => {
      setIsCompactLogLayout(detectCompactLogLayout());
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    if (!isCompactLogLayout) {
      setLogMobilePane("detail");
      return;
    }
    setLogMobilePane("list");
  }, [isCompactLogLayout]);
  useEffect(() => {
    if (open) {
      setActiveTab("system");
      setExportScope("all");
      setExportFormat("json");
      setExportChatId(exportableChats[0]?.id ?? "");
      setImportFile(null);
      setImportMode("merge");
      setLogLevelFilter("all");
      setLogTypeFilter("all");
      setLogSourceFilter("all");
      setLogSearchQuery("");
      setSelectedLogId(null);
      setActiveLogDetailTab("status");
      setNativeRuntimeEventsError(null);
      setLogMobilePane(detectCompactLogLayout() ? "list" : "detail");
    }
  }, [open, exportableChats]);
  useEffect(() => {
    if (!open || activeTab !== "logs" || !canLoadNativeRuntimeEvents) return;
    void refreshNativeRuntimeEvents();
    const timerId = window.setInterval(() => {
      void refreshNativeRuntimeEvents();
    }, 6_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [activeTab, canLoadNativeRuntimeEvents, open, refreshNativeRuntimeEvents]);
  useEffect(() => {
    if (filteredLogEntries.length === 0) {
      if (selectedLogId !== null) {
        setSelectedLogId(null);
      }
      return;
    }
    if (selectedLogId && filteredLogEntries.some((entry) => entry.id === selectedLogId)) {
      return;
    }
    setSelectedLogId(filteredLogEntries[0].id);
  }, [filteredLogEntries, selectedLogId]);
  useEffect(() => {
    if (!isCompactLogLayout) return;
    if (activeTab !== "logs") return;
    if (selectedLogEntry == null) {
      setLogMobilePane("list");
    }
  }, [activeTab, isCompactLogLayout, selectedLogEntry]);

  const getProviderModelOptions = (
    provider: LlmProvider,
    currentModel: string,
  ) => {
    const providerModels = availableModelsByProvider[provider] ?? [];
    if (providerModels.length > 0) {
      return providerModels.map((modelName) => ({
        value: modelName,
        label: modelName,
      }));
    }
    return [
      {
        value: currentModel,
        label: currentModel || "Модель не найдена",
      },
    ];
  };

  const renderRoleMatrixRow = (params: {
    title: string;
    providerField:
      | "oneToOneProvider"
      | "groupOrchestratorProvider"
      | "groupPersonaProvider"
      | "imagePromptProvider"
      | "personaGenerationProvider";
    modelField:
      | "model"
      | "groupOrchestratorModel"
      | "groupPersonaModel"
      | "imagePromptModel"
      | "personaGenerationModel";
  }) => {
    const provider = settingsDraft[params.providerField];
    const model = settingsDraft[params.modelField];
    const loading = modelsLoadingByProvider[provider] ?? false;

    return (
      <div className="persona-section" key={params.title}>
        <h5>{params.title}</h5>
        <label>
          Провайдер
          <Dropdown
            value={provider}
            options={LLM_PROVIDER_OPTIONS}
            onChange={(nextProvider) =>
              setSettingsDraft((prev) => ({
                ...prev,
                [params.providerField]: nextProvider as LlmProvider,
              }))
            }
          />
        </label>
        <label>
          Модель
          <div className="inline-row">
            <Dropdown
              value={model}
              options={getProviderModelOptions(provider, model)}
              onChange={(nextModel) =>
                setSettingsDraft((prev) => ({
                  ...prev,
                  [params.modelField]: nextModel,
                }))
              }
            />
            <button
              type="button"
              onClick={() => onRefreshModels(provider)}
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} /> Обновить
            </button>
          </div>
        </label>
      </div>
    );
  };

  const selectedLogDetailValue = (() => {
    if (activeLogDetailTab === "request") return selectedLogPanels.request;
    if (activeLogDetailTab === "response") return selectedLogPanels.response;
    if (activeLogDetailTab === "error") return selectedLogPanels.error;
    if (activeLogDetailTab === "raw") return selectedLogPanels.raw;
    return selectedLogPanels.status;
  })();
  const nativeRuntimeStatusLabel = !canLoadNativeRuntimeEvents
    ? "Native Runtime недоступен в этом режиме"
    : nativeRuntimeEventsLoading
      ? "Обновление Native Runtime…"
      : nativeRuntimeEventsFetchedAtMs
        ? `Native Runtime обновлён: ${new Date(nativeRuntimeEventsFetchedAtMs).toLocaleString(
            "ru-RU",
          )}`
        : "Native Runtime ещё не загружен";

  if (!open) return null;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <h3>Настройки</h3>
          <button type="button" onClick={onClose}>
            <X size={14} /> Закрыть
          </button>
        </div>
        <div className="modal-tabs">
          <button
            type="button"
            className={activeTab === "system" ? "active" : ""}
            onClick={() => setActiveTab("system")}
          >
            Система
          </button>
          <button
            type="button"
            className={activeTab === "models" ? "active" : ""}
            onClick={() => setActiveTab("models")}
          >
            Модели
          </button>
          <button
            type="button"
            className={activeTab === "personal" ? "active" : ""}
            onClick={() => setActiveTab("personal")}
          >
            Личное
          </button>
          <button
            type="button"
            className={activeTab === "chat" ? "active" : ""}
            onClick={() => setActiveTab("chat")}
          >
            Чат
          </button>
          <button
            type="button"
            className={activeTab === "data" ? "active" : ""}
            onClick={() => setActiveTab("data")}
          >
            Данные
          </button>
          <button
            type="button"
            className={activeTab === "logs" ? "active" : ""}
            onClick={() => setActiveTab("logs")}
          >
            Логи
          </button>
        </div>
        <form className="form" onSubmit={onSubmit}>
          {activeTab === "system" ? (
            <>
              <div className="persona-section">
                <h5>Провайдеры LLM</h5>
                <label>
                  LMStudio Base URL
                  <input
                    value={settingsDraft.lmBaseUrl}
                    onChange={(e) =>
                      setSettingsDraft((v) => ({ ...v, lmBaseUrl: e.target.value }))
                    }
                  />
                </label>
                <label>
                  OpenRouter Base URL
                  <input
                    value={settingsDraft.openRouterBaseUrl}
                    onChange={(e) =>
                      setSettingsDraft((v) => ({
                        ...v,
                        openRouterBaseUrl: e.target.value,
                      }))
                    }
                    placeholder="https://openrouter.ai/api/v1"
                  />
                </label>
                <label>
                  HuggingFace Router Base URL
                  <input
                    value={settingsDraft.huggingFaceBaseUrl}
                    onChange={(e) =>
                      setSettingsDraft((v) => ({
                        ...v,
                        huggingFaceBaseUrl: e.target.value,
                      }))
                    }
                    placeholder="https://router.huggingface.co/v1"
                  />
                </label>
              </div>
              <label>
                ComfyUI URL
                <input
                  value={settingsDraft.comfyBaseUrl}
                  onChange={(e) => setSettingsDraft((v) => ({ ...v, comfyBaseUrl: e.target.value }))}
                  placeholder="http://127.0.0.1:8188"
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settingsDraft.saveComfyOutputs}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, saveComfyOutputs: e.target.checked }))
                  }
                />
                Сохранять изображения в output папку ComfyUI (Image Saver)
              </label>
              <AuthSettingsSection
                title="Авторизация LM endpoint"
                auth={settingsDraft.lmAuth}
                onChange={(next) => setSettingsDraft((v) => ({ ...v, lmAuth: next }))}
              />
              <AuthSettingsSection
                title="Авторизация OpenRouter endpoint"
                auth={settingsDraft.openRouterAuth}
                onChange={(next) =>
                  setSettingsDraft((v) => ({ ...v, openRouterAuth: next }))
                }
              />
              <AuthSettingsSection
                title="Авторизация HuggingFace endpoint"
                auth={settingsDraft.huggingFaceAuth}
                onChange={(next) =>
                  setSettingsDraft((v) => ({ ...v, huggingFaceAuth: next }))
                }
              />
              <AuthSettingsSection
                title="Авторизация Comfy endpoint"
                auth={settingsDraft.comfyAuth}
                onChange={(next) => setSettingsDraft((v) => ({ ...v, comfyAuth: next }))}
              />
              <label>
                Температура
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settingsDraft.temperature}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, temperature: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Макс. токенов
                <input
                  type="number"
                  min={32}
                  max={4096}
                  step={16}
                  value={settingsDraft.maxTokens}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, maxTokens: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Legacy API key (fallback, опционально)
                <input
                  type="password"
                  value={settingsDraft.apiKey}
                  onChange={(e) => setSettingsDraft((v) => ({ ...v, apiKey: e.target.value }))}
                />
              </label>
              <div className="persona-section">
                <h5>PWA приложение</h5>
                <small style={{ color: "var(--text-secondary)", display: "block", marginBottom: 8 }}>
                  Режим установки позволяет держать приложение отдельным окном и снижает риск паузы генерации при сворачивании.
                </small>
                <div className="inline-row">
                  <span style={{ color: "var(--text-secondary)" }}>
                    Статус:{" "}
                    {pwaInstallStatus === "installed"
                      ? "установлено"
                      : pwaInstallStatus === "available"
                      ? "доступна установка"
                      : "установка недоступна в этом контексте"}
                  </span>
                  <button
                    type="button"
                    onClick={onInstallPwa}
                    disabled={pwaInstallStatus !== "available"}
                  >
                    Установить PWA
                  </button>
                </div>
                <small style={{ color: "var(--text-secondary)", display: "block", marginTop: 8 }}>
                  Готовые сборки:
                </small>
                <div className="settings-artifact-links">
                  <a
                    className="button-link"
                    href={windowsArtifactUrl}
                    download="tg-gf-windows.exe"
                  >
                    Скачать Windows
                  </a>
                  <a
                    className="button-link"
                    href={androidArtifactUrl}
                    download="tg-gf-android-debug.apk"
                  >
                    Скачать Android
                  </a>
                </div>
              </div>
              <div className="persona-section">
                <h5>Android фоновый режим</h5>
                {runtimeMode !== "android" ? (
                  <small style={{ color: "var(--text-secondary)" }}>
                    Этот блок доступен только внутри Android-приложения.
                  </small>
                ) : (
                  <>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={foregroundServiceEnabled}
                        disabled={foregroundServiceLoading}
                        onChange={(event) =>
                          onToggleForegroundService(event.target.checked)
                        }
                      />
                      Держать приложение активным в фоне (постоянная нотификация)
                    </label>
                    <div className="inline-row">
                      <button
                        type="button"
                        onClick={onRefreshForegroundService}
                        disabled={foregroundServiceLoading}
                      >
                        <RefreshCw
                          size={14}
                          className={foregroundServiceLoading ? "spin" : ""}
                        />
                        Обновить статус
                      </button>
                      <small style={{ color: "var(--text-secondary)" }}>
                        Сервис: {foregroundServiceRunning ? "запущен" : "остановлен"}
                      </small>
                    </div>
                    <div className="settings-health-overview">
                      <div className="settings-health-row">
                        <span>Состояние runtime</span>
                        <span
                          className={`settings-health-badge settings-health-${nativeRuntimeHealth}`}
                        >
                          {FOREGROUND_HEALTH_LABEL[nativeRuntimeHealth]}
                        </span>
                      </div>
                      <div className="settings-health-grid">
                        <div>
                          <span>Queue depth</span>
                          <strong>{foregroundServiceQueueDepth}</strong>
                        </div>
                        <div>
                          <span>Stale jobs</span>
                          <strong>{foregroundServiceStaleJobs}</strong>
                        </div>
                        <div>
                          <span>Stale workers</span>
                          <strong>{foregroundServiceStaleWorkers}</strong>
                        </div>
                        <div>
                          <span>Active group rooms</span>
                          <strong>{foregroundServiceActiveGroupScopes}</strong>
                        </div>
                        <div>
                          <span>Active topic rooms</span>
                          <strong>{foregroundServiceActiveTopicScopes}</strong>
                        </div>
                      </div>
                    </div>
                    {!settingsDraft.androidNativeGroupIterationV1 ? (
                      <small style={{ color: "var(--text-secondary)" }}>
                        Native group iteration выключен, используется bridge fallback.
                      </small>
                    ) : null}
                    {foregroundServiceError ? (
                      <small style={{ color: "var(--danger)" }}>
                        {foregroundServiceError}
                      </small>
                    ) : null}
                    {!foregroundServiceError && foregroundServiceLastError ? (
                      <small style={{ color: "#fbbf24" }}>
                        Последняя ошибка worker: {foregroundServiceLastError}
                      </small>
                    ) : null}
                    <div className="android-rollout-controls">
                      <strong>Staged rollout controls</strong>
                      <label>
                        Текущий этап rollout
                        <Dropdown
                          value={settingsDraft.androidNativeRolloutStage}
                          options={ANDROID_ROLLOUT_STAGE_OPTIONS}
                          onChange={(nextStage) =>
                            applyAndroidRolloutPreset(
                              nextStage as AppSettings["androidNativeRolloutStage"],
                            )
                          }
                        />
                      </label>
                      <div className="inline-row">
                        <button
                          type="button"
                          onClick={() =>
                            applyAndroidRolloutPreset(
                              settingsDraft.androidNativeRolloutStage,
                            )
                          }
                        >
                          Применить preset этапа
                        </button>
                        <button
                          type="button"
                          className="danger-ghost-button"
                          onClick={rollbackAndroidNativeToFallback}
                        >
                          Rollback в fallback
                        </button>
                      </div>
                      <small style={{ color: "var(--text-secondary)" }}>
                        Internal: только native iteration. Beta: +native images. Prod: отключает
                        dual-write после стабильного окна.
                      </small>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={settingsDraft.androidNativeGroupIterationV1}
                          onChange={(event) =>
                            setSettingsDraft((prev) => ({
                              ...prev,
                              androidNativeGroupIterationV1: event.target.checked,
                            }))
                          }
                        />
                        Android: native group iteration v1
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={settingsDraft.androidNativeGroupImagesV1}
                          onChange={(event) =>
                            setSettingsDraft((prev) => ({
                              ...prev,
                              androidNativeGroupImagesV1: event.target.checked,
                            }))
                          }
                        />
                        Android: native group images v1
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={settingsDraft.androidNativeGroupStructuredStorageV1}
                          onChange={(event) =>
                            setSettingsDraft((prev) => ({
                              ...prev,
                              androidNativeGroupStructuredStorageV1: event.target.checked,
                            }))
                          }
                        />
                        Android: structured group storage v1 (SQLite)
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={settingsDraft.androidNativeGroupStructuredStorageDualWrite}
                          onChange={(event) =>
                            setSettingsDraft((prev) => ({
                              ...prev,
                              androidNativeGroupStructuredStorageDualWrite: event.target.checked,
                            }))
                          }
                        />
                        Android: structured storage dual-write compatibility
                      </label>
                    </div>
                    <div className="android-battery-hints">
                      <strong>Подсказки по отключению ограничений батареи:</strong>
                      <ol>
                        <li>
                          Откройте системные настройки: Приложения → tg-gf →
                          Батарея.
                        </li>
                        <li>
                          Включите режим без ограничений:
                          <span> Unrestricted / No restrictions / Не ограничивать.</span>
                        </li>
                        <li>
                          Добавьте tg-gf в исключения энергосбережения:
                          <span> Battery optimization → Don&apos;t optimize.</span>
                        </li>
                        <li>
                          Для MIUI/HyperOS, ColorOS, EMUI, OneUI:
                          <span> включите Autostart и добавьте в Never sleeping apps.</span>
                        </li>
                      </ol>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : null}

          {activeTab === "models" ? (
            <>
              <div className="persona-section">
                <h5>Матрица моделей</h5>
                <small
                  style={{
                    color: "var(--text-secondary)",
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Для каждой роли можно назначить свой провайдер и модель.
                </small>
              </div>
              {renderRoleMatrixRow({
                title: "1:1 чат",
                providerField: "oneToOneProvider",
                modelField: "model",
              })}
              {renderRoleMatrixRow({
                title: "Группы: оркестратор",
                providerField: "groupOrchestratorProvider",
                modelField: "groupOrchestratorModel",
              })}
              {renderRoleMatrixRow({
                title: "Группы: персона",
                providerField: "groupPersonaProvider",
                modelField: "groupPersonaModel",
              })}
              {renderRoleMatrixRow({
                title: "Генератор prompt изображений",
                providerField: "imagePromptProvider",
                modelField: "imagePromptModel",
              })}
              {renderRoleMatrixRow({
                title: "Генератор карточек персон",
                providerField: "personaGenerationProvider",
                modelField: "personaGenerationModel",
              })}
              <div className="persona-section">
                <h5>Tool Calling Capability Matrix</h5>
                <small
                  style={{
                    color: "var(--text-secondary)",
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Проверка выполняется для выбранной пары provider+model по каждой роли.
                </small>
                <div className="inline-row" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    onClick={onCheckAllToolCapabilities}
                    disabled={toolCapabilityBatchChecking}
                  >
                    <RefreshCw
                      size={14}
                      className={toolCapabilityBatchChecking ? "spin" : ""}
                    />{" "}
                    Проверить все
                  </button>
                </div>
                <div className="settings-table-scroll">
                  <table className="settings-table toolcap-table">
                    <thead>
                      <tr>
                        <th>Роль</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Статус</th>
                        <th>Проверено</th>
                        <th>Детали</th>
                        <th>Действие</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolCapabilityMatrix.map((row) => {
                        const isChecking = row.status === "checking";
                        return (
                          <tr key={row.task}>
                            <th>{row.title}</th>
                            <td>{row.provider}</td>
                            <td title={row.model}>{row.model || "—"}</td>
                            <td>
                              <span
                                className={`toolcap-status toolcap-status-${row.status}`}
                              >
                                {TOOL_CAPABILITY_STATUS_LABEL[row.status]}
                              </span>
                              {row.fromCache ? (
                                <div className="toolcap-cache-note">cache</div>
                              ) : null}
                            </td>
                            <td>{formatToolCapabilityCheckedAt(row.checkedAt)}</td>
                            <td
                              title={row.reason}
                              className="toolcap-reason-cell"
                            >
                              {row.reason || "—"}
                            </td>
                            <td>
                              <button
                                type="button"
                                onClick={() => onCheckToolCapability(row.task)}
                                disabled={isChecking || toolCapabilityBatchChecking}
                              >
                                <RefreshCw
                                  size={14}
                                  className={isChecking ? "spin" : ""}
                                />{" "}
                                Проверить
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}

          {activeTab === "personal" ? (
            <>
              <label>
                Имя пользователя
                <input
                  value={settingsDraft.userName}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, userName: e.target.value }))
                  }
                  placeholder="Как к вам обращаться"
                />
              </label>
              <label>
                Пол пользователя
                <Dropdown
                  value={settingsDraft.userGender}
                  options={USER_GENDER_OPTIONS}
                  onChange={(nextGender) =>
                    setSettingsDraft((v) => ({ ...v, userGender: nextGender as AppSettings["userGender"] }))
                  }
                />
              </label>
            </>
          ) : null}

          {activeTab === "chat" ? (
            <>
              <label>
                Сила detailing для "Все части"
                <Dropdown
                  value={settingsDraft.enhanceDetailLevelAll}
                  options={DETAILING_LEVEL_OPTIONS}
                  onChange={(nextLevel) =>
                    setSettingsDraft((v) => ({
                      ...v,
                      enhanceDetailLevelAll:
                        nextLevel as AppSettings["enhanceDetailLevelAll"],
                    }))
                  }
                />
              </label>
              <label>
                Сила detailing для "Конкретной части"
                <Dropdown
                  value={settingsDraft.enhanceDetailLevelPart}
                  options={DETAILING_LEVEL_OPTIONS}
                  onChange={(nextLevel) =>
                    setSettingsDraft((v) => ({
                      ...v,
                      enhanceDetailLevelPart:
                        nextLevel as AppSettings["enhanceDetailLevelPart"],
                    }))
                  }
                />
                <small style={{ color: "var(--text-secondary)", display: "block", marginTop: 6 }}>
                  Используется при улучшении глаз/губ/рук/груди/вагины и других отдельных таргетов.
                </small>
              </label>
              <div className="persona-section">
                <h5>Таблица denoise для soft / medium / strong</h5>
                <small style={{ color: "var(--text-secondary)", display: "block", marginBottom: 10 }}>
                  Эти значения напрямую идут в flow detailing: img2img denoise и denoise по частям.
                </small>
                <div className="settings-table-scroll">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th>Уровень</th>
                        {DETAILING_STRENGTH_COLUMNS.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {DETAILING_LEVEL_OPTIONS.map((levelOption) => {
                        const level = levelOption.value;
                        const levelValues =
                          settingsDraft.enhanceDetailStrengthTable[level];
                        return (
                          <tr key={level}>
                            <th scope="row">{levelOption.label}</th>
                            {DETAILING_STRENGTH_COLUMNS.map((column) => (
                              <td key={`${level}:${column.key}`}>
                                <input
                                  className="settings-table-input"
                                  type="number"
                                  min={0.01}
                                  max={1}
                                  step={column.step}
                                  value={levelValues[column.key]}
                                  onChange={(event) =>
                                    updateDetailStrengthValue(
                                      level,
                                      column.key,
                                      event.target.value,
                                    )
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <label>
                Сила style reference в чате
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settingsDraft.chatStyleStrength}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({
                      ...v,
                      chatStyleStrength: Number(e.target.value),
                    }))
                  }
                />
                <small style={{ color: "var(--text-secondary)", display: "block", marginTop: 6 }}>
                  Насколько строго Comfy держит внешность от референса (avatar/fullbody). Ниже = больше вариативности, выше = больше консистентности.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settingsDraft.showSystemImageBlock}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, showSystemImageBlock: e.target.checked }))
                  }
                />
                Отображать системный блок изображения (description/prompt)
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settingsDraft.showStatusChangeDetails}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, showStatusChangeDetails: e.target.checked }))
                  }
                />
                Отображать детали изменения статуса
              </label>
            </>
          ) : null}

          {activeTab === "data" ? (
            <>
              <div className="persona-section">
                <h5>Google Drive (ручная синхронизация)</h5>
                <small style={{ color: "var(--text-secondary)" }}>
                  Авторизация происходит через всплывающее окно Google в браузере.
                  Автоматической фоновой синхронизации нет, только по кнопке.
                </small>
                <div className="inline-row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void onGoogleDriveConnect()}
                    disabled={
                      driveBusy || exportBusy || importBusy || !googleDriveConfigured
                    }
                  >
                    <LogIn size={14} />
                    {driveBusy
                      ? "Подключение..."
                      : googleDriveConnected
                        ? "Переавторизовать Drive"
                        : "Подключить Drive"}
                  </button>
                  <button
                    type="button"
                    onClick={onGoogleDriveDisconnect}
                    disabled={
                      driveBusy || exportBusy || importBusy || !googleDriveConnected
                    }
                  >
                    <LogOut size={14} />
                    Отключить
                  </button>
                </div>
                <label>
                  Название бэкапа (опционально)
                  <input
                    value={driveBackupName}
                    onChange={(event) => setDriveBackupName(event.target.value)}
                    placeholder="Например: перед релизом 1.4"
                    disabled={driveBusy || exportBusy || importBusy || !googleDriveConfigured}
                  />
                </label>
                <div className="inline-row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void onGoogleDriveSyncUpload()}
                    disabled={
                      driveBusy ||
                      exportBusy ||
                      importBusy ||
                      !googleDriveConfigured
                    }
                  >
                    <CloudUpload size={14} />
                    {driveBusy ? "Синк..." : "Синхронизировать в Drive"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onGoogleDriveRefreshBackups()}
                    disabled={driveBusy || exportBusy || importBusy || !googleDriveConfigured}
                  >
                    <RefreshCw size={14} className={driveBusy ? "spin" : ""} />
                    Обновить версии
                  </button>
                </div>
                <label>
                  Версия/название для восстановления
                  <Dropdown
                    value={selectedGoogleDriveBackupId}
                    options={googleDriveBackupOptions}
                    onChange={setSelectedGoogleDriveBackupId}
                    disabled={
                      driveBusy ||
                      exportBusy ||
                      importBusy ||
                      !googleDriveConfigured ||
                      googleDriveBackups.length === 0
                    }
                  />
                </label>
                <div className="inline-row">
                  <button
                    type="button"
                    onClick={() => void onGoogleDriveSyncDownload(importMode)}
                    disabled={
                      driveBusy ||
                      exportBusy ||
                      importBusy ||
                      !googleDriveConfigured ||
                      googleDriveBackups.length === 0 ||
                      !selectedGoogleDriveBackupId
                    }
                  >
                    <CloudDownload size={14} />
                    {driveBusy ? "Восстановление..." : "Восстановить из Drive"}
                  </button>
                </div>
                {selectedGoogleDriveBackup ? (
                  <small style={{ color: "var(--text-secondary)" }}>
                    Выбран бэкап: {selectedGoogleDriveBackup.name}
                    {selectedGoogleDriveBackup.versionTag
                      ? ` • v${selectedGoogleDriveBackup.versionTag}`
                      : ""}
                    {selectedGoogleDriveBackup.backupLabel
                      ? ` • ${selectedGoogleDriveBackup.backupLabel}`
                      : ""}
                  </small>
                ) : null}
                {!googleDriveConfigured ? (
                  <small style={{ color: "var(--danger)" }}>
                    Google Drive не настроен в приложении (нет OAuth Client ID).
                  </small>
                ) : null}
                <small style={{ color: "var(--text-secondary)" }}>
                  Статус:{" "}
                  {googleDriveConnected
                    ? `подключено${
                        googleDriveAccountEmail
                          ? ` (${googleDriveAccountEmail})`
                          : ""
                      }`
                    : "не подключено"}
                </small>
              </div>

              <div className="persona-section">
                <h5>Экспорт</h5>
                <label>
                  Набор данных
                  <Dropdown
                    value={exportScope}
                    options={EXPORT_SCOPE_OPTIONS}
                    onChange={(nextScope) =>
                      setExportScope(nextScope as BackupExportScope)
                    }
                  />
                </label>
                {exportScope === "chat" ? (
                  <label>
                    Чат для экспорта
                    <Dropdown
                      value={exportChatId}
                      options={
                        exportableChats.length > 0
                          ? exportableChats.map((chat) => ({
                              value: chat.id,
                              label: `${chat.personaName} — ${chat.title}`,
                            }))
                          : [{ value: "", label: "Чаты не найдены" }]
                      }
                      onChange={(nextChatId) => setExportChatId(nextChatId)}
                    />
                  </label>
                ) : null}
                <label>
                  Формат файла
                  <Dropdown
                    value={exportFormat}
                    options={EXPORT_FORMAT_OPTIONS}
                    onChange={(nextFormat) =>
                      setExportFormat(nextFormat as BackupExportFormat)
                    }
                  />
                </label>
                {exportFormat === "raw_json" || exportFormat === "raw_zip" ? (
                  <small style={{ color: "var(--text-secondary)" }}>
                    RAW формат сохраняет полный снимок IndexedDB и игнорирует выбранный scope.
                  </small>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    void onExportData({
                      scope: exportScope,
                      format: exportFormat,
                      chatId: exportScope === "chat" ? exportChatId : undefined,
                    })
                  }
                  disabled={
                    exportBusy ||
                    importBusy ||
                    driveBusy ||
                    ((exportFormat === "json" || exportFormat === "zip") &&
                      exportScope === "chat" &&
                      !exportChatId)
                  }
                >
                  {exportBusy ? "Экспорт..." : "Экспортировать"}
                </button>
                {exportDownloadUrl && exportDownloadFileName ? (
                  <div className="settings-download-row">
                    <a
                      className="button-link"
                      href={exportDownloadUrl}
                      download={exportDownloadFileName}
                    >
                      Скачать экспорт
                    </a>
                    <small style={{ color: "var(--text-secondary)" }}>
                      {exportDownloadFileName}
                    </small>
                  </div>
                ) : null}
              </div>

              <div className="persona-section">
                <h5>Импорт</h5>
                <label>
                  Файл бэкапа
                  <input
                    type="file"
                    accept=".json,.zip,application/json,application/zip"
                    onChange={(event) =>
                      setImportFile(event.target.files?.[0] ?? null)
                    }
                  />
                </label>
                <label>
                  Режим импорта
                  <Dropdown
                    value={importMode}
                    options={IMPORT_MODE_OPTIONS}
                    onChange={(nextMode) =>
                      setImportMode(nextMode as BackupImportMode)
                    }
                  />
                </label>
                {importMode === "replace" ? (
                  <small style={{ color: "var(--danger)" }}>
                    Внимание: текущие локальные данные будут полностью удалены перед импортом.
                  </small>
                ) : null}
                <div className="inline-row">
                  <button
                    type="button"
                    onClick={() =>
                      importFile && void onImportData(importFile, importMode)
                    }
                    disabled={!importFile || importBusy || exportBusy || driveBusy}
                  >
                    {importBusy ? "Импорт..." : "Импортировать"}
                  </button>
                  <small style={{ color: "var(--text-secondary)" }}>
                    {importFile ? importFile.name : "Файл не выбран"}
                  </small>
                </div>
              </div>

              {dataTransferMessage ? (
                <small
                  style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}
                >
                  {dataTransferMessage}
                </small>
              ) : null}
            </>
          ) : activeTab === "logs" ? (
            <>
              <div className="persona-section">
                <h5>Системные логи</h5>
                <small style={{ color: "var(--text-secondary)" }}>
                  Devtools-режим для анализа событий: слева поток записей, справа детальная панель
                  Request/Response/Status/Error.
                </small>
                <div className="settings-log-filters">
                  <label>
                    Уровень
                    <Dropdown
                      value={logLevelFilter}
                      options={LOG_LEVEL_OPTIONS}
                      onChange={(nextValue) =>
                        setLogLevelFilter(nextValue as LogLevelFilter)
                      }
                    />
                  </label>
                  <label>
                    Источник
                    <Dropdown
                      value={logSourceFilter}
                      options={LOG_SOURCE_OPTIONS}
                      onChange={(nextValue) =>
                        setLogSourceFilter(nextValue as LogSourceFilter)
                      }
                    />
                  </label>
                  <label>
                    Тип
                    <Dropdown
                      value={logTypeFilter}
                      options={logTypeOptions}
                      onChange={(nextValue) => setLogTypeFilter(nextValue)}
                    />
                  </label>
                  <label>
                    Поиск
                    <input
                      type="text"
                      value={logSearchQuery}
                      onChange={(event) => setLogSearchQuery(event.target.value)}
                      placeholder="eventType / message / details"
                    />
                  </label>
                </div>
                <div className="inline-row" style={{ marginTop: 8 }}>
                  <small style={{ color: "var(--text-secondary)" }}>
                    Показано: {filteredLogEntries.length} из {allLogEntries.length}
                  </small>
                  <div className="inline-row">
                    {canLoadNativeRuntimeEvents ? (
                      <button
                        type="button"
                        onClick={() => {
                          void refreshNativeRuntimeEvents();
                        }}
                        disabled={nativeRuntimeEventsLoading}
                      >
                        <RefreshCw
                          size={14}
                          className={nativeRuntimeEventsLoading ? "spin" : ""}
                        />{" "}
                        Обновить Native Runtime
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={onClearSystemLogs}
                      disabled={systemLogs.length === 0}
                    >
                      Очистить Web/System
                    </button>
                    {canLoadNativeRuntimeEvents ? (
                      <button
                        type="button"
                        onClick={() => {
                          void clearNativeRuntimeLogs();
                        }}
                        disabled={
                          nativeRuntimeEventsClearing ||
                          nativeRuntimeEventsLoading ||
                          nativeRuntimeEvents.length === 0
                        }
                      >
                        {nativeRuntimeEventsClearing
                          ? "Очистка Native Runtime…"
                          : "Очистить Native Runtime"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <small style={{ color: "var(--text-secondary)" }}>
                  {nativeRuntimeStatusLabel}
                  {nativeRuntimeEventsError
                    ? ` • Ошибка: ${nativeRuntimeEventsError}`
                    : ""}
                </small>
              </div>
              <div
                className={`settings-log-devtools ${
                  isCompactLogLayout
                    ? logMobilePane === "detail"
                      ? "mobile-detail"
                      : "mobile-list"
                    : ""
                }`}
              >
                <div className="settings-log-master">
                  {filteredLogEntries.length === 0 ? (
                    <small style={{ color: "var(--text-secondary)" }}>
                      Нет логов для выбранных фильтров.
                    </small>
                  ) : (
                    filteredLogEntries.map((entry) => (
                      <button
                        type="button"
                        className={`settings-log-row ${
                          entry.id === selectedLogId ? "active" : ""
                        }`}
                        key={entry.id}
                        onClick={() => {
                          setSelectedLogId(entry.id);
                          if (isCompactLogLayout) {
                            setLogMobilePane("detail");
                          }
                        }}
                      >
                        <div className="settings-log-row-head">
                          <span
                            className={`settings-log-level settings-log-level-${entry.level}`}
                          >
                            {entry.level.toUpperCase()}
                          </span>
                          <code className="settings-log-type">{entry.eventType}</code>
                          <span className={`settings-log-source settings-log-source-${entry.source}`}>
                            {entry.source === "native_runtime" ? "NATIVE" : "WEB"}
                          </span>
                        </div>
                        <p className="settings-log-message">{entry.message}</p>
                        <small className="settings-log-time settings-log-row-time">
                          {formatSystemLogTimestamp(entry.timestamp)}
                        </small>
                      </button>
                    ))
                  )}
                </div>
                {selectedLogEntry == null ? (
                  <div className="settings-log-detail">
                    <small style={{ color: "var(--text-secondary)" }}>
                      Выбери запись слева, чтобы открыть детали.
                    </small>
                  </div>
                ) : (
                  <div className="settings-log-detail">
                    <header className="settings-log-detail-head">
                      {isCompactLogLayout ? (
                        <div className="inline-row">
                          <button
                            type="button"
                            className="settings-log-mobile-back"
                            onClick={() => setLogMobilePane("list")}
                          >
                            Назад к списку
                          </button>
                        </div>
                      ) : null}
                      <div className="settings-log-entry-head">
                        <span
                          className={`settings-log-level settings-log-level-${selectedLogEntry.level}`}
                        >
                          {selectedLogEntry.level.toUpperCase()}
                        </span>
                        <code className="settings-log-type">{selectedLogEntry.eventType}</code>
                        <span
                          className={`settings-log-source settings-log-source-${selectedLogEntry.source}`}
                        >
                          {selectedLogEntry.source === "native_runtime" ? "NATIVE" : "WEB"}
                        </span>
                        <small className="settings-log-time">
                          {formatSystemLogTimestamp(selectedLogEntry.timestamp)}
                        </small>
                      </div>
                      <p className="settings-log-message">{selectedLogEntry.message}</p>
                    </header>
                    <div className="settings-log-detail-tabs">
                      {LOG_DETAIL_TAB_OPTIONS.map((tab) => (
                        <button
                          type="button"
                          key={tab.value}
                          className={activeLogDetailTab === tab.value ? "active" : ""}
                          onClick={() => setActiveLogDetailTab(tab.value)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <pre className="settings-log-detail-pre">
                      {formatDetailForView(selectedLogDetailValue)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button type="submit" className="primary">
              Сохранить
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
