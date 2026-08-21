import { useEffect, useRef, useState } from 'react';
import type { StatusState } from '../chat/statusTypes';

export interface ToastStackProps {
  toasts: StatusState[];
  onDismiss: (timestamp: number) => void;
}

/** Top-right dismissible stack for warning/error/success statuses.
 *  V6 P2.6: toasts animate in on mount (CSS) and animate out via a short
 *  leaving phase before removal (this component owns the exit choreography). */
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const id of timersRef.current.values()) window.clearTimeout(id);
    };
  }, []);

  if (toasts.length === 0 && leaving.size === 0) return null;

  function requestDismiss(timestamp: number) {
    if (leaving.has(timestamp)) return;
    setLeaving((current) => new Set(current).add(timestamp));
    const timer = window.setTimeout(() => {
      onDismiss(timestamp);
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(timestamp);
        return next;
      });
      timersRef.current.delete(timestamp);
    }, 160); // matches --duration-fast
    timersRef.current.set(timestamp, timer);
  }

  return (
    <div className="toast-stack" aria-live="assertive">
      {toasts.map((toast) => (
        <div
          key={toast.timestamp}
          className={`toast kind-${toast.kind}${leaving.has(toast.timestamp) ? ' leaving' : ''}`}
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
            onClick={() => requestDismiss(toast.timestamp)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
