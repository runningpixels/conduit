import { MoonIcon, PanelIcon, SunIcon } from '../icons';
import { modShortcutHint } from '../lib/shortcuts';

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
}

/**
 * Title strip (spec §2.1, §4). 46px inside the centre column — so the sidebar
 * and the artifact panel run the full height beneath the caption row — holding
 * the chat's name and the theme and panel toggles.
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
}: MainHeadProps) {
  const panelHint = modShortcutHint('J');
  const panelLabel = hiddenArtifactCount
    ? `Show context panel (${hiddenArtifactCount} artifact${hiddenArtifactCount === 1 ? '' : 's'})`
    : 'Toggle context panel';

  return (
    <header className="main-head">
      <span className="main-title" title={title}>
        {title ?? 'New chat'}
      </span>

      <div className="head-actions">
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
