import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { X } from "lucide-react";

interface RenameModalProps {
  open: boolean;
  entityLabel: string;
  initialValue: string;
  onClose: () => void;
  onSubmit: (nextValue: string) => void;
}

export function RenameModal({
  open,
  entityLabel,
  initialValue,
  onClose,
  onSubmit,
}: RenameModalProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError("");
  }, [initialValue, open]);

  if (!open) return null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = value.trim();
    if (!normalized) {
      setError("Название не может быть пустым.");
      return;
    }
    onSubmit(normalized);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal rename-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>Переименовать</h3>
          <button type="button" onClick={onClose} title="Закрыть">
            <X size={14} /> Закрыть
          </button>
        </div>
        <form className="form" onSubmit={handleSubmit}>
          <label>
            Новое название ({entityLabel})
            <input
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError("");
              }}
              placeholder="Введите новое название"
            />
          </label>
          {error ? <small style={{ color: "var(--danger)" }}>{error}</small> : null}
          <div className="inline-row">
            <button type="button" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="primary">
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
