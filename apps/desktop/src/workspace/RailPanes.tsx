import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceTab } from './Rail';
import type {
  Artifact,
  ArtifactKind,
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
  ConversationSummary,
  FileState,
} from '../ipc/contracts';
import {
  discoverConnector,
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConversations,
  setConversationTitle,
  startConnector,
  stopConnector,
} from '../ipc/client';
import { summarizeMessageContentForPreview } from '../chat/messageSegments';
import { InfoCard, SearchBox, SectionLabel, StatusPill } from '@conduit/ui';
import {
  ChatIcon,
  ChevronDown,
  ChevronRight,
  ConnectorsIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '../icons';
import { ACTIVITY_PANE_ENABLED } from './features';

interface RailPanesProps {
  active: WorkspaceTab;
  /// Artifacts for the active conversation (metadata-only list from `listArtifacts`).
  artifacts: Artifact[];
  /// Per-artifact file-state for the rail state dots.
  fileStateMap: Record<string, FileState>;
  /// Currently open artifact id (highlights the matching row).
  activeArtifactId?: string | null;
  /// Open an artifact in the DocumentPanel by id.
  onOpenArtifact: (id: string) => void;
  /// Active conversation id (drives the highlighted row in the history pane).
  activeConversationId: string | null;
  /// Switch the chat view to an existing conversation.
  onSelectConversation: (id: string) => void;
  /// Delete a single conversation from history.
  onDeleteConversation: (id: string) => void | Promise<void>;
  /// Delete all conversation history.
  onDeleteAllHistory: () => void | Promise<void>;
  onNewChat: () => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
  onManageConnectors?: () => void;
  /// Called after a conversation is renamed so App can refresh the panel subtitle.
  onConversationRenamed?: () => void;
}

// Rail panes are shown/hidden by [data-tab] on <html> via styles.css
// (the v5 mechanism). They stay mounted so their scroll/state persists.

/// Format an ISO-8601 `updatedAt` as a short relative label (e.g. "just now",
/// "3m", "2h", "5d"), falling back to the locale date for older turns.
function relativeFromIso(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString();
}

function formatHistoryPreview(row: ConversationSummary): string {
  if (row.lastMessagePreview) {
    return summarizeMessageContentForPreview(row.lastMessagePreview) ?? row.lastMessagePreview;
  }
  return `${row.messageCount} message${row.messageCount === 1 ? '' : 's'}`;
}

function HistoryPane({
  paneActive,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onDeleteAllHistory,
  onNewChat,
  onConversationRenamed,
}: {
  paneActive: boolean;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  onDeleteAllHistory: () => void | Promise<void>;
  onNewChat: () => void;
  onConversationRenamed?: () => void;
}) {
  const [rows, setRows] = useState<ConversationSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await listConversations();
        if (!cancelled) setRows(listed);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = `${r.displayTitle} ${r.title ?? ''} ${r.lastMessagePreview ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  async function handleDeleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await onDeleteConversation(id);
    setRefreshKey((k) => k + 1);
  }

  async function handleDeleteAllHistory() {
    await onDeleteAllHistory();
    setRefreshKey((k) => k + 1);
  }

  function beginRename(row: ConversationSummary, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(row.id);
    setEditingValue(row.title ?? row.displayTitle);
  }

  async function commitRename() {
    if (!editingId) return;
    const title = editingValue.trim();
    const id = editingId;
    setEditingId(null);
    setEditingValue('');
    if (!title) return;
    try {
      await setConversationTitle(id, title);
      setRefreshKey((k) => k + 1);
      onConversationRenamed?.();
    } catch {
      /* status surfaces via App if needed */
    }
  }

  return (
    <section
      className="tab-pane"
      data-pane="history"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Chat history"
    >
      <div className="tab-list scroll">
        <SearchBox
          placeholder="Search conversations"
          ariaLabel="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="list-row new-chat-row" type="button" onClick={onNewChat}>
          <PlusIcon className="row-icon" />
          <span className="meta">
            <b>New chat</b>
            <small>Start a fresh local conversation</small>
          </span>
        </button>
        {rows.length > 0 && (
          <div className="history-actions">
            <button className="history-delete-all-btn" type="button" onClick={() => void handleDeleteAllHistory()}>
              <TrashIcon />
              Delete all history
            </button>
          </div>
        )}
        {rows.length === 0 ? (
          <SectionLabel left="No conversations yet" right="local" />
        ) : filtered.length === 0 ? (
          <SectionLabel left="No matches" right={`${rows.length} total`} />
        ) : (
          <>
            <SectionLabel left="Previous conversations" right={`${filtered.length}`} />
            {filtered.map((r) => (
              <div
                key={r.id}
                className={`list-row history-row${r.id === activeConversationId ? ' active' : ''}`}
              >
                <button
                  className="history-row-main"
                  type="button"
                  onClick={() => onSelectConversation(r.id)}
                >
                  <ChatIcon className="row-icon" />
                  <span className="meta">
                    {editingId === r.id ? (
                      <input
                        className="inline-title-input"
                        value={editingValue}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                    ) : (
                      <b>{r.displayTitle}</b>
                    )}
                    <small>{formatHistoryPreview(r)}</small>
                  </span>
                  <span className="row-right">
                    <span>{relativeFromIso(r.updatedAt)}</span>
                    {r.messageCount === 0 && <StatusPill tone="warn">empty</StatusPill>}
                  </span>
                </button>
                <button
                  className="history-row-rename"
                  type="button"
                  aria-label={`Rename ${r.displayTitle}`}
                  title="Rename"
                  onClick={(e) => beginRename(r, e)}
                >
                  <PencilIcon />
                </button>
                <button
                  className="history-row-delete"
                  type="button"
                  aria-label={`Delete ${r.displayTitle}`}
                  title="Delete conversation"
                  onClick={(e) => void handleDeleteConversation(r.id, e)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/// Human label for each artifact kind, shown in the rail subtitle + doc-head.
const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

const KIND_EXT: Record<ArtifactKind, string> = {
  markdown: '.md',
  text: '.txt',
  code: '.code',
  json: '.json',
  html: '.html',
};

const KIND_ORDER: ArtifactKind[] = ['html', 'markdown', 'code', 'json', 'text'];

/// Quiet file-state indicator for the directory-style list (dot + title).
function fileStateDot(state: FileState): { className: string; title: string } {
  switch (state) {
    case 'ok':
      return { className: 'ok', title: 'Saved' };
    case 'modified':
      return { className: 'warn', title: 'Changed on disk' };
    case 'missing':
      return { className: 'bad', title: 'Missing on disk' };
    case 'noFileContent':
      return { className: 'hold', title: 'Inline' };
  }
}

function ArtifactsPane({
  paneActive,
  artifacts,
  fileStateMap,
  activeArtifactId,
  onOpenArtifact,
  onRenameArtifact,
}: {
  paneActive: boolean;
  artifacts: Artifact[];
  fileStateMap: Record<string, FileState>;
  activeArtifactId?: string | null;
  onOpenArtifact: (id: string) => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [query, setQuery] = useState('');
  const [collapsedKinds, setCollapsedKinds] = useState<Partial<Record<ArtifactKind, boolean>>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((a) => {
      const hay = `${a.title ?? ''} ${KIND_LABEL[a.kind] ?? a.kind} ${KIND_EXT[a.kind] ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [artifacts, query]);

  const grouped = useMemo(() => {
    const byKind = new Map<ArtifactKind, Artifact[]>();
    for (const a of filtered) {
      const list = byKind.get(a.kind) ?? [];
      list.push(a);
      byKind.set(a.kind, list);
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => ({
      kind,
      items: byKind.get(kind)!,
    }));
  }, [filtered]);

  function startEdit(a: Artifact, e: React.MouseEvent) {
    e.stopPropagation();
    const current = a.title ?? '';
    setEditingId(a.id);
    setEditingValue(current);
  }

  function commitEdit(id: string) {
    const trimmed = editingValue.trim();
    if (trimmed && onRenameArtifact) {
      void onRenameArtifact(id, trimmed);
    }
    setEditingId(null);
    setEditingValue('');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingValue('');
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>, id: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  function toggleKind(kind: ArtifactKind) {
    setCollapsedKinds((current) => ({ ...current, [kind]: !current[kind] }));
  }

  return (
    <section
      className="tab-pane"
      data-pane="artifacts"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Files and artifacts"
    >
      <div className="tab-list scroll artifact-dir">
        {artifacts.length > 0 && (
          <SearchBox
            placeholder="Search files"
            ariaLabel="Search artifacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {artifacts.length === 0 ? (
          <SectionLabel left="No artifacts yet" right="local" />
        ) : filtered.length === 0 ? (
          <SectionLabel left="No matching files" right={`${artifacts.length} local`} />
        ) : (
          <>
            <SectionLabel left="Files" right={`${filtered.length} local`} />
            {grouped.map(({ kind, items }) => {
              const collapsed = collapsedKinds[kind] === true;
              return (
                <div key={kind} className="artifact-dir-group">
                  <button
                    className="artifact-dir-folder"
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleKind(kind)}
                  >
                    {collapsed ? (
                      <ChevronRight className="artifact-dir-chevron" />
                    ) : (
                      <ChevronDown className="artifact-dir-chevron" />
                    )}
                    <FolderIcon className="artifact-dir-folder-icon" />
                    <span className="artifact-dir-folder-label">{KIND_LABEL[kind]}</span>
                    <span className="artifact-dir-folder-count">{items.length}</span>
                  </button>
                  {!collapsed &&
                    items.map((a) => {
                      const state = fileStateMap[a.id] ?? 'noFileContent';
                      const dot = fileStateDot(state);
                      const name = a.title ?? 'Untitled artifact';
                      const isActive = a.id === activeArtifactId;
                      return (
                        <button
                          key={a.id}
                          className={`artifact-file-row${isActive ? ' active' : ''}`}
                          type="button"
                          data-file-state-target={state}
                          data-kind={a.kind}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => onOpenArtifact(a.id)}
                        >
                          <span className="artifact-file-ext" aria-hidden="true">
                            {KIND_EXT[a.kind]}
                          </span>
                          <span className="meta">
                            {editingId === a.id ? (
                              <input
                                className="inline-title-input"
                                value={editingValue}
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setEditingValue(e.target.value)}
                                onBlur={() => commitEdit(a.id)}
                                onKeyDown={(e) => handleKey(e, a.id)}
                              />
                            ) : (
                              <b onClick={(e) => startEdit(a, e)} style={{ cursor: 'text' }}>
                                {name}
                              </b>
                            )}
                            <small>
                              {a.updatedAt ? relativeFromIso(a.updatedAt) : KIND_LABEL[a.kind]}
                            </small>
                          </span>
                          <span
                            className={`artifact-file-dot ${dot.className}`}
                            title={dot.title}
                            aria-label={dot.title}
                          />
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

/// Map a connector snapshot's health + support state + grant status to a
/// health-dot class + a `StatusPill` tone/label. This is the failure-state UI
/// the phase doc requires: degraded/revoked/authRequired/adminDisabled are all
/// visible at a glance, not buried.
function connectorStatus(s: ConnectorRuntimeSnapshot): {
  dot: 'live' | 'warn' | 'off';
  tone: 'ok' | 'warn' | 'bad' | 'hold';
  label: string;
} {
  if (s.grantStatus === 'revoked') return { dot: 'off', tone: 'bad', label: 'revoked' };
  if (s.supportState === 'adminDisabled') return { dot: 'off', tone: 'bad', label: 'disabled' };
  if (s.supportState === 'revoked') return { dot: 'off', tone: 'bad', label: 'revoked' };
  if (s.supportState === 'unsupported') return { dot: 'off', tone: 'bad', label: 'unsupported' };
  if (s.supportState === 'authRequired') return { dot: 'warn', tone: 'warn', label: 'sign in' };
  if (s.running) {
    if (s.health === 'healthy') return { dot: 'live', tone: 'ok', label: 'live' };
    if (s.health === 'degraded') return { dot: 'warn', tone: 'warn', label: 'degraded' };
    if (s.health === 'down') return { dot: 'off', tone: 'bad', label: 'down' };
    return { dot: 'warn', tone: 'warn', label: s.health ?? '—' };
  }
  // Not running: a stopped (but grantable) connector is on hold.
  if (s.health === 'down') return { dot: 'off', tone: 'bad', label: 'down' };
  if (s.health === 'degraded') return { dot: 'warn', tone: 'warn', label: 'degraded' };
  return { dot: 'off', tone: 'hold', label: 'stopped' };
}

function ConnectorsPane({
  onManageConnectors,
  paneActive,
}: {
  onManageConnectors?: () => void;
  paneActive: boolean;
}) {
  const [rows, setRows] = useState<ConnectorRuntimeSnapshot[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ConnectorCapability[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingDiscovery, setRefreshingDiscovery] = useState<string | null>(null);

  const refresh = () => {
    void (async () => {
      try {
        const nextRows = await getConnectorRuntimeStates();
        setRows(nextRows);
        const capabilityEntries = await Promise.all(
          nextRows.map(async (row) => {
            try {
              return [row.connectorVersionId, await listConnectorCapabilities(row.connectorVersionId)] as const;
            } catch {
              return [row.connectorVersionId, []] as const;
            }
          }),
        );
        setCapabilities(Object.fromEntries(capabilityEntries));
      } catch {
        setRows([]);
        setCapabilities({});
      }
    })();
  };

  useEffect(() => {
    if (!paneActive) return;
    if (document.visibilityState === 'hidden') return;

    refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 5000);

    function onVisibility() {
      if (document.visibilityState === 'visible' && paneActive) refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [paneActive]);

  const granted = rows.filter((r) => r.grantStatus === 'active').length;

  async function toggle(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      if (s.running) {
        await stopConnector(s.connectorVersionId);
      } else {
        await startConnector(s.connectorVersionId);
      }
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function refreshDiscovery(s: ConnectorRuntimeSnapshot) {
    setRefreshingDiscovery(s.connectorVersionId);
    try {
      const next = await discoverConnector(s.connectorVersionId);
      setCapabilities((current) => ({ ...current, [s.connectorVersionId]: next }));
      refresh();
    } finally {
      setRefreshingDiscovery(null);
    }
  }

  return (
    <section
      className="tab-pane"
      data-pane="connectors"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Connectors"
    >
      <div className="tab-list scroll">
        <InfoCard title="Tenant capabilities, not generic plugins">
          Connector status combines transport health, auth state, tenant grant, and support state.
          {onManageConnectors && (
            <>
              {' '}
              <button className="btn ghost" type="button" style={{ padding: '2px 6px', fontSize: '12px' }} onClick={onManageConnectors}>
                Manage in Settings
              </button>
            </>
          )}
        </InfoCard>
        {rows.length === 0 ? (
          <SectionLabel left="No connectors yet" right="add in settings" />
        ) : (
          <>
            <SectionLabel left="Connectors" right={`${granted} granted`} />
            {rows.map((s) => {
              const st = connectorStatus(s);
              const subtitle =
                s.lastError && (st.tone === 'bad' || st.tone === 'warn')
                  ? s.lastError
                  : `${s.transport} · v${s.version}`;
              const toolCaps = (capabilities[s.connectorVersionId] ?? []).filter((cap) => cap.kind === 'tool');
              const canToggle =
                s.grantStatus === 'active' &&
                s.supportState !== 'adminDisabled' &&
                s.supportState !== 'revoked' &&
                s.supportState !== 'unsupported' &&
                s.supportState !== 'authRequired';
              return (
                <div key={s.connectorVersionId} className="list-row">
                  <span className={`health ${st.dot}`} />
                  <span className="meta">
                    <b>{s.connectorName}</b>
                    <small>{subtitle}</small>
                    <small>
                      Tools: {toolCaps.length > 0 ? toolCaps.map((cap) => cap.name).join(', ') : 'none discovered'}
                    </small>
                  </span>
                  <span className="row-right">
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={refreshingDiscovery === s.connectorVersionId || !s.running}
                      onClick={() => void refreshDiscovery(s)}
                    >
                      Refresh tools
                    </button>
                    {canToggle && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busy === s.connectorVersionId}
                        onClick={() => void toggle(s)}
                      >
                        {s.running ? 'Stop' : 'Start'}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

function activityPane(paneActive: boolean) {
  return (
    <section
      className="tab-pane"
      data-pane="activity"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Activity and approvals"
    >
      <div className="tab-list scroll">
        <InfoCard title="Activity and approvals">
          Approvals, tool runs, and connector errors will appear here when the runtime feed is wired. Nothing is pending right now.
        </InfoCard>
        <SectionLabel left="Awaiting you" />
        <p className="empty-pane-note">No pending approvals</p>
      </div>
    </section>
  );
}

export function RailPanes({
  active,
  artifacts,
  fileStateMap,
  activeArtifactId,
  onOpenArtifact,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onDeleteAllHistory,
  onNewChat,
  onRenameArtifact,
  onManageConnectors,
  onConversationRenamed,
}: RailPanesProps) {
  return (
    <>
      <HistoryPane
        paneActive={active === 'history'}
        activeConversationId={activeConversationId}
        onSelectConversation={onSelectConversation}
        onDeleteConversation={onDeleteConversation}
        onDeleteAllHistory={onDeleteAllHistory}
        onNewChat={onNewChat}
        onConversationRenamed={onConversationRenamed}
      />
      <ArtifactsPane
        paneActive={active === 'artifacts'}
        artifacts={artifacts}
        fileStateMap={fileStateMap}
        activeArtifactId={activeArtifactId}
        onOpenArtifact={onOpenArtifact}
        onRenameArtifact={onRenameArtifact}
      />
      <ConnectorsPane
        onManageConnectors={onManageConnectors}
        paneActive={active === 'connectors'}
      />
      {ACTIVITY_PANE_ENABLED ? activityPane(active === 'activity') : null}
    </>
  );
}