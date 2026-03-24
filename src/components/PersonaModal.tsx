import type { FormEvent } from "react";
import { Sparkles, Trash2, UserRound, X } from "lucide-react";
import type { GeneratedPersonaDraft } from "../lmstudio";
import type { Persona } from "../types";
import type { PersonaDraft, PersonaModalTab } from "../ui/types";

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
}: PersonaModalProps) {
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
                  <div className="persona-item-content" onClick={() => onEditPersona(persona)} style={{cursor: 'pointer'}}>
                    <strong>{persona.name}</strong>
                    <span>{persona.personalityPrompt || "Без описания"}</span>
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
              <input
                placeholder="Имя"
                value={personaDraft.name}
                onChange={(e) => setPersonaDraft((v) => ({ ...v, name: e.target.value }))}
                required
              />
              <textarea
                placeholder="Промпт характера"
                value={personaDraft.personalityPrompt}
                onChange={(e) =>
                  setPersonaDraft((v) => ({ ...v, personalityPrompt: e.target.value }))
                }
              />
              <textarea
                placeholder="Промпт внешности"
                value={personaDraft.appearancePrompt}
                onChange={(e) =>
                  setPersonaDraft((v) => ({ ...v, appearancePrompt: e.target.value }))
                }
              />
              <textarea
                placeholder="Промпт стиля речи"
                value={personaDraft.stylePrompt}
                onChange={(e) => setPersonaDraft((v) => ({ ...v, stylePrompt: e.target.value }))}
              />
              <input
                placeholder="URL аватара"
                value={personaDraft.avatarUrl}
                onChange={(e) => setPersonaDraft((v) => ({ ...v, avatarUrl: e.target.value }))}
              />
              <div className="inline-row">
                <button type="submit" className="primary">{editingPersonaId ? "Сохранить" : "Создать"}</button>
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
                onChange={(e) => setGenerationTheme(e.target.value)}
                rows={4}
              />
              <label>
                Количество
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={generationCount}
                  onChange={(e) => setGenerationCount(Number(e.target.value))}
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
    </div>
  );
}
