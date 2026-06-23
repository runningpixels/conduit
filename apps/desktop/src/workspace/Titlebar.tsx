import type { AppSettings } from '@conduit/config-schema';
import { BrandMark, FolderIcon, ModelIcon, MoonIcon, SunIcon } from '../icons';

interface TitlebarProps {
  settings: AppSettings;
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  workspaceLabel?: string;
}

/** v5 titlebar: brand mark + edition chip, workspace/model/local chips with the
 *  animated local-first ping, and the theme toggle. */
export function Titlebar({ settings, effectiveTheme, onToggleTheme, workspaceLabel }: TitlebarProps) {
  return (
    <header className="titlebar">
      <div className="windots" aria-hidden="true">
        <i /><i /><i />
      </div>
      <div className="brand">
        <BrandMark className="mark" />
        <b>Conduit</b>
        <span className="edition">V5 - local</span>
      </div>

      <div className="tb-spacer" />

      <div className="tb-right">
        {workspaceLabel && (
          <span className="workspace-chip" title="Artifact workspace location">
            <FolderIcon />
            <span>{workspaceLabel}</span>
          </span>
        )}
        <span className="model-chip" title="Current provider and model">
          <ModelIcon />
          <b>{settings.activeModel}</b>
        </span>
        <span className="local-chip" title="No data leaves this device. Calls go straight to your provider with your key.">
          <span className="ping" aria-hidden="true" />
          <span>Fully local - BYOK</span>
        </span>
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