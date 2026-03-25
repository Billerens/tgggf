import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ChevronDown, RefreshCw, X } from "lucide-react";
import type { AppSettings } from "../types";

interface SettingsModalProps {
  open: boolean;
  settingsDraft: AppSettings;
  availableModels: string[];
  modelsLoading: boolean;
  setSettingsDraft: (updater: (prev: AppSettings) => AppSettings) => void;
  onRefreshModels: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}

type SettingsTab = "system" | "personal" | "chat";

export function SettingsModal({
  open,
  settingsDraft,
  availableModels,
  modelsLoading,
  setSettingsDraft,
  onRefreshModels,
  onClose,
  onSubmit,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("system");

  useEffect(() => {
    if (open) {
      setActiveTab("system");
    }
  }, [open]);

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
                Модель
                <div className="inline-row">
                  <div className="select-container">
                    <select
                      value={settingsDraft.model}
                      onChange={(e) => setSettingsDraft((v) => ({ ...v, model: e.target.value }))}
                    >
                      {availableModels.length === 0 ? (
                        <option value={settingsDraft.model}>
                          {settingsDraft.model || "Модель не найдена"}
                        </option>
                      ) : null}
                      {availableModels.map((modelName) => (
                        <option key={modelName} value={modelName}>
                          {modelName}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="select-icon" />
                  </div>
                  <button type="button" onClick={onRefreshModels} disabled={modelsLoading}>
                    <RefreshCw size={14} className={modelsLoading ? "spin" : ""} /> Обновить
                  </button>
                </div>
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
                API key (опционально)
                <input
                  type="password"
                  value={settingsDraft.apiKey}
                  onChange={(e) => setSettingsDraft((v) => ({ ...v, apiKey: e.target.value }))}
                />
              </label>
            </>
          ) : null}

          {activeTab === "personal" ? (
            <>
              <label>
                Пол пользователя
                <div className="select-container">
                  <select
                    value={settingsDraft.userGender}
                    onChange={(e) =>
                      setSettingsDraft((v) => ({ ...v, userGender: e.target.value as AppSettings["userGender"] }))
                    }
                  >
                    <option value="unspecified">Не указан</option>
                    <option value="male">Мужской</option>
                    <option value="female">Женский</option>
                    <option value="nonbinary">Небинарный / другой</option>
                  </select>
                  <ChevronDown size={14} className="select-icon" />
                </div>
              </label>
            </>
          ) : null}

          {activeTab === "chat" ? (
            <>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settingsDraft.showSystemImageBlock}
                  onChange={(e) =>
                    setSettingsDraft((v) => ({ ...v, showSystemImageBlock: e.target.checked }))
                  }
                />
                Отображать системный блок генерации изображения
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

          <button type="submit" className="primary">
            Сохранить
          </button>
        </form>
      </div>
    </div>
  );
}
