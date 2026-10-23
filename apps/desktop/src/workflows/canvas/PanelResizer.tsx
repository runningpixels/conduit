/// The bar between the canvas and the panel beside it: drag it (or use the
/// arrow keys on it) to make the panel wider or narrower. The width is kept
/// for next time on this computer; a double-click goes back to the default.

import { useCallback, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useT } from '../../i18n';

const KEY = 'conduit.workflows.panelWidth';
export const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 760;
/// The canvas keeps at least this much room when the panel grows.
const MIN_CANVAS_WIDTH = 360;
const STEP = 16;

function readWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN_PANEL_WIDTH ? n : null;
  } catch {
    return null;
  }
}

function keepWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(width)));
  } catch {
    // Not kept (private window, blocked storage): it still works until the page closes.
  }
}

/// The panel width the user chose, or `null` for the layout's own default.
export function usePanelWidth(): [number | null, (width: number | null) => void] {
  const [width, setWidth] = useState<number | null>(readWidth);
  const set = useCallback((next: number | null) => {
    setWidth(next);
    keepWidth(next);
  }, []);
  return [width, set];
}

/// The widest the panel may be in a layout `total` pixels wide.
function widest(total: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, total - MIN_CANVAS_WIDTH));
}

export function PanelResizer({
  container,
  width,
  onChange,
}: {
  /// The canvas-and-panel layout; the panel is at its right edge.
  container: RefObject<HTMLElement | null>;
  /// The chosen width, or `null` when the panel has its default width.
  width: number | null;
  onChange: (width: number | null) => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => {
    const total = container.current?.getBoundingClientRect().width ?? 0;
    return Math.round(Math.min(widest(total), Math.max(MIN_PANEL_WIDTH, w)));
  };
  /// The panel's width now, whether chosen or the default.
  const current = () => {
    const panel = container.current?.querySelector<HTMLElement>(':scope > .wfc-inspector');
    return width ?? panel?.getBoundingClientRect().width ?? MIN_PANEL_WIDTH;
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const right = container.current?.getBoundingClientRect().right ?? event.clientX;
    onChange(clamp(right - event.clientX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The panel is on the right: moving the bar left makes it wider.
    const by = event.key === 'ArrowLeft' ? STEP : event.key === 'ArrowRight' ? -STEP : 0;
    if (by !== 0) {
      event.preventDefault();
      onChange(clamp(current() + by));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onChange(event.key === 'Home' ? MIN_PANEL_WIDTH : clamp(Number.MAX_SAFE_INTEGER));
    }
  };
  const total = container.current?.getBoundingClientRect().width ?? 0;
  return (
    <div
      className={dragging ? 'wfc-resizer is-dragging' : 'wfc-resizer'}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('workspace.workflows.canvas.resizePanel')}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={total > 0 ? widest(total) : MAX_PANEL_WIDTH}
      aria-valuenow={width ?? undefined}
      title={t('workspace.workflows.canvas.resizePanelHint')}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragging) fromPointer(event);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
    />
  );
}
