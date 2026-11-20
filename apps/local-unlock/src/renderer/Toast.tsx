import { useEffect } from 'react';

const TOAST_DURATION_MS = 4800;

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

export function Toast({ message, onDismiss }: ToastProps): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-mark" aria-hidden="true" />
      <p className="toast-message">{message}</p>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
