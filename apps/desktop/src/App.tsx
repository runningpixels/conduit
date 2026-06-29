import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppPaths, AppSettings, Artifact, ArtifactContent, FileState, OnboardingState } from './ipc/contracts';
import type { ArtifactCandidate } from './chat/artifactCandidates';
import {
  checkArtifactFileState,
  createArtifact,
  createConversation,
  exportArtifact,
  getAppPaths,
  getArtifact,
  getMessageIdByRequest,
  getOnboardingState,
  getSettings,
  listArtifacts,
  listConversations,
  setArtifactContent,
  setArtifactTitle,
  updateSettings,
} from './ipc/client';
import { ChatView } from './chat/ChatView';
import {
  hadSuccessfulDocumentToolCalls,
  resolveDocumentArtifactId,
} from './chat/agentTools';
import type { AssistantStreamState } from './chat/streamState';
import { applyTheme, resolveTheme, watchSystemTheme } from './theme';
import { Titlebar } from './workspace/Titlebar';
import { Rail, type WorkspaceTab } from './workspace/Rail';
import { RailPanes } from './workspace/RailPanes';
import { DocumentPanel } from './workspace/DocumentPanel';
import { SettingsScreen, type SettingsTab } from './workspace/settings/SettingsScreen';
import { useColumnResize, useDocPanelCollapse, useRailExpand } from './workspace/useLayout';
import { ChevronLeft, PlusIcon } from './icons';
import { Onboarding, MigrationRecoveryNotice } from './onboarding/Onboarding';

