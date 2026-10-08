/// "Undo this update" on the run row of an "Update a deck / draft" step: puts
/// the document back to the history entry the step saved before it ran. Asks
/// first, like History does, and is used up for the rest of the session once
/// it worked (a second undo would only replace the document with itself).

import { useState } from 'react';
import { useT } from '../i18n';
import { restoreDeckSnapshot, restoreDraftSnapshot } from '../ipc/client';

/// `kind:id:snapshotId` of every undo done in this session.
const undone = new Set<string>();

export function UndoUpdate({
  kind,
  id,
  snapshotId,
  onRestore,
}: {
  kind: 'deck' | 'draft';
  id: string;
  snapshotId: string;
  /// Restores and reloads the document when it is open (the app shell). Without it the snapshot is restored directly.
  onRestore?: (kind: 'deck' | 'draft', id: string, snapshotId: string) => Promise<void>;
}) {
  const t = useT();
  const key = `${kind}:${id}:${snapshotId}`;
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(undone.has(key));
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    setWorking(true);
    setError(null);
    try {
      if (onRestore) await onRestore(kind, id, snapshotId);
      else if (kind === 'deck') await restoreDeckSnapshot(id, snapshotId);
      else await restoreDraftSnapshot(id, snapshotId);
      undone.add(key);
      setDone(true);
      setConfirming(false);
    } catch (e) {
      setError(t('workspace.workflows.runDetail.undoFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setWorking(false);
    }
  };

  if (confirming && !done) {
    const question = t(
      kind === 'deck' ? 'workspace.workflows.runDetail.undoConfirmDeck' : 'workspace.workflows.runDetail.undoConfirmDraft',
    );
    return (
      <span className="deck-history-confirm" role="group" aria-label={question}>
        <span className="deck-history-confirm-text">{question}</span>
        <button type="button" className="btn primary" disabled={working} onClick={() => void restore()}>
          {t('workspace.workflows.runDetail.undoRestore')}
        </button>
        <button type="button" className="btn" disabled={working} onClick={() => setConfirming(false)}>
          {t('common.actions.cancel')}
        </button>
        {error ? (
          <span className="wf-error" role="alert">
            {error}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <>
      <button type="button" className="btn ghost" disabled={done} onClick={() => setConfirming(true)}>
        {done ? t('workspace.workflows.runDetail.undoDone') : t('workspace.workflows.runDetail.undoUpdate')}
      </button>
      {error ? (
        <span className="wf-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
