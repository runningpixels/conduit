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
import { useT } from '../../i18n';

interface MemorySectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

export function MemorySection({ settings, onUpdate, onStatus }: MemorySectionProps) {
  const t = useT();
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
      onStatus(t('settings.memory.status.loadFailed', { error: String(e) }));
    }
  }, [onStatus, t]);

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
      onStatus(t('settings.memory.status.actionFailed', { label, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.memory.toggle.label')}</b>
          <small>{t('settings.memory.toggle.hint')}</small>
        </span>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-pressed={settings.memoryEnabled}
          aria-label={t('settings.memory.toggle.label')}
          onClick={() => onUpdate({ ...settings, memoryEnabled: !settings.memoryEnabled })}
        />
      </div>

      <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
        <textarea
          placeholder={t('settings.memory.draft.placeholder')}
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
            aria-label={t('settings.memory.kind.ariaLabel')}
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
            <option value="core">{t('settings.memory.kind.core')}</option>
            <option value="note">{t('settings.memory.kind.note')}</option>
          </select>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() =>
              void run(t('settings.memory.status.savedMemory'), async () => {
                await createMemoryItem(draft.trim(), kind);
                setDraft('');
              })
            }
          >
            {t('settings.memory.actions.saveFact')}
          </button>
        </div>
      </div>

      {pending.length > 0 ? (
        <div className="memory-pending">
          <div className="settings-section-header">{t('settings.memory.pending.header')}</div>
          <p className="sheet-sub" style={{ marginTop: 0 }}>
            {t('settings.memory.pending.hint')}
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
                    onClick={() =>
                      void run(t('settings.memory.status.savedProposal'), () => acceptMemoryItem(item.id))
                    }
                  >
                    {t('common.actions.save')}
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(t('settings.memory.status.discardedProposal'), () => deleteMemoryItem(item.id))
                    }
                  >
                    {t('settings.memory.actions.discard')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {active.length === 0 && pending.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t('settings.memory.empty.hint')}</p>
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
                        void run(t('settings.memory.status.updatedMemory'), async () => {
                          await updateMemoryItem(item.id, editBody, item.kind, item.pinned);
                          setEditingId(null);
                        })
                      }
                    >
                      {t('common.actions.save')}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setEditingId(null)}>
                      {t('common.actions.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="skill-row-main">
                    <div className="skill-row-title">
                      <b>{item.kind === 'core' ? t('settings.memory.kind.core') : t('settings.memory.kind.note')}</b>
                      {item.pinned ? <span className="skill-flag">{t('settings.memory.pinnedFlag')}</span> : null}
                    </div>
                    <small>{item.body}</small>
                  </div>
                  <div className="skill-row-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          item.pinned
                            ? t('settings.memory.status.unpinned')
                            : t('settings.memory.status.pinned'),
                          () => updateMemoryItem(item.id, item.body, item.kind, !item.pinned),
                        )
                      }
                    >
                      {item.pinned ? t('settings.memory.actions.unpin') : t('settings.memory.actions.pin')}
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
                      {t('common.actions.edit')}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(t('settings.memory.confirm.delete'))) return;
                        void run(t('settings.memory.status.deletedMemory'), () => deleteMemoryItem(item.id));
                      }}
                    >
                      {t('common.actions.delete')}
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
