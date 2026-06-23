import { useEffect, useMemo, useState } from 'react';
import type { Artifact, ArtifactContent, ArtifactKind, FileState } from '../ipc/contracts';
import { getArtifactContentBytes, readArtifactFileBytes } from '../ipc/client';
import { buildPreviewProps, selectRenderer } from '../artifacts/selectRenderer';
import { CopyIcon, ExternalIcon, FilePlainIcon, CheckIcon, AlertIcon } from '../icons';

type DocTab = 'preview' | 'source' | 'file';

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

const STATE_LABEL: Record<FileState, string> = {
  ok: 'saved',
  modified: 'changed',
  missing: 'missing',
  noFileContent: 'inline',
};

const STATE_TONE: Record<FileState, 'ok' | 'warn' | 'bad' | 'hold'> = {
  ok: 'ok',
  modified: 'warn',
  missing: 'bad',
  noFileContent: 'hold',
};

/// File-state → per-tab state-dot class (matches the CSS `tab-state` modifiers).
function tabStateClass(state: FileState): string {
  if (state === 'ok') return '';
  if (state === 'modified') return ' warn';
  if (state === 'missing') return ' bad';
  return ''; // noFileContent / inline — no dot
}

/// Derive the raw inline text for the Copy button + Source pane: prefer
/// `contentText`, fall back to pretty-printed `contentJson`, else empty.
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

interface DocumentPanelProps {
  /// The payload-bearing artifact open in the panel (null = empty state).
  artifact: Artifact | null;
  /// The conversation's artifacts, for the open-file tab strip.
  artifacts: Artifact[];
  /// Per-artifact file-state, for the tab-strip state dots.
  fileStateMap: Record<string, FileState>;
  /// File-state of the active artifact (resolved by the owner).
  activeFileState: FileState;
  /// User-managed remote allowlist for HTML/JS artifact previews.
  allowlist: string[];
  docTab: DocTab;
  onSelectTab: (tab: DocTab) => void;
  onOpenArtifact: (id: string) => void;
  /// M3: overwrite the artifact's single payload (no version history). The
  /// Source tab edits inline text; "Use disk" in the Modified banner re-saves
  /// the on-disk blob's plaintext as a File payload to re-sync the hash.
  onSaveContent: (artifactId: string, content: ArtifactContent, mimeType?: string) => Promise<void>;
  /// M5: export the current payload (optionally with a metadata sidecar) to
  /// the app's exports directory. The destination path is surfaced by the owner.
  onExport: (artifactId: string, includeMetadata: boolean) => Promise<void>;
  onCloseTab?: (id: string) => void;
}

/** v5 right-hand document panel: doc-head, artifact-tabs (editor-style open-file
 *  tabs with per-file state dots), doc-tabs (Preview/Source/File), doc-body
 *  panes, file-state banners, and doc-foot (sync status). Real artifact data
 *  flows from the IPC layer; the rich Preview renderers (M6), Source save (M3),
 *  and Export (M5) slot into the seams marked below. No version picker, no
 *  restore — the artifact holds a single current payload (user-directed override
 *  of ADR-002). */
