import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  avatarSrc?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = "Выберите значение",
  disabled = false,
  className = "",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = useMemo(() => options.find((option) => option.value === value), [options, value]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    if (!open) return;
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div ref={containerRef} className={`dropdown ${className}`.trim()}>
      <button
        type="button"
        className={`dropdown-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedOption ? (
          selectedOption.avatarSrc || selectedOption.description ? (
            <span className="dropdown-selected-rich">
              {selectedOption.avatarSrc ? (
                <span className="dropdown-option-avatar" aria-hidden="true">
                  <img src={selectedOption.avatarSrc} alt="" loading="lazy" />
                </span>
              ) : null}
              <span className="dropdown-option-text">
                <span className="dropdown-selected-label">{selectedOption.label}</span>
                {selectedOption.description ? (
                  <span className="dropdown-option-description">
                    {selectedOption.description}
                  </span>
                ) : null}
              </span>
            </span>
          ) : (
            <span className="dropdown-selected-label">{selectedOption.label}</span>
          )
        ) : (
          <span className="dropdown-placeholder">{placeholder}</span>
        )}
        <ChevronDown size={14} className={`dropdown-chevron ${open ? "open" : ""}`} />
      </button>
      {open ? (
        <div className="dropdown-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`dropdown-option ${option.value === value ? "active" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={option.value === value}
            >
              {option.avatarSrc || option.description ? (
                <span className="dropdown-option-content">
                  {option.avatarSrc ? (
                    <span className="dropdown-option-avatar" aria-hidden="true">
                      <img src={option.avatarSrc} alt="" loading="lazy" />
                    </span>
                  ) : null}
                  <span className="dropdown-option-text">
                    <span className="dropdown-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="dropdown-option-description">{option.description}</span>
                    ) : null}
                  </span>
                </span>
              ) : (
                option.label
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
