import { useMemo, useRef, useState } from 'react';
import type { ProviderUsage } from '@conduit/config-schema';
import { ForkIcon, MoreIcon, SpeakerIcon, StopIcon, TrashIcon } from '../icons';
import { useLocale, useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { readAloud, speechLanguage, stopReadAloud, useReadAloud } from '../lib/readAloud';
import { Menu } from '../workspace/Menu';
import { formatUsageParts } from './UsageSummary';

interface TurnMoreMenuProps {
  messageId?: string;
  text: string;
  /** Read aloud is offered only for a finished reply. */
  readable: boolean;
  onFork?: () => void;
  onDelete?: () => void;
  usage?: ProviderUsage;
}

/**
 * The reply's ⋯ button. In a narrow thread (CSS, `@container thread`) the
 * actions row keeps Copy and Retry and folds Read aloud, Fork, Delete and the
 * token usage in here; in a wide thread this button is hidden and those stay
 * in the row. Both are rendered, so the switch is pure CSS and needs no
 * measuring.
 */
export function TurnMoreMenu({ messageId, text, readable, onFork, onDelete, usage }: TurnMoreMenuProps) {
  const t = useT();
  const fmt = useFormatters();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { supported, speaking, hasVoice } = useReadAloud(messageId);
  const lang = useMemo(() => speechLanguage(text, locale), [text, locale]);
  const canRead = Boolean(messageId) && readable && supported && text.trim() !== '';
  const usageParts = usage ? formatUsageParts(usage, fmt) : [];

  if (!canRead && !onFork && !onDelete && usageParts.length === 0) return null;

  return (
    <span className="turn-more">
      <button
        ref={triggerRef}
        type="button"
        className="act turn-more-btn"
        aria-label={t('chat.assistant.actions.more')}
        title={t('chat.assistant.actions.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="menu turn-more-menu"
        label={t('chat.assistant.actions.more')}
        dismissOnOutsidePress
      >
        {canRead ? (
          speaking ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                stopReadAloud();
              }}
            >
              <StopIcon />
              <span>{t('chat.assistant.actions.stopReading')}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={!hasVoice(lang)}
              onClick={() => {
                setOpen(false);
                readAloud(messageId!, text, lang);
              }}
            >
              <SpeakerIcon />
              <span>{t('chat.assistant.actions.readAloud')}</span>
            </button>
          )
        ) : null}
        {onFork ? (
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onFork();
            }}
          >
            <ForkIcon />
            <span>{t('common.actions.fork')}</span>
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            role="menuitem"
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <TrashIcon />
            <span>{t('common.actions.delete')}</span>
          </button>
        ) : null}
        {usageParts.length > 0 ? (
          <>
            {canRead || onFork || onDelete ? <div className="menu-sep" role="separator" /> : null}
            <div className="turn-more-usage">{usageParts.join(' · ')}</div>
          </>
        ) : null}
      </Menu>
    </span>
  );
}
