/**
 * `[data-window-resizing]` on <html> while the window is being resized.
 *
 * Every resize event reflows the column widths (useLayout's reflowColumns), and
 * the body grid animates `grid-template-columns` for the sidebar/panel collapse.
 * Left on during a window resize, that transition restarts on every frame and
 * never catches up: the layout sits still while the edge is dragged, then snaps
 * once the drag stops. workspace.css switches transitions off under this flag.
 */
export const WINDOW_RESIZING_ATTR = 'data-window-resizing';

/** How long after the last resize event the flag stays up. */
export const WINDOW_RESIZE_SETTLE_MS = 150;

export function installWindowResizeFlag(win: Window = window): () => void {
  const root = win.document.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    root.setAttribute(WINDOW_RESIZING_ATTR, '');
    clearTimeout(timer);
    timer = setTimeout(() => root.removeAttribute(WINDOW_RESIZING_ATTR), WINDOW_RESIZE_SETTLE_MS);
  };
  win.addEventListener('resize', onResize);
  return () => {
    win.removeEventListener('resize', onResize);
    clearTimeout(timer);
    root.removeAttribute(WINDOW_RESIZING_ATTR);
  };
}
