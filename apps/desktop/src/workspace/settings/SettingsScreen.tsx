import { useEffect, useState } from 'react';
import type { AppPaths, AppSettings } from '../../ipc/contracts';
import type { WebSearchDefaults } from '@conduit/config-schema';
import { ProviderPicker } from './ProviderPicker';
import { AppearanceSection } from './AppearanceSection';
import { PrivacyDataSection } from './PrivacyDataSection';
import { ArtifactSecuritySection } from './ArtifactSecuritySection';
import { UpdatesSection } from './UpdatesSection';
import { ConnectorsSection } from './ConnectorsSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { AboutSection } from './AboutSection';
import { WebSearchSection } from './WebSearchSection';
import { useAutoSave } from './useAutoSave';

interface SettingsScreenProps {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  paths: AppPaths | null;
  onStatus: (message: string) => void;
  /// Optional sub-tab to open when navigating from elsewhere (e.g. Connectors rail).
  initialTab?: SettingsTab;
}

export type SettingsTab =
  | 'provider'
  | 'appearance'
  | 'privacy'
  | 'artifact-security'
  | 'web-search'
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
  { id: 'updates', label: 'Updates' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
];

/** Settings screen: a first-class workspace screen with tab-based navigation and auto-save. */
export function SettingsScreen({
  settings,
  onSettingsChange,
  paths,
  onStatus,
  initialTab,
}: SettingsScreenProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'provider');
  const save = useAutoSave(onSettingsChange, onStatus);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  return (
    <section className="tab-pane settings-screen" data-pane="settings" aria-label="Settings">
      <nav className="settings-tab-sidebar" aria-label="Settings sections">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`settings-tab-btn${activeTab === tab.id ? ' active' : ''}`}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
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
          <PrivacyDataSection settings={settings} onUpdate={save} onStatus={onStatus} />
        )}
        {activeTab === 'artifact-security' && (
          <ArtifactSecuritySection settings={settings} onUpdate={save} />
        )}
        {activeTab === 'web-search' && (
          <WebSearchSection settings={settings} onUpdate={save} onStatus={onStatus} />
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
