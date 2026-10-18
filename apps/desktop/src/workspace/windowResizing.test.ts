import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_RESIZE_SETTLE_MS, WINDOW_RESIZING_ATTR, installWindowResizeFlag } from './windowResizing';

describe('installWindowResizeFlag', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags <html> during a resize and clears it once resizing settles', () => {
    vi.useFakeTimers();
    const uninstall = installWindowResizeFlag();
    const root = document.documentElement;
    expect(root.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(false);

    window.dispatchEvent(new Event('resize'));
    expect(root.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(true);

    // A resize mid-way keeps it up: the settle timer restarts.
    vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS - 10);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(WINDOW_RESIZE_SETTLE_MS - 10);
    expect(root.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(true);

    vi.advanceTimersByTime(20);
    expect(root.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(false);
    uninstall();
  });

  it('uninstalling removes the listener and the flag', () => {
    vi.useFakeTimers();
    const uninstall = installWindowResizeFlag();
    window.dispatchEvent(new Event('resize'));
    uninstall();
    expect(document.documentElement.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(false);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.hasAttribute(WINDOW_RESIZING_ATTR)).toBe(false);
  });
});
