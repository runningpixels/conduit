import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChatIcon,
  ChevronDown,
  ConnectorsIcon,
  DownloadIcon,
  InfoIcon,
  LockIcon,
  ModelIcon,
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  SunIcon,
} from '../icons';
import { modShortcutHint } from '../lib/shortcuts';
import { useT } from '../i18n';
import type { SettingsSection } from '../shell/SettingsSheet';
import { Menu } from './Menu';

interface MainHeadProps {
  /** Current chat's name. Undefined before a conversation is selected. */
  title?: string;
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * Artifacts sitting in the hidden panel. Badged onto the toggle so the panel
   * stays discoverable now that the full-height edge rail is gone; pass 0 (or
   * omit) whenever the panel is open, since the count is visible in it.
   */
  hiddenArtifactCount?: number;
  /** Reopen the sidebar. Shown only while it is collapsed (CSS, `.head-nav`). */
  onToggleSidebar: () => void;
  onNewChat: () => void;
  /** Open the ⌘K palette, the sidebar's Search row's job. */
  onOpenPalette: () => void;
  /** Open the settings sheet; no section means "where the user last was". */
  onOpenSettings: (section?: SettingsSection) => void;
  onExportDiagnostics: () => void;
  providerCount?: number;
  connectorCount?: number;
}

/**
 * Title strip (spec §2.1, §4). 46px inside the centre column — so the sidebar
 * and the artifact panel run the full height beneath the caption row — holding
 * the chat's name, the theme and panel toggles, and the settings entry point.
 *
 * Settings used to be reachable by pointer only through the sidebar footer's
 * workspace chip, two clicks deep under a label naming the *workspace*, and not
 * at all once the sidebar was collapsed. The gear here opens the sheet in one
 * click on the section last visited; its chevron (or a right-click on the gear)
 * lists the sections worth jumping to directly.
 *
 * With the sidebar collapsed, `.head-nav` takes over the sidebar's own row of
 * actions — reopen, New chat, Search — so collapsing it no longer strands
 * them behind hotkeys. That replaced a `position: fixed` reveal button that
 * floated over this strip and made the title step aside for it.
 *
 * It is deliberately *not* a drag region. It was one while the app had no
 * caption row, and that arrangement was fragile: Tauri hit-tests the element
 * directly under the cursor and does not walk up to an ancestor carrying
 * `data-tauri-drag-region`, so every non-interactive child needed the attribute
 * too. `.main-title` did not have it, and since a long chat name stretches the
 * span across nearly the whole strip, most of the title bar was dead to the
 * pointer — while every static gate passed, because the header itself was
 * tagged exactly as specified. `TitleBar` owns dragging outright now.
 */
