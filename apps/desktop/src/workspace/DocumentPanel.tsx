import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BrandConfig } from '@conduit/config-schema';
import type { Artifact, ArtifactContent, ArtifactKind, FileState } from '../ipc/contracts';
import {
  getArtifactContentBytes,
  openExternalUrl,
  parseBrandSource,
  readArtifactFileBytes,
  revealPath,
  setBrandConfig,
} from '../ipc/client';
import { buildPreviewProps, selectRenderer } from '../artifacts/selectRenderer';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { artifactExternalLinkGrantKey, isHttpOrHttpsUrl } from '../artifacts/externalUrl';
import { DocumentPanelErrorBoundary } from '../artifacts/DocumentPanelErrorBoundary';
import { ArtifactEmptyState } from '../artifacts/ArtifactEmptyState';
import { formatSize, inlineArtifactText, timeAgo } from '../artifacts/format';
import { FilePlainIcon, ChevronRight, MoreIcon, PencilIcon, CopyIcon, DownloadIcon } from '../icons';
import { Menu } from './Menu';
import { OpenExternalLinkDialog } from './OpenExternalLinkDialog';
import { readExportMetadata } from '../shell/uiPrefs';
import { modShortcutHint } from '../lib/shortcuts';
import type { PendingArtifact } from '../artifacts/pendingArtifact';
import { applyBrand, applyBrandTheme, clearBrand } from '../brand/applyBrand';
import { allowUserBranding } from '../brand/buildFlags';
import { ConfirmDialog } from '@conduit/ui';

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
  /// Clear a failed pending artifact (the panel's Dismiss action).
  onDismissPending?: () => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
  onStatus?: (message: string) => void;
  /** Validated `data:image/...` brand logo URI, threaded to the empty-state
   *  BrandMark. See `brand/logo.ts`. */
  logoSrc?: string;
  /**
   * The currently-active persisted brand (or `null` if unbranded), threaded
   * down purely so a preview started from this panel has something correct
   * to revert *to* — the stock look if nothing is active, or whatever is
   * already applied if something is. See `handleStopBrandPreview` below.
   */
  activeBrandConfig?: BrandConfig | null;
  /** Fired after "Apply" persists and applies a brand-theme artifact, so the
   *  app shell (sidebar wordmark, `App.tsx`'s own brand state) picks up the
   *  change without waiting for a reload — the same coherence hook
   *  `BrandingSection`'s `onBrandChange` serves for Settings. */
  onBrandApplied?: (config: BrandConfig) => void;
  /**
   * `AppSettings.brandingEnabled` — the user's own "Enable branding" toggle,
   * threaded down so the brand-eligibility check below can consult it
   * directly instead of only sniffing artifact content. Defaults `false`
   * (matching `AppSettings.branding_enabled`'s own opt-in-only default) so a
   * caller that forgets to pass it fails closed rather than silently
   * offering Preview/Apply.
   *
   * This matters beyond mere UX polish: unlike Apply (which round-trips
   * through `setBrandConfig`, itself now gated server-side — see
   * `commands::branding::guard_write`), Preview
   * (`handleBrandPreview`/`applyBrandTheme`) re-skins the running app's CSS
   * custom properties entirely client-side, with no IPC call at all. If
   * eligibility here did not also consult this flag, a user could hit
   * Preview while Settings reported branding disabled and watch the app
   * re-skin anyway — the exact "UI and running state disagree" failure this
   * whole gate exists to prevent.
   */
  brandingEnabled?: boolean;
}

