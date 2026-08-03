import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Artifact, ArtifactContent, ArtifactKind, FileState } from '../ipc/contracts';
import { getArtifactContentBytes, readArtifactFileBytes, revealArtifact } from '../ipc/client';
import { buildPreviewProps, selectRenderer } from '../artifacts/selectRenderer';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { DocumentPanelErrorBoundary } from '../artifacts/DocumentPanelErrorBoundary';
import { ArtifactEmptyState } from '../artifacts/ArtifactEmptyState';
import { FilePlainIcon, ChevronRight, MoreIcon, PencilIcon, CopyIcon, FolderIcon, DownloadIcon } from '../icons';
import { Menu } from './Menu';
import { readExportMetadata } from '../shell/uiPrefs';
import type { PendingArtifact } from '../artifacts/pendingArtifact';

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

/// Compact relative timestamp for the foot strip + ⋯ metadata block.
function timeAgo(iso?: string): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/// Version label for the metadata block + foot (sidecar metadata only; the
/// artifact model has no version history — contracts.ts note).
function versionLabel(artifact: Artifact): string | undefined {
  const v = artifact.metadata?.version;
  if (v == null || v === '') return undefined;
  return `v${String(v)}`;
}

function DocPlaceholder({ children }: { children: ReactNode }) {
  return <p className="doc-placeholder">{children}</p>;
}

function modShortcutHint(key: string): string {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return `${isMac ? '⌘' : 'Ctrl'}+${key}`;
}

interface DocumentPanelProps {
  artifact: Artifact | null;
  pendingArtifact?: PendingArtifact | null;
  openArtifacts: Artifact[];
  fileStateMap: Record<string, FileState>;
  activeFileState: FileState;
  allowlist: string[];
  styledPreview?: boolean;
  effectiveTheme?: ArtifactColorScheme;
  docTab: DocTab;
  onSelectTab: (tab: DocTab) => void;
  onOpenArtifact: (id: string) => void;
  onSaveContent: (artifactId: string, content: ArtifactContent, mimeType?: string) => Promise<void>;
  onExport: (artifactId: string, includeMetadata: boolean) => Promise<void>;
  onCloseTab?: (id: string) => void;
  onCollapsePanel?: () => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
  onStatus?: (message: string) => void;
}

function ArtifactPendingState({
  pending,
  onCollapsePanel,
  collapseShortcutHint,
}: {
  pending: PendingArtifact;
  onCollapsePanel?: () => void;
  collapseShortcutHint?: string;
}) {
  const kindLabel = KIND_LABEL[pending.kind] ?? pending.kind;
  const title = pending.title?.trim() || `${kindLabel} document`;
  const action = pending.mode === 'edit' ? 'Updating' : 'Generating';

  return (
    <section className="doc-panel doc-panel-pending" aria-label="Document panel" aria-busy="true">
      <div className="doc-toolbar">
        <div className="doc-toolbar-title">
          <div className="ficon"><FilePlainIcon /></div>
          <div className="doc-title">
            <b title={title}>{title}</b>
            <small>{kindLabel} · {action.toLowerCase()}…</small>
          </div>
        </div>
        <span className="doc-toolbar-spacer" />
        {onCollapsePanel && (
          <div className="doc-actions">
            <button
              className="icon-btn"
              type="button"
              aria-label="Hide artifact panel"
              aria-pressed={false}
              title={
                collapseShortcutHint
                  ? `Hide artifact panel (${collapseShortcutHint})`
                  : 'Hide artifact panel'
              }
              onClick={onCollapsePanel}
            >
              <ChevronRight />
            </button>
          </div>
        )}
      </div>
      <div className="doc-body scroll">
        <div className="artifact-pending">
          <div className="artifact-skeleton" aria-hidden="true" />
          <p className="artifact-pending-copy">
            {action} {kindLabel.toLowerCase()} document…
          </p>
        </div>
      </div>
    </section>
  );
}