export function MainHead({
  title,
  effectiveTheme,
  onToggleTheme,
  panelOpen,
  onTogglePanel,
  hiddenArtifactCount = 0,
  onToggleSidebar,
  onNewChat,
  onOpenPalette,
  onOpenSettings,
  onExportDiagnostics,
  providerCount,
  connectorCount,
}: MainHeadProps) {
  const t = useT();
  const panelHint = modShortcutHint('J');
  const panelLabel = t('workspace.mainHead.panelToggleLabel', { count: hiddenArtifactCount });
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // Menu owns Escape and arrow keys; an outside press is the caller's to close.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (settingsRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  function MenuItem({
    icon,
    label,
    kbd,
    tail,
    onSelect,
  }: {
    icon: ReactNode;
    label: string;
    kbd?: string;
    tail?: number;
    onSelect: () => void;
  }) {
    return (
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          setMenuOpen(false);
          onSelect();
        }}
      >
        {icon}
        {label}
        {kbd ? <kbd>{kbd}</kbd> : null}
        {tail != null ? <span className="tail">{tail}</span> : null}
      </button>
    );
  }

  return (
    <header className="main-head">
      <div className="head-nav">
        <button
          className="iconbtn"
          type="button"
          aria-label={t('app.sidebar.openAriaLabel')}
          title={t('app.sidebar.openTitle', { shortcut: modShortcutHint('\\') })}
          onClick={onToggleSidebar}
        >
          <SidebarIcon />
        </button>
        <button
          className="iconbtn"
          type="button"
          aria-label={t('workspace.mainHead.newChat.ariaLabel')}
          title={t('workspace.mainHead.newChat.title', { shortcut: modShortcutHint('N') })}
          onClick={onNewChat}
        >
          <PlusIcon />
        </button>
        <button
          className="iconbtn"
          type="button"
          aria-label={t('workspace.mainHead.search.ariaLabel')}
          title={t('workspace.mainHead.search.title', { shortcut: modShortcutHint('K') })}
          onClick={onOpenPalette}
        >
          <SearchIcon />
        </button>
      </div>

      <span className="main-title" title={title}>
        {title ?? t('workspace.mainHead.newChatTitle')}
      </span>

      <div className="head-actions">
        <button
          className="iconbtn"
          type="button"
          aria-label={t('workspace.mainHead.themeToggleAriaLabel')}
          title={t('workspace.mainHead.themeToggleTitle')}
          onClick={onToggleTheme}
        >
          {effectiveTheme === 'light' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          className="iconbtn panel-toggle"
          type="button"
          aria-pressed={panelOpen}
          aria-label={panelLabel}
          title={t('workspace.mainHead.panelToggleTitle', { count: hiddenArtifactCount, shortcut: panelHint })}
          onClick={onTogglePanel}
        >
          <PanelIcon />
          {hiddenArtifactCount > 0 && (
            <span className="panel-toggle-badge" aria-hidden="true">
              {hiddenArtifactCount > 9 ? '9+' : hiddenArtifactCount}
            </span>
          )}
        </button>

        <div className="head-settings" ref={settingsRef}>
          <button
            className="iconbtn head-settings-open"
            type="button"
            aria-label={t('workspace.mainHead.settingsButton.ariaLabel')}
            title={t('workspace.mainHead.settingsButton.title', { shortcut: modShortcutHint(',') })}
            onClick={() => onOpenSettings()}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
          >
            <SettingsIcon />
          </button>
          <button
            ref={menuTriggerRef}
            className="iconbtn head-settings-menu"
            type="button"
            aria-label={t('workspace.mainHead.settingsMenu.ariaLabel')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <ChevronDown />
          </button>
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            triggerRef={menuTriggerRef}
            className="menu head-settings-list"
            label={t('workspace.mainHead.settingsMenu.ariaLabel')}
          >
            <MenuItem
              icon={<SettingsIcon />}
              label={t('workspace.mainHead.settingsMenu.openSettings')}
              kbd={modShortcutHint(',')}
              onSelect={() => onOpenSettings()}
            />
            <div className="menu-sep" role="separator" />
            <MenuItem
              icon={<ModelIcon />}
              label={t('workspace.mainHead.settingsMenu.providers')}
              tail={providerCount}
              onSelect={() => onOpenSettings('providers')}
            />
            <MenuItem
              icon={<ChatIcon />}
              label={t('workspace.mainHead.settingsMenu.chat')}
              onSelect={() => onOpenSettings('chat')}
            />
            <MenuItem
              icon={<ConnectorsIcon />}
              label={t('workspace.mainHead.settingsMenu.connectors')}
              tail={connectorCount}
              onSelect={() => onOpenSettings('connectors')}
            />
            <MenuItem
              icon={<SunIcon />}
              label={t('workspace.mainHead.settingsMenu.appearance')}
              onSelect={() => onOpenSettings('appearance')}
            />
            <MenuItem
              icon={<LockIcon />}
              label={t('workspace.mainHead.settingsMenu.privacy')}
              onSelect={() => onOpenSettings('privacy')}
            />
            <div className="menu-sep" role="separator" />
            <MenuItem
              icon={<DownloadIcon />}
              label={t('workspace.mainHead.settingsMenu.exportDiagnostics')}
              onSelect={onExportDiagnostics}
            />
            <MenuItem
              icon={<InfoIcon />}
              label={t('workspace.mainHead.settingsMenu.about')}
              onSelect={() => onOpenSettings('about')}
            />
          </Menu>
        </div>
      </div>
    </header>
  );
}
