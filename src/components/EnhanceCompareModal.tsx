import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (open) {
      setPosition(50);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="enhance-compare-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
        <h3>Сравнение до/после</h3>
        <div className="enhance-compare-stage">
          <img src={beforeUrl} alt="before-enhance" className="enhance-before-img" />
          <img
            src={afterUrl}
            alt="after-enhance"
            className="enhance-after-overlay"
            style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          />
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
}
