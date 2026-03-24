import { AlertTriangle } from "lucide-react";

interface ErrorToastProps {
  error: string | null;
  onClose: () => void;
}

export function ErrorToast({ error, onClose }: ErrorToastProps) {
  if (!error) return null;

  return (
    <div className="error-toast">
      <AlertTriangle size={14} />
      <p>{error}</p>
      <button type="button" onClick={onClose}>
        ОК
      </button>
    </div>
  );
}
