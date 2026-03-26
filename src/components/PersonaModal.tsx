import { useState, type FormEvent } from "react";
import { Sparkles, Trash2, UserRound, X } from "lucide-react";
import type { GeneratedPersonaDraft } from "../lmstudio";
import type { Persona } from "../types";
import type { PersonaDraft, PersonaLookPack, PersonaModalTab } from "../ui/types";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface PersonaModalProps {
  open: boolean;
  personas: Persona[];
  personaModalTab: PersonaModalTab;
  setPersonaModalTab: (value: PersonaModalTab) => void;
  editingPersonaId: string | null;
  personaDraft: PersonaDraft;
  setPersonaDraft: (updater: (prev: PersonaDraft) => PersonaDraft) => void;
  onClose: () => void;
  onEditPersona: (persona: Persona) => void;
  onDeletePersona: (personaId: string) => void;
  onSubmitPersona: (event: FormEvent) => void;
  onResetDraft: () => void;
  generationTheme: string;
  setGenerationTheme: (value: string) => void;
  generationCount: number;
  setGenerationCount: (value: number) => void;
  generationLoading: boolean;
  generatedDrafts: GeneratedPersonaDraft[];
  onSubmitGenerate: (event: FormEvent) => void;
  onSaveGenerated: (draft: GeneratedPersonaDraft) => void;
  onMoveGeneratedToEditor: (draft: GeneratedPersonaDraft) => void;
  lookGenerationLoading: boolean;
  onGeneratePersonaLook: () => void;
  lookPackageCount: number;
  setLookPackageCount: (value: number) => void;
  generatedLookPacks: PersonaLookPack[];
  onApplyLookPack: (pack: PersonaLookPack) => void;
  generateSideView: boolean;
  setGenerateSideView: (value: boolean) => void;
  generateBackView: boolean;
  setGenerateBackView: (value: boolean) => void;
  comfyCheckpoints: string[];
  checkpointsLoading: boolean;
  onRefreshCheckpoints: () => void;
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

function SliderField({ label, value, onChange }: SliderFieldProps) {
  return (
    <label className="slider-field">
      <span>
        {label}: <strong>{value}</strong>
      </span>
      <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function PersonaModal({
  open,
  personas,
  personaModalTab,
  setPersonaModalTab,
  editingPersonaId,
  personaDraft,
  setPersonaDraft,
  onClose,
  onEditPersona,
  onDeletePersona,
  onSubmitPersona,
  onResetDraft,
  generationTheme,
  setGenerationTheme,
  generationCount,
  setGenerationCount,
  generationLoading,
  generatedDrafts,
  onSubmitGenerate,
  onSaveGenerated,
  onMoveGeneratedToEditor,
  lookGenerationLoading,
  onGeneratePersonaLook,
  lookPackageCount,
  setLookPackageCount,
  generatedLookPacks,
  onApplyLookPack,
  generateSideView,
  setGenerateSideView,
  generateBackView,
  setGenerateBackView,
  comfyCheckpoints,
  checkpointsLoading,
  onRefreshCheckpoints,
}: PersonaModalProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (!open) return null;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal large">
        <div className="modal-header">
          <h3>Персоны</h3>
          <button type="button" onClick={onClose}>
            <X size={14} /> Закрыть
          </button>
        </div>

        <div className="modal-tabs">
          <button
            type="button"
            className={personaModalTab === "editor" ? "active" : ""}
            onClick={() => setPersonaModalTab("editor")}
          >
            <UserRound size={14} /> Редактор
          </button>
          <button
            type="button"
            className={personaModalTab === "generator" ? "active" : ""}
            onClick={() => setPersonaModalTab("generator")}
          >
            <Sparkles size={14} /> Генерация личности
          </button>
        </div>

        {personaModalTab === "editor" ? (
          <div className="split">
            <div className="persona-list">
              {personas.map((persona) => (
                <div key={persona.id} className={`persona-item ${persona.id === editingPersonaId ? "active" : ""}`}>
                  <div
                    className="persona-item-content"
                    onClick={() => onEditPersona(persona)}
                    style={{ cursor: "pointer" }}
                  >
                    <strong>{persona.name}</strong>
                    <span>{persona.advanced.core.archetype || persona.personalityPrompt || "Без описания"}</span>
                  </div>
                  <button
                    type="button"
                    className="icon-btn danger mini"
                    onClick={() => onDeletePersona(persona.id)}
                    disabled={personas.length <= 1}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            <form className="form" onSubmit={onSubmitPersona}>
              <h4>{editingPersonaId ? "Редактирование" : "Новая персона"}</h4>

              <div className="persona-section">
                <h5>База</h5>
                <input
                  placeholder="Имя"
                  value={personaDraft.name}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, name: event.target.value }))}
                  required
                />
                <textarea
                  placeholder="Legacy промпт характера"
                  value={personaDraft.personalityPrompt}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, personalityPrompt: event.target.value }))}
                />
                <textarea
                  placeholder="Legacy промпт внешности"
                  value={personaDraft.appearancePrompt}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, appearancePrompt: event.target.value }))}
                />
                <textarea
                  placeholder="Legacy стиль речи"
                  value={personaDraft.stylePrompt}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, stylePrompt: event.target.value }))}
                />
                <label>
                  Checkpoint для генерации изображений
                  <div className="inline-row">
                    <select
                      value={personaDraft.imageCheckpoint}
                      onChange={(event) =>
                        setPersonaDraft((prev) => ({ ...prev, imageCheckpoint: event.target.value }))
                      }
                    >
                      <option value="">По умолчанию из workflow</option>
                      {comfyCheckpoints.map((checkpoint) => (
                        <option key={checkpoint} value={checkpoint}>
                          {checkpoint}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={onRefreshCheckpoints}
                      disabled={checkpointsLoading}
                    >
                      {checkpointsLoading ? "..." : "Обновить"}
                    </button>
                  </div>
                </label>
                <input
                  placeholder="URL аватара"
                  value={personaDraft.avatarUrl}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, avatarUrl: event.target.value }))}
                />
                <input
                  placeholder="URL fullbody"
                  value={personaDraft.fullBodyUrl}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, fullBodyUrl: event.target.value }))}
                />
                <input
                  placeholder="URL fullbody side"
                  value={personaDraft.fullBodySideUrl}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({ ...prev, fullBodySideUrl: event.target.value }))
                  }
                />
                <input
                  placeholder="URL fullbody back"
                  value={personaDraft.fullBodyBackUrl}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({ ...prev, fullBodyBackUrl: event.target.value }))
                  }
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={generateSideView}
                    onChange={(event) => setGenerateSideView(event.target.checked)}
                  />
                  <span>Генерировать fullbody side (опционально)</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={generateBackView}
                    onChange={(event) => setGenerateBackView(event.target.checked)}
                  />
                  <span>Генерировать fullbody back (опционально)</span>
                </label>
                <label>
                  Количество пакетов для выбора
                  <select
                    value={lookPackageCount}
                    onChange={(event) => setLookPackageCount(Number(event.target.value))}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={onGeneratePersonaLook}
                  disabled={lookGenerationLoading || !personaDraft.appearancePrompt.trim()}
                >
                  <Sparkles size={14} />{" "}
                  {lookGenerationLoading ? "Генерирую внешний вид..." : "Сгенерировать внешность"}
                </button>
                {personaDraft.avatarUrl ||
                personaDraft.fullBodyUrl ||
                personaDraft.fullBodySideUrl ||
                personaDraft.fullBodyBackUrl ? (
                  <div className="persona-look-grid">
                    {personaDraft.avatarUrl ? (
                      <article className="persona-look-card avatar">
                        <span>Avatar</span>
                        <button
                          type="button"
                          className="persona-look-preview-btn"
                          onClick={() => setPreviewSrc(personaDraft.avatarUrl)}
                        >
                          <img src={personaDraft.avatarUrl} alt="persona-avatar" loading="lazy" />
                        </button>
                      </article>
                    ) : null}
                    {personaDraft.fullBodyUrl ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody</span>
                        <button
                          type="button"
                          className="persona-look-preview-btn"
                          onClick={() => setPreviewSrc(personaDraft.fullBodyUrl)}
                        >
                          <img src={personaDraft.fullBodyUrl} alt="persona-fullbody" loading="lazy" />
                        </button>
                      </article>
                    ) : null}
                    {personaDraft.fullBodySideUrl ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody Side</span>
                        <button
                          type="button"
                          className="persona-look-preview-btn"
                          onClick={() => setPreviewSrc(personaDraft.fullBodySideUrl)}
                        >
                          <img src={personaDraft.fullBodySideUrl} alt="persona-fullbody-side" loading="lazy" />
                        </button>
                      </article>
                    ) : null}
                    {personaDraft.fullBodyBackUrl ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody Back</span>
                        <button
                          type="button"
                          className="persona-look-preview-btn"
                          onClick={() => setPreviewSrc(personaDraft.fullBodyBackUrl)}
                        >
                          <img src={personaDraft.fullBodyBackUrl} alt="persona-fullbody-back" loading="lazy" />
                        </button>
                      </article>
                    ) : null}
                  </div>
                ) : null}
                {generatedLookPacks.length > 0 ? (
                  <div className="generated-list">
                    {generatedLookPacks.map((pack, index) => (
                      <article key={`${pack.fullBodyUrl}-${index}`} className="generated-card">
                        <strong>
                          Пакет #{index + 1} {pack.status === "pending" ? "(генерируется...)" : ""}
                        </strong>
                        <div className="persona-look-grid">
                          <article className="persona-look-card avatar">
                            <span>Avatar</span>
                            {pack.avatarUrl ? (
                              <button
                                type="button"
                                className="persona-look-preview-btn"
                                onClick={() => setPreviewSrc(pack.avatarUrl)}
                              >
                                <img src={pack.avatarUrl} alt={`look-pack-${index + 1}-avatar`} loading="lazy" />
                              </button>
                            ) : (
                              <div className="image-skeleton-card image-skeleton-fill" />
                            )}
                          </article>
                          <article className="persona-look-card fullbody">
                            <span>Fullbody</span>
                            {pack.fullBodyUrl ? (
                              <button
                                type="button"
                                className="persona-look-preview-btn"
                                onClick={() => setPreviewSrc(pack.fullBodyUrl)}
                              >
                                <img src={pack.fullBodyUrl} alt={`look-pack-${index + 1}-fullbody`} loading="lazy" />
                              </button>
                            ) : (
                              <div className="image-skeleton-card image-skeleton-fill" />
                            )}
                          </article>
                          {generateSideView ? (
                            <article className="persona-look-card fullbody">
                              <span>Side</span>
                              {pack.fullBodySideUrl ? (
                                <button
                                  type="button"
                                  className="persona-look-preview-btn"
                                  onClick={() => setPreviewSrc(pack.fullBodySideUrl)}
                                >
                                  <img
                                    src={pack.fullBodySideUrl}
                                    alt={`look-pack-${index + 1}-side`}
                                    loading="lazy"
                                  />
                                </button>
                              ) : (
                                <div className="image-skeleton-card image-skeleton-fill" />
                              )}
                            </article>
                          ) : null}
                          {generateBackView ? (
                            <article className="persona-look-card fullbody">
                              <span>Back</span>
                              {pack.fullBodyBackUrl ? (
                                <button
                                  type="button"
                                  className="persona-look-preview-btn"
                                  onClick={() => setPreviewSrc(pack.fullBodyBackUrl)}
                                >
                                  <img
                                    src={pack.fullBodyBackUrl}
                                    alt={`look-pack-${index + 1}-back`}
                                    loading="lazy"
                                  />
                                </button>
                              ) : (
                                <div className="image-skeleton-card image-skeleton-fill" />
                              )}
                            </article>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => onApplyLookPack(pack)}
                          disabled={pack.status !== "ready"}
                        >
                          Применить этот пакет
                        </button>
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="persona-section">
                <h5>Core</h5>
                <label>
                  Грамматический род персоны
                  <select
                    value={personaDraft.advanced.core.selfGender}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          core: {
                            ...prev.advanced.core,
                            selfGender: event.target.value as typeof prev.advanced.core.selfGender,
                          },
                        },
                      }))
                    }
                  >
                    <option value="auto">Авто (по имени)</option>
                    <option value="female">Женский</option>
                    <option value="male">Мужской</option>
                    <option value="neutral">Нейтральный (безличные формулировки)</option>
                  </select>
                </label>
                <input
                  placeholder="Архетип"
                  value={personaDraft.advanced.core.archetype}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, archetype: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Предыстория"
                  value={personaDraft.advanced.core.backstory}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, backstory: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Цели"
                  value={personaDraft.advanced.core.goals}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, goals: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Ценности"
                  value={personaDraft.advanced.core.values}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, values: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Границы/табу"
                  value={personaDraft.advanced.core.boundaries}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, boundaries: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Области экспертизы"
                  value={personaDraft.advanced.core.expertise}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, expertise: event.target.value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Voice</h5>
                <input
                  placeholder="Тон"
                  value={personaDraft.advanced.voice.tone}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, tone: event.target.value },
                      },
                    }))
                  }
                />
                <input
                  placeholder="Лексика/словарь"
                  value={personaDraft.advanced.voice.lexicalStyle}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, lexicalStyle: event.target.value },
                      },
                    }))
                  }
                />
                <label>
                  Длина фраз
                  <select
                    value={personaDraft.advanced.voice.sentenceLength}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          voice: {
                            ...prev.advanced.voice,
                            sentenceLength: event.target.value as typeof prev.advanced.voice.sentenceLength,
                          },
                        },
                      }))
                    }
                  >
                    <option value="short">Короткие</option>
                    <option value="balanced">Сбалансированные</option>
                    <option value="long">Длинные</option>
                  </select>
                </label>
                <SliderField
                  label="Формальность"
                  value={personaDraft.advanced.voice.formality}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, formality: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Экспрессивность"
                  value={personaDraft.advanced.voice.expressiveness}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, expressiveness: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Эмодзи"
                  value={personaDraft.advanced.voice.emoji}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, emoji: value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Behavior</h5>
                <SliderField
                  label="Инициативность"
                  value={personaDraft.advanced.behavior.initiative}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, initiative: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Эмпатия"
                  value={personaDraft.advanced.behavior.empathy}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, empathy: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Прямота"
                  value={personaDraft.advanced.behavior.directness}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, directness: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Любопытство"
                  value={personaDraft.advanced.behavior.curiosity}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, curiosity: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Челлендж"
                  value={personaDraft.advanced.behavior.challenge}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, challenge: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Креативность"
                  value={personaDraft.advanced.behavior.creativity}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, creativity: value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Emotion</h5>
                <label>
                  Базовое настроение
                  <select
                    value={personaDraft.advanced.emotion.baselineMood}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          emotion: {
                            ...prev.advanced.emotion,
                            baselineMood: event.target.value as typeof prev.advanced.emotion.baselineMood,
                          },
                        },
                      }))
                    }
                  >
                    <option value="calm">Спокойное</option>
                    <option value="warm">Теплое</option>
                    <option value="playful">Игривое</option>
                    <option value="focused">Сфокусированное</option>
                    <option value="analytical">Аналитичное</option>
                    <option value="inspired">Вдохновленное</option>
                    <option value="annoyed">Раздраженное</option>
                    <option value="upset">Расстроенное</option>
                    <option value="angry">Злое</option>
                  </select>
                </label>
                <SliderField
                  label="Теплота"
                  value={personaDraft.advanced.emotion.warmth}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, warmth: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Стабильность"
                  value={personaDraft.advanced.emotion.stability}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, stability: value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Позитивные триггеры"
                  value={personaDraft.advanced.emotion.positiveTriggers}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, positiveTriggers: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Негативные триггеры"
                  value={personaDraft.advanced.emotion.negativeTriggers}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, negativeTriggers: event.target.value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Memory</h5>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberFacts}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberFacts: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать факты
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberPreferences}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberPreferences: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать предпочтения
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberGoals}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberGoals: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать цели
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberEvents}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberEvents: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать события диалога
                </label>
                <label>
                  Лимит памяти
                  <input
                    type="number"
                    min={4}
                    max={120}
                    value={personaDraft.advanced.memory.maxMemories}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, maxMemories: Number(event.target.value) },
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  Срок затухания (дней)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={personaDraft.advanced.memory.decayDays}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, decayDays: Number(event.target.value) },
                        },
                      }))
                    }
                  />
                </label>
              </div>

              <div className="inline-row">
                <button type="submit" className="primary">
                  {editingPersonaId ? "Сохранить" : "Создать"}
                </button>
                <button type="button" onClick={onResetDraft}>
                  Сбросить
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="form">
            <form onSubmit={onSubmitGenerate} className="generator-form">
              <textarea
                placeholder="Тема генерации: киберпанк, фэнтези, научпоп, дружеский ассистент..."
                value={generationTheme}
                onChange={(event) => setGenerationTheme(event.target.value)}
                rows={4}
              />
              <label>
                Количество
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={generationCount}
                  onChange={(event) => setGenerationCount(Number(event.target.value))}
                />
              </label>
              <button type="submit" disabled={generationLoading}>
                <Sparkles size={14} /> {generationLoading ? "Генерирую..." : "Сгенерировать"}
              </button>
            </form>

            <div className="generated-list">
              {generatedDrafts.map((draft, index) => (
                <article key={`${draft.name}-${index}`} className="generated-card">
                  <h4>{draft.name}</h4>
                  <p>
                    <strong>Характер:</strong> {draft.personalityPrompt}
                  </p>
                  <p>
                    <strong>Внешность:</strong> {draft.appearancePrompt}
                  </p>
                  <p>
                    <strong>Стиль:</strong> {draft.stylePrompt}
                  </p>
                  <p>
                    <strong>Архетип:</strong> {draft.advanced.core.archetype}
                  </p>
                  <p>
                    <strong>Род:</strong> {draft.advanced.core.selfGender}
                  </p>
                  <div className="inline-row">
                    <button type="button" className="primary" onClick={() => onSaveGenerated(draft)}>
                      Сохранить
                    </button>
                    <button type="button" onClick={() => onMoveGeneratedToEditor(draft)}>
                      В редактор
                    </button>
                  </div>
                </article>
              ))}
              {generatedDrafts.length === 0 ? (
                <p className="empty-state">Сгенерированные варианты появятся здесь.</p>
              ) : null}
            </div>
          </div>
        )}
      </div>
      <ImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
