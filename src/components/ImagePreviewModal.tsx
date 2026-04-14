import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import type { ImageGenerationMeta } from "../types";
import type {
  LookEnhanceDetailKey,
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
} from "../ui/types";
import { Dropdown } from "./Dropdown";

interface ImagePreviewModalProps {
  src: string | null;
  alt?: string;
  meta?: ImageGenerationMeta;
  actionBusy?: boolean;
  enhanceTarget?: LookEnhanceTarget;
  enhanceTargetOptions?: Array<{ value: LookEnhanceTarget; label: string }>;
  enhancePromptDefaults?: LookEnhancePromptOverrides;
  onEnhanceTargetChange?: (nextTarget: LookEnhanceTarget) => void;
  onEnhance?: (
    targetOverride?: LookEnhanceTarget,
    promptOverride?: string | LookEnhancePromptOverrides,
  ) => void;
  onRegenerate?: (promptOverride?: string) => void;
  onClose: () => void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_PREVIEW_SCALE = 1;
const MAX_PREVIEW_SCALE = 5;
const WHEEL_ZOOM_SPEED = 0.0015;
const DOUBLE_TAP_MS = 280;
const ENHANCE_TARGET_OPTIONS: Array<{
  value: LookEnhanceTarget;
  label: string;
}> = [
  { value: "all", label: "Все части" },
  { value: "face", label: "Лицо" },
  { value: "eyes", label: "Глаза" },
  { value: "nose", label: "Нос" },
  { value: "lips", label: "Губы" },
  { value: "hands", label: "Руки" },
  { value: "chest", label: "Грудь" },
  { value: "vagina", label: "Вагина" },
];
const DETAIL_PROMPT_KEYS: LookEnhanceDetailKey[] = [
  "face",
  "eyes",
  "nose",
  "lips",
  "hands",
  "chest",
  "vagina",
];
const DETAIL_PROMPT_LABELS: Record<LookEnhanceDetailKey, string> = {
  face: "Лицо",
  eyes: "Глаза",
  nose: "Нос",
  lips: "Губы",
  hands: "Руки",
  chest: "Грудь",
  vagina: "Вагина",
};

function clampScale(value: number) {
  return Math.max(MIN_PREVIEW_SCALE, Math.min(MAX_PREVIEW_SCALE, value));
}

function getTouchDistance(event: TouchEvent<HTMLDivElement>) {
  if (event.touches.length < 2) return 0;
  const first = event.touches[0];
  const second = event.touches[1];
  const dx = first.clientX - second.clientX;
  const dy = first.clientY - second.clientY;
  return Math.hypot(dx, dy);
}

function getTouchMidpoint(event: TouchEvent<HTMLDivElement>): Point | null {
  if (event.touches.length < 2) return null;
  const first = event.touches[0];
  const second = event.touches[1];
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

export function ImagePreviewModal({
  src,
  alt = "preview",
  meta,
  actionBusy = false,
  enhanceTarget,
  enhanceTargetOptions,
  enhancePromptDefaults,
  onEnhanceTargetChange,
  onEnhance,
  onRegenerate,
  onClose,
}: ImagePreviewModalProps) {
  const [scale, setScale] = useState<number>(MIN_PREVIEW_SCALE);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [promptEditMode, setPromptEditMode] = useState<
    "enhance" | "regenerate" | null
  >(null);
  const [promptEditSourcePrompt, setPromptEditSourcePrompt] = useState("");
  const [promptEditDetailPrompts, setPromptEditDetailPrompts] = useState<
    Partial<Record<LookEnhanceDetailKey, string>>
  >({});
  const [localEnhanceTarget, setLocalEnhanceTarget] =
    useState<LookEnhanceTarget>("all");

  const panStartRef = useRef<Point | null>(null);
  const pinchDistanceRef = useRef<number>(0);
  const pinchMidpointRef = useRef<Point | null>(null);
  const lastTapRef = useRef<number>(0);
  const promptEditTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const zoomed = scale > MIN_PREVIEW_SCALE;
  const resolvedEnhanceTargetOptions =
    enhanceTargetOptions && enhanceTargetOptions.length > 0
      ? enhanceTargetOptions
      : ENHANCE_TARGET_OPTIONS;
  const fallbackEnhanceTarget =
    resolvedEnhanceTargetOptions.find((option) => option.value === "all")?.value ??
    resolvedEnhanceTargetOptions[0]?.value ??
    "all";
  const resolvedEnhanceTarget = enhanceTarget ?? localEnhanceTarget;
  const hasDetailPromptEditor = Boolean(enhancePromptDefaults?.detailPrompts);
  const activeEnhanceTarget = resolvedEnhanceTargetOptions.some(
    (option) => option.value === resolvedEnhanceTarget,
  )
    ? resolvedEnhanceTarget
    : fallbackEnhanceTarget;

  const handleEnhanceTargetChange = (nextTarget: LookEnhanceTarget) => {
    if (onEnhanceTargetChange) {
      onEnhanceTargetChange(nextTarget);
      return;
    }
    setLocalEnhanceTarget(nextTarget);
  };

  const resetTransform = () => {
    setScale(MIN_PREVIEW_SCALE);
    setOffset({ x: 0, y: 0 });
    setIsDragging(false);
    panStartRef.current = null;
    pinchDistanceRef.current = 0;
    pinchMidpointRef.current = null;
  };

  useEffect(() => {
    resetTransform();
  }, [src]);

  useEffect(() => {
    if (!src) {
      setPromptEditMode(null);
      setPromptEditSourcePrompt("");
      setPromptEditDetailPrompts({});
      return;
    }
    setPromptEditMode(null);
    if (!enhanceTarget) {
      setLocalEnhanceTarget(fallbackEnhanceTarget);
    }
  }, [src, meta?.prompt, enhanceTarget, fallbackEnhanceTarget]);

  useEffect(() => {
    if (!promptEditMode) return;
    const raf = window.requestAnimationFrame(() => {
      promptEditTextareaRef.current?.focus();
      const length = promptEditTextareaRef.current?.value.length ?? 0;
      promptEditTextareaRef.current?.setSelectionRange(length, length);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [promptEditMode, src]);

  if (!src) return null;

  const updateScale = (nextScale: number | ((prev: number) => number)) => {
    setScale((prev) => {
      const candidate = typeof nextScale === "function" ? nextScale(prev) : nextScale;
      const clamped = clampScale(candidate);
      if (clamped <= MIN_PREVIEW_SCALE) {
        setOffset({ x: 0, y: 0 });
        setIsDragging(false);
        panStartRef.current = null;
      }
      return clamped;
    });
  };

  const handleWheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = 1 - event.deltaY * WHEEL_ZOOM_SPEED;
    updateScale((prev) => prev * factor);
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!zoomed) return;
    event.preventDefault();
    setIsDragging(true);
    panStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !panStartRef.current || !zoomed) return;
    event.preventDefault();
    const dx = event.clientX - panStartRef.current.x;
    const dy = event.clientY - panStartRef.current.y;
    panStartRef.current = { x: event.clientX, y: event.clientY };
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const stopMouseDrag = () => {
    setIsDragging(false);
    panStartRef.current = null;
  };

  const toggleZoom = () => {
    if (zoomed) {
      resetTransform();
    } else {
      updateScale(2);
    }
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      const distance = getTouchDistance(event);
      pinchDistanceRef.current = distance;
      pinchMidpointRef.current = getTouchMidpoint(event);
      setIsDragging(true);
      panStartRef.current = null;
      return;
    }

    if (event.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
        event.preventDefault();
        toggleZoom();
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;

      if (zoomed) {
        const touch = event.touches[0];
        panStartRef.current = { x: touch.clientX, y: touch.clientY };
        setIsDragging(true);
      }
    }
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      event.preventDefault();
      const nextDistance = getTouchDistance(event);
      if (pinchDistanceRef.current > 0 && Number.isFinite(nextDistance)) {
        const ratio = nextDistance / pinchDistanceRef.current;
        updateScale((prev) => prev * ratio);
      }

      const nextMidpoint = getTouchMidpoint(event);
      if (nextMidpoint && pinchMidpointRef.current) {
        const dx = nextMidpoint.x - pinchMidpointRef.current.x;
        const dy = nextMidpoint.y - pinchMidpointRef.current.y;
        setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      }

      pinchDistanceRef.current = nextDistance;
      pinchMidpointRef.current = nextMidpoint;
      return;
    }

    if (event.touches.length === 1 && zoomed && panStartRef.current) {
      event.preventDefault();
      const touch = event.touches[0];
      const dx = touch.clientX - panStartRef.current.x;
      const dy = touch.clientY - panStartRef.current.y;
      panStartRef.current = { x: touch.clientX, y: touch.clientY };
      setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    }
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length >= 2) return;

    pinchDistanceRef.current = 0;
    pinchMidpointRef.current = null;

    if (event.touches.length === 1 && zoomed) {
      const touch = event.touches[0];
      panStartRef.current = { x: touch.clientX, y: touch.clientY };
      return;
    }

    panStartRef.current = null;
    setIsDragging(false);
  };

