import { X } from "lucide-react";

interface ImagePreviewModalProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export function ImagePreviewModal({ src, alt = "preview", onClose }: ImagePreviewModalProps) {
  if (!src) return null;

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-dialog" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn image-preview-close" onClick={onClose} title="Закрыть">
          <X size={18} />
        </button>
        <img src={src} alt={alt} className="image-preview-img" />
      </div>
    </div>
  );
}

