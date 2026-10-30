import { afterEach, describe, expect, it } from 'vitest';
import { fitPopover } from './fitPopover';

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
}

/** A scrolling pane holding a composer (the anchor) and its popover. */
function layout(pane: [number, number], composer: [number, number], popoverHeight: number) {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const anchor = document.createElement('div');
  const pop = document.createElement('div');
  scroller.appendChild(anchor);
  anchor.appendChild(pop);
  document.body.appendChild(scroller);
  scroller.getBoundingClientRect = () => rect(...pane);
  anchor.getBoundingClientRect = () => rect(...composer);
  pop.getBoundingClientRect = () => rect(0, popoverHeight);
  // jsdom has no layout, so offsetParent is null; the parent is the anchor.
  return pop;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('fitPopover', () => {
  it('opens downward when the pane above the composer is too short', () => {
    // An empty chat: the composer sits high in the pane with room below.
    const pop = layout([100, 700], [200, 300], 400);
    const cleanup = fitPopover(pop);
    expect(pop.classList.contains('opens-down')).toBe(true);
    expect(pop.style.maxHeight).toBe('386px');
    cleanup?.();
  });

  it('stays upward when it fits above, capped to the room there', () => {
    const pop = layout([100, 700], [600, 690], 400);
    fitPopover(pop)?.();
    expect(pop.classList.contains('opens-down')).toBe(false);
    expect(pop.style.maxHeight).toBe('486px');
  });

  it('stays upward and scrolls when neither side has the room, but above has more', () => {
    const pop = layout([100, 700], [450, 600], 520);
    fitPopover(pop)?.();
    expect(pop.classList.contains('opens-down')).toBe(false);
    expect(pop.style.maxHeight).toBe('336px');
  });

  it('leaves the stylesheet in charge when nothing is laid out', () => {
    const pop = document.createElement('div');
    document.body.appendChild(document.createElement('div')).appendChild(pop);
    fitPopover(pop)?.();
    expect(pop.classList.contains('opens-down')).toBe(false);
    expect(pop.style.maxHeight).toBe('');
  });
});
