import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { dbApi } from "../db";
import { Dropdown } from "./Dropdown";
import {
  resolvePersonaAvatarImageId,
  resolvePersonaExternalAvatarUrl,
  resolvePersonaSecondaryLabel,
} from "../personaAvatar";
import type { GroupRoomMode, Persona } from "../types";

interface GroupRoomModalProps {
  open: boolean;
  personas: Persona[];
  onClose: () => void;
  onCreate: (payload: {
    title: string;
    mode: GroupRoomMode;
    participantPersonaIds: string[];
  }) => Promise<void>;
}

export function GroupRoomModal({
  open,
  personas,
  onClose,
  onCreate,
}: GroupRoomModalProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<GroupRoomMode>("personas_only");
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([]);
  const [pickerPersonaId, setPickerPersonaId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [avatarByPersonaId, setAvatarByPersonaId] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setMode("personas_only");
    setSelectedPersonaIds([]);
    setPickerPersonaId("");
    setIsSubmitting(false);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const refs = personas
        .map((persona) => ({
          personaId: persona.id,
          imageId: resolvePersonaAvatarImageId(persona),
        }))
        .filter((item) => item.imageId);

      if (refs.length === 0) {
        if (!cancelled) setAvatarByPersonaId({});
        return;
      }

      const assets = await dbApi.getImageAssets(refs.map((item) => item.imageId));
      if (cancelled) return;
      const byId = Object.fromEntries(assets.map((asset) => [asset.id, asset.dataUrl]));
      setAvatarByPersonaId(
        Object.fromEntries(
          refs.map((item) => [item.personaId, byId[item.imageId] ?? ""]),
        ),
      );
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [personas]);

  const personaById = useMemo(
    () => Object.fromEntries(personas.map((persona) => [persona.id, persona])),
    [personas],
  );
  const resolveAvatarSrc = (persona: Persona) =>
    avatarByPersonaId[persona.id] || resolvePersonaExternalAvatarUrl(persona);

  const availableOptions = personas
    .filter((persona) => !selectedPersonaIds.includes(persona.id))
    .map((persona) => ({
      value: persona.id,
      label: persona.name,
      description: resolvePersonaSecondaryLabel(persona),
      avatarSrc: resolveAvatarSrc(persona),
      avatarFallbackText: persona.name,
    }));

  const canSubmit =
    title.trim().length > 0 && selectedPersonaIds.length > 0 && !isSubmitting;

  if (!open) return null;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal group-room-modal">
        <div className="modal-header">
          <h3>Новая группа</h3>
          <button type="button" onClick={onClose}>
            <X size={14} /> Закрыть
          </button>
        </div>

        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            setIsSubmitting(true);
            void onCreate({
              title: title.trim(),
              mode,
              participantPersonaIds: selectedPersonaIds,
            }).finally(() => setIsSubmitting(false));
          }}
        >
          <label>
            Название группы
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Например: Команда проекта"
            />
          </label>

          <label>
            Режим комнаты
            <Dropdown
              value={mode}
              onChange={(value) => setMode(value as GroupRoomMode)}
              portal
              options={[
                { value: "personas_only", label: "Только персоны" },
                { value: "personas_plus_user", label: "Персоны + пользователь" },
              ]}
            />
          </label>

          <div className="group-room-persona-picker">
            <label>
              Добавить участника
              <Dropdown
                value={pickerPersonaId}
                onChange={(nextPersonaId) => {
                  setPickerPersonaId(nextPersonaId);
                  const candidate = nextPersonaId.trim();
                  if (!candidate) return;
                  setSelectedPersonaIds((prev) =>
                    prev.includes(candidate) ? prev : [...prev, candidate],
                  );
                  setPickerPersonaId("");
                }}
                portal
                options={
                  availableOptions.length > 0
                    ? availableOptions
                    : [{ value: "", label: "Все персоны уже добавлены" }]
                }
                placeholder="Выберите персону"
                disabled={availableOptions.length === 0}
              />
            </label>
          </div>

          <div className="group-room-chip-list" aria-label="Выбранные участники">
            {selectedPersonaIds.map((personaId) => {
              const persona = personaById[personaId];
              if (!persona) return null;
              const avatarSrc = resolveAvatarSrc(persona);
              return (
                <span key={personaId} className="group-room-chip">
                  <span className="group-room-chip-avatar" aria-hidden="true">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt="" loading="lazy" />
                    ) : (
                      <span>{persona.name.trim().charAt(0).toUpperCase()}</span>
                    )}
                  </span>
                  <span className="group-room-chip-meta">
                    <strong>{persona.name}</strong>
                    <span>{resolvePersonaSecondaryLabel(persona)}</span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn mini"
                    onClick={() =>
                      setSelectedPersonaIds((prev) =>
                        prev.filter((value) => value !== personaId),
                      )
                    }
                    title="Удалить участника"
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })}
            {selectedPersonaIds.length === 0 ? (
              <small style={{ color: "var(--text-secondary)" }}>
                Добавьте хотя бы одну персону в группу.
              </small>
            ) : null}
          </div>

          <button type="submit" className="primary" disabled={!canSubmit}>
            {isSubmitting ? "Создание..." : "Создать группу"}
          </button>
        </form>
      </div>
    </div>
  );
}
