import type { StatusState } from '../chat/statusTypes';

export interface ToastStackProps {
  toasts: StatusState[];
  onDismiss: (timestamp: number) => void;
}

/** Top-right dismissible stack for warning/error/success statuses. */
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="assertive">
      {toasts.map((toast) => (
        <div
          key={toast.timestamp}
          className={`toast kind-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <div className="toast-body">
            <strong className="toast-brief">{toast.brief}</strong>
            {toast.detail && <span className="toast-detail">{toast.detail}</span>}
          </div>
          <button
            className="toast-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.timestamp)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
