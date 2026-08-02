import { BrandMark, FolderIcon, MoonIcon, SunIcon } from '../icons';

export type ConnectionState = 'connected' | 'no-key' | 'local-only' | 'disconnected';

interface TitlebarProps {
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  workspaceLabel?: string;
  onRevealWorkspace?: () => void;
  connectionState: ConnectionState;
  onConnectionClick: () => void;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  'no-key': 'No API key',
  'local-only': 'Local only',
  disconnected: 'Disconnected',
};

const CONNECTION_TITLE: Record<ConnectionState, string> = {
  connected:
    'Ready to call your provider with your key. Click to open Privacy & Data.',
  'no-key': 'Add a provider API key in Settings to start chatting.',
  'local-only':
    'No data leaves this device except BYOK provider calls. Click to open Privacy & Data.',
  disconnected: 'Desktop shell could not reach the local trust boundary.',
};

/** Titlebar: brand, workspace reveal, connection state, theme toggle. */
export function Titlebar({
  effectiveTheme,
  onToggleTheme,
  workspaceLabel,
  onRevealWorkspace,
  connectionState,
  onConnectionClick,
}: TitlebarProps) {
  return (
    <header className="titlebar">
      <div className="brand">
        <BrandMark className="mark" />
        <b>Conduit</b>
      </div>

      <div className="tb-spacer" />

      <div className="tb-right">
        {workspaceLabel && (
          <button
            className="workspace-chip"
            type="button"
            aria-label="Reveal artifacts folder in Explorer"
            title="Reveal artifacts folder in Explorer"
            onClick={onRevealWorkspace}
          >
            <FolderIcon />
            <span>{workspaceLabel}</span>
          </button>
        )}
        <button
          className={`connection-chip state-${connectionState}`}
          type="button"
          aria-label={CONNECTION_LABEL[connectionState]}
          title={CONNECTION_TITLE[connectionState]}
          onClick={onConnectionClick}
        >
          <span className="connection-dot" aria-hidden="true" />
          <span>{CONNECTION_LABEL[connectionState]}</span>
        </button>
        <button
          className="icon-btn"
          id="themeBtn"
          type="button"
          aria-label="Toggle light and dark mode"
          title="Toggle theme"
          onClick={onToggleTheme}
        >
          {effectiveTheme === 'light' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

/** Derive titlebar connection indicator from live app state. */
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
