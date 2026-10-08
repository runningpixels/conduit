/// Memory (rail destination): what the assistant remembers about you.
///
/// A single column rather than list-and-detail: a memory is a sentence or
/// two, so the text *is* the item — a detail pane would only repeat the row.
/// Scanning every fact at once and editing in place is the job. Suggestions
/// the model proposed sit first, in their own highlighted block, because they
/// do nothing until accepted; saved facts follow, grouped by kind.
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, MemoryItem, MemoryKind } from '../ipc/contracts';
import { acceptMemoryItem, createMemoryItem, deleteMemoryItem, updateMemoryItem } from '../ipc/client';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { useMemoryItems } from '../workspace/settings/memory/useMemoryItems';
import { useAutoSave } from '../workspace/settings/useAutoSave';

/** Saved facts are grouped by kind, core first. */
const KIND_GROUPS: ReadonlyArray<{ kind: MemoryKind; labelId: string }> = [
  { kind: 'core', labelId: 'settings.memory.page.groupCore' },
  { kind: 'note', labelId: 'settings.memory.page.groupNotes' },
];

function KindSelect({ value, onChange }: { value: MemoryKind; onChange: (kind: MemoryKind) => void }) {
  const t = useT();
  return (
    <select
      className="sel"
      aria-label={t('settings.memory.kind.ariaLabel')}
      value={value}
      onChange={(e) => onChange(e.target.value as MemoryKind)}
    >
      <option value="core">{t('settings.memory.kind.core')}</option>
      <option value="note">{t('settings.memory.kind.note')}</option>
    </select>
  );
}

export function MemoryPage({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const save = useAutoSave(onSettingsChange, onStatus);
  const { items, loaded, busy, run, pending, active } = useMemoryItems(onStatus);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<MemoryKind>('core');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editKind, setEditKind] = useState<MemoryKind>('core');
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (composing) draftRef.current?.focus();
  }, [composing]);

  const openComposer = () => {
    setComposing(true);
    draftRef.current?.focus();
  };

  const toggle = (
    <label className="mem-switch">
      <span>{t('settings.memory.toggle.label')}</span>
      <button
        className="toggle"
        type="button"
        role="switch"
        aria-pressed={settings.memoryEnabled}
        aria-checked={settings.memoryEnabled}
        aria-label={t('settings.memory.toggle.label')}
        onClick={() => save({ ...settings, memoryEnabled: !settings.memoryEnabled })}
      />
    </label>
  );

  const addButton = (
    <button className="btn primary" type="button" onClick={openComposer}>
      {t('settings.memory.page.add')}
    </button>
  );

  const meta = (item: MemoryItem) => {
    const parts = [t('settings.memory.page.added', { when: fmt.timeAgo(item.createdAt) })];
    if (item.sourceWorkflow != null) {
      parts.push(
        item.sourceWorkflow
          ? t('settings.memory.page.fromWorkflowNamed', { name: item.sourceWorkflow })
          : t('settings.memory.page.fromWorkflow'),
      );
    } else if (item.sourceConversationId) parts.push(t('settings.memory.page.fromChat'));
    return parts.join(' · ');
  };

  const row = (item: MemoryItem) => (
    <li key={item.id} className="mem-row">
      {editingId === item.id ? (
        <div className="mem-edit">
          <textarea
            className="mem-input"
            aria-label={t('settings.memory.page.editLabel')}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={3}
          />
          <div className="mem-actions">
            <KindSelect value={editKind} onChange={setEditKind} />
            <button
              className="btn primary"
              type="button"
              disabled={busy || !editBody.trim()}
              onClick={() =>
                void run(t('settings.memory.status.updatedMemory'), async () => {
                  await updateMemoryItem(item.id, editBody, editKind, item.pinned);
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
          <div className="mem-main">
            <p className="mem-body">{item.body}</p>
            <p className="mem-meta">
              {item.pinned ? <span className="mem-flag">{t('settings.memory.pinnedFlag')}</span> : null}
              {meta(item)}
            </p>
          </div>
          <div className="mem-actions">
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  item.pinned ? t('settings.memory.status.unpinned') : t('settings.memory.status.pinned'),
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
                setEditKind(item.kind);
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
  );

  return (
    <PageFrame
      title={t('shell.settingsSheet.memory.heading')}
      subtitle={t('settings.memory.page.subtitle')}
      actions={
        <>
          {toggle}
          {addButton}
        </>
      }
      about={
        <>
          <p>{t('shell.settingsSheet.memory.intro')}</p>
          <p>{t('settings.memory.toggle.hint')}</p>
        </>
      }
    >
      <div className="mem-page">
        {!settings.memoryEnabled ? (
          <p className="mem-off" role="status">
            {t('settings.memory.page.off')}
          </p>
        ) : null}

        {composing ? (
          <section className="mem-composer" aria-label={t('settings.memory.page.add')}>
            <textarea
              ref={draftRef}
              className="mem-input"
              aria-label={t('settings.memory.page.bodyLabel')}
              placeholder={t('settings.memory.draft.placeholder')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
            <div className="mem-actions">
              <KindSelect value={kind} onChange={setKind} />
              <button
                className="btn primary"
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() =>
                  void run(t('settings.memory.status.savedMemory'), async () => {
                    await createMemoryItem(draft.trim(), kind);
                    setDraft('');
                    setComposing(false);
                  })
                }
              >
                {t('settings.memory.actions.saveFact')}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  setComposing(false);
                  setDraft('');
                }}
              >
                {t('common.actions.cancel')}
              </button>
            </div>
          </section>
        ) : null}

        {pending.length > 0 ? (
          <section className="mem-pending" aria-label={t('settings.memory.pending.header')}>
            <div className="mem-pending-head">
              <h3 className="mem-pending-title">{t('settings.memory.pending.header')}</h3>
              <p className="mem-pending-hint">{t('settings.memory.pending.hint')}</p>
            </div>
            <ul className="mem-list">
              {pending.map((item) => (
                <li key={item.id} className="mem-row">
                  <div className="mem-main">
                    <p className="mem-body">{item.body}</p>
                    <p className="mem-meta">
                      {t(item.kind === 'core' ? 'settings.memory.kind.core' : 'settings.memory.kind.note')}
                      {' · '}
                      {meta(item)}
                    </p>
                  </div>
                  <div className="mem-actions">
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
          </section>
        ) : null}

        {loaded && items.length === 0 && !composing ? (
          <PageEmpty
            title={t('settings.memory.page.emptyTitle')}
            body={t('settings.memory.page.emptyBody')}
            action={addButton}
          />
        ) : null}

        {KIND_GROUPS.map(({ kind: k, labelId }) => {
          const group = active.filter((i) => i.kind === k);
          if (group.length === 0) return null;
          return (
            <section key={k} className="grp" aria-label={t(labelId)}>
              <div className="grp-label">{t(labelId)}</div>
              <ul className="mem-list">{group.map(row)}</ul>
            </section>
          );
        })}
      </div>
    </PageFrame>
  );
}
