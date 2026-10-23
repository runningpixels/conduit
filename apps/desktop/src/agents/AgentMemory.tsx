/// The "Memory" and "What it can read" sections of the agent editor.
///
/// Memory: the switch for the agent's own notes, and (for a saved agent) the notes
/// themselves, which can be read, changed, removed and added to by hand. Empty is the
/// normal start: the agent adds notes as it works.
/// What it can read: one checkbox per collection of documents.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import {
  agentMemoryScope,
  createMemoryItem,
  deleteMemoryItem,
  listKnowledgeCollections,
  listMemoryItems,
  updateMemoryItem,
} from '../ipc/client';
import type { KnowledgeCollection, MemoryItem, MemoryOrigin } from '../ipc/contracts';

const ORIGIN_KEY: Record<MemoryOrigin, string> = {
  chat: 'shell.agents.editor.memory.fromChat',
  run: 'shell.agents.editor.memory.fromRun',
  scheduled_run: 'shell.agents.editor.memory.fromScheduledRun',
};

export function AgentMemory({
  agentId,
  on,
  onToggle,
}: {
  /// The saved agent's id; `null` while the agent is new.
  agentId: string | null;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  const t = useT();
  const [notes, setNotes] = useState<MemoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (agentId === null) return Promise.resolve();
    return Promise.resolve()
      .then(() => listMemoryItems(null, agentMemoryScope(agentId)))
      .then((list) => {
        setNotes(Array.isArray(list) ? list : []);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const origin = (note: MemoryItem) =>
    note.origin && ORIGIN_KEY[note.origin] ? t(ORIGIN_KEY[note.origin]) : t('shell.agents.editor.memory.byYou');

  return (
    <fieldset className="wf-tools agent-editor-group">
      <legend>{t('shell.agents.editor.memory.heading')}</legend>
      <label className="wf-check">
        <input type="checkbox" role="switch" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {t('shell.agents.editor.memory.switch')}
      </label>
      <p className="wf-muted">{t('shell.agents.editor.memory.hint')}</p>
      {agentId === null ? (
        <p className="wf-muted">{t('shell.agents.editor.memory.unsaved')}</p>
      ) : (
        <>
          {!on && notes !== null && notes.length > 0 ? (
            <p className="wf-muted">{t('shell.agents.editor.memory.off')}</p>
          ) : null}
          {failed ? (
            <p className="wf-error" role="status">
              {t('shell.agents.editor.memory.failed')}
            </p>
          ) : null}
          {notes !== null && notes.length === 0 && !adding ? (
            <p className="wf-muted">{t('shell.agents.editor.memory.none')}</p>
          ) : null}
          {notes !== null && notes.length > 0 ? (
            <ul className="mem-list agent-editor-notes">
              {notes.map((note) => (
                <li key={note.id} className="mem-row">
                  {editingId === note.id ? (
                    <div className="mem-edit">
                      <textarea
                        className="mem-input"
                        rows={3}
                        aria-label={t('shell.agents.editor.memory.editLabel')}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                      />
                      <div className="mem-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={busy || !editBody.trim()}
                          onClick={() =>
                            void run(async () => {
                              await updateMemoryItem(note.id, editBody.trim(), note.kind, note.pinned);
                              setEditingId(null);
                            })
                          }
                        >
                          {t('common.actions.save')}
                        </button>
                        <button type="button" className="btn ghost" onClick={() => setEditingId(null)}>
                          {t('common.actions.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mem-main">
                        <p className="mem-body">{note.body}</p>
                        <p className="mem-meta">{origin(note)}</p>
                      </div>
                      <div className="mem-actions">
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(note.id);
                            setEditBody(note.body);
                          }}
                        >
                          {t('common.actions.edit')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={() => void run(() => deleteMemoryItem(note.id))}
                        >
                          {t('common.actions.delete')}
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {adding ? (
            <div className="mem-edit">
              <textarea
                className="mem-input"
                rows={3}
                autoFocus
                aria-label={t('shell.agents.editor.memory.newLabel')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mem-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !draft.trim()}
                  onClick={() =>
                    void run(async () => {
                      await createMemoryItem(draft.trim(), 'note', false, agentMemoryScope(agentId));
                      setDraft('');
                      setAdding(false);
                    })
                  }
                >
                  {t('common.actions.save')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setAdding(false);
                    setDraft('');
                  }}
                >
                  {t('common.actions.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="mem-actions">
              <button type="button" className="btn ghost" onClick={() => setAdding(true)}>
                {t('shell.agents.editor.memory.add')}
              </button>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

export function AgentKnowledge({
  value,
  onToggle,
  onOpenDocuments,
}: {
  value: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  /// Go to where collections are made.
  onOpenDocuments?: () => void;
}) {
  const t = useT();
  const [all, setAll] = useState<KnowledgeCollection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listKnowledgeCollections())
      .then((list) => {
        if (!cancelled) setAll(Array.isArray(list) ? list : null);
      })
      .catch(() => {
        if (!cancelled) setAll(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gone = all ? value.filter((id) => !all.some((c) => c.id === id)) : [];
  return (
    <fieldset className="wf-tools agent-editor-group">
      <legend>{t('shell.agents.editor.knowledge.heading')}</legend>
      <p className="wf-muted">{t('shell.agents.editor.knowledge.hint')}</p>
      {all && all.length === 0 ? (
        <p className="wf-muted">
          {t('shell.agents.editor.knowledge.none')}{' '}
          {onOpenDocuments ? (
            <button type="button" className="btn ghost" onClick={onOpenDocuments}>
              {t('shell.agents.editor.knowledge.open')}
            </button>
          ) : null}
        </p>
      ) : null}
      {(all ?? []).map((c) => (
        <label key={c.id} className="wf-check">
          <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onToggle(c.id, e.target.checked)} />
          {t('workspace.workflows.editor.searchDocs.option', { name: c.name, count: c.documentCount })}
        </label>
      ))}
      {gone.map((id) => (
        <label key={id} className="wf-check">
          <input type="checkbox" checked onChange={(e) => onToggle(id, e.target.checked)} />
          {t('workspace.workflows.editor.searchDocs.gone')}
        </label>
      ))}
    </fieldset>
  );
}
