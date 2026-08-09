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
 * V9 title strip (spec §2.1, §4). The V7/V8 top bar is gone: it carried a mark
 * that already lives in the sidebar head and an omnibox that was a second door
 * to the same ⌘K palette. What replaces it is 46px inside the centre column —
 * so the sidebar and the artifact panel now run the full height of the window —
 * holding the chat's name, the theme and panel toggles, and otherwise empty
 * drag region.
 *
 * Dragging is `data-tauri-drag-region`, never `-webkit-app-region`: the latter
 * is an Electron property that WebView2 ignores. The V9 proposal's CSS uses it
 * throughout and it would silently do nothing here.
 *
 * The attribute has to repeat on `.main-title`, not just the <header>. Tauri
 * hit-tests the element under the cursor and does not walk up to an ancestor
 * carrying it, so a plain child swallows the drag. The title is the widest
 * thing in the strip — a long chat name fills nearly all of it — so without
 * this the title bar is mostly dead to the pointer. Found by dragging the real
 * shell; every static gate passed while it was broken, because the attribute
 * was present on the header exactly as specified.
 *
 * Buttons are the deliberate exception: an interactive descendant takes its own
 * clicks, so the toggles need no opt-out.
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
    <header className="main-head" data-tauri-drag-region>
      <span className="main-title" title={title} data-tauri-drag-region>
        {title ?? 'New chat'}
      </span>

      {/* Tagged for the same reason as .main-title: the gaps between the
          toggles are part of the strip and should drag with it. */}
      <div className="head-actions" data-tauri-drag-region>
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
