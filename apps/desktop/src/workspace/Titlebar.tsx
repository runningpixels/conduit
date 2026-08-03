import { BrandMark, MoonIcon, SearchIcon, SunIcon } from '../icons';

export type ConnectionState = 'connected' | 'no-key' | 'local-only' | 'disconnected';

interface TitlebarProps {
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** Open the command palette — the centred command entry is its discoverability mechanism. */
  onOpenPalette: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
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
}: TitlebarProps) {
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
        <kbd>⌘K</kbd>
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
          className="iconbtn"
          type="button"
          aria-pressed={panelOpen}
          aria-label="Toggle context panel"
          title="Toggle context panel  ⌘J"
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
        </button>
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
