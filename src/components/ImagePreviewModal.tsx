import { X } from "lucide-react";
import type { ImageGenerationMeta } from "../types";

interface ImagePreviewModalProps {
  src: string | null;
  alt?: string;
  meta?: ImageGenerationMeta;
  onClose: () => void;
}

export function ImagePreviewModal({
  src,
  alt = "preview",
  meta,
  onClose,
}: ImagePreviewModalProps) {
  if (!src) return null;

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
        <img src={src} alt={alt} className="image-preview-img" />
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
