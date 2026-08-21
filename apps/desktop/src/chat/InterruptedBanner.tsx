interface InterruptedBannerProps {
  visible: boolean;
  /** Optional retry action (§9.3) — the turn keeps its content and gains an
   *  inline `Interrupted` row; retry re-runs the turn. */
  onRetry?: () => void;
}

export function InterruptedBanner({ visible, onRetry }: InterruptedBannerProps) {
  if (!visible) {
    return null;
  }
  return (
    <div className="Interrupted" role="status">
      <span className="Interrupted-label">Interrupted</span>
      <span className="Interrupted-note">Partial output was saved.</span>
      {onRetry && (
        <button type="button" className="Interrupted-action" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
