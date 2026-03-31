import { useEffect, useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from "react";
import { X } from "lucide-react";
import type { ImageGenerationMeta } from "../types";

interface ImagePreviewModalProps {
  src: string | null;
  alt?: string;
  meta?: ImageGenerationMeta;
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
  onClose,
}: ImagePreviewModalProps) {
  const [scale, setScale] = useState<number>(MIN_PREVIEW_SCALE);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const panStartRef = useRef<Point | null>(null);
  const pinchDistanceRef = useRef<number>(0);
  const pinchMidpointRef = useRef<Point | null>(null);
  const lastTapRef = useRef<number>(0);

  const zoomed = scale > MIN_PREVIEW_SCALE;

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

  if (!src) return null;

  try {
    console.debug("[tg-gf][preview][image-modal]", {
      src,
      hasMeta: Boolean(meta),
      meta: meta ?? null,
    });
  } catch {
    // no-op
  }

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

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
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
      </div>
    </div>
  );
}
