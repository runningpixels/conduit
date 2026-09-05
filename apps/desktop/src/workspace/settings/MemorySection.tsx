import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import type { MemoryItem, MemoryKind } from '../../ipc/contracts';
import {
  acceptMemoryItem,
  createMemoryItem,
  deleteMemoryItem,
  listMemoryItems,
  updateMemoryItem,
} from '../../ipc/client';

interface MemorySectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

export function MemorySection({ settings, onUpdate, onStatus }: MemorySectionProps) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<MemoryKind>('core');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listMemoryItems());
    } catch (e) {
      onStatus(`Failed to load memory: ${String(e)}`);
    }
  }, [onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = items.filter((i) => i.status === 'pending');
  const active = items.filter((i) => i.status === 'active');

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      onStatus(label);
      await refresh();
    } catch (e) {
      onStatus(`${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="srow">
        <span className="srow-text">
          <b>Use saved memory</b>
          <small>Inject saved facts into every chat. Off stops injection immediately.</small>
        </span>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-pressed={settings.memoryEnabled}
          aria-label="Use saved memory"
          onClick={() => onUpdate({ ...settings, memoryEnabled: !settings.memoryEnabled })}
        />
      </div>

      <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
        <textarea
          placeholder="A fact to remember — e.g. I prefer terse commit messages"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          style={{
            width: '100%',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--line)',
            background: 'var(--card)',
            color: 'var(--ink)',
            padding: '8px 10px',
            fontSize: 13,
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            aria-label="Memory kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
            style={{
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--line)',
              background: 'var(--card)',
              color: 'var(--ink)',
              padding: '6px 8px',
            }}
          >
            <option value="core">Core</option>
            <option value="note">Note</option>
          </select>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() =>
              void run('Saved memory', async () => {
                await createMemoryItem(draft.trim(), kind);
                setDraft('');
              })
            }
          >
            Save fact
          </button>
        </div>
      </div>

      {pending.length > 0 ? (
        <div className="memory-pending">
          <div className="settings-section-header">Waiting for you</div>
          <p className="sheet-sub" style={{ marginTop: 0 }}>
            The model proposed these. They are not injected until you save them.
          </p>
          <ul className="skill-list">
            {pending.map((item) => (
              <li key={item.id} className="skill-row">
                <div className="skill-row-main">
                  <small>{item.body}</small>
                </div>
                <div className="skill-row-actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void run('Saved proposed memory', () => acceptMemoryItem(item.id))}
                  >
                    Save
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => void run('Discarded proposal', () => deleteMemoryItem(item.id))}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {active.length === 0 && pending.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          No saved facts yet. Add one here, or let the model propose via the remember tool
          and confirm above.
        </p>
      ) : (
        <ul className="skill-list">
          {active.map((item) => (
            <li key={item.id} className="skill-row">
              {editingId === item.id ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    style={{
                      width: '100%',
                      borderRadius: 'var(--r-sm)',
                      border: '1px solid var(--line)',
                      background: 'var(--card)',
                      color: 'var(--ink)',
                      padding: '8px 10px',
                    }}
                  />
                  <div className="skill-row-actions">
                    <button
                      className="btn primary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run('Updated memory', async () => {
                          await updateMemoryItem(item.id, editBody, item.kind, item.pinned);
                          setEditingId(null);
                        })
                      }
                    >
                      Save
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="skill-row-main">
                    <div className="skill-row-title">
                      <b>{item.kind === 'core' ? 'Core' : 'Note'}</b>
                      {item.pinned ? <span className="skill-flag">pinned</span> : null}
                    </div>
                    <small>{item.body}</small>
                  </div>
                  <div className="skill-row-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(item.pinned ? 'Unpinned' : 'Pinned', () =>
                          updateMemoryItem(item.id, item.body, item.kind, !item.pinned),
                        )
                      }
                    >
                      {item.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditBody(item.body);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm('Delete this memory?')) return;
                        void run('Deleted memory', () => deleteMemoryItem(item.id));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
