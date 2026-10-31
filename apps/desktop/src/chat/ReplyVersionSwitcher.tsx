import { useT } from '../i18n';
import { ChevronLeft, ChevronRight } from '../icons';

interface ReplyVersionSwitcherProps {
  /** How many versions the reply has (more than one). */
  count: number;
  /** The version the chat uses, 1-based. */
  current: number;
  /** Switch to a version. Absent on an earlier reply, which cannot switch. */
  onSelect?: (position: number) => void;
  /** Open the versions side by side (Compare). */
  onCompare?: () => void;
}

/** `‹ 2 / 3 ›` in a reply's actions: Retry keeps earlier replies as versions. */
export function ReplyVersionSwitcher({ count, current, onSelect, onCompare }: ReplyVersionSwitcherProps) {
  const t = useT();
  const label = t('chat.replyVersions.group', { current, count });
  return (
    <span
      className="reply-versions"
      role="group"
      aria-label={label}
      title={onSelect ? label : t('chat.replyVersions.lastOnly')}
      onKeyDown={(event) => {
        if (!onSelect) return;
        if (event.key === 'ArrowLeft' && current > 1) {
          event.preventDefault();
          onSelect(current - 1);
        } else if (event.key === 'ArrowRight' && current < count) {
          event.preventDefault();
          onSelect(current + 1);
        }
      }}
    >
      <button
        type="button"
        className="act reply-versions-step"
        aria-label={t('chat.replyVersions.previous')}
        disabled={!onSelect || current <= 1}
        onClick={() => onSelect?.(current - 1)}
      >
        <ChevronLeft />
      </button>
      <span className="reply-versions-count" aria-hidden="true">
        {current} / {count}
      </span>
      <button
        type="button"
        className="act reply-versions-step"
        aria-label={t('chat.replyVersions.next')}
        disabled={!onSelect || current >= count}
        onClick={() => onSelect?.(current + 1)}
      >
        <ChevronRight />
      </button>
      {onCompare && (
        <button
          type="button"
          className="act reply-versions-compare"
          title={t('chat.replyVersions.compareTitle')}
          onClick={onCompare}
        >
          {t('chat.replyVersions.compare')}
        </button>
      )}
    </span>
  );
}