const TAB_TITLES: Record<WorkspaceTab, [string, string]> = {
  chat: ['Chat session', 'Repo triage note - github, slack'],
  history: ['Chat history', 'Local conversations and their artifacts'],
  artifacts: ['Files and artifacts', 'Local workspace, versions, share state'],
  connectors: ['Connectors', 'Tenant-granted tools and support state'],
  activity: ['Activity and approvals', 'Tool runs, consent, recoverable events'],
  settings: ['Settings', 'Provider, privacy, connectors, and more'],
};

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
  const [status, setStatus] = useState('Booting desktop shell');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [openArtifactIds, setOpenArtifactIds] = useState<string[]>([]);
  const [fileStateMap, setFileStateMap] = useState<Record<string, FileState>>({});
  const [docTab, setDocTab] = useState<'preview' | 'source'>('preview');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const { onPointerDown } = useColumnResize();
  const { expanded, toggle: toggleRail } = useRailExpand();
  const { collapsed: docPanelCollapsed, collapse: collapseDocPanel, expand: expandDocPanel } = useDocPanelCollapse();

  const setStatusMessage = useCallback((message: string) => setStatus(message), []);

  const clearWorkspaceArtifactSelection = useCallback(() => {
    setActiveArtifact(null);
    setOpenArtifactIds([]);
  }, []);

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
          setStatus('Rust trust boundary online');
        } else {
          setStatus('');
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to load desktop state');
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
      setStatus('Started a new chat');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create chat');
    }
  }, [clearWorkspaceArtifactSelection]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);
      clearWorkspaceArtifactSelection();
    },
    [clearWorkspaceArtifactSelection],
  );

  const refreshArtifacts = useCallback(async (conversationId: string): Promise<Artifact[]> => {
    try {
      const listed = await listArtifacts(conversationId);
      setArtifacts(listed);
      const states = await Promise.all(
        listed.map(async (a) => {
          try {
            return [a.id, await checkArtifactFileState(a.id)] as const;
          } catch {
            return [a.id, 'missing' as FileState] as const;
          }
        }),
      );
      setFileStateMap(Object.fromEntries(states));
      return listed;
    } catch (error) {
      setArtifacts([]);
      setFileStateMap({});
      setStatus(error instanceof Error ? error.message : 'Failed to load artifacts');
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
        setStatus(error instanceof Error ? error.message : 'Failed to open artifact');
      }
    },
    [addOpenArtifactId, expandDocPanel],
  );

  const handleChatTurnComplete = useCallback(
    async (streamState: AssistantStreamState) => {
      if (!activeConversationId || !hadSuccessfulDocumentToolCalls(streamState)) return;

      const listed = await refreshArtifacts(activeConversationId);
      const artifactId = resolveDocumentArtifactId(streamState, listed);
      if (!artifactId) return;

      await handleOpenArtifact(artifactId);
      setStatus('Document updated');
    },
    [activeConversationId, refreshArtifacts, handleOpenArtifact],
  );

  const handleCloseArtifactTab = useCallback(
    (artifactId: string) => {
      let fallbackId: string | undefined;
      setOpenArtifactIds((current) => {
        const next = current.filter((id) => id !== artifactId);
        if (activeArtifact?.id === artifactId) {
          fallbackId = next[next.length - 1];
        }
        return next;
      });
      if (activeArtifact?.id === artifactId) {
        if (fallbackId) {
          void handleOpenArtifact(fallbackId);
        } else {
          setActiveArtifact(null);
        }
      }
    },
    [activeArtifact?.id, handleOpenArtifact],
  );

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
        setStatus('Saved artifact');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to save artifact');
        throw error;
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  const handleExport = useCallback(
    async (artifactId: string, includeMetadata: boolean) => {
      try {
        const result = await exportArtifact(artifactId, includeMetadata);
        setStatus(`Exported to ${result.exportedTo}`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to export artifact');
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeArtifact) return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const state = await checkArtifactFileState(activeArtifact.id);
          setFileStateMap((current) => ({ ...current, [activeArtifact.id]: state }));
        } catch {
          /* keep last known state */
        }
      })();
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeArtifact]);

  const handlePromoteArtifact = useCallback(
    async (messageId: string, candidate: ArtifactCandidate) => {
      if (!activeConversationId) return;
      try {
        const sourceMessageId = await resolveSourceMessageId(messageId);
        const existing = artifacts.find(
          (a) => a.sourceMessageId === sourceMessageId || a.sourceMessageId === messageId,
        );
        if (existing) {
          await handleOpenArtifact(existing.id);
          setStatus('Opened existing artifact');
          return;
        }

        const created = await createArtifact(
          activeConversationId,
          candidate.kind,
          candidate.title,
          sourceMessageId,
        );
        await setArtifactContent(created.id, { kind: 'text', text: candidate.body }, candidate.mimeType);
        await refreshArtifacts(activeConversationId);
        await handleOpenArtifact(created.id);
        setStatus('Promoted to artifact');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to promote artifact');
      }
    },
    [activeConversationId, artifacts, refreshArtifacts, handleOpenArtifact],
  );

  const handleRenameArtifact = useCallback(
    async (artifactId: string, title: string) => {
      try {
        await setArtifactTitle(artifactId, title);
        if (activeConversationId) {
          await refreshArtifacts(activeConversationId);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to rename artifact');
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

  const [panelTitle, panelSubtitle] = TAB_TITLES[activeTab];

  const openSettings = useCallback((tab?: SettingsTab) => {
    if (tab) setSettingsInitialTab(tab);
    setActiveTab('settings');
  }, []);

  const handleSelectTab = useCallback((tab: WorkspaceTab) => {
    if (tab !== 'settings') setSettingsInitialTab(undefined);
    setActiveTab(tab);
  }, []);

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
        settings={settings}
        effectiveTheme={effectiveTheme}
        onToggleTheme={handleToggleTheme}
        workspaceLabel="Documents/Conduit/Artifacts"
      />

      {status && (
        <div
          role="status"
          aria-live="polite"
          className="status-bar"
          style={{ padding: '4px 12px', fontSize: 12, color: 'var(--text-3)', background: 'var(--surface-2)' }}
        >
          {status}
        </div>
      )}

      <main className="body">
        <section className="left-workspace" aria-label="Assistant workspace">
          {docPanelCollapsed && (
            <button
              className="doc-panel-expand-tab"
              type="button"
              aria-label="Show artifact panel"
              title="Show artifact panel"
              onClick={expandDocPanel}
            >
              <ChevronLeft />
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
            <div className="panel-head">
              <div className="panel-title">
                <b>{panelTitle}</b>
                <small>{panelSubtitle}</small>
              </div>
              {activeTab !== 'settings' && (
                <div className="actions">
                  <button className="new-btn" type="button" onClick={() => void handleNewChat()}>
                    <PlusIcon />
                    New chat
                  </button>
                </div>
              )}
            </div>

            <ChatView
              settings={settings}
              onStatus={setStatusMessage}
              conversationId={activeConversationId}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              onPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
              onAutoPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
              onChatTurnComplete={(streamState) => void handleChatTurnComplete(streamState)}
            />
            <RailPanes
              active={activeTab}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              onNewChat={() => void handleNewChat()}
              onRenameArtifact={handleRenameArtifact}
              onManageConnectors={() => openSettings('connectors')}
            />
            <SettingsScreen
              settings={settings}
              onSettingsChange={setSettings}
              paths={paths}
              onStatus={setStatusMessage}
              initialTab={settingsInitialTab}
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
          onPointerDown={onPointerDown}
        />

        <DocumentPanel
          artifact={activeArtifact}
          openArtifacts={openArtifacts}
          fileStateMap={fileStateMap}
          activeFileState={activeFileState}
          allowlist={settings.artifactRemoteAllowlist}
          styledPreview={settings.artifactStyledPreview}
          docTab={docTab}
          onSelectTab={setDocTab}
          onOpenArtifact={(id) => void handleOpenArtifact(id)}
          onCloseTab={handleCloseArtifactTab}
          onCollapsePanel={collapseDocPanel}
          onSaveContent={(artifactId, content, mimeType) => handleSaveContent(artifactId, content, mimeType)}
          onExport={(artifactId, includeMetadata) => handleExport(artifactId, includeMetadata)}
          onRenameArtifact={handleRenameArtifact}
        />
          </>
        )}
      </main>
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
