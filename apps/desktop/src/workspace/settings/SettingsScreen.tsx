import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppPaths, AppSettings } from '../../ipc/contracts';
import type { WebSearchDefaults } from '@conduit/config-schema';
import { SearchIcon } from '../../icons';
import { ProviderPicker } from './ProviderPicker';
import { AppearanceSection } from './AppearanceSection';
import { PrivacyDataSection } from './PrivacyDataSection';
import { ArtifactSecuritySection } from './ArtifactSecuritySection';
import { UpdatesSection } from './UpdatesSection';
import { ConnectorsSection } from './ConnectorsSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { AboutSection } from './AboutSection';
import { WebSearchSection } from './WebSearchSection';
import { AgentSection } from './AgentSection';
import { PromptsSection } from './PromptsSection';
import { UsageSection } from './UsageSection';
import { useAutoSave } from './useAutoSave';
import type { ConnectionState } from '../Titlebar';

interface SettingsScreenProps {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  paths: AppPaths | null;
  onStatus: (message: string) => void;
  /// Optional sub-tab to open when navigating from elsewhere (e.g. Connectors rail).
  initialTab?: SettingsTab;
  /// Whether this pane is the active workspace tab (`data-active` for CSS). Defaults true for tests.
  paneActive?: boolean;
  connectionState?: ConnectionState;
  boundaryOk?: boolean;
  hasCredential?: boolean;
  /// Callback to insert prompt text into the composer.
  onInsertPrompt?: (body: string) => void;
}

export type SettingsTab =
  | 'provider'
  | 'appearance'
  | 'privacy'
  | 'artifact-security'
  | 'web-search'
  | 'agent'
  | 'prompts'
  | 'usage'
  | 'updates'
  | 'connectors'
  | 'diagnostics'
  | 'about';

interface TabDef {
  id: SettingsTab;
  label: string;
}

const SETTINGS_TABS: TabDef[] = [
  { id: 'provider', label: 'Provider & Model' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'privacy', label: 'Privacy & Data' },
  { id: 'artifact-security', label: 'Artifact Security' },
  { id: 'web-search', label: 'Web Search' },
  { id: 'agent', label: 'Agent' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'usage', label: 'Usage & Cost' },
  { id: 'updates', label: 'Updates' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
];

/** Settings screen: a first-class workspace screen with tab-based navigation and auto-save.
 *  V6 P4.2: search filter over the sidebar. V6 P4.3: ArrowUp/Down/Home/End keyboard nav. */
export function SettingsScreen({
  settings,
  onSettingsChange,
  paths,
  onStatus,
  initialTab,
  paneActive = true,
  connectionState,
  boundaryOk,
  hasCredential,
  onInsertPrompt,
}: SettingsScreenProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'provider');
  const [searchQuery, setSearchQuery] = useState('');
  const [rovingIndex, setRovingIndex] = useState(-1);
  const save = useAutoSave(onSettingsChange, onStatus);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // P4.2 — filter tabs by label (and a few keyword aliases) as the user types.
  const filteredTabs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return SETTINGS_TABS;
    const alias = (t: TabDef): string => {
      const byId: Record<string, string> = {
        provider: 'provider model key byok credential api',
        appearance: 'appearance theme font density dark light',
        privacy: 'privacy data trust encryption local diagnostics',
        'artifact-security': 'artifact security remote allowlist html csp',
        'web-search': 'web search domains tokens location',
        agent: 'agent steps budget loop rounds',
        prompts: 'prompts library variables templates',
        usage: 'usage cost tokens analytics spend',
        updates: 'updates channel beta stable release',
        connectors: 'connectors mcp stdio tools runtime',
        diagnostics: 'diagnostics export disclosure support',
        about: 'about paths version app',
      };
      return `${t.label} ${byId[t.id] ?? ''}`.toLowerCase();
    };
    return SETTINGS_TABS.filter((t) => alias(t).includes(q));
  }, [searchQuery]);

  // P4.3 — roving keyboard navigation over the (filtered) sidebar.
  function handleSidebarKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const count = filteredTabs.length;
    if (count === 0) return;
    let next = -1;
    if (event.key === 'ArrowDown') next = (rovingIndex + 1) % count;
    else if (event.key === 'ArrowUp') next = (rovingIndex - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    const targetId = filteredTabs[next].id;
    setRovingIndex(next);
    setActiveTab(targetId);
    tabRefs.current[next]?.focus();
  }

  function selectTab(id: SettingsTab, index: number) {
    setActiveTab(id);
    setRovingIndex(index);
  }

  return (
    <section
      className="tab-pane settings-screen"
      data-pane="settings"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Settings"
    >
      <nav className="settings-tab-sidebar" aria-label="Settings sections" onKeyDown={handleSidebarKeyDown}>
        {/* P4.2 — settings search */}
        <div className="settings-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search settings…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setRovingIndex(-1);
            }}
            aria-label="Search settings"
          />
        </div>
        {filteredTabs.length === 0 ? (
          <div className="settings-search-empty">No settings match “{searchQuery}”.</div>
        ) : (
          filteredTabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              className={`settings-tab-btn${activeTab === tab.id ? ' active' : ''}${rovingIndex === index ? ' roving' : ''}`}
              type="button"
              onClick={() => selectTab(tab.id, index)}
            >
              {tab.label}
            </button>
          ))
        )}
      </nav>
      <div className="settings-tab-content">
        {activeTab === 'provider' && (
          <div className="settings-section">
            <div className="settings-section-header">
              <span>Provider & Model</span>
            </div>
            <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--text-2)' }}>
              Provider selection and BYOK entry stay inside Rust and the OS keychain.
            </p>
            <ProviderPicker settings={settings} onSettingsChange={save} onStatus={onStatus} />
          </div>
        )}
        {activeTab === 'appearance' && (
          <AppearanceSection settings={settings} onUpdate={save} />
        )}
        {activeTab === 'privacy' && (
          <PrivacyDataSection
            settings={settings}
            onUpdate={save}
            onStatus={onStatus}
            connectionState={connectionState}
            boundaryOk={boundaryOk}
            hasCredential={hasCredential}
          />
        )}
        {activeTab === 'artifact-security' && (
          <ArtifactSecuritySection settings={settings} onUpdate={save} />
        )}
        {activeTab === 'web-search' && (
          <WebSearchSection settings={settings} onUpdate={save} onStatus={onStatus} />
        )}
        {activeTab === 'agent' && (
          <AgentSection settings={settings} onUpdate={save} onStatus={onStatus} />
        )}
        {activeTab === 'prompts' && (
          <PromptsSection onStatus={onStatus} onInsertPrompt={onInsertPrompt ?? (() => {})} />
        )}
        {activeTab === 'usage' && (
          <UsageSection />
        )}
        {activeTab === 'updates' && (
          <UpdatesSection settings={settings} onUpdate={save} onStatus={onStatus} />
        )}
        {activeTab === 'connectors' && (
          <ConnectorsSection onStatus={onStatus} />
        )}
        {activeTab === 'diagnostics' && (
          <DiagnosticsSection settings={settings} onStatus={onStatus} />
        )}
        {activeTab === 'about' && (
          <AboutSection paths={paths} />
        )}
      </div>
    </section>
  );
}
