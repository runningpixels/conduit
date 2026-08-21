/**
 * TitleBar — the window's caption row, and nothing else.
 *
 * V7 had a top bar carrying app content (a brand mark, an omnibox) alongside
 * the window buttons; V9 deleted it and floated the buttons in the corner as
 * `position: fixed`, which made every surface underneath dodge them. This is
 * neither: a 32px strip whose only job is window chrome — the drag region and
 * the minimise/maximise/close cluster — with the sidebar, thread and artifact
 * panel all starting beneath it.
 *
 * It renders on every platform, always:
 *   - Windows/Linux (`decorations: false`) — holds `WindowControls`.
 *   - macOS — `WindowControls` renders null, and tauri.macos.conf.json keeps
 *     `decorations` with titleBarStyle Overlay, which draws the native traffic
 *     lights over the webview's top-left. This bar *is* the strip they need,
 *     which is why `.sb-head` no longer reserves height for them.
 *   - dev:web / vitest — an empty strip. Deliberate: dev:web is a preview of
 *     the packaged shell, so keeping the row makes its layout faithful.
 *
 * Dragging is `data-tauri-drag-region`, never `-webkit-app-region` — the latter
 * is an Electron property that WebView2 ignores silently. Tauri hit-tests the
 * element directly under the cursor and does not walk up to an ancestor, so any
 * non-interactive element added inside this bar needs the attribute too;
 * `<WindowControls />` is exempt because its children are buttons, which are
 * supposed to take their own clicks. shellContract.test.ts pins both rules.
 */

import { WindowControls } from './WindowControls';

export function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <WindowControls />
    </div>
  );
}
