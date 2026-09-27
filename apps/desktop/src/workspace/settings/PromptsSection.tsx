import { useCallback, useEffect, useState } from 'react';
import type { Prompt } from '../../ipc/contracts';
import {
  createPrompt,
  deletePrompt,
  listPromptFolders,
  listPrompts,
  updatePrompt,
} from '../../ipc/client';
import { useT, type Translate } from '../../i18n';
import { useFormatters } from '../../i18n/formatters';
import { PageEmpty, PageListItem } from '../../shell/PageFrame';
import { embeddedLibraryFrame, type LibraryFrame } from './LibraryLayout';
import { VariableFillDialog } from './VariableFillDialog';

interface PromptsSectionProps {
  onStatus: (message: string) => void;
  onInsertPrompt: (body: string) => void;
  /** How the parts are arranged; the Library page passes its PageFrame. */
  frame?: LibraryFrame;
}

interface EditingPrompt {
  id?: string; // undefined = new prompt
  title: string;
  body: string;
  folder: string;
  tags: string;
}

const emptyEditor: EditingPrompt = { title: '', body: '', folder: '', tags: '' };

/** Parse space-separated tags from the input string. */
function parseTags(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Highlight {{variable}} tokens in prompt body text. */
function highlightVariables(body: string, t: Translate): React.ReactNode {
  const parts = body.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) => {
    if (part.startsWith('{{') && part.endsWith('}}')) {
      return (
        <span key={i} className="variable-token" title={t('settings.prompts.variableTokenTitle', { name: part.slice(2, -2) })}>
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function PromptsSection({ onStatus, onInsertPrompt, frame = embeddedLibraryFrame }: PromptsSectionProps) {
  const t = useT();
  const fmt = useFormatters();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  /// The prompt shown in the detail pane. Null (or an id no longer in the
  /// list) falls back to the first prompt, so there is always a selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingPrompt | null>(null);
  /// The prompt whose `{{variable}}` tokens are being filled in before insert.
  /// Null when nothing is waiting -- a prompt with no variables never gets here.
  const [filling, setFilling] = useState<Prompt | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([
        listPrompts(selectedFolder ?? undefined),
        listPromptFolders(),
      ]);
      setPrompts(p);
      setFolders(f);
    } catch (e) {
      onStatus(t('settings.prompts.status.loadFailed', { error: String(e) }));
    }
  }, [selectedFolder, onStatus, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = prompts.find((p) => p.id === selectedId) ?? prompts[0] ?? null;

  const handleSave = useCallback(async () => {
    if (!editing || !editing.title.trim() || !editing.body.trim()) {
      onStatus(t('settings.prompts.status.titleBodyRequired'));
      return;
    }
    setSaving(true);
    try {
      const tags = parseTags(editing.tags);
      const folder = editing.folder.trim() || undefined;
      if (editing.id) {
        await updatePrompt(editing.id, editing.title.trim(), editing.body.trim(), folder, tags);
        onStatus(t('settings.prompts.status.updated'));
      } else {
        const created = await createPrompt(editing.title.trim(), editing.body.trim(), folder, tags);
        onStatus(t('settings.prompts.status.created'));
        if (created?.id) setSelectedId(created.id);
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      onStatus(t('settings.prompts.status.saveFailed', { error: String(e) }));
    } finally {
      setSaving(false);
    }
  }, [editing, refresh, onStatus, t]);

  const handleDelete = useCallback(
    async (id: string, title: string) => {
      if (!confirm(t('settings.prompts.confirm.delete', { title }))) return;
      try {
        await deletePrompt(id);
        onStatus(t('settings.prompts.status.deleted'));
        if (editing?.id === id) setEditing(null);
        if (selectedId === id) setSelectedId(null);
        await refresh();
      } catch (e) {
        onStatus(t('settings.prompts.status.deleteFailed', { error: String(e) }));
      }
    },
    [editing, selectedId, refresh, onStatus, t],
  );

  const handleEdit = useCallback((p: Prompt) => {
    setEditing({
      id: p.id,
      title: p.title,
      body: p.body,
      folder: p.folder ?? '',
      tags: (p.tags ?? []).join(', '),
    });
  }, []);

  const handleNew = useCallback(() => {
    setEditing({
      ...emptyEditor,
      folder: selectedFolder ?? '',
    });
  }, [selectedFolder]);

  const handleInsert = useCallback(
    (p: Prompt) => {
      // A prompt with variables gets filled in first; inserting the raw body
      // would drop `{{name}}` into the composer for the user to find and fix
      // by hand.
      if (p.variables && p.variables.length > 0) {
        setFilling(p);
        return;
      }
      onInsertPrompt(p.body);
    },
    [onInsertPrompt],
  );

  const allFolders = [...new Set([...folders, ...(selectedFolder ? [selectedFolder] : [])])].sort();

  const updated = (p: Prompt) => fmt.timeAgo(p.updatedAt ?? p.createdAt);

  const newButton = (
    <button className="btn primary" type="button" onClick={handleNew}>
      {t('shell.library.prompts.new')}
    </button>
  );

  const listHeader =
    allFolders.length > 0 ? (
      <label className="library-filter">
        <span className="library-filter-label">{t('shell.library.prompts.folderFilter')}</span>
        <select
          className="library-select"
          value={selectedFolder ?? ''}
          onChange={(e) => setSelectedFolder(e.target.value || null)}
        >
          <option value="">{t('settings.prompts.folder.all')}</option>
          {allFolders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;

  const list =
    prompts.length === 0 ? (
      <p className="library-list-hint">
        {selectedFolder
          ? t('settings.prompts.list.emptyFolder', { folder: selectedFolder })
          : t('shell.library.prompts.empty.title')}
      </p>
    ) : (
      prompts.map((p) => (
        <PageListItem
          key={p.id}
          selected={editing ? editing.id === p.id : selected?.id === p.id}
          onSelect={() => {
            setSelectedId(p.id);
            setEditing(null);
          }}
          title={p.title}
          meta={[p.folder, (p.tags ?? []).join(', '), updated(p)].filter(Boolean).join(' · ')}
        />
      ))
    );

  let detail: React.ReactNode;
  if (editing) {
    const heading = editing.id ? t('settings.prompts.editor.editTitle') : t('settings.prompts.editor.newTitle');
    detail = (
      <form
        className="library-detail library-editor"
        aria-label={heading}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <header className="library-detail-head">
          <h3 className="library-detail-title">{heading}</h3>
        </header>
        <label className="field">
          <span className="field-label">{t('shell.library.prompts.field.title')}</span>
          <input
            className="library-input"
            autoFocus
            placeholder={t('settings.prompts.editor.titlePlaceholder')}
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">{t('shell.library.prompts.field.body')}</span>
          <textarea
            className="library-input library-textarea"
            placeholder={t('settings.prompts.editor.bodyPlaceholder')}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            rows={10}
          />
        </label>
        <div className="library-editor-row">
          <label className="field">
            <span className="field-label">{t('shell.library.prompts.field.folder')}</span>
            <input
              className="library-input"
              placeholder={t('settings.prompts.editor.folderPlaceholder')}
              value={editing.folder}
              onChange={(e) => setEditing({ ...editing, folder: e.target.value })}
              list="prompt-folders"
            />
          </label>
          <datalist id="prompt-folders">
            {allFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <label className="field">
            <span className="field-label">{t('shell.library.prompts.field.tags')}</span>
            <input
              className="library-input"
              placeholder={t('settings.prompts.editor.tagsPlaceholder')}
              value={editing.tags}
              onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
            />
          </label>
        </div>
        <div className="library-editor-actions">
          <button className="btn ghost" type="button" onClick={() => setEditing(null)} disabled={saving}>
            {t('common.actions.cancel')}
          </button>
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? t('settings.prompts.editor.saving') : t('common.actions.save')}
          </button>
        </div>
      </form>
    );
  } else if (selected) {
    const p = selected;
    detail = (
      <article className="library-detail" aria-labelledby={`prompt-title-${p.id}`}>
        <header className="library-detail-head">
          <div className="library-detail-heading">
            <h3 className="library-detail-title" id={`prompt-title-${p.id}`}>
              {p.title}
            </h3>
            <p className="library-detail-meta">
              {[p.folder, t('shell.library.prompts.updated', { when: updated(p) })].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="library-detail-actions">
            <button className="btn primary" type="button" onClick={() => handleInsert(p)}>
              {t('shell.library.prompts.insert')}
            </button>
            <button className="btn ghost" type="button" onClick={() => handleEdit(p)}>
              {t('common.actions.edit')}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => void handleDelete(p.id, p.title)}
              title={t('settings.prompts.actions.deleteTitle')}
            >
              {t('common.actions.delete')}
            </button>
          </div>
        </header>
        <section className="grp">
          <div className="grp-label">{t('shell.library.prompts.field.body')}</div>
          <div className="library-prompt-body">{highlightVariables(p.body, t)}</div>
        </section>
        {p.variables && p.variables.length > 0 ? (
          <section className="grp">
            <div className="grp-label">{t('shell.library.prompts.variables')}</div>
            <div className="library-chips">
              {p.variables.map((v) => (
                <span key={v} className="variable-token">
                  {v}
                </span>
              ))}
            </div>
          </section>
        ) : null}
        {p.tags && p.tags.length > 0 ? (
          <section className="grp">
            <div className="grp-label">{t('shell.library.prompts.field.tags')}</div>
            <div className="library-chips">
              {p.tags.map((tag) => (
                <span key={tag} className="library-chip">
                  {tag}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </article>
    );
  } else {
    detail = selectedFolder ? (
      <PageEmpty title={t('settings.prompts.list.emptyFolder', { folder: selectedFolder })} action={newButton} />
    ) : (
      <PageEmpty
        title={t('shell.library.prompts.empty.title')}
        body={t('shell.library.prompts.empty.body')}
        action={newButton}
      />
    );
  }

  const detailWithDialog = (
    <>
      {detail}
      {filling && (
        <VariableFillDialog
          prompt={filling}
          onConfirm={(filledBody) => {
            setFilling(null);
            onInsertPrompt(filledBody);
          }}
          onCancel={() => setFilling(null)}
        />
      )}
    </>
  );

  return <>{frame({ actions: newButton, listHeader, list, detail: detailWithDialog })}</>;
}