export function DocumentPanel({
  artifact,
  artifacts,
  fileStateMap,
  activeFileState,
  allowlist,
  docTab,
  onSelectTab,
  onOpenArtifact,
  onSaveContent,
  onExport,
}: DocumentPanelProps) {
  const [copied, setCopied] = useState(false);
  // Hooks must run before the empty-state early return, so derive the raw text
  // unconditionally (`rawInlineText` tolerates a null artifact).
  const raw = useMemo(() => (artifact ? rawInlineText(artifact) : ''), [artifact]);
  const isFilePayload = artifact?.contentPath != null;

  // M6: for File-content artifacts (no inline text), fetch the payload bytes
  // (5 MiB preview cap) so the renderer can preview them. Inline-content
  // artifacts use `raw` directly. Cleared on artifact switch.
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

  // Effective inline text for the renderer: loaded File-content bytes, else the
  // artifact's inline text. A synthetic artifact view that carries the loaded
  // text so `buildPreviewProps` sees it as inline content.
  const effectiveArtifact: Artifact | null = useMemo(() => {
    if (!artifact) return null;
    if (loadedText != null) {
      return { ...artifact, contentText: artifact.contentText ?? loadedText };
    }
    return artifact;
  }, [artifact, loadedText]);

  // M3: Source-tab edit state. `sourceText` is the canonical raw text for the
  // effective artifact (inline text, or pretty-printed JSON, or loaded
  // File-content bytes). The draft resets to it whenever it changes (artifact
  // switch, File-content load completing, or a save that updates the artifact).
  const sourceText = useMemo(() => (effectiveArtifact ? rawInlineText(effectiveArtifact) : ''), [effectiveArtifact]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedSource, setSavedSource] = useState(false);
  // M5: export controls — a "include metadata" toggle + the export action.
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [exporting, setExporting] = useState(false);
  // M3: dismiss the Modified banner without writing (the indexed hash stays
  // canonical; the file remains out of sync until the next save/use-disk).
  const [dismissedModified, setDismissedModified] = useState(false);
  useEffect(() => {
    setDraft(sourceText);
    setSavedSource(false);
  }, [sourceText]);
  // Re-arm the dismiss whenever the active artifact or its file-state changes.
  useEffect(() => {
    setDismissedModified(false);
  }, [artifact?.id, activeFileState]);
  const dirty = draft !== sourceText;

  // Empty state: no artifact open.
  if (!artifact) {
    return (
      <section className="doc-panel" aria-label="Document panel" data-doc-tab={docTab}>
        <div className="doc-head">
          <div className="ficon"><FilePlainIcon /></div>
          <div className="doc-title">
            <b>No artifact open</b>
            <small>Promote a code block from chat or pick an artifact from the rail</small>
          </div>
        </div>
        <div className="doc-body scroll">
          <div className="doc-pane" data-doc-pane="preview">
            <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>
              Artifacts created in this conversation appear here. Use the rail&rsquo;s Files tab to open one.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const toneClass = `status-pill ${STATE_TONE[activeFileState]}`;
  const label = STATE_LABEL[activeFileState];
  const name = artifact.title ?? 'Untitled artifact';
  const subtitle = `${KIND_LABEL[artifact.kind] ?? artifact.kind} · current`;

  async function handleCopy() {
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  // M3: save the Source-tab draft as the artifact's single inline-text payload
  // (overwrites — no version history). The mimeType is preserved so the
  // renderer (json/html/markdown/code) keeps resolving correctly.
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

  // M3: Modified-banner "Use disk" — accept the on-disk blob's current plaintext
  // as canonical. We read the decrypted bytes (the live disk content, which
  // differs from the indexed hash), then re-save them as a File payload with
  // the same filename so `content_hash` re-syncs and the state returns to `ok`.
  async function handleUseDisk() {
    if (!artifact || !artifact.contentPath || saving) return;
    setSaving(true);
    try {
      // Use the uncapped recovery reader so large modified files can be re-accepted.
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

  // M5: export the current payload (+ optional curated metadata sidecar).
  async function handleExport() {
    if (!artifact || exporting) return;
    setExporting(true);
    try {
      await onExport(artifact.id, includeMetadata);
    } catch {
      /* failure surfaces via the App status line */
    } finally {
      setExporting(false);
    }
  }

  const fileMeta: Array<{ k: string; v: string; dim?: boolean }> = [
    { k: 'Path', v: artifact.contentPath ?? '(inline)' },
    { k: 'Hash', v: artifact.contentHash ?? '—' },
    { k: 'Size', v: formatSize(artifact.sizeBytes) },
    { k: 'MIME', v: artifact.mimeType ?? '—' },
    { k: 'Origin', v: artifact.sourceMessageId ? 'From message' : 'Manual', dim: true },
    { k: 'Cloud', v: artifact.cloudShareId ?? 'Not published — local only', dim: true },
    { k: 'Updated', v: artifact.updatedAt ?? artifact.createdAt, dim: true },
  ];

  return (
    <section
      className="doc-panel"
      aria-label="Document panel"
      data-doc-tab={docTab}
      data-file-state={activeFileState}
    >
      <div className="doc-head">
        <div className="ficon"><FilePlainIcon /></div>
        <div className="doc-title">
          <b>{name}</b>
          <small>{subtitle}</small>
        </div>
        <span className={toneClass}>{label}</span>
        <div className="doc-actions">
          <button className="icon-btn" type="button" aria-label="Reveal in Explorer" title="Reveal in Explorer" disabled={!isFilePayload}>
            <ExternalIcon />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label={copied ? 'Copied' : 'Copy'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={handleCopy}
            disabled={!raw}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <div className="artifact-tabs" aria-label="Open artifacts">
        {artifacts.map((a) => {
          const state = fileStateMap[a.id] ?? 'noFileContent';
          return (
            <button
              key={a.id}
              className={`artifact-file-tab${a.id === artifact.id ? ' active' : ''}`}
              type="button"
              data-state={state}
              title={KIND_LABEL[a.kind] ?? a.kind}
              onClick={() => onOpenArtifact(a.id)}
            >
              <FilePlainIcon />
              <span className="tab-name">{a.title ?? 'Untitled artifact'}</span>
              <span className={`tab-state${tabStateClass(state)}`} />
              <span className="tab-close" aria-hidden="true">&times;</span>
            </button>
          );
        })}
        <button className="artifact-add-tab" type="button" aria-label="Open another artifact" title="Open another artifact">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <div className="doc-tabs">
        <button className="doc-tab" data-doc-tab="preview" type="button" onClick={() => onSelectTab('preview')}>
          Preview
        </button>
        <button className="doc-tab" data-doc-tab="source" type="button" onClick={() => onSelectTab('source')}>
          Source
        </button>
        <button className="doc-tab" data-doc-tab="file" type="button" onClick={() => onSelectTab('file')}>
          File
        </button>
        <span className="doc-tab-spacer" />
      </div>

      <div className="doc-body scroll">
        {activeFileState === 'modified' && !dismissedModified && (
          <div className="doc-banner warn">
            <strong>Modified outside Conduit.</strong> The file on disk changed since Conduit last read it. Review the disk copy before continuing.
            {/* M3: recovery overwrites the current payload (no version created). */}
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
            <strong>File missing.</strong> Conduit cannot find this artifact at its indexed path. The catalog entry is intact, but the payload is gone from the workspace.
            {/* M3 seam — "Locate" (re-import via a native file dialog) and
                "Remove" (set a flag in artifact.metadata) need a Tauri dialog
                plugin and a metadata-update IPC respectively, neither of which
                is wired yet. The banner stays informational this phase. */}
          </div>
        )}

        <div className="doc-pane" data-doc-pane="preview">
          {/* M6: dispatch to the safe renderer for the artifact's kind/mimeType.
              File-content payloads are fetched above (5 MiB cap) into
              `effectiveArtifact`. `buildPreviewProps` returns null when there is
              no inline content to preview yet (File-content still loading or
              over the cap). */}
          {(() => {
            if (!effectiveArtifact) return null;
            if (isFilePayload && loadedText == null && !loadFailed) {
              return <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>Loading file payload…</p>;
            }
            if (isFilePayload && loadFailed) {
              return (
                <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>
                  This artifact&rsquo;s file payload is too large to preview (over 5 MiB) or could not be read. Use the File tab or export it.
                </p>
              );
            }
            const { Preview } = selectRenderer(effectiveArtifact);
            const props = buildPreviewProps(effectiveArtifact, allowlist);
            if (!Preview || !props) {
              return <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>No content yet.</p>;
            }
            return <Preview {...props} />;
          })()}
        </div>

        <div className="doc-pane" data-doc-pane="source">
          {/* M3: editable raw source. Save overwrites the single payload via
              `setArtifactContent` (Text content, preserving mimeType). No
              version history — the previous payload is gone. For File-content
              artifacts still loading or over the 5 MiB preview cap, fall back to
              a read-only note (edit large/binary payloads via Export + an
              external editor, then re-import). */}
          {isFilePayload && loadedText == null && !loadFailed ? (
            <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>Loading file payload…</p>
          ) : isFilePayload && loadFailed ? (
            <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>
              This artifact&rsquo;s file payload is too large to edit inline (over 5 MiB) or could not be read. Use the File tab or export it.
            </p>
          ) : !sourceText && !dirty ? (
            <p style={{ margin: 0, color: 'var(--text-2)', fontSize: '13px' }}>No source to show.</p>
          ) : (
            <div className="source-edit">
              <div className="source-edit-bar">
                <span className="source-edit-hint">
                  {dirty ? 'Unsaved changes' : savedSource ? 'Saved' : 'Read-only preview updates as you edit'}
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
                aria-label={`Edit ${KIND_LABEL[artifact.kind] ?? artifact.kind} source`}
              />
            </div>
          )}
        </div>

        <div className="doc-pane" data-doc-pane="file">
          <p style={{ margin: '0 0 12px', fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5, maxWidth: '860px' }}>
            The local store indexes this artifact. {isFilePayload ? 'The canonical payload is the file below, not a database blob.' : 'The payload is stored inline (encrypted at rest).'}
          </p>
          <div className="file-meta">
            {fileMeta.map((row) => (
              <div className="row" key={row.k}>
                <span className="k">{row.k}</span>
                <span className={`v${row.dim ? ' dim' : ''}`}>{row.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="doc-foot">
        {activeFileState === 'ok' && <span className="foot-ok sync"><CheckIcon />Saved on device — not synced</span>}
        {activeFileState === 'noFileContent' && <span className="foot-ok sync"><CheckIcon />Inline — saved on device</span>}
        {activeFileState === 'modified' && <span className="foot-warn sync"><AlertIcon />Modified outside app</span>}
        {activeFileState === 'missing' && <span className="foot-bad sync"><AlertIcon />File missing</span>}
        {/* M5: Export the current payload to the app's exports directory, with an
            optional curated `.conduit.json` metadata sidecar. Cloud Publish is a
            non-goal. The destination path is surfaced via the App status line. */}
        <div className="doc-foot-export">
          <label className="export-meta-toggle">
            <input
              type="checkbox"
              checked={includeMetadata}
              onChange={(e) => setIncludeMetadata(e.target.checked)}
            />
            Include metadata sidecar
          </label>
          <button
            className="btn ghost"
            type="button"
            disabled={exporting || saving}
            onClick={() => void handleExport()}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </section>
  );
}