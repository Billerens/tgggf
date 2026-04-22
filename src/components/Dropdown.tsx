import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  avatarSrc?: string;
  avatarFallbackText?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  portal?: boolean;
  renderSelectedLabel?: (option: DropdownOption) => ReactNode;
  renderOption?: (option: DropdownOption, isSelected: boolean) => ReactNode;
  searchable?: boolean;
  searchMinOptions?: number;
  searchPlaceholder?: string;
  emptyLabel?: string;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = "Выберите значение",
  disabled = false,
  className = "",
  menuClassName = "",
  portal = false,
  renderSelectedLabel,
  renderOption,
  searchable = true,
  searchMinOptions = 6,
  searchPlaceholder = "Поиск...",
  emptyLabel = "Ничего не найдено",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [portalMenuStyle, setPortalMenuStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedOption = useMemo(() => options.find((option) => option.value === value), [options, value]);
  const showSearch = searchable && options.length >= searchMinOptions;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter((option) => {
      const haystack = [option.label, option.description || "", option.value]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, options]);

  const updatePortalMenuPosition = () => {
    if (!portal || !open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const menuHeight = menuRef.current?.offsetHeight ?? 260;
    const belowTop = rect.bottom + 6;
    const aboveTop = rect.top - menuHeight - 6;
    const shouldOpenUpward =
      belowTop + menuHeight > window.innerHeight - viewportPadding &&
      aboveTop >= viewportPadding;

    setPortalMenuStyle({
      position: "fixed",
      top: Math.max(
        viewportPadding,
        shouldOpenUpward ? aboveTop : belowTop,
      ),
      left: Math.max(viewportPadding, rect.left),
      width: Math.max(140, rect.width),
      zIndex: 220,
    });
  };

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      const inContainer = Boolean(containerRef.current?.contains(target));
      const inMenu = Boolean(menuRef.current?.contains(target));
      if (!inContainer && !inMenu) {
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

  useEffect(() => {
    if (open) return;
    setSearchQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || !showSearch) return;
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [open, showSearch]);

  useLayoutEffect(() => {
    if (!open || !portal) return;
    updatePortalMenuPosition();
    const rafId = window.requestAnimationFrame(() => updatePortalMenuPosition());
    return () => window.cancelAnimationFrame(rafId);
  }, [open, portal, filteredOptions.length, showSearch]);

  useEffect(() => {
    if (!open || !portal) return;
    const handleReposition = () => updatePortalMenuPosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, portal]);

  const menu = (
    <div
      ref={menuRef}
      className={`dropdown-menu ${showSearch ? "with-search" : ""} ${portal ? "portal" : ""} ${menuClassName}`.trim()}
      style={portal ? portalMenuStyle : undefined}
    >
      {showSearch ? (
        <div className="dropdown-search">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="dropdown-search-input"
            autoComplete="off"
          />
        </div>
      ) : null}
      <div className="dropdown-options" role="listbox">
        {filteredOptions.length === 0 ? (
          <div className="dropdown-empty">{emptyLabel}</div>
        ) : (
          filteredOptions.map((option) => {
            const isSelected = option.value === value;
            const content = renderOption ? (
              renderOption(option, isSelected)
            ) : (
              <>
                {option.avatarSrc || option.avatarFallbackText ? (
                  <span className="dropdown-option-avatar" aria-hidden="true">
                    {option.avatarSrc ? (
                      <img src={option.avatarSrc} alt="" loading="lazy" />
                    ) : (
                      <span>{option.avatarFallbackText?.trim().charAt(0).toUpperCase()}</span>
                    )}
                  </span>
                ) : null}
                <span className="dropdown-option-text">
                  <strong>{option.label}</strong>
                  {option.description ? <span>{option.description}</span> : null}
                </span>
              </>
            );

            return (
              <button
                key={option.value}
                type="button"
                className={`dropdown-option ${isSelected ? "active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
              >
                {content}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className={`dropdown ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`dropdown-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selectedOption ? "dropdown-selected-label" : "dropdown-placeholder"}>
          {selectedOption
            ? renderSelectedLabel
              ? renderSelectedLabel(selectedOption)
              : selectedOption.label
            : placeholder}
        </span>
        <ChevronDown size={14} className={`dropdown-chevron ${open ? "open" : ""}`} />
      </button>
      {open ? (portal ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}
