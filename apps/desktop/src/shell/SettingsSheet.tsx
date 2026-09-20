/**
 * SettingsSheet — the settings surface (V9 §2.6). A summoned overlay (⌘,), not
 * a navigation destination: 200px nav + scrolling main.
 *
 * V9 dissolves Advanced. Settings-backed sections auto-save (useAutoSave);
 * renderer-only prefs (palette, provider colour, reduce motion, show reasoning,
 * send-with, export metadata, expanded status) persist to localStorage via
 * uiPrefs.
 *
 * Nav order groups by intent: configure (providers → chat → web search →
 * workspace → connectors → prompts → skills → memory), look (appearance → branding), trust
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
import { GenerationControlsSection } from '../workspace/settings/GenerationControlsSection';
import { PromptsSection } from '../workspace/settings/PromptsSection';
import { SkillsSection } from '../workspace/settings/SkillsSection';
import { MemorySection } from '../workspace/settings/MemorySection';
import { KnowledgeSection } from '../workspace/settings/KnowledgeSection';
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
import { allowUserBranding } from '../brand/buildFlags';
import { foldForSearch, searchSettings } from './settingsSearch';
import { modKey } from '../lib/shortcuts';
import { useRichT, useT } from '../i18n';
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
  | 'skills'
  | 'memory'
  | 'knowledge'
  | 'appearance'
  | 'branding'
  | 'privacy'
  | 'about';

interface SettingsSheetProps {
  open: boolean;
  initialSection?: SettingsSection;
  /** Reports the section on screen, so the app can reopen the sheet there. */
  onSectionChange?: (section: SettingsSection) => void;
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

type NavGroup = 'models' | 'assistant' | 'app';

/** Nav headings, in order. Each item below names the group it sits under. */
const NAV_GROUPS: { id: NavGroup; labelId: string }[] = [
  { id: 'models', labelId: 'shell.settingsSheet.nav.group.models' },
  { id: 'assistant', labelId: 'shell.settingsSheet.nav.group.assistant' },
  { id: 'app', labelId: 'shell.settingsSheet.nav.group.app' },
];

const NAV_ITEMS: { id: SettingsSection; labelId: string; icon: ReactNode; group: NavGroup }[] = [
  { id: 'providers', labelId: 'shell.settingsSheet.nav.providers', icon: <KeyNavIcon />, group: 'models' },
  { id: 'chat', labelId: 'shell.settingsSheet.nav.chat', icon: <ChatIcon />, group: 'models' },
  { id: 'web-search', labelId: 'shell.settingsSheet.nav.web-search', icon: <SearchIcon />, group: 'models' },
  { id: 'workspace', labelId: 'shell.settingsSheet.nav.workspace', icon: <FolderIcon />, group: 'assistant' },
  { id: 'connectors', labelId: 'shell.settingsSheet.nav.connectors', icon: <ConnectorsIcon />, group: 'assistant' },
  { id: 'prompts', labelId: 'shell.settingsSheet.nav.prompts', icon: <ListNavIcon />, group: 'assistant' },
  { id: 'skills', labelId: 'shell.settingsSheet.nav.skills', icon: <SkillNavIcon />, group: 'assistant' },
  { id: 'memory', labelId: 'shell.settingsSheet.nav.memory', icon: <MemoryNavIcon />, group: 'assistant' },
  { id: 'knowledge', labelId: 'shell.settingsSheet.nav.knowledge', icon: <KnowledgeNavIcon />, group: 'assistant' },
  { id: 'appearance', labelId: 'shell.settingsSheet.nav.appearance', icon: <SunNavIcon />, group: 'app' },
  { id: 'branding', labelId: 'shell.settingsSheet.nav.branding', icon: <BrandingNavIcon />, group: 'app' },
  { id: 'privacy', labelId: 'shell.settingsSheet.nav.privacy', icon: <LockIcon />, group: 'app' },
  { id: 'about', labelId: 'shell.settingsSheet.nav.about', icon: <InfoIcon />, group: 'app' },
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

function SkillNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      <path d="M8 7h8M8 11h5" />
    </svg>
  );
}

function MemoryNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  );
}

function KnowledgeNavIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 16.5 12 21l9-4.5" />
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
  onSectionChange,
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
  const t = useT();
  const tr = useRichT();
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

  // Settings search. `query` filters the nav; picking a result remembers what
  // was searched so the section can bring the matching row into view.
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const visibleNav = NAV_ITEMS.filter((item) => item.id !== 'branding' || allowUserBranding);
  const matches = query.trim() ? searchSettings(query, t, visibleNav) : null;
  const shownNav = matches ? visibleNav.filter((item) => matches.has(item.id)) : visibleNav;

  function openSection(id: SettingsSection) {
    setSection(id);
    if (matches) setHighlight(query);
  }

  // Bring the first row naming the query into view and mark it briefly. Looked
  // up in the rendered section by text, so it finds the row however the
  // section builds it, and in whatever language it is rendered.
  useEffect(() => {
    if (!highlight) return;
    const needle = foldForSearch(highlight);
    const candidates = mainRef.current?.querySelectorAll<HTMLElement>(
      'h2, h3, b, label, .grp-label, .field-label, .srow-text > b, legend',
    );
    const hit = Array.from(candidates ?? []).find((el) => foldForSearch(el.textContent ?? '').includes(needle));
    setHighlight(null);
    if (!hit) return;
    hit.scrollIntoView?.({ block: 'center' });
    hit.classList.add('settings-search-hit');
    const timer = window.setTimeout(() => hit.classList.remove('settings-search-hit'), 1600);
    return () => window.clearTimeout(timer);
  }, [highlight, section]);

  // Reset to the requested section each time the sheet opens; focus + restore.
  useEffect(() => {
    if (!open) return;
    setQuery('');
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

  useEffect(() => {
    if (open) onSectionChange?.(section);
  }, [open, section, onSectionChange]);

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
      <div ref={sheetRef} className="sheet" role="dialog" aria-label={t('shell.settingsSheet.ariaLabel')} aria-modal="true">
        <nav ref={navRef} className="sheet-nav scroll" aria-label={t('shell.settingsSheet.nav.ariaLabel')}>
          <div className="sheet-nav-title">{t('shell.settingsSheet.nav.title')}</div>
          <input
            className="sheet-search"
            type="search"
            value={query}
            placeholder={t('shell.settingsSheet.search.placeholder')}
            aria-label={t('shell.settingsSheet.search.ariaLabel')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && shownNav[0]) {
                event.preventDefault();
                openSection(shownNav[0].id);
              } else if (event.key === 'Escape' && query) {
                // Clear the search, and stop there: the sheet's own Escape (and
                // the app's) would otherwise close it along with the query.
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                setQuery('');
              }
            }}
          />
          {NAV_GROUPS.map((group) => {
            const items = shownNav.filter((item) => item.group === group.id);
            if (items.length === 0) return null;
            return (
              <div key={group.id} role="group" aria-label={t(group.labelId)}>
                <div className="sheet-nav-group" aria-hidden="true">{t(group.labelId)}</div>
                {items.map((item) => {
                  const found = matches?.get(item.id) ?? [];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={section === item.id ? 'true' : undefined}
                      onClick={() => openSection(item.id)}
                    >
                      {item.icon}
                      <span className="sheet-nav-label">
                        {t(item.labelId)}
                        {found.length > 0 && (
                          <small className="sheet-nav-match" title={found.join(' · ')}>
                            {found.join(' · ')}
                          </small>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {matches && shownNav.length === 0 && (
            <p className="sheet-search-empty" role="status">
              {t('shell.settingsSheet.search.noResults', { query: query.trim() })}
            </p>
          )}
        </nav>

        <div ref={mainRef} className="sheet-main scroll">
          {section === 'providers' && (
            <div ref={pickerRef}>
              <h2 className="sheet-h">{t('shell.settingsSheet.providers.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.providers.intro')}
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
                  {t('shell.settingsSheet.providers.addButton')}
                </button>
              </div>
            </div>
          )}

          {section === 'chat' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.chat.heading')}</h2>
              <p className="sheet-sub">{t('shell.settingsSheet.chat.intro')}</p>
              <div className="grp">
                <div className="grp-label">{t('shell.settingsSheet.chat.defaultsGroupLabel')}</div>
                <div className="srow">
                  <span className="srow-text">
                    <b>{t('shell.settingsSheet.chat.defaultModel.label')}</b>
                    <small>{t('shell.settingsSheet.chat.defaultModel.help')}</small>
                  </span>
                  <select
                    className="sel"
                    aria-label={t('shell.settingsSheet.chat.defaultModel.label')}
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
                    <b>{t('shell.settingsSheet.chat.alwaysShowReasoning.label')}</b>
                    <small>{t('shell.settingsSheet.chat.alwaysShowReasoning.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.chat.alwaysShowReasoning.label')}
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
                    <b>{t('shell.settingsSheet.chat.sendWith.label')}</b>
                    <small>{t('shell.settingsSheet.chat.sendWith.help')}</small>
                  </span>
                  <select
                    className="sel"
                    aria-label={t('shell.settingsSheet.chat.sendWith.label')}
                    value={sendWith}
                    onChange={(e) => {
                      const next = e.target.value as 'enter' | 'cmd-enter';
                      setSendWith(next);
                      writeSendWith(next);
                    }}
                  >
                    <option value="enter">{t('shell.settingsSheet.chat.sendWith.enterOption')}</option>
                    <option value="cmd-enter">
                      {t('shell.settingsSheet.chat.sendWith.cmdEnterOption', { modKey: modKey() })}
                    </option>
                  </select>
                </div>
                <div className="srow">
                  <span className="srow-text">
                    <b>{t('shell.settingsSheet.chat.autoCompact.label')}</b>
                    <small>{t('shell.settingsSheet.chat.autoCompact.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.chat.autoCompact.label')}
                    pressed={settings.contextCompactEnabled}
                    onChange={() =>
                      save({
                        ...settings,
                        contextCompactEnabled: !settings.contextCompactEnabled,
                      })
                    }
                  />
                </div>
                {settings.contextCompactEnabled && (
                  <div className="srow">
                    <span className="srow-text">
                      <b>{t('shell.settingsSheet.chat.compactThreshold.label')}</b>
                      <small>
                        {t('shell.settingsSheet.chat.compactThreshold.value', {
                          percent: settings.contextCompactThresholdPercent,
                        })}
                      </small>
                    </span>
                    <select
                      className="sel"
                      aria-label={t('shell.settingsSheet.chat.compactThreshold.label')}
                      value={settings.contextCompactThresholdPercent}
                      onChange={(e) =>
                        save({
                          ...settings,
                          contextCompactThresholdPercent: Number(e.target.value),
                        })
                      }
                    >
                      {[85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95].map((n) => (
                        <option key={n} value={n}>
                          {t('shell.settingsSheet.chat.compactThreshold.optionPercent', { percent: n })}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <GenerationControlsSection settings={settings} onUpdate={save} onStatus={onStatus} />
              <AgentSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'web-search' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.webSearch.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.webSearch.intro')}
              </p>
              <WebSearchSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'workspace' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.workspace.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.workspace.intro')}
              </p>
              <WorkspaceToolsSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'connectors' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.connectors.heading')}</h2>
              <p className="sheet-sub">{t('shell.settingsSheet.connectors.intro')}</p>
              <ConnectorsSection onStatus={onStatus} showHeader={false} />
              <div style={{ marginTop: 16 }}>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => onStatus(t('shell.settingsSheet.connectors.setupToast'))}
                >
                  {t('shell.settingsSheet.connectors.connectButton')}
                </button>
              </div>
            </>
          )}

          {section === 'prompts' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.prompts.heading')}</h2>
              <p className="sheet-sub">{t('shell.settingsSheet.prompts.intro')}</p>
              <PromptsSection onStatus={onStatus} onInsertPrompt={onInsertPrompt ?? (() => {})} />
            </>
          )}

          {section === 'skills' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.skills.heading')}</h2>
              <p className="sheet-sub">
                {tr('shell.settingsSheet.skills.intro')}
              </p>
              <SkillsSection onStatus={onStatus} workspaceRoot={settings.workspaceRoot} />
            </>
          )}

          {section === 'memory' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.memory.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.memory.intro')}
              </p>
              <MemorySection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'knowledge' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.knowledge.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.knowledge.intro')}
              </p>
              <KnowledgeSection settings={settings} onUpdate={save} onStatus={onStatus} />
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2 className="sheet-h">{t('shell.settingsSheet.appearance.heading')}</h2>
              <p className="sheet-sub">
                {t('shell.settingsSheet.appearance.intro')}
              </p>
              <AppearanceSection settings={settings} onUpdate={save} />
              <div className="grp" style={{ marginTop: 20 }}>
                <div className="srow">
                  <span className="srow-text">
                    <b>{t('shell.settingsSheet.appearance.providerColour.label')}</b>
                    <small>{t('shell.settingsSheet.appearance.providerColour.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.appearance.providerColour.label')}
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
                    <b>{t('shell.settingsSheet.appearance.reduceMotion.label')}</b>
                    <small>{t('shell.settingsSheet.appearance.reduceMotion.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.appearance.reduceMotion.label')}
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
                    <b>{t('shell.settingsSheet.appearance.expandedStatus.label')}</b>
                    <small>{t('shell.settingsSheet.appearance.expandedStatus.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.appearance.expandedStatus.label')}
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
              <h2 className="sheet-h">{t('shell.settingsSheet.privacy.heading')}</h2>
              <p className="sheet-sub">{t('shell.settingsSheet.privacy.intro')}</p>
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
                <div className="grp-label">{t('shell.settingsSheet.privacy.documentExportGroupLabel')}</div>
                <div className="srow">
                  <span className="srow-text">
                    <b>{t('shell.settingsSheet.privacy.includeMetadata.label')}</b>
                    <small>{t('shell.settingsSheet.privacy.includeMetadata.help')}</small>
                  </span>
                  <Toggle
                    label={t('shell.settingsSheet.privacy.includeMetadata.label')}
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
              <h2 className="sheet-h">{t('shell.settingsSheet.about.heading')}</h2>
              <p className="sheet-sub">{t('shell.settingsSheet.about.intro')}</p>
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
            {t('shell.settingsSheet.footnote')}
          </div>
        </div>
      </div>
    </div>
  );
}