function ArtifactPendingState({
  pending,
  onCollapsePanel,
  collapseShortcutHint,
  onDismissPending,
}: {
  pending: PendingArtifact;
  onCollapsePanel?: () => void;
  collapseShortcutHint?: string;
  onDismissPending?: () => void;
}) {
  const kindLabel = KIND_LABEL[pending.kind] ?? pending.kind;
  const title = pending.title?.trim() || `${kindLabel} document`;
  const action = pending.mode === 'edit' ? 'Updating' : 'Generating';
  // A turn that died mid-write leaves this panel as the only surface still
  // claiming to be working. `failed` stops the shimmer and says what happened
  // instead of vanishing, which would read as the document quietly succeeding
  // somewhere else.
  const failed = pending.status === 'failed';

  return (
    <section
      className="doc-panel doc-panel-pending"
      aria-label="Document panel"
      {...(failed ? {} : { 'aria-busy': true as const })}
    >
      <div className="doc-toolbar">
        <div className="doc-toolbar-title">
          <div className="ficon"><FilePlainIcon /></div>
          <div className="doc-title">
            <b title={title}>{title}</b>
            <small>{kindLabel} · {failed ? 'failed' : `${action.toLowerCase()}…`}</small>
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
        {failed ? (
          <div className="artifact-pending failed" role="alert">
            <p className="artifact-pending-copy">
              {action === 'Updating' ? 'Update' : 'Generation'} failed —{' '}
              {pending.error?.trim() || 'the turn ended before the document was written.'}
            </p>
            {onDismissPending && (
              <button type="button" className="btn" onClick={onDismissPending}>
                Dismiss
              </button>
            )}
          </div>
        ) : (
          <div className="artifact-pending">
            <div className="artifact-skeleton" aria-hidden="true" />
            <p className="artifact-pending-copy">
              {action} {kindLabel.toLowerCase()} document…
            </p>
          </div>
        )}
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
  effectiveTheme = 'light',
  docTab,
  onSelectTab,
  onOpenArtifact,
  onSaveContent,
  onExport,
  onCloseTab,
  onCollapsePanel,
  onDismissPending,
  onRenameArtifact,
  onStatus,
  logoSrc,
  activeBrandConfig = null,
  onBrandApplied,
  brandingEnabled = false,
}: DocumentPanelProps) {
  const [copied, setCopied] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const raw = useMemo(() => (artifact ? inlineArtifactText(artifact) : ''), [artifact]);
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

  const sourceText = useMemo(() => (effectiveArtifact ? inlineArtifactText(effectiveArtifact) : ''), [effectiveArtifact]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedSource, setSavedSource] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dismissedModified, setDismissedModified] = useState(false);
  // Session-only: first "Open link" for an artifact+content unlocks later
  // http(s) clicks in that same artifact until the content changes or the app restarts.
  const externalLinkGrantsRef = useRef<Set<string>>(new Set());
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  // V7 §8.7 — the metadata sidecar is a persistent preference (Settings →
  // Advanced), not a per-export checkbox inside an action menu.
  const includeMetadata = readExportMetadata() === 'on';

  // ── Brand-theme Preview/Apply (white-label plan §4, Phase 4) ───────────
  //
  // Eligibility is "branding is actually permitted, AND the content is
  // Markdown starting with `+++`, AND `parseBrandSource` accepts it" — never
  // just content sniffing on its own. A `+++` prefix only means "might be
  // TOML frontmatter"; plenty of ordinary Markdown could start that way by
  // coincidence or by a user deliberately writing about the format. Showing
  // branding actions on a document that fails validation (or that
  // `parseBrandSource` can't even reach, e.g. because the command isn't
  // registered yet) would be misleading, so an invalid/unreachable source
  // shows nothing at all — never an error banner — exactly mirroring how an
  // ordinary artifact with no `+++` prefix is treated.
  //
  // `brandingPermitted` folds in both authorization flags, mirroring
  // `commands::branding::guard_write` on the Rust side (which every
  // persisting write now runs through):
  //   - `allowUserBranding` (`brand/buildFlags.ts`): the Mode B build-time
  //     lock. A locked build's `set_brand_config`/`apply_brand_edits` always
  //     refuse server-side regardless of this check, so offering
  //     Preview/Apply here would be a pure dead end — the button would do
  //     nothing a user can act on short of a different build.
  //   - `brandingEnabled` (this panel's own prop, from
  //     `AppSettings.branding_enabled`): unlike the build lock, this is
  //     genuinely gating something reachable here that IPC alone cannot
  //     catch. `handleBrandPreview` calls `applyBrandTheme` directly against
  //     `document.documentElement` with no IPC round trip at all — if
  //     eligibility here ignored this flag, clicking Preview while Settings
  //     reports branding disabled would re-skin the running app anyway, the
  //     UI and the persisted setting visibly disagreeing. Folding it in here
  //     means that action is never offered in the first place, not merely
  //     rejected after the fact the way a server round trip could.
  const brandingPermitted = allowUserBranding && brandingEnabled;

  const [brandCandidate, setBrandCandidate] = useState<{ artifactId: string; config: BrandConfig } | null>(null);
  const [brandPreviewing, setBrandPreviewing] = useState(false);
  const [confirmApplyBrand, setConfirmApplyBrand] = useState(false);
  const [applyingBrand, setApplyingBrand] = useState(false);
  const [brandApplyError, setBrandApplyError] = useState<string | null>(null);

  const looksLikeBrandSource =
    brandingPermitted && artifact?.kind === 'markdown' && sourceText.trimStart().startsWith('+++');

  useEffect(() => {
    setBrandCandidate(null);
    setBrandApplyError(null);
    if (!artifact || !looksLikeBrandSource) return;
    let cancelled = false;
    const artifactId = artifact.id;
    void (async () => {
      try {
        const config = await parseBrandSource(sourceText);
        if (!cancelled) setBrandCandidate({ artifactId, config });
      } catch {
        // Not a valid brand, or `parse_brand_source` isn't registered yet —
        // either way, degrade to "show nothing" rather than an error banner.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact?.id, looksLikeBrandSource, sourceText]);

  // `brandingPermitted` is re-checked here too, not just folded into
  // `looksLikeBrandSource` above: the effect that populates `brandCandidate`
  // only re-runs (and clears it) after `brandingPermitted` flips and a
  // render has committed, so re-checking it directly here closes that
  // one-render gap instead of trusting the effect alone.
  const brandEligible =
    brandingPermitted && brandCandidate != null && brandCandidate.artifactId === artifact?.id;

  // Refs so the "leaving this artifact" cleanup below always reverts using
  // the *latest* preview/active-brand/theme values rather than whatever was
  // current when the effect was set up — same technique, for the same
  // reason, as `BrandingSection.tsx`'s own unmount cleanup.
  const brandPreviewingRef = useRef(brandPreviewing);
  const activeBrandConfigRef = useRef(activeBrandConfig);
  const effectiveThemeRef = useRef(effectiveTheme);
  useEffect(() => {
    brandPreviewingRef.current = brandPreviewing;
  }, [brandPreviewing]);
  useEffect(() => {
    activeBrandConfigRef.current = activeBrandConfig;
  }, [activeBrandConfig]);
  useEffect(() => {
    effectiveThemeRef.current = effectiveTheme;
  }, [effectiveTheme]);

  // Switching to a different artifact (or unmounting) while previewing must
  // not leave the whole app stuck on a never-saved candidate theme with no
  // banner left to back out of it: revert to whatever was actually active
  // (or the stock look), and reset the local "previewing" flag for the newly
  // shown artifact.
  useEffect(() => {
    setBrandPreviewing(false);
    setConfirmApplyBrand(false);
    return () => {
      if (!brandPreviewingRef.current) return;
      if (activeBrandConfigRef.current) {
        applyBrandTheme(activeBrandConfigRef.current, effectiveThemeRef.current);
      } else {
        clearBrand();
      }
    };
  }, [artifact?.id]);

  /**
   * Preview: colours only, applied straight through `applyBrandTheme` — never
   * `applyBrand()`, which also writes the pre-paint `localStorage` cache. An
   * unpreviewed/abandoned theme must never resurrect on next launch, so a
   * preview must leave that cache untouched exactly like `BrandingSection`'s
   * own live-preview effect does.
   */
  function handleBrandPreview() {
    if (!brandCandidate) return;
    applyBrandTheme(brandCandidate.config, effectiveTheme);
    setBrandPreviewing(true);
    onStatus?.('Previewing this theme — not saved.');
  }

  /** The way back out of a preview: restore whatever was actually active
   *  (or the stock look if nothing was), same logic as the unmount cleanup
   *  above but user-triggered instead of implicit. */
  function handleStopBrandPreview() {
    if (activeBrandConfig) {
      applyBrandTheme(activeBrandConfig, effectiveTheme);
    } else {
      clearBrand();
    }
    setBrandPreviewing(false);
    onStatus?.('Stopped previewing.');
  }

  /** Apply: persist through the same `set_brand_config` path Settings' brand
   *  import uses, then fully apply the re-parsed result (identity + palette
   *  + the pre-paint cache) — unlike Preview, Apply is meant to survive a
   *  relaunch. Confirmed first (`confirmApplyBrand`) because this replaces
   *  the user's existing brand outright with no merge. */
  async function handleApplyBrandConfirmed() {
    if (!brandCandidate) return;
    setApplyingBrand(true);
    setBrandApplyError(null);
    try {
      const result = await setBrandConfig(sourceText);
      applyBrand(result, effectiveTheme);
      onBrandApplied?.(result);
      setBrandPreviewing(false);
      setConfirmApplyBrand(false);
      onStatus?.('Brand applied.');
    } catch (e) {
      const message = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
      setBrandApplyError(message);
      onStatus?.(`Apply failed: ${message}`);
    } finally {
      setApplyingBrand(false);
    }
  }

  const externalLinkGrantKey = useMemo(() => {
    if (!effectiveArtifact) return null;
    const content = effectiveArtifact.contentText ?? sourceText;
    return artifactExternalLinkGrantKey(effectiveArtifact.id, content);
  }, [effectiveArtifact, sourceText]);

  const openValidatedExternalUrl = useCallback(
    async (url: string) => {
      try {
        await openExternalUrl(url);
      } catch (err) {
        onStatus?.(err instanceof Error ? err.message : String(err));
      }
    },
    [onStatus],
  );

  const handleExternalLink = useCallback(
    (url: string) => {
      if (!isHttpOrHttpsUrl(url)) return;
      if (externalLinkGrantKey && externalLinkGrantsRef.current.has(externalLinkGrantKey)) {
        void openValidatedExternalUrl(url);
        return;
      }
      setPendingExternalUrl(url);
    },
    [externalLinkGrantKey, openValidatedExternalUrl],
  );

  const handleConfirmExternalLink = useCallback(() => {
    const url = pendingExternalUrl;
    setPendingExternalUrl(null);
    if (!url) return;
    if (externalLinkGrantKey) {
      externalLinkGrantsRef.current.add(externalLinkGrantKey);
    }
    void openValidatedExternalUrl(url);
  }, [pendingExternalUrl, externalLinkGrantKey, openValidatedExternalUrl]);

  const handleCancelExternalLink = useCallback(() => {
    setPendingExternalUrl(null);
  }, []);

  useEffect(() => {
    setDraft(sourceText);
    setSavedSource(false);
  }, [sourceText]);

  useEffect(() => {
    setDismissedModified(false);
    setMenuOpen(false);
    setPendingExternalUrl(null);
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
        onDismissPending={onDismissPending}
      />
    );
  }

  if (!artifact) {
    return <ArtifactEmptyState logoSrc={logoSrc} />;
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

  /// Export, then show the user where the file landed. This absorbs the old
  /// "Reveal in Explorer" item, which was disabled in every real session:
  /// artifact payloads live in the database as text, so `contentPath` is never
  /// set and there is no file to reveal until an export writes one.
  async function handleExport() {
    if (!artifact || exporting) return;
    setExporting(true);
    try {
      await onExport(artifact.id, includeMetadata);
      setMenuOpen(false);
      // The export has already been reported by the App status line; a file
      // manager that refuses to open must not make it look like a failure.
      try {
        await revealPath();
      } catch {
        /* export succeeded; revealing is a convenience */
      }
    } catch {
      /* failure surfaces via the App status line */
    } finally {
      setExporting(false);
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
        {brandEligible && (
          <div className="doc-banner hold" role="status" aria-label="Brand theme actions">
            {brandPreviewing ? (
              <>
                <strong>Previewing this theme.</strong> Colours are applied locally and not saved —
                leaving preview restores your current look.
              </>
            ) : (
              <>
                <strong>This document defines a brand theme.</strong> Preview it locally, or apply it
                to replace your saved brand.
              </>
            )}
            {brandApplyError && (
              <p className="brand-error" role="alert">
                {brandApplyError}
              </p>
            )}
            <div className="row">
              {brandPreviewing ? (
                <button className="btn ghost" type="button" onClick={handleStopBrandPreview}>
                  Stop previewing
                </button>
              ) : (
                <button className="btn ghost" type="button" onClick={handleBrandPreview}>
                  Preview
                </button>
              )}
              <button
                className="btn primary"
                type="button"
                disabled={applyingBrand}
                onClick={() => setConfirmApplyBrand(true)}
              >
                {applyingBrand ? 'Applying…' : 'Apply…'}
              </button>
            </div>
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
              return (
                <Preview
                  {...props}
                  onExternalLink={handleExternalLink}
                />
              );
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
                  className="source-textarea scroll"
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

      <OpenExternalLinkDialog
        url={pendingExternalUrl}
        onConfirm={handleConfirmExternalLink}
        onCancel={handleCancelExternalLink}
      />

      <ConfirmDialog
        open={confirmApplyBrand}
        title="Apply this brand?"
        description="Replaces your saved brand.md with this theme and applies it immediately. Your previous brand can be restored by applying an earlier theme again, but this action itself cannot be undone from here."
        confirmLabel="Apply brand"
        onCancel={() => setConfirmApplyBrand(false)}
        onConfirm={() => void handleApplyBrandConfirmed()}
      />
    </section>
  );
}
