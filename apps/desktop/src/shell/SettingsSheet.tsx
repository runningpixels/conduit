/**
 * SettingsSheet — the settings surface (V9 §2.6). A summoned overlay (⌘,), not
 * a navigation destination: 186px nav + scrolling main.
 *
 * V9 dissolves Advanced. Settings-backed sections auto-save (useAutoSave);
 * renderer-only prefs (palette, provider colour, reduce motion, show reasoning,
 * send-with, export metadata, expanded status) persist to localStorage via
 * uiPrefs.
 *
 * Nav order groups by intent: configure (providers → chat → web search →
 * workspace → connectors → prompts), look (appearance → branding), trust
 * (privacy → about). Web search and workspace tools used to live under Chat
 * defaults; usage/updates/about used to live under Privacy & data.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppPaths, AppSettings, BrandConfig, ModelInfo } from '../ipc/contracts';
import { listProviderModels } from '../ipc/client';
import type { ConnectionState } from '../lib/connectionState';
import { useAutoSave } from '../workspace/settings/useAutoSave';
import { ProviderPicker } from '../workspace/settings/ProviderPicker';
import { AppearanceSection } from '../workspace/settings/AppearanceSection';
import { BrandingSection } from '../workspace/settings/BrandingSection';
import { PrivacyDataSection } from '../workspace/settings/PrivacyDataSection';
import { ArtifactSecuritySection } from '../workspace/settings/ArtifactSecuritySection';
import { UpdatesSection } from '../workspace/settings/UpdatesSection';
import { ConnectorsSection } from '../workspace/settings/ConnectorsSection';
import { DiagnosticsSection } from '../workspace/settings/DiagnosticsSection';
import { AboutSection } from '../workspace/settings/AboutSection';
import { WebSearchSection } from '../workspace/settings/WebSearchSection';
import { WorkspaceToolsSection } from '../workspace/settings/WorkspaceToolsSection';
import { AgentSection } from '../workspace/settings/AgentSection';
import { PromptsSection } from '../workspace/settings/PromptsSection';
import { UsageSection } from '../workspace/settings/UsageSection';
import {
  readProviderColour,
  writeProviderColour,
  readReduceMotion,
  writeReduceMotion,
  readShowReasoning,
  writeShowReasoning,
  readSendWith,
  writeSendWith,
  readExportMetadata,
  writeExportMetadata,
  readExpandedStatus,
  writeExpandedStatus,
} from './uiPrefs';
import { useFocusTrap } from './useFocusTrap';
import { appName } from '../brand';
import { allowUserBranding } from '../brand/buildFlags';
import { modKey } from '../lib/shortcuts';
import {
  ChatIcon,
  ConnectorsIcon,
  FolderIcon,
  InfoIcon,
  LockIcon,
  SearchIcon,
  SettingsIcon,
} from '../icons';

/**
 * Settings nav ids. `advanced` is gone (its blocks moved into Privacy & data,
 * then Usage / Updates / About split out to `about`). Branding stays gated by
 * `allowUserBranding`. Web search and workspace are first-class sections so
 * they are findable without scrolling Chat defaults.
 */
export type SettingsSection =
  | 'providers'
  | 'chat'
  | 'web-search'
  | 'workspace'
  | 'connectors'
  | 'prompts'
  | 'appearance'
  | 'branding'
  | 'privacy'
  | 'about';

interface SettingsSheetProps {
  open: boolean;
  initialSection?: SettingsSection;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  paths: AppPaths | null;
  onStatus: (message: string) => void;
  connectionState?: ConnectionState;
  boundaryOk?: boolean;
  hasCredential?: boolean;
  onInsertPrompt?: (body: string) => void;
  /** Optional coherence hook into App.tsx's own brand state: called after
   *  every successful save/import/reset/logo change so the sidebar
   *  wordmark/logo and the theme-change re-apply effect (App.tsx) update
   *  immediately instead of waiting for a reload. BrandingSection fetches
   *  and applies its own state regardless, matching AppearanceSection's
   *  self-contained idiom — this is purely additive. */
  onBrandChange?: (config: BrandConfig | null, logo: string | null) => void;
}

