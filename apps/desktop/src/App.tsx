import { useCallback, useEffect, useState } from 'react';
import type { AppPaths, AppSettings, Artifact, ArtifactContent, FileState } from './ipc/contracts';
import type { ArtifactCandidate } from './chat/artifactCandidates';
import {
  checkArtifactFileState,
  createArtifact,
  createConversation,
  exportArtifact,
  getAppPaths,
  getArtifact,
  getSettings,
  listArtifacts,
  listConversations,
  setArtifactContent,
  updateSettings,
} from './ipc/client';
import { ChatView } from './chat/ChatView';
import { applyTheme, resolveTheme, watchSystemTheme } from './theme';
import { Titlebar } from './workspace/Titlebar';
import { Rail, type WorkspaceTab } from './workspace/Rail';
import { RailPanes } from './workspace/RailPanes';
import { DocumentPanel } from './workspace/DocumentPanel';
import { SettingsPanel } from './workspace/SettingsPanel';
import { useColumnResize, useRailExpand } from './workspace/useLayout';
import { PlusIcon } from './icons';

const TAB_TITLES: Record<WorkspaceTab, [string, string]> = {
  chat: ['Chat session', 'Repo triage note - github, slack'],
  history: ['Chat history', 'Local conversations and their artifacts'],
  artifacts: ['Files and artifacts', 'Local workspace, versions, share state'],
  connectors: ['Connectors', 'Tenant-granted tools and support state'],
  activity: ['Activity and approvals', 'Tool runs, consent, recoverable events'],
  models: ['Models and keys', 'BYOK providers, tenant allowlist, local runtimes'],
};

const defaultSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
};

