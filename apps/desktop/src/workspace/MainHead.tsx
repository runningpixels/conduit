import {
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SunIcon,
} from '../icons';
import { modShortcutHint } from '../lib/shortcuts';
import { useT } from '../i18n';

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
  /** Show the sidebar: reopen the column, or on a narrow window toggle its
   *  overlay. The row is visible only when the column is not (CSS, `.head-nav`). */
  onToggleSidebar: () => void;
  /** The sidebar is showing as an overlay (narrow windows). */
  sidebarOverlayOpen?: boolean;
  onNewChat: () => void;
  /** Open the ⌘K palette, the sidebar's Search row's job. */
  onOpenPalette: () => void;
}

/**
 * Title strip (spec §2.1, §4). 46px inside the centre column — so the sidebar
 * and the artifact panel run the full height beneath the caption row — holding
 * the chat's name and the theme and panel toggles. Settings is on the
 * activity rail (UI revamp), which is always visible, so the gear and its
 * section menu that used to sit here are gone.
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
  sidebarOverlayOpen = false,
  onNewChat,
  onOpenPalette,
}: MainHeadProps) {
  const t = useT();
  const panelHint = modShortcutHint('J');
  const panelLabel = t('workspace.mainHead.panelToggleLabel', { count: hiddenArtifactCount });
  return (
    <header className="main-head">
      <div className="head-nav">
        <button
          className="iconbtn"
          type="button"
          aria-label={t('app.sidebar.openAriaLabel')}
          aria-expanded={sidebarOverlayOpen}
          aria-controls="sidebar"
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

      </div>
    </header>
  );
}
