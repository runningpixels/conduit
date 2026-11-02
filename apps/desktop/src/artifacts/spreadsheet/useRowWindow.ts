/// Row windowing for the spreadsheet grid: with fixed-height rows, which rows
/// intersect the scroll viewport is arithmetic, so the grid renders only those
/// (plus a little overscan) and positions them by offset. No dependency.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Used when the scroller has no layout yet (first render, jsdom). */
export const DEFAULT_VIEWPORT_HEIGHT = 600;
export const DEFAULT_OVERSCAN = 8;

export interface RowWindow {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
}

/**
 * The rows to render for a scroll position. `start` and `end` are clamped to
 * `[0, rowCount]`; `end - start` stays small however large `rowCount` is.
 */
export function computeRowWindow(options: {
  scrollTop: number;
  viewportHeight: number;
  rowCount: number;
  rowHeight: number;
  overscan?: number;
}): RowWindow {
  const { rowCount, rowHeight } = options;
  const overscan = options.overscan ?? DEFAULT_OVERSCAN;
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const scrollTop = Math.max(0, options.scrollTop);
  const viewportHeight = Math.max(0, options.viewportHeight);
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  const start = Math.min(rowCount, Math.max(0, first - overscan));
  const end = Math.min(rowCount, Math.max(start, last + overscan));
  return { start, end };
}

export interface UseRowWindow extends RowWindow {
  /** Attach to the scroll container. */
  scrollRef: (element: HTMLDivElement | null) => void;
  /** Attach to the scroll container's `onScroll`. */
  onScroll: (event: { currentTarget: { scrollTop: number } }) => void;
  /** Reset to the top (a different sheet). */
  reset: () => void;
}

/**
 * Windows `rowCount` rows of `rowHeight` px inside a scroll container. The
 * viewport height comes from the element (and a ResizeObserver, when the
 * environment has one); scroll position from `onScroll`.
 */
export function useRowWindow(rowCount: number, rowHeight: number, overscan = DEFAULT_OVERSCAN): UseRowWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const height = elementRef.current?.clientHeight ?? 0;
    setViewportHeight(height > 0 ? height : DEFAULT_VIEWPORT_HEIGHT);
  }, []);

  const scrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      elementRef.current = element;
      if (!element) return;
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        observerRef.current = new ResizeObserver(measure);
        observerRef.current.observe(element);
      }
    },
    [measure],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const onScroll = useCallback((event: { currentTarget: { scrollTop: number } }) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const reset = useCallback(() => {
    setScrollTop(0);
    if (elementRef.current) elementRef.current.scrollTop = 0;
  }, []);

  const window = computeRowWindow({ scrollTop, viewportHeight, rowCount, rowHeight, overscan });
  return { ...window, scrollRef, onScroll, reset };
}
