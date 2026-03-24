import type { FormEvent } from "react";
import { RefreshCw, X } from "lucide-react";
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
        <form className="form" onSubmit={onSubmit}>
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
          <button type="submit">Сохранить</button>
        </form>
      </div>
    </div>
  );
}
