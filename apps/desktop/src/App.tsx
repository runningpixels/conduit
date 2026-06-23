import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppPaths, AppSettings } from './ipc/contracts';
import {
  createConversation,
  getAppPaths,
  getSettings,
  listConversations,
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
import type { ArtifactRow, FileState } from './mock/workspace';
import { DOC_FILE_TABS } from './mock/workspace';

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
};

export default function App() {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [status, setStatus] = useState('Booting desktop shell');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactRow | null>(null);
  const [docTab, setDocTab] = useState<'preview' | 'source' | 'file'>('preview');
  const [fileState, setFileState] = useState<FileState>('modified');
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

  const handleOpenArtifact = useCallback((row: ArtifactRow) => {
    setActiveArtifact(row);
    setFileState(row.state);
    setDocTab(row.state === 'missing' ? 'file' : 'preview');
  }, []);

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

  // The document panel reflects the active artifact tab (or the default mock file).
  const docFile = useMemo(() => {
    if (activeArtifact) {
      return DOC_FILE_TABS.find((t) => t.name === activeArtifact.name) ?? DOC_FILE_TABS[0];
    }
    return DOC_FILE_TABS[0];
  }, [activeArtifact]);

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
            />
            <RailPanes
              active={activeTab}
              onOpenArtifact={handleOpenArtifact}
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
          activeName={docFile.name}
          activeState={docFile.state}
          activeSubtitle={docFile.subtitle}
          docTab={docTab}
          fileState={fileState}
          onSelectTab={setDocTab}
          onSetFileState={setFileState}
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