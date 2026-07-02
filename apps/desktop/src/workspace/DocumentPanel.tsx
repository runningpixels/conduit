import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Artifact, ArtifactContent, ArtifactKind, FileState } from '../ipc/contracts';
import { getArtifactContentBytes, readArtifactFileBytes } from '../ipc/client';
import { buildPreviewProps, selectRenderer } from '../artifacts/selectRenderer';
import { FilePlainIcon, ChevronRight, MoreIcon } from '../icons';

type DocTab = 'preview' | 'source';

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

/// Whether to show a sync/state dot for this artifact.
function showStateDot(state: FileState, hasFilePayload: boolean): boolean {
  if (!hasFilePayload) return false;
  return state === 'ok' || state === 'modified' || state === 'missing';
}

/// File-state → per-tab state-dot class (matches the CSS `tab-state` modifiers).
function tabStateClass(state: FileState): string {
  if (state === 'modified') return ' warn';
  if (state === 'missing') return ' bad';
  return '';
}

/// Derive the raw inline text for Copy + Source pane: prefer `contentText`,
/// fall back to pretty-printed `contentJson`, else empty.
function rawInlineText(artifact: Artifact): string {
  if (artifact.contentText != null) return artifact.contentText;
  if (artifact.contentJson != null) {
    try {
      return JSON.stringify(artifact.contentJson, null, 2);
    } catch {
      return String(artifact.contentJson);
    }
  }
  return '';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function DocPlaceholder({ children }: { children: ReactNode }) {
  return <p className="doc-placeholder">{children}</p>;
}

interface DocumentPanelProps {
  artifact: Artifact | null;
  openArtifacts: Artifact[];
  fileStateMap: Record<string, FileState>;
  activeFileState: FileState;
  allowlist: string[];
  styledPreview?: boolean;
  docTab: DocTab;
  onSelectTab: (tab: DocTab) => void;
  onOpenArtifact: (id: string) => void;
  onSaveContent: (artifactId: string, content: ArtifactContent, mimeType?: string) => Promise<void>;
  onExport: (artifactId: string, includeMetadata: boolean) => Promise<void>;
  onCloseTab?: (id: string) => void;
  onCollapsePanel?: () => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
}

export function DocumentPanel({
  artifact,
  openArtifacts,
  fileStateMap,
  activeFileState,
  allowlist,
  styledPreview = true,
  docTab,
  onSelectTab,
  onOpenArtifact,
  onSaveContent,
  onExport,
  onCloseTab,
  onCollapsePanel,
  onRenameArtifact,
}: DocumentPanelProps) {
  const [copied, setCopied] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const raw = useMemo(() => (artifact ? rawInlineText(artifact) : ''), [artifact]);
  const isFilePayload = artifact?.contentPath != null;
  const multiOpen = openArtifacts.length > 1;

  const [loadedText, setLoadedText] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    setLoadedText(null);
    setLoadFailed(false);
    if (!artifact || !isFilePayload) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await getArtifactContentBytes(artifact.id);
        if (cancelled) return;
        setLoadedText(new TextDecoder().decode(new Uint8Array(bytes)));
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact, isFilePayload]);

  const effectiveArtifact: Artifact | null = useMemo(() => {
    if (!artifact) return null;
    if (loadedText != null) {
      return { ...artifact, contentText: artifact.contentText ?? loadedText };
    }
    return artifact;
  }, [artifact, loadedText]);

  const sourceText = useMemo(() => (effectiveArtifact ? rawInlineText(effectiveArtifact) : ''), [effectiveArtifact]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedSource, setSavedSource] = useState(false);
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dismissedModified, setDismissedModified] = useState(false);

  useEffect(() => {
    setDraft(sourceText);
    setSavedSource(false);
  }, [sourceText]);

  useEffect(() => {
    setDismissedModified(false);
    setShowDetails(false);
    setMenuOpen(false);
  }, [artifact?.id, activeFileState]);

  useEffect(() => {
    if (activeFileState === 'missing') setShowDetails(true);
  }, [artifact?.id, activeFileState]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const dirty = draft !== sourceText;

  if (!artifact) {
    return (
      <section className="doc-panel doc-panel-empty" aria-label="Document panel" data-doc-tab={docTab}>
        <div className="doc-body scroll">
          <DocPlaceholder>No artifact open</DocPlaceholder>
        </div>
      </section>
    );
  }

  const name = artifact.title ?? 'Untitled artifact';
  const kindLabel = KIND_LABEL[artifact.kind] ?? artifact.kind;

  async function handleCopy() {
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
      setMenuOpen(false);
    } catch {
      /* ignore */
    }
  }

  async function handleSaveSource() {
    if (!artifact || !dirty || saving) return;
    setSaving(true);
    try {
      await onSaveContent(artifact.id, { kind: 'text', text: draft }, artifact.mimeType);
      setSavedSource(true);
      window.setTimeout(() => setSavedSource(false), 1400);
    } catch {
      /* failure surfaces via the App status line */
    } finally {
      setSaving(false);
    }
  }

  async function handleUseDisk() {
    if (!artifact || !artifact.contentPath || saving) return;
    setSaving(true);
    try {
      const bytes = await readArtifactFileBytes(artifact.id);
      const path = artifact.contentPath;
      const filename = path.includes('/') ? path.split('/').slice(1).join('/') : path;
      await onSaveContent(artifact.id, { kind: 'file', bytes, filename }, artifact.mimeType);
    } catch {
      /* failure surfaces via the App status line */
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    if (!artifact || exporting) return;
    setExporting(true);
    try {
      await onExport(artifact.id, includeMetadata);
      setMenuOpen(false);
    } catch {
      /* failure surfaces via the App status line */
    } finally {
      setExporting(false);
    }
  }

  const fileMeta: Array<{ k: string; v: string }> = [
    { k: 'Path', v: artifact.contentPath ?? '(inline)' },
    { k: 'Type', v: artifact.mimeType ?? kindLabel },
    { k: 'Updated', v: artifact.updatedAt ?? artifact.createdAt },
    ...(isFilePayload
      ? [
          { k: 'Size', v: formatSize(artifact.sizeBytes) },
        ]
      : []),
  ];

  function beginRename(id: string, currentTitle: string) {
    setEditingTabId(id);
    setEditingTabValue(currentTitle);
  }

  function commitRename() {
    const v = editingTabValue.trim();
    if (v && onRenameArtifact && artifact) void onRenameArtifact(artifact.id, v);
    setEditingTabId(null);
    setEditingTabValue('');
  }

  function cancelRename() {
    setEditingTabId(null);
    setEditingTabValue('');
  }

  return (
    <section
      className="doc-panel"
      aria-label="Document panel"
      data-doc-tab={docTab}
      data-file-state={activeFileState}
      data-multi-open={multiOpen ? 'true' : 'false'}
    >
      <div className="doc-toolbar">
        {!multiOpen ? (
          <div className="doc-toolbar-title">
            <div className="ficon"><FilePlainIcon /></div>
            <div className="doc-title">
              {editingTabId === artifact.id ? (
                <input
                  className="inline-title-input"
                  value={editingTabValue}
                  autoFocus
                  onChange={(e) => setEditingTabValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                />
              ) : (
                <b
                  onClick={() => onRenameArtifact && beginRename(artifact.id, name)}
                  style={onRenameArtifact ? { cursor: 'text' } : undefined}
                  title={name}
                >
                  {name}
                </b>
              )}
              <small>
                {kindLabel}
                {showStateDot(activeFileState, isFilePayload) && (
                  <span className={`tab-state inline${tabStateClass(activeFileState)}`} aria-hidden="true" />
                )}
              </small>
            </div>
          </div>
        ) : (
          <div className="artifact-tabs" aria-label="Open artifacts">
            {openArtifacts.map((a) => {
              const state = fileStateMap[a.id] ?? 'noFileContent';
              return (
                <button
                  key={a.id}
                  className={`artifact-file-tab${a.id === artifact.id ? ' active' : ''}`}
                  type="button"
                  data-state={state}
                  title={a.title ?? 'Untitled artifact'}
                  onClick={() => onOpenArtifact(a.id)}
                >
                  <FilePlainIcon />
                  {editingTabId === a.id && a.id === artifact.id ? (
                    <input
                      className="inline-title-input tab-name"
                      value={editingTabValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTabValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="tab-name"
                      onClick={(e) => {
                        if (a.id === artifact.id && onRenameArtifact) {
                          e.stopPropagation();
                          beginRename(a.id, a.title ?? '');
                        }
                      }}
                      style={a.id === artifact.id && onRenameArtifact ? { cursor: 'text' } : undefined}
                    >
                      {a.title ?? 'Untitled artifact'}
                    </span>
                  )}
                  {showStateDot(state, a.contentPath != null) && (
                    <span className={`tab-state${tabStateClass(state)}`} />
                  )}
                  {onCloseTab && (
                    <span
                      className="tab-close"
                      role="button"
                      tabIndex={0}
                      aria-label={`Close ${a.title ?? 'artifact'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(a.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onCloseTab(a.id);
                        }
                      }}
                    >
                      &times;
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <span className="doc-toolbar-spacer" />

        <div className="doc-view-toggle" role="tablist" aria-label="View mode">
          <button
            className={`doc-view-btn${docTab === 'preview' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={docTab === 'preview'}
            onClick={() => onSelectTab('preview')}
          >
            Preview
          </button>
          <button
            className={`doc-view-btn${docTab === 'source' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={docTab === 'source'}
            onClick={() => onSelectTab('source')}
          >
            Source
          </button>
        </div>

        <div className="doc-actions">
          <div className="doc-overflow" ref={menuRef}>
            <button
              className="icon-btn"
              type="button"
              aria-label="More actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <div className="doc-overflow-menu" role="menu">
                <button className="doc-overflow-item" type="button" role="menuitem" disabled={!raw} onClick={() => void handleCopy()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button className="doc-overflow-item" type="button" role="menuitem" disabled={!isFilePayload}>
                  Reveal in Explorer
                </button>
                <button
                  className="doc-overflow-item"
                  type="button"
                  role="menuitem"
                  disabled={exporting || saving}
                  onClick={() => void handleExport()}
                >
                  {exporting ? 'Exporting…' : 'Export'}
                </button>
                <label className="doc-overflow-item doc-overflow-check">
                  <input
                    type="checkbox"
                    checked={includeMetadata}
                    onChange={(e) => setIncludeMetadata(e.target.checked)}
                  />
                  Include metadata sidecar
                </label>
                <button
                  className="doc-overflow-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowDetails((open) => !open);
                    setMenuOpen(false);
                  }}
                >
                  {showDetails ? 'Hide details' : 'Details'}
                </button>
              </div>
            )}
          </div>
          {onCollapsePanel && (
            <button
              className="icon-btn"
              type="button"
              aria-label="Hide artifact panel"
              title="Hide artifact panel"
              onClick={onCollapsePanel}
            >
              <ChevronRight />
            </button>
          )}
        </div>
      </div>

      <div className="doc-body scroll">
        {activeFileState === 'modified' && !dismissedModified && (
          <div className="doc-banner warn">
            <strong>Modified on disk.</strong> Review before continuing.
            <div className="row">
              <button className="btn ghost" type="button" disabled={saving} onClick={() => void handleUseDisk()}>
                Use disk
              </button>
              <button className="btn ghost" type="button" onClick={() => setDismissedModified(true)}>
                Keep current
              </button>
            </div>
          </div>
        )}
        {activeFileState === 'missing' && (
          <div className="doc-banner bad">
            <strong>File missing.</strong> The payload is no longer at its indexed path.
          </div>
        )}

        <div className="doc-content">
          <div className="doc-pane" data-doc-pane="preview">
            {(() => {
              if (!effectiveArtifact) return null;
              if (isFilePayload && loadedText == null && !loadFailed) {
                return <div className="artifact-skeleton" />;
              }
              if (isFilePayload && loadFailed) {
                return (
                  <DocPlaceholder>
                    Payload too large to preview or could not be read. Export or open details.
                  </DocPlaceholder>
                );
              }
              const { Preview } = selectRenderer(effectiveArtifact);
              const props = buildPreviewProps(effectiveArtifact, allowlist, styledPreview);
              if (!Preview || !props) {
                return <DocPlaceholder>No content yet.</DocPlaceholder>;
              }
              return <Preview {...props} />;
            })()}
          </div>

          <div className="doc-pane" data-doc-pane="source">
            {isFilePayload && loadedText == null && !loadFailed ? (
              <DocPlaceholder>Loading…</DocPlaceholder>
            ) : isFilePayload && loadFailed ? (
              <DocPlaceholder>
                Payload too large to edit inline or could not be read. Export or open details.
              </DocPlaceholder>
            ) : !sourceText && !dirty ? (
              <DocPlaceholder>No source to show.</DocPlaceholder>
            ) : (
              <div className="source-edit">
                <div className="source-edit-bar">
                  <span className="source-edit-hint">
                    {dirty ? 'Unsaved changes' : savedSource ? 'Saved' : ''}
                  </span>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!dirty || saving}
                    onClick={() => void handleSaveSource()}
                  >
                    {saving ? 'Saving…' : savedSource ? 'Saved' : 'Save'}
                  </button>
                </div>
                <textarea
                  className="source-textarea"
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={`Edit ${kindLabel} source`}
                />
              </div>
            )}
          </div>

          {showDetails && (
            <aside className="doc-details" aria-label="Artifact details">
              <div className="doc-details-head">
                <strong>Details</strong>
                <button className="icon-btn" type="button" aria-label="Hide details" onClick={() => setShowDetails(false)}>
                  &times;
                </button>
              </div>
              <div className="file-meta compact">
                {fileMeta.map((row) => (
                  <div className="row" key={row.k}>
                    <span className="k">{row.k}</span>
                    <span className="v">{row.v}</span>
                  </div>
                ))}
              </div>
            </aside>
          )}
        </div>
      </div>
    </section>
  );
}
