import { useEffect, useState } from 'react';
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
  startConnector,
  stopConnector,
} from '../ipc/client';
import {
  ACTIVITY_ROWS,
} from '../mock/workspace';
import { summarizeMessageContentForPreview } from '../chat/messageSegments';
import { InfoCard, SectionLabel, StatusPill } from '@conduit/ui';
import {
  ActivityCheckIcon,
  AlertIcon,
  ChatIcon,
  ConnectorsIcon,
  FileIcon,
  PlusIcon,
  ShareIcon,
  TrashIcon,
} from '../icons';

interface RailPanesProps {
  active: WorkspaceTab;
  /// Artifacts for the active conversation (metadata-only list from `listArtifacts`).
  artifacts: Artifact[];
  /// Per-artifact file-state for the rail state dots.
  fileStateMap: Record<string, FileState>;
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
  /// Create + switch to a fresh conversation (the "New chat" button).
  onNewChat: () => void;
  /// Rename an artifact (title update). Optional — when provided, rows become editable.
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
  /// Open Settings on the Connectors sub-tab for full connector management.
  onManageConnectors?: () => void;
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
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onDeleteAllHistory,
  onNewChat,
}: {
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  onDeleteAllHistory: () => void | Promise<void>;
  onNewChat: () => void;
}) {
  const [rows, setRows] = useState<ConversationSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

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

  async function handleDeleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await onDeleteConversation(id);
    setRefreshKey((k) => k + 1);
  }

  async function handleDeleteAllHistory() {
    await onDeleteAllHistory();
    setRefreshKey((k) => k + 1);
  }

  return (
    <section className="tab-pane" data-pane="history" aria-label="Chat history">
      <div className="tab-list scroll">
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
        ) : (
          <>
            <SectionLabel left="Previous conversations" right={`${rows.length}`} />
            {rows.map((r) => (
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
                    <b>{r.displayTitle}</b>
                    <small>{formatHistoryPreview(r)}</small>
                  </span>
                  <span className="row-right">
                    <span>{relativeFromIso(r.updatedAt)}</span>
                    {r.messageCount === 0 && <StatusPill tone="warn">empty</StatusPill>}
                  </span>
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

/// File-state → `StatusPill` tone + short label for the rail.
function fileStatePill(state: FileState): { tone: 'ok' | 'warn' | 'bad' | 'hold'; label: string } {
  switch (state) {
    case 'ok':
      return { tone: 'ok', label: 'saved' };
    case 'modified':
      return { tone: 'warn', label: 'changed' };
    case 'missing':
      return { tone: 'bad', label: 'missing' };
    case 'noFileContent':
      return { tone: 'hold', label: 'inline' };
  }
}

function ArtifactsPane({
  artifacts,
  fileStateMap,
  onOpenArtifact,
  onRenameArtifact,
}: {
  artifacts: Artifact[];
  fileStateMap: Record<string, FileState>;
  onOpenArtifact: (id: string) => void;
  onRenameArtifact?: (id: string, title: string) => void | Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

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

  return (
    <section className="tab-pane" data-pane="artifacts" aria-label="Files and artifacts">
      <div className="tab-list scroll">
        {artifacts.length === 0 ? (
          <SectionLabel left="No artifacts yet" right="local" />
        ) : (
          <>
            <SectionLabel left="Open artifacts" right={`${artifacts.length} local`} />
            {artifacts.map((a) => {
              const state = fileStateMap[a.id] ?? 'noFileContent';
              const pill = fileStatePill(state);
              const name = a.title ?? 'Untitled artifact';
              const subtitle = `${KIND_LABEL[a.kind] ?? a.kind}${a.updatedAt ? ` · ${relativeFromIso(a.updatedAt)}` : ''}`;
              return (
                <button
                  key={a.id}
                  className="list-row"
                  type="button"
                  data-file-state-target={state}
                  onClick={() => onOpenArtifact(a.id)}
                >
                  <FileIcon className="row-icon" />
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
                    <small>{subtitle}</small>
                  </span>
                  <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
                </button>
              );
            })}
          </>
        )}
        <SectionLabel left="Cloud state" />
        <button className="list-row" type="button">
          <ShareIcon className="row-icon" />
          <span className="meta">
            <b>Artifact share is off</b>
            <small>Opt in only. Local users remain invisible by default.</small>
          </span>
          <span className="row-right">local</span>
        </button>
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

function ConnectorsPane({ onManageConnectors }: { onManageConnectors?: () => void }) {
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
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, []);

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
    <section className="tab-pane" data-pane="connectors" aria-label="Connectors">
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

function activityPane() {
  return (
    <section className="tab-pane" data-pane="activity" aria-label="Activity and approvals">
      <div className="tab-list scroll">
        <InfoCard title="What else belongs in the chat rail?">
          A dedicated Activity tab makes approvals, tool runs, cancellations, and connector errors easy to audit without burying them in chat history.
        </InfoCard>
        <SectionLabel left="Awaiting you" />
        {ACTIVITY_ROWS.filter((r) => r.awaiting).map((r) => (
          <button key={r.id} className="activity-row" type="button">
            <ConnectorsIcon className="row-icon" />
            <span className="meta">
              <b>{r.title}</b>
              <small>{r.subtitle}</small>
            </span>
            <StatusPill tone={r.tone}>{r.toneLabel}</StatusPill>
          </button>
        ))}
        <SectionLabel left="Recent activity" />
        {ACTIVITY_ROWS.filter((r) => !r.awaiting).map((r) => (
          <button key={r.id} className="activity-row" type="button">
            {r.tone === 'ok' ? <ActivityCheckIcon className="row-icon" /> : <AlertIcon className="row-icon" />}
            <span className="meta">
              <b>{r.title}</b>
              <small>{r.subtitle}</small>
            </span>
            <StatusPill tone={r.tone}>{r.toneLabel}</StatusPill>
          </button>
        ))}
      </div>
    </section>
  );
}

export function RailPanes({
  active,
  artifacts,
  fileStateMap,
  onOpenArtifact,
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onDeleteAllHistory,
  onNewChat,
  onRenameArtifact,
  onManageConnectors,
}: RailPanesProps) {
  // The active prop is accepted for future per-pane focus/refresh hooks; the
  // show/hide is driven by [data-tab] on <html> so panes stay mounted.
  void active;
  return (
    <>
      <HistoryPane
        activeConversationId={activeConversationId}
        onSelectConversation={onSelectConversation}
        onDeleteConversation={onDeleteConversation}
        onDeleteAllHistory={onDeleteAllHistory}
        onNewChat={onNewChat}
      />
      <ArtifactsPane
        artifacts={artifacts}
        fileStateMap={fileStateMap}
        onOpenArtifact={onOpenArtifact}
        onRenameArtifact={onRenameArtifact}
      />
      <ConnectorsPane onManageConnectors={onManageConnectors} />
      {activityPane()}
    </>
  );
}