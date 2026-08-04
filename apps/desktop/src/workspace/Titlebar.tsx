import { BrandMark, MoonIcon, SearchIcon, SunIcon } from '../icons';
import { WindowControls } from '../shell/WindowControls';
import { modShortcutHint } from '../lib/shortcuts';

export type ConnectionState = 'connected' | 'no-key' | 'local-only' | 'disconnected';

interface TitlebarProps {
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** Open the command palette — the centred command entry is its discoverability mechanism. */
  onOpenPalette: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * Artifacts sitting in the hidden panel. Badged onto the toggle so the panel
   * stays discoverable now that the full-height edge rail is gone; pass 0 (or
   * omit) whenever the panel is open, since the count is visible in it.
   */
  hiddenArtifactCount?: number;
}

/**
 * V7 single top bar (spec §8.1). One 44px bar, no chips: brand mark in the
 * provider hue, the command entry at the visual centre (a button that opens
 * ⌘K, not a search input), and the theme + context-panel toggles on the right.
 * The workspace/connection chips moved into the sidebar footer + provenance
 * strip in Phases B/C.
 */
export function Titlebar({
  effectiveTheme,
  onToggleTheme,
  onOpenPalette,
  panelOpen,
  onTogglePanel,
  hiddenArtifactCount = 0,
}: TitlebarProps) {
  const panelHint = modShortcutHint('J');
  const panelLabel = hiddenArtifactCount
    ? `Show context panel (${hiddenArtifactCount} artifact${hiddenArtifactCount === 1 ? '' : 's'})`
    : 'Toggle context panel';

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="mark">
        <BrandMark className="mark-glyph" />
        <b>Conduit</b>
      </div>

      <button
        className="omni"
        type="button"
        aria-label="Search chats, run a command, switch model"
        onClick={onOpenPalette}
      >
        <SearchIcon />
        <span>Search chats, run a command, switch model…</span>
        <kbd>{modShortcutHint('K')}</kbd>
      </button>

      <div className="topbar-right">
        <button
          className="iconbtn"
          type="button"
          aria-label="Toggle light and dark mode"
          title="Toggle theme"
          onClick={onToggleTheme}
        >
          {effectiveTheme === 'light' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          className="iconbtn panel-toggle"
          type="button"
          aria-pressed={panelOpen}
          aria-label={panelLabel}
          title={`${panelLabel}  ${panelHint}`}
          onClick={onTogglePanel}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M15 4v16" />
          </svg>
          {hiddenArtifactCount > 0 && (
            <span className="panel-toggle-badge" aria-hidden="true">
              {hiddenArtifactCount > 9 ? '9+' : hiddenArtifactCount}
            </span>
          )}
        </button>
        <WindowControls />
      </div>
    </header>
  );
}

/** Derive the connection posture from live app state (V6 signature retained
 *  for PrivacyDataSection; the titlebar itself no longer renders chips). */
export function deriveConnectionState(opts: {
  boundaryOk: boolean;
  hasCredential: boolean;
  localOnly: boolean;
}): ConnectionState {
  if (!opts.boundaryOk) return 'disconnected';
  if (!opts.hasCredential) return 'no-key';
  if (opts.localOnly) return 'local-only';
  return 'connected';
}
