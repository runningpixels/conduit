import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppPaths, AppSettings, Artifact, ArtifactContent, ConversationSummary, FileState, OnboardingState } from './ipc/contracts';
import type { ArtifactCandidate } from './chat/artifactCandidates';
import type { StatusState } from './chat/statusTypes';
import { ToastStack } from './workspace/ToastStack';
import { makeStatus, fromString, STATUS_DISMISS_MS, TOAST_DISMISS_MS, TOAST_STATUS_KINDS } from './chat/statusTypes';
import {
  checkArtifactFileState,
  createArtifact,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  exportArtifact,
  getAppPaths,
  getArtifact,
  getMessageIdByRequest,
  getOnboardingState,
  getSettings,
  listConversations,
  revealArtifactsDir,
  setArtifactContent,
  setArtifactTitle,
  updateSettings,
} from './ipc/client';
import { ChatView, type ChatViewHandle } from './chat/ChatView';
import {
  documentToolArtifactKind,
  hadFailedDocumentToolCalls,
  hadSuccessfulDocumentToolCalls,
  isDocumentCreateTool,
  resolveDocumentArtifactId,
  type DocumentToolActivity,
} from './chat/agentTools';
import type { AssistantStreamState } from './chat/streamState';
import type { PendingArtifact } from './artifacts/pendingArtifact';
import { applyTheme, resolveTheme, watchSystemTheme } from './theme';
import { Titlebar, deriveConnectionState } from './workspace/Titlebar';
import { Rail, type WorkspaceTab } from './workspace/Rail';
import { RailPanes } from './workspace/RailPanes';
import { DocumentPanel } from './workspace/DocumentPanel';
import { SettingsScreen, type SettingsTab } from './workspace/settings/SettingsScreen';
import { useColumnResize, useDocPanelCollapse, useRailExpand } from './workspace/useLayout';
import { ACTIVITY_PANE_ENABLED } from './workspace/features';
import { useHotkeys } from './workspace/useHotkeys';
import { CommandPalette } from './workspace/CommandPalette';
import { refreshArtifactList } from './workspace/useArtifacts';
import { ChevronLeft, PlusIcon } from './icons';
import { Onboarding, MigrationRecoveryNotice } from './onboarding/Onboarding';
import { ConfirmDialog } from '@conduit/ui';

const DOC_PANEL_HINT_KEY = 'conduit:v5-doc-panel-hint-seen';

const TAB_TITLES: Record<WorkspaceTab, [string, string]> = {
  chat: ['Untitled chat', ''],
  history: ['Chat history', 'Local conversations and their artifacts'],
  artifacts: ['Files and artifacts', 'Local workspace, versions, share state'],
  connectors: ['Connectors', 'Tenant-granted tools and support state'],
  activity: ['Activity and approvals', 'Tool runs, consent, recoverable events'],
  settings: ['Settings', 'Provider, privacy, connectors, and more'],
};

/** Shorten an absolute path to the last few segments for the titlebar. */
function shortenWorkspacePath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/') || absolutePath;
  return parts.slice(-3).join('/');
}

function formatChatSubtitle(summary: ConversationSummary | null): string {
  if (!summary) return '';
  const n = summary.messageCount;
  return n === 1 ? '1 message' : `${n} messages`;
}

function modShortcutHint(key: string): string {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return `${isMac ? '⌘' : 'Ctrl'}+${key}`;
}

const defaultSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: false,
  webSearchEnabled: false,
  webSearch: {
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
};

const ASSISTANT_TURN_PREFIX = 'assistant-';

async function resolveSourceMessageId(messageId: string): Promise<string> {
  if (!messageId.startsWith(ASSISTANT_TURN_PREFIX)) return messageId;
  const requestId = messageId.slice(ASSISTANT_TURN_PREFIX.length);
  try {
    const realId = await getMessageIdByRequest(requestId);
    if (realId) return realId;
  } catch {
    /* fall back to the client turn id */
  }
  return messageId;
}

