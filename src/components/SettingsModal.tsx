import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { RefreshCw, X } from "lucide-react";
import type { AppSettings, AuthMode, EndpointAuthConfig } from "../types";
import { Dropdown } from "./Dropdown";
import type {
  BackupExportFormat,
  BackupImportMode,
  BackupExportScope,
} from "../features/backup/dataTransfer";

type PwaInstallStatus = "installed" | "available" | "unavailable";

interface SettingsModalProps {
  open: boolean;
  settingsDraft: AppSettings;
  pwaInstallStatus: PwaInstallStatus;
  availableModels: string[];
  modelsLoading: boolean;
  exportableChats: Array<{ id: string; title: string; personaName: string }>;
  exportBusy: boolean;
  importBusy: boolean;
  dataTransferMessage: string | null;
  exportDownloadUrl: string | null;
  exportDownloadFileName: string | null;
  setSettingsDraft: (updater: (prev: AppSettings) => AppSettings) => void;
  onInstallPwa: () => void;
  onRefreshModels: () => void;
  onExportData: (params: {
    scope: BackupExportScope;
    format: BackupExportFormat;
    chatId?: string;
  }) => Promise<void>;
  onImportData: (file: File, mode: BackupImportMode) => Promise<void>;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}

type SettingsTab = "system" | "personal" | "chat" | "data";

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
];
const IMPORT_MODE_OPTIONS: Array<{ value: BackupImportMode; label: string }> = [
  { value: "merge", label: "Добавить / объединить" },
  { value: "replace", label: "Заменить текущие данные" },
];

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
  settingsDraft,
  pwaInstallStatus,
  availableModels,
  modelsLoading,
  exportableChats,
  exportBusy,
  importBusy,
  dataTransferMessage,
  exportDownloadUrl,
  exportDownloadFileName,
  setSettingsDraft,
  onInstallPwa,
  onRefreshModels,
  onExportData,
  onImportData,
  onClose,
  onSubmit,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("system");
  const [exportScope, setExportScope] = useState<BackupExportScope>("all");
  const [exportFormat, setExportFormat] = useState<BackupExportFormat>("json");
  const [exportChatId, setExportChatId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<BackupImportMode>("merge");
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
    if (open) {
      setActiveTab("system");
      setExportScope("all");
      setExportFormat("json");
      setExportChatId(exportableChats[0]?.id ?? "");
      setImportFile(null);
      setImportMode("merge");
    }
  }, [open, exportableChats]);

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
        </div>
        <form className="form" onSubmit={onSubmit}>
          {activeTab === "system" ? (
            <>
              <label>
                Base URL
                <input
                  value={settingsDraft.lmBaseUrl}
                  onChange={(e) => setSettingsDraft((v) => ({ ...v, lmBaseUrl: e.target.value }))}
                />
              </label>
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
                title="Авторизация Comfy endpoint"
                auth={settingsDraft.comfyAuth}
                onChange={(next) => setSettingsDraft((v) => ({ ...v, comfyAuth: next }))}
              />
              <label>
                Модель
                <div className="inline-row">
                  <Dropdown
                    value={settingsDraft.model}
                    onChange={(nextModel) => setSettingsDraft((v) => ({ ...v, model: nextModel }))}
                    options={
                      availableModels.length > 0
                        ? availableModels.map((modelName) => ({ value: modelName, label: modelName }))
                        : [{ value: settingsDraft.model, label: settingsDraft.model || "Модель не найдена" }]
                    }
                  />
                  <button type="button" onClick={onRefreshModels} disabled={modelsLoading}>
                    <RefreshCw size={14} className={modelsLoading ? "spin" : ""} /> Обновить
                  </button>
                </div>
              </label>
              <label>
                Модель генерации промптов изображений
                <Dropdown
                  value={settingsDraft.imagePromptModel}
                  onChange={(nextModel) =>
                    setSettingsDraft((v) => ({ ...v, imagePromptModel: nextModel }))
                  }
                  options={
                    availableModels.length > 0
                      ? availableModels.map((modelName) => ({ value: modelName, label: modelName }))
                      : [
                          {
                            value: settingsDraft.imagePromptModel,
                            label: settingsDraft.imagePromptModel || "Модель не найдена",
                          },
                        ]
                  }
                />
              </label>
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
              </div>
            </>
          ) : null}

          {activeTab === "personal" ? (
            <>
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
                    (exportScope === "chat" && !exportChatId)
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
                    disabled={!importFile || importBusy || exportBusy}
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