export function DocumentPanel({
  artifact,
  pendingArtifact = null,
  openArtifacts,
  fileStateMap,
  activeFileState,
  allowlist,
  styledPreview = true,
  effectiveTheme: _effectiveTheme = 'light',
  docTab,
  onSelectTab,
  onOpenArtifact,
  onSaveContent,
  onExport,
  onCloseTab,
  onCollapsePanel,
  onRenameArtifact,
  onStatus,
}: DocumentPanelProps) {
  const [copied, setCopied] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const raw = useMemo(() => (artifact ? rawInlineText(artifact) : ''), [artifact]);
  const isFilePayload = artifact?.contentPath != null;
  const multiOpen = openArtifacts.length > 1;
  const collapseHint = modShortcutHint('J');

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
  const [exporting, setExporting] = useState(false);
  const [dismissedModified, setDismissedModified] = useState(false);
  // V7 §8.7 — the metadata sidecar is a persistent preference (Settings →
  // Advanced), not a per-export checkbox inside an action menu.
  const includeMetadata = readExportMetadata() === 'on';

  useEffect(() => {
    setDraft(sourceText);
    setSavedSource(false);
  }, [sourceText]);

  useEffect(() => {
    setDismissedModified(false);
    setMenuOpen(false);
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

  // Esc closes the active artifact when focus is inside the panel (not in an
  // editable field), returning to the empty welcome state.
  useEffect(() => {
    if (!artifact || !onCloseTab) return;
    const artifactId = artifact.id;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const panel = target?.closest('.doc-panel');
      if (!panel || panel.classList.contains('doc-panel-empty')) return;
      event.preventDefault();
      onCloseTab?.(artifactId);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [artifact, onCloseTab]);

  const dirty = draft !== sourceText;

  const showCreatePending =
    pendingArtifact != null &&
    (pendingArtifact.mode === 'create' || !artifact);

  if (showCreatePending && pendingArtifact) {
    return (
      <ArtifactPendingState
        pending={pendingArtifact}
        onCollapsePanel={onCollapsePanel}
        collapseShortcutHint={collapseHint}
      />
    );
  }

  if (!artifact) {
    return (
      <ArtifactEmptyState
        onCollapsePanel={onCollapsePanel}
        collapseShortcutHint={collapseHint}
      />
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
      setDismissedModified(true);
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

  async function handleReveal() {
    if (!artifact || !isFilePayload) return;
    setMenuOpen(false);
    try {
      await revealArtifact(artifact.id);
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : 'Could not reveal artifact');
    }
  }

  const artifactPath = artifact.contentPath ?? '(inline payload)';
  const metaModified = timeAgo(artifact.updatedAt ?? artifact.createdAt);
  const metaSize = formatSize(artifact.sizeBytes);
  const metaVersion = versionLabel(artifact);
  const footMeta = [metaSize, ...(metaVersion ? [metaVersion] : []), `saved ${metaModified}`].join(' · ');

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
                <div className="doc-title-row">
                  <b title={name}>{name}</b>
                  {onRenameArtifact && (
                    <button
                      className="icon-btn tab-rename"
                      type="button"
                      aria-label={`Rename ${name}`}
                      title="Rename"
                      onClick={() => beginRename(artifact.id, name)}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {onCloseTab && (
                    <button
                      className="icon-btn tab-close"
                      type="button"
                      aria-label={`Close ${name}`}
                      title="Close"
                      onClick={() => onCloseTab(artifact.id)}
                    >
                      &times;
                    </button>
                  )}
                </div>
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
              const tabTitle = a.title ?? 'Untitled artifact';
              const isActive = a.id === artifact.id;
              return (
                <div
                  key={a.id}
                  className={`artifact-file-tab${isActive ? ' active' : ''}`}
                  data-state={state}
                >
                  <button
                    className="tab-select"
                    type="button"
                    title={tabTitle}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => onOpenArtifact(a.id)}
                  >
                    <FilePlainIcon />
                    {editingTabId === a.id && isActive ? (
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
                      <span className="tab-name">{tabTitle}</span>
                    )}
                    {showStateDot(state, a.contentPath != null) && (
                      <span className={`tab-state${tabStateClass(state)}`} aria-hidden="true" />
                    )}
                  </button>
                  {isActive && onRenameArtifact && editingTabId !== a.id && (
                    <button
                      className="tab-rename"
                      type="button"
                      aria-label={`Rename ${tabTitle}`}
                      title="Rename"
                      onClick={() => beginRename(a.id, tabTitle)}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {onCloseTab && (
                    <button
                      className="tab-close"
                      type="button"
                      aria-label={`Close ${tabTitle}`}
                      onClick={() => onCloseTab(a.id)}
                    >
                      &times;
                    </button>
                  )}
                </div>
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
              ref={menuTriggerRef}
              className="icon-btn"
              type="button"
              aria-label="More actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreIcon />
            </button>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              triggerRef={menuTriggerRef}
              className="menu doc-more-menu"
              label="Artifact actions"
            >
              <button className="menu-item" type="button" role="menuitem" disabled={!raw} onClick={() => void handleCopy()}>
                <CopyIcon />
                {copied ? 'Copied' : 'Copy contents'}
              </button>
              <button
                className="menu-item"
                type="button"
                role="menuitem"
                disabled={!isFilePayload}
                onClick={() => void handleReveal()}
              >
                <FolderIcon />
                Reveal in Explorer
              </button>
              <button
                className="menu-item"
                type="button"
                role="menuitem"
                disabled={exporting || saving}
                onClick={() => void handleExport()}
              >
                <DownloadIcon />
                {exporting ? 'Exporting…' : 'Save a copy…'}
              </button>
              {onCloseTab && (
                <button
                  className="menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onCloseTab(artifact.id);
                  }}
                >
                  <ChevronRight />
                  Close
                </button>
              )}
              <div className="menu-sep" role="separator" />
              <div className="menu-label" title={artifactPath}>{artifactPath}</div>
              <div className="doc-meta-row">
                {metaSize} · modified {metaModified}
                {metaVersion ? <span className="tail">{metaVersion}</span> : null}
              </div>
            </Menu>
          </div>
          {onCollapsePanel && (
            <button
              className="icon-btn"
              type="button"
              aria-label="Hide artifact panel"
              aria-pressed={false}
              title={`Hide artifact panel (${collapseHint})`}
              onClick={onCollapsePanel}
            >
              <ChevronRight />
            </button>
          )}
        </div>
      </div>

      <div className="doc-body scroll">
        <DocumentPanelErrorBoundary>
        {pendingArtifact?.mode === 'edit' && (
          <div className="doc-banner hold" role="status">
            <strong>Updating document…</strong> The assistant is revising this artifact.
          </div>
        )}
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

        </div>
        </DocumentPanelErrorBoundary>
      </div>

      <div className="panel-foot" aria-label="Artifact metadata">
        <span className="foot-path" title={artifactPath}>{artifactPath}</span>
        <span className="spacer" aria-hidden="true" />
        <span className="foot-meta mono">{footMeta}</span>
      </div>
    </section>
  );
}
