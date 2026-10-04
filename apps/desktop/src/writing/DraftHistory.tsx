/// The draft's history: one entry per saved version (when it was created,
/// after each AI turn that changed it, after an editing session of yours, and
/// restores). Restore asks inline, in the row, never with a browser dialog.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { DraftSnapshotCause, DraftSnapshotSummary } from '../ipc/contracts';

export interface DraftHistoryProps {
  /** Bumps when a version may have been added; reloads the list. */
  revision: number;
  onList: () => Promise<DraftSnapshotSummary[]>;
  onRestore: (snapshotId: string) => Promise<void>;
}

const CAUSE_IDS: Record<DraftSnapshotCause, string> = {
  created: 'writing.history.cause.created',
  'ai-turn': 'writing.history.cause.aiTurn',
  manual: 'writing.history.cause.manual',
  restore: 'writing.history.cause.restore',
};

export function DraftHistory({ revision, onList, onRestore }: DraftHistoryProps) {
  const t = useT();
  const fmt = useFormatters();
  const [snapshots, setSnapshots] = useState<DraftSnapshotSummary[] | null>(null);
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
    <section className="deck-history draft-history" aria-label={t('writing.history.title')}>
      <header className="deck-history-head">
        <h3 className="deck-history-title">{t('writing.history.title')}</h3>
      </header>
      {error && (
        <p className="deck-history-error" role="alert">
          {error}
        </p>
      )}
      {snapshots && snapshots.length === 0 && !error && <p className="deck-history-empty">{t('writing.history.empty')}</p>}
      <ul className="deck-history-list">
        {(snapshots ?? []).map((s, i) => {
          const label = s.label?.trim() || t(CAUSE_IDS[s.cause] ?? CAUSE_IDS.manual);
          return (
            <li key={s.id} className="deck-history-item">
              <span className="deck-history-label" title={label}>
                {label}
              </span>
              <span className="deck-history-meta">
                {fmt.timeAgo(s.createdAt)} · {t('writing.history.words', { count: s.words })}
              </span>
              {i === 0 ? (
                <span className="deck-history-current">{t('writing.history.current')}</span>
              ) : confirming === s.id ? (
                <span className="deck-history-confirm" role="group" aria-label={t('writing.history.confirm')}>
                  <span className="deck-history-confirm-text">{t('writing.history.confirm')}</span>
                  <button type="button" className="btn primary" disabled={restoring != null} onClick={() => void restore(s.id)}>
                    {t('writing.history.restore')}
                  </button>
                  <button type="button" className="btn" disabled={restoring != null} onClick={() => setConfirming(null)}>
                    {t('common.actions.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn deck-history-restore"
                  aria-label={t('writing.history.restoreAria', { label })}
                  onClick={() => setConfirming(s.id)}
                >
                  {t('writing.history.restore')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
