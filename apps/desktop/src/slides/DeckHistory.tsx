/// The deck's history: one entry per saved state (after each AI turn that
/// changed the deck, plus the first one and restores). Restore asks inline,
/// in the row, never with a browser dialog.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { DeckSnapshotSummary } from '../ipc/contracts';

export interface DeckHistoryProps {
  /** Bumps when a snapshot may have been added; reloads the list. */
  revision: number;
  onList: () => Promise<DeckSnapshotSummary[]>;
  onRestore: (snapshotId: string) => Promise<void>;
  onClose: () => void;
}

export function DeckHistory({ revision, onList, onRestore, onClose }: DeckHistoryProps) {
  const t = useT();
  const fmt = useFormatters();
  const [snapshots, setSnapshots] = useState<DeckSnapshotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const listRef = useRef(onList);
  listRef.current = onList;

  const load = useCallback(async () => {
    try {
      setSnapshots(await listRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshots((s) => s ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const restore = async (id: string) => {
    setRestoring(id);
    try {
      await onRestore(id);
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <aside className="deck-history" aria-label={t('slides.history.title')}>
      <header className="deck-history-head">
        <h3 className="deck-history-title">{t('slides.history.title')}</h3>
        <button type="button" className="storyline-icon-btn" aria-label={t('slides.history.close')} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {error && (
        <p className="deck-history-error" role="alert">
          {error}
        </p>
      )}
      {snapshots && snapshots.length === 0 && !error && <p className="deck-history-empty">{t('slides.history.empty')}</p>}
      <ul className="deck-history-list">
        {(snapshots ?? []).map((s, i) => (
          <li key={s.id} className="deck-history-item">
            <span className="deck-history-label" title={s.label}>
              {s.label || t(`slides.history.cause.${s.cause}`)}
            </span>
            <span className="deck-history-meta">
              {fmt.timeAgo(s.createdAt)} · {t('slides.history.slides', { count: s.slideCount })}
            </span>
            {i === 0 ? (
              <span className="deck-history-current">{t('slides.history.current')}</span>
            ) : confirming === s.id ? (
              <span className="deck-history-confirm" role="group" aria-label={t('slides.history.confirm')}>
                <span className="deck-history-confirm-text">{t('slides.history.confirm')}</span>
                <button type="button" className="btn primary" disabled={restoring != null} onClick={() => void restore(s.id)}>
                  {t('slides.history.restore')}
                </button>
                <button type="button" className="btn" disabled={restoring != null} onClick={() => setConfirming(null)}>
                  {t('common.actions.cancel')}
                </button>
              </span>
            ) : (
              <button type="button" className="btn deck-history-restore" onClick={() => setConfirming(s.id)}>
                {t('slides.history.restore')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
