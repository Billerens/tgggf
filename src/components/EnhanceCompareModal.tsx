import { useEffect, useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface EnhanceCompareModalProps {
  open: boolean;
  beforeUrl: string;
  afterUrl: string;
  onAccept: () => void;
  onKeepOld: () => void;
  onRegenerate: () => void;
  onClose: () => void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_COMPARE_SCALE = 1;
const MAX_COMPARE_SCALE = 5;
const WHEEL_ZOOM_SPEED = 0.0015;
const DOUBLE_TAP_MS = 280;

function clampScale(value: number) {
  return Math.max(MIN_COMPARE_SCALE, Math.min(MAX_COMPARE_SCALE, value));
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

export function EnhanceCompareModal({
  open,
  beforeUrl,
  afterUrl,
  onAccept,
  onKeepOld,
  onRegenerate,
  onClose,
}: EnhanceCompareModalProps) {
  const [position, setPosition] = useState(50);
  const [scale, setScale] = useState<number>(MIN_COMPARE_SCALE);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const panStartRef = useRef<Point | null>(null);
  const pinchDistanceRef = useRef<number>(0);
  const pinchMidpointRef = useRef<Point | null>(null);
  const lastTapRef = useRef<number>(0);
  const zoomed = scale > MIN_COMPARE_SCALE;

  const resetTransform = () => {
    setScale(MIN_COMPARE_SCALE);
    setOffset({ x: 0, y: 0 });
    setIsDragging(false);
    panStartRef.current = null;
    pinchDistanceRef.current = 0;
    pinchMidpointRef.current = null;
  };

  useEffect(() => {
    if (open) {
      setPosition(50);
      resetTransform();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    resetTransform();
  }, [beforeUrl, afterUrl, open]);

  if (!open) return null;

  const updateScale = (nextScale: number | ((prev: number) => number)) => {
    setScale((prev) => {
      const candidate = typeof nextScale === "function" ? nextScale(prev) : nextScale;
      const clamped = clampScale(candidate);
      if (clamped <= MIN_COMPARE_SCALE) {
        setOffset({ x: 0, y: 0 });
        setIsDragging(false);
        panStartRef.current = null;
      }
      return clamped;
    });
  };

  const handleWheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement)?.closest(".enhance-compare-slider")) return;
    event.preventDefault();
    const factor = 1 - event.deltaY * WHEEL_ZOOM_SPEED;
    updateScale((prev) => prev * factor);
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!zoomed) return;
    if ((event.target as HTMLElement)?.closest(".enhance-compare-slider")) return;
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
    if ((event.target as HTMLElement)?.closest(".enhance-compare-slider")) return;
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

  const transformStyle = { transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` };

  const overlay = (
    <div className="image-preview-overlay enhance-compare-overlay" onClick={onClose}>
      <div className="enhance-compare-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
        <h3>Сравнение до/после</h3>
        <div
          className={`enhance-compare-stage${zoomed ? " zoomed" : ""}${isDragging ? " dragging" : ""}`}
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
            src={beforeUrl}
            alt="before-enhance"
            className="enhance-before-img"
            draggable={false}
            style={transformStyle}
          />
          <div className="enhance-after-overlay" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
            <img
              src={afterUrl}
              alt="after-enhance"
              className="enhance-after-img"
              draggable={false}
              style={transformStyle}
            />
          </div>
          <div className="enhance-divider" style={{ left: `${position}%` }} />
          <span className="enhance-label before">До</span>
          <span className="enhance-label after">После</span>
          <input
            className="enhance-compare-slider"
            type="range"
            min={0}
            max={100}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
          />
        </div>
        <div className="enhance-compare-actions">
          <button type="button" className="primary" onClick={onAccept}>
            Сохранить новое
          </button>
          <button type="button" onClick={onKeepOld}>
            Оставить старое
          </button>
          <button type="button" onClick={onRegenerate}>
            Перегенерировать
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