export default function App() {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [status, setStatus] = useState<StatusState | null>(makeStatus('Booting desktop shell', 'active'));
  const [boundaryOk, setBoundaryOk] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [openArtifactIds, setOpenArtifactIds] = useState<string[]>([]);
  const [pendingArtifact, setPendingArtifact] = useState<PendingArtifact | null>(null);
  const [fileStateMap, setFileStateMap] = useState<Record<string, FileState>>({});
  const [docTab, setDocTab] = useState<'preview' | 'source'>('preview');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationSummary, setActiveConversationSummary] = useState<ConversationSummary | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [toasts, setToasts] = useState<StatusState[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteConversations, setPaletteConversations] = useState<{ id: string; title: string }[]>([]);
  const chatViewRef = useRef<ChatViewHandle>(null);

  const { onPointerDown, onKeyDown: onResizeKeyDown, ariaValueNow, ariaValueMin, ariaValueMax } =
    useColumnResize();
  const { expanded, toggle: toggleRail } = useRailExpand();
  const { collapsed: docPanelCollapsed, collapse: collapseDocPanel, expand: expandDocPanel, toggle: toggleDocPanel } = useDocPanelCollapse();

  // Rich status: accepts either a string (legacy) or a StatusState object.
  const setStatusMessage = useCallback((message: string | StatusState) => {
    const state = typeof message === 'string' ? fromString(message) : message;
    setStatus(state);
  }, []);

  // Route error/warning/success to ToastStack exclusively; clear panel status after.
  useEffect(() => {
    if (!status) return;
    if (!TOAST_STATUS_KINDS.has(status.kind)) return;
    setToasts((current) => {
      if (current.some((t) => t.timestamp === status.timestamp)) return current;
      return [...current.slice(-4), status];
    });
    setStatus(null);
  }, [status]);

  const dismissToast = useCallback((timestamp: number) => {
    setToasts((current) => current.filter((t) => t.timestamp !== timestamp));
  }, []);

  // Auto-dismiss timer for transient panel-head status kinds (idle).
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!status) return;
    const ms = STATUS_DISMISS_MS[status.kind];
    if (ms == null) return;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatus(null);
    }, ms);
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [status]);

  // Auto-dismiss warning/success toasts; errors stay until dismissed.
  useEffect(() => {
    const timers = toasts
      .filter((t) => TOAST_DISMISS_MS[t.kind] != null)
      .map((t) =>
        window.setTimeout(() => dismissToast(t.timestamp), TOAST_DISMISS_MS[t.kind]!),
      );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts, dismissToast]);

  const handleCollapseDocPanel = useCallback(() => {
    collapseDocPanel();
    try {
      if (localStorage.getItem(DOC_PANEL_HINT_KEY) === '1') return;
      localStorage.setItem(DOC_PANEL_HINT_KEY, '1');
      const hint = makeStatus(
        `Artifact panel hidden. Press ${modShortcutHint('J')} or use the edge tab to bring it back.`,
        'success',
      );
      setToasts((current) => [...current.slice(-4), hint]);
    } catch {
      /* ignore storage failures */
    }
  }, [collapseDocPanel]);

  const refreshActiveConversationSummary = useCallback(async (conversationId: string | null) => {
    if (!conversationId) {
      setActiveConversationSummary(null);
      return;
    }
    try {
      const conversations = await listConversations();
      setActiveConversationSummary(conversations.find((c) => c.id === conversationId) ?? null);
    } catch {
      setActiveConversationSummary(null);
    }
  }, []);

  useEffect(() => {
    void refreshActiveConversationSummary(activeConversationId);
  }, [activeConversationId, refreshActiveConversationSummary]);

  const clearWorkspaceArtifactSelection = useCallback(() => {
    setActiveArtifact(null);
    setOpenArtifactIds([]);
    setPendingArtifact(null);
  }, []);

  const handleDocumentToolActivity = useCallback(
    (activity: DocumentToolActivity) => {
      if (activity.phase === 'error') {
        setPendingArtifact(null);
        return;
      }

      const mode: PendingArtifact['mode'] = isDocumentCreateTool(activity.toolName)
        ? 'create'
        : 'edit';
      const kind = documentToolArtifactKind(activity.toolName);

      expandDocPanel();
      setPendingArtifact((current) => ({
        kind,
        toolName: activity.toolName,
        mode,
        title: activity.titleHint ?? current?.title,
        artifactId: activity.artifactId ?? current?.artifactId,
      }));
    },
    [expandDocPanel],
  );

  const ensureConversation = useCallback(async () => {
    try {
      const conversations = await listConversations();
      if (conversations.length > 0) {
        setActiveConversationId(conversations[0].id);
      } else {
        const created = await createConversation();
        setActiveConversationId(created.id);
      }
    } catch {
      /* leave null; the chat view surfaces an empty thread */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [loadedPaths, loadedSettings, onboardingState] = await Promise.all([
          getAppPaths(),
          getSettings(),
          getOnboardingState(),
        ]);
        setPaths(loadedPaths);
        setSettings(loadedSettings);
        setOnboarding(onboardingState);

        const readyForWorkspace =
          onboardingState.onboardingCompleted &&
          onboardingState.hasProviderCredential &&
          !onboardingState.migrationRecovery;
        if (readyForWorkspace) {
          await ensureConversation();
          setBoundaryOk(true);
          setStatus(null);
        } else {
          setBoundaryOk(true);
          setStatus(null);
        }
      } catch (error) {
        setBoundaryOk(false);
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to load desktop state', 'error'));
      }
    })();
  }, [ensureConversation]);

  const refreshOnboarding = useCallback(async () => {
    try {
      const next = await getOnboardingState();
      setOnboarding(next);
      setSettings(await getSettings());
      if (next.onboardingCompleted && next.hasProviderCredential && !next.migrationRecovery) {
        await ensureConversation();
      }
    } catch {
      /* leave current state; the user can retry */
    }
  }, [ensureConversation]);

  const handleNewChat = useCallback(async () => {
    try {
      const created = await createConversation();
      setActiveConversationId(created.id);
      clearWorkspaceArtifactSelection();
      setStatus(makeStatus('Started a new chat', 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to create chat', 'error'));
    }
  }, [clearWorkspaceArtifactSelection]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);
      clearWorkspaceArtifactSelection();
      setActiveTab('chat');
    },
    [clearWorkspaceArtifactSelection],
  );

  const handleDeleteConversation = useCallback((id: string) => {
    setConfirmDeleteId(id);
  }, []);

  const performDeleteConversation = useCallback(
    async (id: string) => {
      const wasActive = activeConversationId === id;
      try {
        await deleteConversation(id);
        if (wasActive) {
          const remaining = await listConversations();
          if (remaining.length > 0) {
            setActiveConversationId(remaining[0].id);
          } else {
            const created = await createConversation();
            setActiveConversationId(created.id);
          }
          clearWorkspaceArtifactSelection();
          setActiveTab('chat');
        }
        setStatus(makeStatus('Conversation deleted', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to delete conversation', 'error'));
      }
    },
    [activeConversationId, clearWorkspaceArtifactSelection],
  );

  const handleDeleteAllHistory = useCallback(() => {
    setConfirmDeleteAll(true);
  }, []);

  const performDeleteAllHistory = useCallback(async () => {
    try {
      const created = await deleteAllConversations();
      setActiveConversationId(created.id);
      clearWorkspaceArtifactSelection();
      setActiveTab('chat');
      setStatus(makeStatus('All conversation history deleted', 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to delete history', 'error'));
    }
  }, [clearWorkspaceArtifactSelection]);

  const refreshArtifacts = useCallback(async (conversationId: string): Promise<Artifact[]> => {
    try {
      const { artifacts: listed, fileStateMap: nextMap } = await refreshArtifactList(conversationId);
      setArtifacts(listed);
      setFileStateMap(nextMap);
      return listed;
    } catch (error) {
      setArtifacts([]);
      setFileStateMap({});
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to load artifacts', 'error'));
      return [];
    }
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    void refreshArtifacts(activeConversationId);
  }, [activeConversationId, refreshArtifacts]);

  const addOpenArtifactId = useCallback((artifactId: string) => {
    setOpenArtifactIds((current) => (current.includes(artifactId) ? current : [...current, artifactId]));
  }, []);

  // Artifact auto-open updates the right DocumentPanel only.
  // The left rail tab reflects explicit user navigation and is never forced.
  const handleOpenArtifact = useCallback(
    async (artifactId: string) => {
      try {
        const got = await getArtifact(artifactId);
        if (!got) return;
        expandDocPanel();
        addOpenArtifactId(artifactId);
        setActiveArtifact(got);
        const state = await checkArtifactFileState(artifactId);
        setFileStateMap((current) => ({ ...current, [artifactId]: state }));
        setDocTab('preview');
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to open artifact', 'error'));
      }
    },
    [addOpenArtifactId, expandDocPanel],
  );

  const handleChatTurnComplete = useCallback(
    async (streamState: AssistantStreamState) => {
      if (!activeConversationId) return;
      void refreshActiveConversationSummary(activeConversationId);

      if (hadFailedDocumentToolCalls(streamState) && !hadSuccessfulDocumentToolCalls(streamState)) {
        setPendingArtifact(null);
        return;
      }
      if (!hadSuccessfulDocumentToolCalls(streamState)) {
        setPendingArtifact(null);
        return;
      }

      const listed = await refreshArtifacts(activeConversationId);
      const artifactId = resolveDocumentArtifactId(streamState, listed);
      if (artifactId) {
        await handleOpenArtifact(artifactId);
      }
      setPendingArtifact(null);
      setStatus(makeStatus('Document updated', 'success'));
    },
    [
      activeConversationId,
      refreshArtifacts,
      refreshActiveConversationSummary,
      handleOpenArtifact,
    ],
  );

  const handleCloseArtifactTab = useCallback(
    (artifactId: string) => {
      setOpenArtifactIds((current) => current.filter((id) => id !== artifactId));
    },
    [],
  );

  // When the active artifact is removed from openArtifactIds, switch to the
  // last remaining open artifact or clear the active artifact.
  useEffect(() => {
    if (!activeArtifact) return;
    if (!openArtifactIds.includes(activeArtifact.id)) {
      if (openArtifactIds.length > 0) {
        void handleOpenArtifact(openArtifactIds[openArtifactIds.length - 1]);
      } else {
        setActiveArtifact(null);
      }
    }
  }, [activeArtifact?.id, openArtifactIds, handleOpenArtifact]);

  const handleSaveContent = useCallback(
    async (artifactId: string, content: ArtifactContent, mimeType?: string) => {
      try {
        const updated = await setArtifactContent(artifactId, content, mimeType);
        setActiveArtifact(updated);
        if (activeConversationId) {
          await refreshArtifacts(activeConversationId);
        }
        const state = await checkArtifactFileState(artifactId);
        setFileStateMap((current) => ({ ...current, [artifactId]: state }));
        setStatus(makeStatus('Saved artifact', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to save artifact', 'error'));
        throw error;
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  const handleExport = useCallback(
    async (artifactId: string, includeMetadata: boolean) => {
      try {
        const result = await exportArtifact(artifactId, includeMetadata);
        setStatus(makeStatus(`Exported to ${result.exportedTo}`, 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to export artifact', 'error'));
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeArtifact) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (docPanelCollapsed) return;
      void (async () => {
        try {
          const state = await checkArtifactFileState(activeArtifact.id);
          setFileStateMap((current) => ({ ...current, [activeArtifact.id]: state }));
        } catch {
          /* keep last known state */
        }
      })();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    function onVisibility() {
      if (document.visibilityState === 'visible') tick();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeArtifact, docPanelCollapsed]);

  const handlePromoteArtifact = useCallback(
    async (messageId: string, candidate: ArtifactCandidate) => {
      if (!activeConversationId) return;
      try {
        const sourceMessageId = await resolveSourceMessageId(messageId);
        const created = await createArtifact(
          activeConversationId,
          candidate.kind,
          candidate.title,
          sourceMessageId,
        );
        await setArtifactContent(created.id, { kind: 'text', text: candidate.body }, candidate.mimeType);
        await refreshArtifacts(activeConversationId);
        await handleOpenArtifact(created.id);
        setStatus(makeStatus('Promoted to artifact', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to promote artifact', 'error'));
      }
    },
    [activeConversationId, refreshArtifacts, handleOpenArtifact],
  );

  const handleRenameArtifact = useCallback(
    async (artifactId: string, title: string) => {
      try {
        await setArtifactTitle(artifactId, title);
        if (activeConversationId) {
          await refreshArtifacts(activeConversationId);
        }
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to rename artifact', 'error'));
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => resolveTheme(settings.theme));
  useEffect(() => {
    const eff = applyTheme(settings.theme);
    setEffectiveTheme(eff);
    return watchSystemTheme(settings.theme, () => setEffectiveTheme(resolveTheme(settings.theme)));
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-tab', activeTab);
  }, [activeTab]);

  const [panelTitleBase, panelSubtitleBase] = TAB_TITLES[activeTab];
  const panelTitle =
    activeTab === 'chat'
      ? (activeConversationSummary?.displayTitle ?? 'Untitled chat')
      : panelTitleBase;
  const panelSubtitle =
    activeTab === 'chat' ? formatChatSubtitle(activeConversationSummary) : panelSubtitleBase;

  const workspaceLabel = paths?.artifacts ? shortenWorkspacePath(paths.artifacts) : undefined;

  const hasCredential = onboarding?.hasProviderCredential ?? false;
  const connectionState = deriveConnectionState({
    boundaryOk,
    hasCredential,
    localOnly: settings.localOnly,
  });
  const showActivity =
    status != null && (status.kind === 'active' || status.kind === 'thinking');
  const expandShortcut = modShortcutHint('J');

  const openSettings = useCallback((tab?: SettingsTab) => {
    if (tab) setSettingsInitialTab(tab);
    setActiveTab('settings');
  }, []);

  const handleRevealWorkspace = useCallback(() => {
    void revealArtifactsDir().catch((error) => {
      setStatus(
        makeStatus(error instanceof Error ? error.message : 'Could not reveal artifacts folder', 'error'),
      );
    });
  }, []);

  const handleSelectTab = useCallback((tab: WorkspaceTab) => {
    if (tab === 'activity' && !ACTIVITY_PANE_ENABLED) {
      setActiveTab('chat');
      return;
    }
    if (tab !== 'settings') setSettingsInitialTab(undefined);
    setActiveTab(tab);
  }, []);

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
    void listConversations()
      .then((rows) => {
        setPaletteConversations(rows.map((r) => ({ id: r.id, title: r.displayTitle })));
      })
      .catch(() => {
        setPaletteConversations([]);
      });
  }, []);

  const hotkeyHandlers = useMemo(
    () => ({
      newChat: () => {
        void handleNewChat();
      },
      settings: () => openSettings(),
      toggleRail: () => toggleRail(),
      toggleDocPanel: () => toggleDocPanel(),
      historySearch: () => openPalette(),
      copyLastAssistant: () => {
        void chatViewRef.current?.copyLastAssistantMessage().then((ok) => {
          if (ok) setStatus(makeStatus('Copied last assistant message', 'success'));
          else setStatus(makeStatus('Nothing to copy', 'warning'));
        });
      },
      escape: () => {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (confirmDeleteId != null || confirmDeleteAll) {
          setConfirmDeleteId(null);
          setConfirmDeleteAll(false);
          return;
        }
        const active = document.activeElement;
        if (
          active instanceof HTMLTextAreaElement &&
          active.getAttribute('aria-label') === 'Message the active provider' &&
          chatViewRef.current?.isStreaming()
        ) {
          chatViewRef.current.stopStreaming();
        }
      },
    }),
    [
      confirmDeleteAll,
      confirmDeleteId,
      handleNewChat,
      openPalette,
      openSettings,
      paletteOpen,
      toggleDocPanel,
      toggleRail,
    ],
  );
  useHotkeys(hotkeyHandlers);

  const handleToggleTheme = useCallback(() => {
    setSettings((current) => {
      const next: AppSettings = {
        ...current,
        theme: effectiveTheme === 'light' ? 'dark' : 'light',
      };
      void updateSettingsPersisted(next);
      return next;
    });
  }, [effectiveTheme]);

  const activeFileState = activeArtifact ? fileStateMap[activeArtifact.id] ?? 'noFileContent' : 'noFileContent';

  const openArtifacts = useMemo(() => {
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    return openArtifactIds
      .map((id) => byId.get(id))
      .filter((a): a is Artifact => a != null);
  }, [artifacts, openArtifactIds]);

  if (onboarding?.migrationRecovery) {
    return <MigrationRecoveryNotice recovery={onboarding.migrationRecovery} onStatus={setStatusMessage} />;
  }
  if (onboarding && (!onboarding.onboardingCompleted || !onboarding.hasProviderCredential)) {
    return (
      <Onboarding
        settings={settings}
        onSettingsChange={setSettings}
        onStatus={setStatusMessage}
        status={status}
        onComplete={() => void refreshOnboarding()}
      />
    );
  }

  return (
    <div className="app" id="app">
      <Titlebar
        effectiveTheme={effectiveTheme}
        onToggleTheme={handleToggleTheme}
        workspaceLabel={workspaceLabel}
        onRevealWorkspace={handleRevealWorkspace}
        connectionState={connectionState}
        onConnectionClick={() => openSettings('privacy')}
      />

      <main className="body">
        <section className="left-workspace" aria-label="Assistant workspace">
          {docPanelCollapsed && activeTab !== 'settings' && (
            <button
              className="doc-panel-expand-tab"
              type="button"
              aria-label="Show artifact panel"
              title={`Show artifact panel (${expandShortcut})`}
              onClick={expandDocPanel}
            >
              <ChevronLeft />
              <span className="doc-panel-expand-label">Artifacts</span>
            </button>
          )}
          <Rail
            active={activeTab}
            onSelect={handleSelectTab}
            expanded={expanded}
            onToggleExpand={toggleRail}
            artifactCount={artifacts.length}
          />

          <div className="panel">
            <div className={`panel-head${activeTab === 'chat' ? ' panel-head-chat' : ''}`}>
              <div className="panel-title">
                <b>{panelTitle}</b>
                {panelSubtitle ? <small>{panelSubtitle}</small> : null}
              </div>
              {activeTab !== 'settings' && (
                <div className="actions">
                  {showActivity && status && (
                    <div
                      className="panel-activity"
                      role="status"
                      aria-live="polite"
                    >
                      <span className={`status-icon kind-${status.kind}`} aria-hidden="true" />
                      <span className="panel-activity-brief">{status.brief}</span>
                    </div>
                  )}
                  <button className="new-btn" type="button" onClick={() => void handleNewChat()}>
                    <PlusIcon />
                    New chat
                  </button>
                </div>
              )}
            </div>

            <ChatView
              ref={chatViewRef}
              settings={settings}
              onSettingsChange={setSettings}
              onStatus={setStatusMessage}
              conversationId={activeConversationId}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              onPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
              onChatTurnComplete={(streamState) => void handleChatTurnComplete(streamState)}
              onDocumentToolActivity={handleDocumentToolActivity}
              paneActive={activeTab === 'chat'}
            />
            <RailPanes
              active={activeTab}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              activeArtifactId={activeArtifact?.id ?? null}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              onDeleteConversation={(id) => void handleDeleteConversation(id)}
              onDeleteAllHistory={() => void handleDeleteAllHistory()}
              onNewChat={() => void handleNewChat()}
              onRenameArtifact={handleRenameArtifact}
              onManageConnectors={() => openSettings('connectors')}
              onConversationRenamed={() => void refreshActiveConversationSummary(activeConversationId)}
            />
            <SettingsScreen
              settings={settings}
              onSettingsChange={setSettings}
              paths={paths}
              onStatus={setStatusMessage}
              initialTab={settingsInitialTab}
              paneActive={activeTab === 'settings'}
              connectionState={connectionState}
              boundaryOk={boundaryOk}
              hasCredential={hasCredential}
            />
          </div>
        </section>

        {activeTab !== 'settings' && (
          <>
        <div
          className="resize-handle"
          id="columnResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and document columns"
          aria-valuenow={ariaValueNow}
          aria-valuemin={ariaValueMin}
          aria-valuemax={ariaValueMax}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onResizeKeyDown}
        />

        <DocumentPanel
          artifact={activeArtifact}
          pendingArtifact={pendingArtifact}
          openArtifacts={openArtifacts}
          fileStateMap={fileStateMap}
          activeFileState={activeFileState}
          allowlist={settings.artifactRemoteAllowlist}
          styledPreview={settings.artifactStyledPreview}
          effectiveTheme={effectiveTheme}
          docTab={docTab}
          onSelectTab={setDocTab}
          onOpenArtifact={(id) => void handleOpenArtifact(id)}
          onCloseTab={handleCloseArtifactTab}
          onCollapsePanel={handleCollapseDocPanel}
          onSaveContent={(artifactId, content, mimeType) => handleSaveContent(artifactId, content, mimeType)}
          onExport={(artifactId, includeMetadata) => handleExport(artifactId, includeMetadata)}
          onRenameArtifact={handleRenameArtifact}
          onStatus={setStatusMessage}
        />
          </>
        )}
      </main>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={() => void handleNewChat()}
        onOpenHistory={() => handleSelectTab('history')}
        onOpenSettings={() => openSettings()}
        onToggleTheme={handleToggleTheme}
        onToggleDocPanel={toggleDocPanel}
        conversations={paletteConversations}
        onSelectConversation={handleSelectConversation}
      />

      <ConfirmDialog
        open={confirmDeleteId != null}
        title="Delete conversation?"
        description="Messages and associated local artifacts will be removed."
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void performDeleteConversation(id);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all conversation history?"
        description="All conversations, messages, and associated local artifacts will be removed. App settings are preserved."
        confirmLabel="Delete all"
        confirmPhrase="delete all"
        onCancel={() => setConfirmDeleteAll(false)}
        onConfirm={() => {
          setConfirmDeleteAll(false);
          void performDeleteAllHistory();
        }}
      />
    </div>
  );
}

async function updateSettingsPersisted(next: AppSettings): Promise<void> {
  try {
    await updateSettings(next);
  } catch {
    /* persistence failures surface via status; ignore here */
  }
}
