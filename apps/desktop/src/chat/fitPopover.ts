/** Room kept between a composer popover and the edge of the area showing it. */
const EDGE_GAP = 14;
/** Shortest a popover is made before opening it the other way stops helping. */
const MIN_HEIGHT = 120;

/** The visible area an element can paint in: the viewport, cut down by every
 *  ancestor that clips its overflow (the chat pane's scroller, mainly). */
function visibleArea(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

/**
 * Callback ref for a composer popover (`.chat-settings-pop`). These open
 * upward from the composer, but in an empty chat the composer sits mid-page
 * and the pane above it is too short, so the top was cut off. When there is
 * more room below, the popover opens downward instead (`.opens-down`), and
 * either way its height is capped to the room it has. Refits on resize.
 */
export function fitPopover(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  const fit = () => {
    const anchor = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    // Nothing laid out (jsdom, a hidden pane): leave the stylesheet in charge.
    if (a.height === 0) return;
    const area = visibleArea(anchor);
    const above = a.top - area.top - EDGE_GAP;
    const below = area.bottom - a.bottom - EDGE_GAP;
    el.classList.remove('opens-down');
    el.style.maxHeight = '';
    const wanted = el.getBoundingClientRect().height;
    const down = wanted > above && below > above;
    el.classList.toggle('opens-down', down);
    // The stylesheet's own cap, min(70vh, 520px), still applies.
    const cap = Math.min(window.innerHeight * 0.7, 520);
    el.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(cap, down ? below : above))}px`;
  };
  fit();
  window.addEventListener('resize', fit);
  return () => window.removeEventListener('resize', fit);
}
