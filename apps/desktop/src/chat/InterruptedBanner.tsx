import { useT } from '../i18n';

interface InterruptedBannerProps {
  visible: boolean;
  /** Optional retry action (§9.3) — the turn keeps its content and gains an
   *  inline `Interrupted` row; retry re-runs the turn. */
  onRetry?: () => void;
}

export function InterruptedBanner({ visible, onRetry }: InterruptedBannerProps) {
  const t = useT();
  if (!visible) {
    return null;
  }
  return (
    <div className="Interrupted" role="status">
      <span className="Interrupted-label">{t('chat.interrupted.label')}</span>
      <span className="Interrupted-note">{t('chat.interrupted.note')}</span>
      {onRetry && (
        <button type="button" className="Interrupted-action" onClick={onRetry}>
          {t('common.actions.retry')}
        </button>
      )}
    </div>
  );
}