const NAV_ITEMS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'providers', label: 'Providers & keys', icon: <KeyNavIcon /> },
  { id: 'chat', label: 'Chat defaults', icon: <ChatIcon /> },
  { id: 'web-search', label: 'Web search', icon: <SearchIcon /> },
  { id: 'workspace', label: 'Workspace', icon: <FolderIcon /> },
  { id: 'connectors', label: 'Connectors', icon: <ConnectorsIcon /> },
  { id: 'prompts', label: 'Prompts', icon: <ListNavIcon /> },
  { id: 'appearance', label: 'Appearance', icon: <SunNavIcon /> },
  { id: 'branding', label: 'Branding', icon: <BrandingNavIcon /> },
  { id: 'privacy', label: 'Privacy & data', icon: <LockIcon /> },
  { id: 'about', label: 'About', icon: <InfoIcon /> },
];

function KeyNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9h10M7 13h6" />
    </svg>
  );
}

function SunNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4" />
    </svg>
  );
}

function ListNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

function BrandingNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 3 8.5V21h18V8.5L12 3Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function Toggle({ pressed, onChange, label }: { pressed: boolean; onChange: () => void; label: string }) {
  return (
    <button
      className="toggle"
      type="button"
      role="switch"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onChange}
    />
  );
}

export function SettingsSheet({
  open,
  initialSection,
  onClose,
  settings,
  onSettingsChange,
  paths,
  onStatus,
  connectionState,
  boundaryOk,
  hasCredential,
  onInsertPrompt,
  onBrandChange,
}: SettingsSheetProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'providers');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const save = useAutoSave(onSettingsChange, onStatus);
  const navRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const [providerColour, setProviderColour] = useState(readProviderColour);
  const [reduceMotion, setReduceMotion] = useState(readReduceMotion);
  const [showReasoning, setShowReasoning] = useState(readShowReasoning);
  const [sendWith, setSendWith] = useState(readSendWith);
  const [exportMetadata, setExportMetadata] = useState(readExportMetadata);
  const [expandedStatus, setExpandedStatus] = useState(readExpandedStatus);

  // Reset to the requested section each time the sheet opens; focus + restore.
  useEffect(() => {
    if (!open) return;
    const requested = initialSection ?? 'providers';
    // A stale deep link into 'branding' (a saved shortcut, a prior session)
    // must not land on the empty pane a disabled Mode B build renders for
    // it -- fall back the same way the retired 'advanced' id would.
    setSection(requested === 'branding' && !allowUserBranding ? 'providers' : requested);
    lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      lastFocusRef.current?.focus();
    };
  }, [open, initialSection]);

  // Load the default-model list when the chat section is visible.
  useEffect(() => {
    if (!open || section !== 'chat') return;
    let cancelled = false;
    void listProviderModels(settings.activeProvider)
      .then((listed) => {
        if (!cancelled) setModels(listed);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, section, settings.activeProvider]);

  // Escape + scrim click close the sheet (App's own escape handler also
  // closes it; the two paths are idempotent).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // V7 §9.2: Tab cannot escape the sheet while it is open.
  useFocusTrap(sheetRef, open);

  if (!open) return null;

  return (
    <div className="scrim" data-open="true" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={sheetRef} className="sheet" role="dialog" aria-label="Settings" aria-modal="true">
        <nav ref={navRef} className="sheet-nav scroll" aria-label="Settings sections">
          <div className="sheet-nav-title">Settings</div>
          {NAV_ITEMS.filter((item) => item.id !== 'branding' || allowUserBranding).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'true' : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sheet-main scroll">
          {section === 'providers' && (
            <div ref={pickerRef}>
              <h2 className="sheet-h">Providers &amp; keys</h2>
              <p className="sheet-sub">
                Keys are stored in the OS keychain and never written to disk. {appName()} talks to each provider directly.
              </p>
              <ProviderPicker settings={settings} onSettingsChange={save} onStatus={onStatus} />
              <div style={{ marginTop: 16 }}>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => {
                    pickerRef.current?.querySelector<HTMLElement>('select, input, button')?.focus();
                  }}
                >
                  Add a provider
                </button>
              </div>
            </div>
          )}

          {section === 'chat' && (
            <>
              <h2 className="sheet-h">Chat defaults</h2>
              <p className="sheet-sub">Applied to new chats. Any chat can override these from the composer.</p>
              <div className="grp">
                <div className="grp-label">Defaults</div>
                <div className="srow">
                  <span className="srow-text">
                    <b>Default model</b>
                    <small>Used when a chat starts</small>
                  </span>
                  <select
                    className="sel"
                    aria-label="Default model"
                    value={settings.activeModel}
                    onChange={(e) => save({ ...settings, activeModel: e.target.value })}
                  >
                    {models.length === 0 ? (
                      <option value={settings.activeModel}>{settings.activeModel}</option>
                    ) : (
                      models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName ?? m.id}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="srow">
                  <span className="srow-text">
                    <b>Show reasoning</b>
                    <small>Expand thinking blocks by default</small>
                  </span>
                  <Toggle
                    label="Show reasoning by default"
                    pressed={showReasoning === 'on'}
                    onChange={() => {
                      const next = showReasoning === 'on' ? 'off' : 'on';
                      setShowReasoning(next);
                      writeShowReasoning(next);
                    }}
                  />
                </div>
                <div className="srow">
                  <span className="srow-text">
                    <b>Send with</b>
                    <small>Choose how a message is sent</small>
                  </span>
                  <select
                    className="sel"
                    aria-label="Send with"
                    value={sendWith}
                    onChange={(e) => {
                      const next = e.target.value as 'enter' | 'cmd-enter';
                      setSendWith(next);
                      writeSendWith(next);
                    }}
                  >
                    <option value="enter">Enter</option>
                    <option value="cmd-enter">{modKey()} + Enter</option>
                  </select>
                </div>
              </div>
              <AgentSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'web-search' && (
            <>
              <h2 className="sheet-h">Web search</h2>
              <p className="sheet-sub">
                When enabled, the model can look things up on the internet during a conversation.
                Local-only mode under Privacy &amp; data turns this off.
              </p>
              <WebSearchSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'workspace' && (
            <>
              <h2 className="sheet-h">Workspace</h2>
              <p className="sheet-sub">
                Default folder for new chats. Bind a different folder from the chat bar for a single conversation.
              </p>
              <WorkspaceToolsSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'connectors' && (
            <>
              <h2 className="sheet-h">Connectors</h2>
              <p className="sheet-sub">Grants live with the workspace. Every run asks for consent before a connector acts.</p>
              <ConnectorsSection onStatus={onStatus} />
              <div style={{ marginTop: 16 }}>
                <button className="btn primary" type="button" onClick={() => onStatus('Connector setup opens in this section')}>
                  Connect a service
                </button>
              </div>
            </>
          )}

          {section === 'prompts' && (
            <>
              <h2 className="sheet-h">Prompts</h2>
              <p className="sheet-sub">Saved prompts you can insert into the composer.</p>
              <PromptsSection onStatus={onStatus} onInsertPrompt={onInsertPrompt ?? (() => {})} />
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2 className="sheet-h">Appearance</h2>
              <p className="sheet-sub">
                Chrome stays neutral so colour reads as information. Orange Charcoal spends
                that colour on one accent; the Terra palette spends it on provider identity.
              </p>
              <AppearanceSection settings={settings} onUpdate={save} />
              <div className="grp" style={{ marginTop: 20 }}>
                <div className="srow">
                  <span className="srow-text">
                    <b>Provider colour</b>
                    <small>Tint the app with the active provider's identity</small>
                  </span>
                  <Toggle
                    label="Provider colour"
                    pressed={providerColour === 'on'}
                    onChange={() => {
                      const next = providerColour === 'on' ? 'off' : 'on';
                      setProviderColour(next);
                      writeProviderColour(next);
                    }}
                  />
                </div>
                <div className="srow">
                  <span className="srow-text">
                    <b>Reduce motion</b>
                    <small>Drop transitions and the streaming caret</small>
                  </span>
                  <Toggle
                    label="Reduce motion"
                    pressed={reduceMotion === 'on'}
                    onChange={() => {
                      const next = reduceMotion === 'on' ? 'off' : 'on';
                      setReduceMotion(next);
                      writeReduceMotion(next);
                    }}
                  />
                </div>
                {/* V9 §10.1's own contingency for the collapse: same facts, the
                    same line re-inflated, no layout change. */}
                <div className="srow">
                  <span className="srow-text">
                    <b>Expanded status line</b>
                    <small>Show key, context and spend under the composer instead of on click</small>
                  </span>
                  <Toggle
                    label="Expanded status line"
                    pressed={expandedStatus === 'on'}
                    onChange={() => {
                      const next = expandedStatus === 'on' ? 'off' : 'on';
                      setExpandedStatus(next);
                      writeExpandedStatus(next);
                    }}
                  />
                </div>
              </div>
            </>
          )}

          {/* Phase 6 white-label (Mode B): a packaged build with brand.md's
              [runtime] allowUserBranding = false compiles `allowUserBranding`
              to `false` (src/brand/buildFlags.ts) and this body renders
              nothing, matching the nav filter above. The `section ===
              'branding'` literal stays either way -- Guard G6
              (settingsCompleteness.test.ts) asserts every SettingsSection id
              has a rendered body by grepping for exactly that text, and it
              reads source, not runtime output, so a conditional body does
              not trip it. */}
          {section === 'branding' && allowUserBranding && (
            <BrandingSection settings={settings} onUpdate={save} onStatus={onStatus} onBrandChange={onBrandChange} />
          )}

          {section === 'privacy' && (
            <>
              <h2 className="sheet-h">Privacy &amp; data</h2>
              <p className="sheet-sub">Conversations, artifacts, and the search index live on this machine only.</p>
              <PrivacyDataSection
                settings={settings}
                onUpdate={save}
                onStatus={onStatus}
                connectionState={connectionState}
                boundaryOk={boundaryOk}
                hasCredential={hasCredential}
              />
              <div style={{ marginTop: 24 }}>
                <ArtifactSecuritySection settings={settings} onUpdate={save} />
              </div>
              <div className="grp" style={{ marginTop: 24 }}>
                <div className="grp-label">Document export</div>
                <div className="srow">
                  <span className="srow-text">
                    <b>Include metadata on export</b>
                    <small>Write a metadata sidecar when saving a copy of an artifact</small>
                  </span>
                  <Toggle
                    label="Include metadata on export"
                    pressed={exportMetadata === 'on'}
                    onChange={() => {
                      const next = exportMetadata === 'on' ? 'off' : 'on';
                      setExportMetadata(next);
                      writeExportMetadata(next);
                    }}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 24, marginTop: 24 }}>
                <DiagnosticsSection settings={settings} onStatus={onStatus} />
              </div>
            </>
          )}

          {section === 'about' && (
            <>
              <h2 className="sheet-h">About</h2>
              <p className="sheet-sub">Usage, updates, and where {appName()} keeps its files on this machine.</p>
              <div style={{ marginBottom: 24 }}>
                <UsageSection />
              </div>
              <div style={{ marginBottom: 24 }}>
                <UpdatesSection settings={settings} onUpdate={save} onStatus={onStatus} />
              </div>
              <AboutSection paths={paths} />
            </>
          )}

          <div className="sheet-footnote">
            <SettingsIcon />
            Settings save automatically
          </div>
        </div>
      </div>
    </div>
  );
}