  const openPromptEditor = (mode: "enhance" | "regenerate") => {
    if (mode === "enhance") {
      setPromptEditSourcePrompt(
        enhancePromptDefaults?.sourcePrompt?.trim() || meta?.prompt?.trim() || "",
      );
      setPromptEditDetailPrompts({
        ...(enhancePromptDefaults?.detailPrompts ?? {}),
      });
    } else {
      setPromptEditSourcePrompt(meta?.prompt?.trim() ?? "");
      setPromptEditDetailPrompts({});
    }
    setPromptEditMode(mode);
  };

  const closePromptEditor = () => {
    setPromptEditMode(null);
  };

  const getNormalizedPromptOverride = () => {
    const promptOverride = promptEditSourcePrompt.trim();
    return promptOverride || undefined;
  };

  const setDetailPromptValue = (key: LookEnhanceDetailKey, value: string) => {
    setPromptEditDetailPrompts((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const getActiveDetailPromptKeys = () => {
    if (!hasDetailPromptEditor) return [] as LookEnhanceDetailKey[];
    if (activeEnhanceTarget === "all") return DETAIL_PROMPT_KEYS;
    if (DETAIL_PROMPT_KEYS.includes(activeEnhanceTarget as LookEnhanceDetailKey)) {
      return [activeEnhanceTarget as LookEnhanceDetailKey];
    }
    return [] as LookEnhanceDetailKey[];
  };

  const handlePromptEnhanceSubmit = () => {
    const sourcePrompt = getNormalizedPromptOverride();
    const detailPrompts: Partial<Record<LookEnhanceDetailKey, string>> = {};
    for (const key of getActiveDetailPromptKeys()) {
      const value = promptEditDetailPrompts[key]?.trim();
      const defaultValue = enhancePromptDefaults?.detailPrompts?.[key]?.trim() ?? "";
      if (value && value !== defaultValue) {
        detailPrompts[key] = value;
      }
    }
    const payload: LookEnhancePromptOverrides = {};
    if (sourcePrompt) {
      payload.sourcePrompt = sourcePrompt;
    }
    if (Object.keys(detailPrompts).length > 0) {
      payload.detailPrompts = detailPrompts;
    }
    onEnhance?.(
      activeEnhanceTarget,
      Object.keys(payload).length > 0 ? payload : undefined,
    );
    closePromptEditor();
  };

  const handlePromptRegenerateSubmit = () => {
    const promptOverride = getNormalizedPromptOverride();
    onRegenerate?.(promptOverride);
    closePromptEditor();
  };

  const handlePromptSubmit = () => {
    if (promptEditMode === "enhance") {
      handlePromptEnhanceSubmit();
      return;
    }
    handlePromptRegenerateSubmit();
  };

  const handlePromptEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      handlePromptSubmit();
    }
  };

  const overlay = (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
        {onEnhance || onRegenerate ? (
          <div className="image-preview-actions">
            {onEnhance ? (
              <>
                <Dropdown
                  value={activeEnhanceTarget}
                  options={resolvedEnhanceTargetOptions}
                  onChange={(value) =>
                    handleEnhanceTargetChange(
                      value as LookEnhanceTarget,
                    )
                  }
                  disabled={actionBusy}
                  className="image-preview-target-dropdown"
                />
                <div className="image-preview-split-action" role="group" aria-label="Действие улучшения">
                  <button
                    type="button"
                    className="image-preview-split-edit"
                    onClick={() => openPromptEditor("enhance")}
                    disabled={actionBusy}
                    title="Улучшить с правкой prompt"
                    aria-label="Улучшить с правкой prompt"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="image-preview-split-main"
                    onClick={() => onEnhance(activeEnhanceTarget)}
                    disabled={actionBusy}
                    title="Улучшить"
                  >
                    <Sparkles size={14} />
                    <span>Улучшить</span>
                  </button>
                </div>
              </>
            ) : null}
            {onRegenerate ? (
              <div className="image-preview-split-action" role="group" aria-label="Действие перегенерации">
                <button
                  type="button"
                  className="image-preview-split-edit"
                  onClick={() => openPromptEditor("regenerate")}
                  disabled={actionBusy}
                  title="Перегенерировать с правкой prompt"
                  aria-label="Перегенерировать с правкой prompt"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="image-preview-split-main"
                  onClick={() => onRegenerate()}
                  disabled={actionBusy}
                  title="Перегенерировать"
                >
                  <RefreshCw size={14} />
                  <span>Перегенерировать</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          className={`image-preview-media${zoomed ? " zoomed" : ""}${isDragging ? " dragging" : ""}`}
          onWheel={handleWheelZoom}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopMouseDrag}
          onMouseLeave={stopMouseDrag}
          onDoubleClick={toggleZoom}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <img
            src={src}
            alt={alt}
            className="image-preview-img"
            draggable={false}
            style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
          />
        </div>
        <section className="image-preview-meta" aria-label="Метаданные генерации">
          <div className="image-preview-meta-grid">
            <p>
              <strong>Flow:</strong> {meta?.flow ?? "—"}
            </p>
            <p>
              <strong>Seed:</strong> {Number.isFinite(meta?.seed) ? meta?.seed : "—"}
            </p>
            <p>
              <strong>Model:</strong> {meta?.model?.trim() || "—"}
            </p>
          </div>
          <div className="image-preview-meta-prompt">
            <strong>Prompt:</strong>
            <pre>{meta?.prompt?.trim() || "—"}</pre>
          </div>
        </section>
        {promptEditMode ? (
          <div
            className="prompt-edit-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={
              promptEditMode === "enhance"
                ? "Улучшение с правкой prompt"
                : "Перегенерация с правкой prompt"
            }
            onClick={() => {
              if (!actionBusy) {
                closePromptEditor();
              }
            }}
          >
            <div className="prompt-edit-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="prompt-edit-header">
                <h4>
                  {promptEditMode === "enhance"
                    ? `Улучшение (${resolvedEnhanceTargetOptions.find((option) => option.value === activeEnhanceTarget)?.label ?? "цель"})`
                    : "Перегенерация"}
                </h4>
                <button
                  type="button"
                  className="icon-btn mini"
                  onClick={closePromptEditor}
                  disabled={actionBusy}
                  aria-label="Закрыть"
                >
                  <X size={14} />
                </button>
              </div>
              <textarea
                ref={promptEditTextareaRef}
                className="prompt-edit-textarea"
                value={promptEditSourcePrompt}
                onChange={(event) =>
                  setPromptEditSourcePrompt(event.target.value)
                }
                onKeyDown={handlePromptEditorKeyDown}
                disabled={actionBusy}
              />
              {promptEditMode === "enhance" ? (
                <div className="prompt-edit-detail-grid">
                  {getActiveDetailPromptKeys().map((key) => (
                    <label key={key} className="prompt-edit-detail-field">
                      <span>{`detailPrompts.${key} (${DETAIL_PROMPT_LABELS[key]})`}</span>
                      <textarea
                        value={promptEditDetailPrompts[key] ?? ""}
                        onChange={(event) =>
                          setDetailPromptValue(key, event.target.value)
                        }
                        disabled={actionBusy}
                        rows={3}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="prompt-edit-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={closePromptEditor}
                  disabled={actionBusy}
                >
                  Отмена
                </button>
                {promptEditMode === "enhance" ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={handlePromptEnhanceSubmit}
                    disabled={actionBusy}
                  >
                    Улучшить
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={handlePromptRegenerateSubmit}
                    disabled={actionBusy}
                  >
                    Перегенерировать
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
