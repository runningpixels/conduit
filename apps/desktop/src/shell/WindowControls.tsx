/**
 * WindowControls — minimise / maximise / close for the frameless shell.
 *
 * The window runs with `decorations: false`, so the app owns its controls. V7
 * parked them at the right end of the top bar; V9 deletes that bar, so they
 * become a fixed cluster pinned to the window's top-right corner instead. That
 * is the only placement correct in both panel states: with the artifact panel
 * open the corner belongs to the panel, with it closed to the title strip, and
 * `.wincontrols` sits above whichever is there while `.main-head` /
 * `.doc-toolbar` reserve the width beneath it (workspace.css).
 *
 * Dragging and double-click-to-maximise come from `data-tauri-drag-region` on
 * `.main-head` and `.sb-head` — never `-webkit-app-region`, which is an
 * Electron property WebView2 ignores.
 *
 * Two environments render nothing here:
 *   - `dev:web` / vitest, where there is no Tauri bridge to call.
 *   - macOS, which keeps its native traffic lights (see tauri.macos.conf.json,
 *     which restores `decorations` and uses the Overlay title bar style).
 */

import { useEffect, useState } from 'react';
import { isMacPlatform } from '../lib/shortcuts';

/** Tauri v2 injects this before any app code runs. */
function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Loaded lazily so the web build never pulls the window API into the bundle. */
async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export function WindowControls() {
  const enabled = hasTauriBridge() && !isMacPlatform();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const win = await currentWindow();
      const sync = async () => {
        const next = await win.isMaximized();
        if (!disposed) setMaximized(next);
      };
      await sync();
      // Keeps the glyph honest when the window is snapped or restored by the
      // OS rather than by our own buttons.
      unlisten = await win.onResized(() => void sync());
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="wincontrols">
      <button
        type="button"
        className="wincontrol"
        aria-label="Minimise"
        title="Minimise"
        onClick={() => void currentWindow().then((w) => w.minimize())}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button
        type="button"
        className="wincontrol"
        aria-label={maximized ? 'Restore' : 'Maximise'}
        title={maximized ? 'Restore' : 'Maximise'}
        onClick={() => void currentWindow().then((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V0.5h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="wincontrol close"
        aria-label="Close"
        title="Close"
        onClick={() => void currentWindow().then((w) => w.close())}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