export default function App() {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [status, setStatus] = useState('Booting desktop shell');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Phase 5: real artifact state. `artifacts` is the conversation's list
  // (metadata-only; inline content is NOT included — fetch via `getArtifact`).
  // `activeArtifact` is payload-bearing (the one open in DocumentPanel).
  // `fileStateMap` carries the per-artifact file-state machine for the rail +
  // doc-tab state dots.
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [fileStateMap, setFileStateMap] = useState<Record<string, FileState>>({});
  const [docTab, setDocTab] = useState<'preview' | 'source' | 'file'>('preview');
  // Phase 3: the active conversation id, owned here so the chat view and the
  // history rail stay in sync. `null` only until boot ensures a conversation.
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const { onPointerDown } = useColumnResize();
  const { expanded, toggle: toggleRail } = useRailExpand();

  const setStatusMessage = useCallback((message: string) => setStatus(message), []);

  // Boot: load paths + settings (credential state is probed per-provider by the
  // panels that need it; nothing global to load here).
  useEffect(() => {
    void (async () => {
      try {
        const [loadedPaths, loadedSettings] = await Promise.all([getAppPaths(), getSettings()]);
        setPaths(loadedPaths);
        setSettings(loadedSettings);

        // Phase 3: ensure there is an active conversation. `list_conversations`
        // returns newest-first; pick the most recent, or create one if the store
        // is empty so the chat view always has somewhere to write.
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

        setStatus('Rust trust boundary online');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to load desktop state');
      }
    })();
  }, []);

  // Phase 3: create a fresh conversation and switch to it (the "New chat"
  // button + the history rail's new-chat row).
  const handleNewChat = useCallback(async () => {
    try {
      const created = await createConversation();
      setActiveConversationId(created.id);
      setStatus('Started a new chat');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create chat');
    }
  }, []);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  // Phase 5: refresh the active conversation's artifact list + per-artifact
  // file-state. Re-run when the conversation changes (and on demand via
  // `refreshArtifacts`). `listArtifacts` is metadata-only; file-state is fetched
  // in parallel for every artifact (inline payloads return `noFileContent`).
  const refreshArtifacts = useCallback(async (conversationId: string) => {
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
    } catch {
      setArtifacts([]);
      setFileStateMap({});
    }
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    void refreshArtifacts(activeConversationId);
  }, [activeConversationId, refreshArtifacts]);

  // Phase 5: open an artifact in the DocumentPanel — fetch the payload-bearing
  // row + its file-state, then show Preview (or File for a missing payload).
  const handleOpenArtifact = useCallback(async (artifactId: string) => {
    try {
      const got = await getArtifact(artifactId);
      if (!got) return;
      setActiveArtifact(got);
      const state = await checkArtifactFileState(artifactId);
      setFileStateMap((current) => ({ ...current, [artifactId]: state }));
      setDocTab(state === 'missing' ? 'file' : 'preview');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open artifact');
    }
  }, []);

  // M3: overwrite the artifact's single payload (no version history). The
  // DocumentPanel Source tab edits inline text; saving calls this. After the
  // write, the returned payload-bearing artifact becomes active and the
  // conversation's artifact list + file-state are refreshed so the rail, the
  // doc-tab state dot, and the preview all reflect the new payload.
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

  // M5: export the artifact's current payload to the app's exports directory,
  // optionally with a curated `.conduit.json` metadata sidecar. The destination
  // path is surfaced via the status line.
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

  // Phase 5: poll the active artifact's file-state every 5s while it is
  // File-content (on-disk blob can change outside the app). Inline payloads are
  // `noFileContent` and never change, so the poll is cheap and harmless.
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

  // M2: promote a fenced-block candidate from an assistant message into a new
  // artifact. The candidate carries its resolved kind + title + mimeType; the
  // body is written as inline text content (the renderer resolves kind via the
  // mimeType override, so json/html/markdown/code all preview correctly). The
  // new artifact is linked back to the message via `sourceMessageId` so the
  // in-chat chip can find it, then opened in the DocumentPanel.
  const handlePromoteArtifact = useCallback(
    async (messageId: string, candidate: ArtifactCandidate) => {
      if (!activeConversationId) return;
      try {
        const created = await createArtifact(
          activeConversationId,
          candidate.kind,
          candidate.title,
          messageId,
        );
        await setArtifactContent(created.id, { kind: 'text', text: candidate.body }, candidate.mimeType);
        await refreshArtifacts(activeConversationId);
        await handleOpenArtifact(created.id);
        setStatus('Promoted to artifact');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to promote artifact');
      }
    },
    [activeConversationId, refreshArtifacts, handleOpenArtifact],
  );

  // Theme: apply on mount + whenever settings.theme changes; follow the OS
  // preference while in 'system' mode.
  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => resolveTheme(settings.theme));
  useEffect(() => {
    const eff = applyTheme(settings.theme);
    setEffectiveTheme(eff);
    return watchSystemTheme(settings.theme, () => setEffectiveTheme(resolveTheme(settings.theme)));
  }, [settings.theme]);

  // Reflect the active rail tab on <html> so the v5 CSS active-bar selectors fire.
  useEffect(() => {
    document.documentElement.setAttribute('data-tab', activeTab);
  }, [activeTab]);

  const [panelTitle, panelSubtitle] = TAB_TITLES[activeTab];

  const handleToggleTheme = useCallback(() => {
    setSettings((current) => {
      const next: AppSettings = {
        ...current,
        theme: effectiveTheme === 'light' ? 'dark' : 'light',
      };
      // Persist immediately so the toggle survives reloads.
      void updateSettingsPersisted(next);
      return next;
    });
  }, [effectiveTheme]);

  // The document panel reflects the active artifact (or an empty state).
  const activeFileState = activeArtifact ? fileStateMap[activeArtifact.id] ?? 'noFileContent' : 'noFileContent';

  return (
    <div className="app" id="app">
      <Titlebar
        settings={settings}
        effectiveTheme={effectiveTheme}
        onToggleTheme={handleToggleTheme}
        workspaceLabel="Documents/Conduit/Artifacts"
      />

      <main className="body">
        <section className="left-workspace" aria-label="Assistant workspace">
          <Rail
            active={activeTab}
            onSelect={setActiveTab}
            expanded={expanded}
            onToggleExpand={toggleRail}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <div className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <b>{panelTitle}</b>
                <small>{panelSubtitle}</small>
              </div>
              <div className="actions">
                <button className="new-btn" type="button" onClick={() => void handleNewChat()}>
                  <PlusIcon />
                  New chat
                </button>
              </div>
            </div>

            <ChatView
              settings={settings}
              onStatus={setStatusMessage}
              conversationId={activeConversationId}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              onPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
            />
            <RailPanes
              active={activeTab}
              artifacts={artifacts}
              fileStateMap={fileStateMap}
              onOpenArtifact={(id) => void handleOpenArtifact(id)}
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              onNewChat={() => void handleNewChat()}
            />
          </div>
        </section>

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
          artifacts={artifacts}
          fileStateMap={fileStateMap}
          activeFileState={activeFileState}
          allowlist={settings.artifactRemoteAllowlist}
          docTab={docTab}
          onSelectTab={setDocTab}
          onOpenArtifact={(id) => void handleOpenArtifact(id)}
          onSaveContent={(artifactId, content, mimeType) => handleSaveContent(artifactId, content, mimeType)}
          onExport={(artifactId, includeMetadata) => handleExport(artifactId, includeMetadata)}
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
        paths={paths}
        onStatus={setStatusMessage}
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