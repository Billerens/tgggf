import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ChevronDown, RefreshCw, X } from "lucide-react";
import type { AppSettings, AuthMode, EndpointAuthConfig } from "../types";

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

const AUTH_MODE_LABELS: Array<{ value: AuthMode; label: string }> = [
  { value: "none", label: "Без auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "token", label: "Token token" },
  { value: "basic", label: "Basic (user:pass)" },
  { value: "custom", label: "Custom header" },
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
        <div className="select-container">
          <select
            value={auth.mode}
            onChange={(e) => onChange({ ...auth, mode: e.target.value as AuthMode })}
          >
            {AUTH_MODE_LABELS.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="select-icon" />
        </div>
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
                ComfyUI URL
                <input
                  value={settingsDraft.comfyBaseUrl}
                  onChange={(e) => setSettingsDraft((v) => ({ ...v, comfyBaseUrl: e.target.value }))}
                  placeholder="http://127.0.0.1:8188"
                />
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
                Legacy API key (fallback, опционально)
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
