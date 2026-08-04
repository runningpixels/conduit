import { useCallback, useEffect, useState } from 'react';
import type { Prompt } from '../../ipc/contracts';
import {
  createPrompt,
  deletePrompt,
  listPromptFolders,
  listPrompts,
  updatePrompt,
} from '../../ipc/client';

interface PromptsSectionProps {
  onStatus: (message: string) => void;
  onInsertPrompt: (body: string) => void;
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
function highlightVariables(body: string): React.ReactNode {
  const parts = body.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) => {
    if (part.startsWith('{{') && part.endsWith('}}')) {
      return (
        <span key={i} className="variable-token" title={`Variable: ${part.slice(2, -2)}`}>
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** Truncate body text for preview while preserving variable tokens. */
function previewBody(body: string, maxLen = 120): string {
  if (body.length <= maxLen) return body;
  // Try to break at a token boundary
  const truncated = body.slice(0, maxLen);
  const lastToken = truncated.lastIndexOf('{{');
  const closeToken = truncated.indexOf('}}', lastToken);
  if (lastToken > maxLen - 40 && closeToken > lastToken) {
    return body.slice(0, closeToken + 2) + '…';
  }
  return truncated + '…';
}

export function PromptsSection({ onStatus, onInsertPrompt }: PromptsSectionProps) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingPrompt | null>(null);
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
      onStatus(`Failed to load prompts: ${String(e)}`);
    }
  }, [selectedFolder, onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    if (!editing || !editing.title.trim() || !editing.body.trim()) {
      onStatus('Title and body are required');
      return;
    }
    setSaving(true);
    try {
      const tags = parseTags(editing.tags);
      const folder = editing.folder.trim() || undefined;
      if (editing.id) {
        await updatePrompt(editing.id, editing.title.trim(), editing.body.trim(), folder, tags);
        onStatus('Prompt updated');
      } else {
        await createPrompt(editing.title.trim(), editing.body.trim(), folder, tags);
        onStatus('Prompt created');
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      onStatus(`Failed to save prompt: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [editing, refresh, onStatus]);

  const handleDelete = useCallback(
    async (id: string, title: string) => {
      if (!confirm(`Delete prompt "${title}"?`)) return;
      try {
        await deletePrompt(id);
        onStatus('Prompt deleted');
        if (editing?.id === id) setEditing(null);
        await refresh();
      } catch (e) {
        onStatus(`Failed to delete: ${String(e)}`);
      }
    },
    [editing, refresh, onStatus],
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

  const allFolders = [...new Set([...folders, ...(selectedFolder ? [selectedFolder] : [])])].sort();

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Prompts</span>
        <button
          className="btn primary"
          type="button"
          onClick={handleNew}
          style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: '12px' }}
        >
          + New prompt
        </button>
      </div>

      {editing && (
        <div className="prompts-editor" style={{ marginBottom: 16, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: '13px' }}>
            {editing.id ? 'Edit prompt' : 'New prompt'}
          </h4>
          <div style={{ display: 'grid', gap: 8 }}>
            <input
              placeholder="Title"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
            />
            <textarea
              placeholder="Prompt body — use {{variable}} for variable substitution"
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              rows={6}
              style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="Folder (optional)"
                value={editing.folder}
                onChange={(e) => setEditing({ ...editing, folder: e.target.value })}
                list="prompt-folders"
                style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
              />
              <datalist id="prompt-folders">
                {allFolders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <input
                placeholder="Tags (comma-separated)"
                value={editing.tags}
                onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
                style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              <button className="btn primary" type="button" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12 }}>
        {/* Folder sidebar */}
        <div className="prompts-folder-sidebar" style={{ borderRadius: 'var(--r-sm)', background: 'var(--card)', padding: 8 }}>
          <button
            className={`folder-btn${selectedFolder === null ? ' active' : ''}`}
            type="button"
            onClick={() => setSelectedFolder(null)}
            aria-pressed={selectedFolder === null}
          >
            All prompts
          </button>
          {allFolders.map((f) => (
            <button
              key={f}
              className={`folder-btn${selectedFolder === f ? ' active' : ''}`}
              type="button"
              onClick={() => setSelectedFolder(f)}
              aria-pressed={selectedFolder === f}
            >
              {f}
            </button>
          ))}
          {allFolders.length === 0 && (
            <span style={{ fontSize: '11px', color: 'var(--ink-3)', padding: '6px 8px', display: 'block' }}>
              No folders
            </span>
          )}
        </div>

        {/* Prompt list */}
        <div className="prompts-list" style={{ maxHeight: 400, overflowY: 'auto' }}>
          {prompts.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', fontSize: '13px', color: 'var(--ink-3)' }}>
              {selectedFolder ? `No prompts in "${selectedFolder}"` : 'No prompts yet. Create your first one!'}
            </div>
          )}
          {prompts.map((p) => (
            <div
              key={p.id}
              className="prompt-card"
              style={{
                padding: 12,
                marginBottom: 8,
                borderRadius: 'var(--r-sm)',
                background: 'var(--card)',
                cursor: 'pointer',
                border: editing?.id === p.id ? '1px solid var(--hue)' : '1px solid transparent',
              }}
              onClick={() => handleEdit(p)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <strong style={{ fontSize: '13px' }}>{p.title}</strong>
                  {p.folder && (
                    <span style={{ fontSize: '11px', color: 'var(--ink-3)', marginLeft: 8 }}>
                      {p.folder}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '2px 8px', fontSize: '11px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onInsertPrompt(p.body);
                    }}
                    title="Insert prompt into chat"
                  >
                    Insert
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '2px 8px', fontSize: '11px', color: 'var(--error)' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(p.id, p.title);
                    }}
                    title="Delete prompt"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.4 }}>
                {highlightVariables(previewBody(p.body))}
              </div>
              {p.tags && p.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {p.tags.map((tag) => (
                    <span key={tag} className="prompt-tag" style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--r-sm)', background: 'var(--card-hi)', color: 'var(--ink-3)' }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {p.variables && p.variables.length > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--hue)', marginTop: 4 }}>
                  Variables: {p.variables.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}