/*
 * V7 workspace layout interactions:
 *  - column-resize: pointer/keyboard drag of --sidebar-open-w and --panel-w,
 *    persisted to localStorage
 *  - sidebar-collapse: [data-sidebar] on <html> (open|closed)
 *  - panel-collapse: [data-panel] on <html> (open|closed)
 *
 * Column collapse is a width animation, not a mount/unmount: the grid
 * columns are driven by `--sidebar-w` / `--panel-w` and the html attributes
 * zero them out (conduit-v7-design-spec §4.1).
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const LAYOUT_KEY = 'conduit:v5-layout';
const SIDEBAR_KEY = 'conduit:v5-sidebar';
const DOC_PANEL_KEY = 'conduit:v5-doc-panel';

type SidebarMode = 'open' | 'closed';
type PanelMode = 'open' | 'closed';

/*
 * Breakpoints. These mirror the media queries in workspace.css, and
 * shellContract.test.ts reads both sides so they cannot drift apart again:
 * the panel's resize used to switch off at 820px while the stylesheet hid its
 * handle at 1100px and collapsed both columns at 900px.
 */
/** At or below this width both side columns are force-collapsed. */
export const NARROW_BREAKPOINT = 900;
/** At or below this width the document panel is hidden. */
export const PANEL_BREAKPOINT = 1100;

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 280;

export const PANEL_MIN = 280;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 420;

/**
 * The width the thread keeps when a side column is dragged or the window
 * shrinks. Before the sidebar could move, the panel clamp assumed a fixed
 * 320px for everything else, which let the thread fall to ~250px at 1101px.
 */
export const THREAD_MIN = 420;

/** The document panel's handle is a fixed grid track (workspace.css `.body`). */
const PANEL_HANDLE_W = 12;
const STEP = 10;
const STEP_LARGE = 50;

/** Fired on `window` after `reflowColumns` so hooks can resync their widths. */
const REFLOW_EVENT = 'conduit:layout-reflow';

type ColumnId = 'sidebar' | 'panel';

interface ColumnSpec {
  cssVar: string;
  field: 'sidebarW' | 'panelW';
  min: number;
  max: number;
  fallback: number;
  collapseAttr: 'data-sidebar' | 'data-panel';
  hiddenAtOrBelow: number;
}

const COLUMNS: Record<ColumnId, ColumnSpec> = {
  sidebar: {
    cssVar: '--sidebar-open-w',
    field: 'sidebarW',
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    fallback: SIDEBAR_DEFAULT,
    collapseAttr: 'data-sidebar',
    hiddenAtOrBelow: NARROW_BREAKPOINT,
  },
  panel: {
    cssVar: '--panel-w',
    field: 'panelW',
    min: PANEL_MIN,
    max: PANEL_MAX,
    fallback: PANEL_DEFAULT,
    collapseAttr: 'data-panel',
    hiddenAtOrBelow: PANEL_BREAKPOINT,
  },
};

type StoredLayout = { sidebarW?: number; panelW?: number };

function readStoredLayout(): StoredLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredLayout;
    const out: StoredLayout = {};
    if (typeof parsed.sidebarW === 'number' && Number.isFinite(parsed.sidebarW)) out.sidebarW = parsed.sidebarW;
    if (typeof parsed.panelW === 'number' && Number.isFinite(parsed.panelW)) out.panelW = parsed.panelW;
    return out;
  } catch {
    return {};
  }
}

/** Merges into the stored object: writing one column must not drop the other's width. */
function writeStoredLayout(patch: StoredLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readStoredLayout(), ...patch }));
  } catch {
    /* storage may be unavailable; fail silently */
  }
}

function clamp(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, px));
}

/** The width the user last chose, within the column's own bounds. */
function preferredWidth(id: ColumnId): number {
  const spec = COLUMNS[id];
  const stored = readStoredLayout()[spec.field];
  return stored === undefined ? spec.fallback : clamp(stored, spec.min, spec.max);
}

function isShown(id: ColumnId): boolean {
  const spec = COLUMNS[id];
  return (
    document.documentElement.getAttribute(spec.collapseAttr) !== 'closed' &&
    window.innerWidth > spec.hiddenAtOrBelow
  );
}

/** The open width currently applied to the column (its CSS variable). */
function appliedWidth(id: ColumnId): number {
  const px = parseFloat(document.documentElement.style.getPropertyValue(COLUMNS[id].cssVar));
  return Number.isFinite(px) ? px : preferredWidth(id);
}

/** Upper bound for a column: its own max, less whatever the thread and the other column need. */
function maxWidth(id: ColumnId): number {
  const spec = COLUMNS[id];
  const other: ColumnId = id === 'sidebar' ? 'panel' : 'sidebar';
  const otherPx = isShown(other) ? appliedWidth(other) : 0;
  const room = window.innerWidth - PANEL_HANDLE_W - THREAD_MIN - otherPx;
  return Math.max(spec.min, Math.min(spec.max, room));
}

function setWidthVar(id: ColumnId, px: number) {
  document.documentElement.style.setProperty(COLUMNS[id].cssVar, `${px}px`);
}

function applyWidth(id: ColumnId, px: number): number {
  const next = Math.round(clamp(px, COLUMNS[id].min, maxWidth(id)));
  setWidthVar(id, next);
  return next;
}

/**
 * Re-applies both preferred widths against the current window and collapse
 * state. When the two do not fit, the panel yields first (down to its min),
 * then the sidebar: the panel is the column that disappears outright at
 * PANEL_BREAKPOINT, so it is the one already expected to give way.
 *
 * Preferences are never overwritten here, so a window that grows back
 * restores the widths the user chose. A column mid-drag keeps its live width
 * instead: snapping the sidebar open again reflows, and must not yank it back
 * to the stored width under the pointer.
 */
export function reflowColumns(): void {
  if (typeof window === 'undefined') return;
  const dragged = document.documentElement.getAttribute('data-resizing');
  const wanted = (id: ColumnId) => (dragged === id ? appliedWidth(id) : preferredWidth(id));
  setWidthVar('sidebar', wanted('sidebar'));
  applyWidth('panel', wanted('panel'));
  applyWidth('sidebar', wanted('sidebar'));
  window.dispatchEvent(new Event(REFLOW_EVENT));
}

function widthToPercent(px: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.round(((px - min) / (max - min)) * 100);
}

interface CollapseControls {
  open: () => void;
  close: () => void;
}

interface ResizableColumnOptions {
  /** When given, dragging below half the min width snaps the column shut. */
  collapse?: CollapseControls;
}

function useResizableColumn(id: ColumnId, options: ResizableColumnOptions = {}) {
  const spec = COLUMNS[id];
  const [widthPx, setWidthPx] = useState(() =>
    typeof window === 'undefined' ? spec.fallback : preferredWidth(id),
  );
  const [dragging, setDragging] = useState(false);
  const collapseRef = useRef(options.collapse);
  collapseRef.current = options.collapse;

  const resizeDisabled = useCallback(() => window.innerWidth <= spec.hiddenAtOrBelow, [spec]);

  const commit = useCallback(
    (px: number, persist: boolean) => {
      const next = applyWidth(id, px);
      setWidthPx(next);
      if (persist) writeStoredLayout({ [spec.field]: next });
      return next;
    },
    [id, spec],
  );

  /** The column's width if its edge sat under the pointer. */
  const pointerToWidth = useCallback(
    (clientX: number) => (id === 'sidebar' ? clientX : window.innerWidth - clientX),
    [id],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || resizeDisabled()) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      handle.setPointerCapture?.(pointerId);
      handle.classList.add('dragging');
      setDragging(true);
      const root = document.documentElement;
      root.setAttribute('data-resizing', id);

      // Where inside the handle it was grabbed, so the column does not jump by
      // that offset on the first move.
      const startWidth = appliedWidth(id);
      const grabOffset = startWidth - pointerToWidth(e.clientX);
      let last = startWidth;
      let moved = false;
      let snapped = false;

      const onMove = (ev: PointerEvent) => {
        moved = true;
        const raw = pointerToWidth(ev.clientX) + grabOffset;
        const collapse = collapseRef.current;
        if (collapse && raw < spec.min / 2) {
          if (!snapped) {
            snapped = true;
            collapse.close();
          }
          return;
        }
        if (snapped) {
          snapped = false;
          collapse?.open();
        }
        last = commit(raw, false);
      };
      const onUp = () => {
        if (snapped) {
          // Snapping shut is a collapse, not a resize: the pointer passed
          // through the min width on its way out, and reopening should not
          // land there. Put back the width the gesture started from.
          commit(startWidth, false);
        } else if (moved) {
          commit(last, true);
        }
        // A press without a move persists nothing, so a click on the sash
        // cannot freeze a viewport-clamped width in as the preference.
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        handle.classList.remove('dragging');
        setDragging(false);
        root.removeAttribute('data-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [commit, id, pointerToWidth, resizeDisabled, spec],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (resizeDisabled()) return;
      const step = e.shiftKey ? STEP_LARGE : STEP;
      const current = appliedWidth(id);
      // Arrows move the separator (WAI-ARIA window splitter), so which one
      // widens the column depends on the side of the window it is anchored to.
      const grow = id === 'sidebar' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = id === 'sidebar' ? 'ArrowLeft' : 'ArrowRight';
      let next: number | null = null;
      if (e.key === grow) next = current + step;
      else if (e.key === shrink) next = current - step;
      else if (e.key === 'Home') next = spec.min;
      else if (e.key === 'End') next = maxWidth(id);
      if (next == null) return;
      e.preventDefault();
      commit(next, true);
    },
    [commit, id, resizeDisabled, spec],
  );

  /** Double-clicking a sash resets it — the Windows and VS Code convention. */
  const onDoubleClick = useCallback(() => {
    if (resizeDisabled()) return;
    commit(spec.fallback, true);
  }, [commit, resizeDisabled, spec]);

  // Layout effect, so persisted widths land before the first paint. The resize
  // listener is rAF-throttled; reflow is idempotent, so two hooks each keeping
  // one costs nothing meaningful.
  useLayoutEffect(() => {
    const sync = () => setWidthPx(appliedWidth(id));
    window.addEventListener(REFLOW_EVENT, sync);
    reflowColumns();

    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reflowColumns);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener(REFLOW_EVENT, sync);
    };
  }, [id]);

  const max = typeof window !== 'undefined' ? maxWidth(id) : spec.max;
  return {
    onPointerDown,
    onKeyDown,
    onDoubleClick,
    dragging,
    widthPx,
    ariaValueNow: widthToPercent(widthPx, spec.min, max),
    ariaValueMin: 0,
    ariaValueMax: 100,
    min: spec.min,
    max,
  };
}

/** Document-panel column resize: drag of --panel-w persisted to localStorage.
 *  Disabled at or below PANEL_BREAKPOINT, where the panel is hidden (§4.3). */
export function useColumnResize() {
  return useResizableColumn('panel');
}

/** Sidebar column resize: drag of --sidebar-open-w persisted to localStorage.
 *  Dragging below half its min width snaps it shut. Disabled at or below
 *  NARROW_BREAKPOINT, where the sidebar is force-collapsed (§4.3). */
export function useSidebarResize(collapse: CollapseControls) {
  return useResizableColumn('sidebar', { collapse });
}

function readStoredSidebar(): SidebarMode {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    return v === 'closed' ? 'closed' : 'open';
  } catch {
    return 'open';
  }
}

function writeStoredSidebar(mode: SidebarMode) {
  try {
    localStorage.setItem(SIDEBAR_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Sidebar collapse: toggles [data-sidebar="open"|"closed"] on <html>, persisted. */
export function useSidebarCollapse() {
  const [mode, setMode] = useState<SidebarMode>(readStoredSidebar);

  // Layout effect: a persisted "closed" must be on <html> before the first
  // paint, or the column visibly animates shut on every launch.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-sidebar', mode);
    writeStoredSidebar(mode);
    // Opening or closing one column changes how much room the other may take.
    reflowColumns();
  }, [mode]);

  const open = useCallback(() => setMode('open'), []);
  const close = useCallback(() => setMode('closed'), []);
  const toggle = useCallback(() => {
    setMode((current) => (current === 'open' ? 'closed' : 'open'));
  }, []);
  const collapsed = mode === 'closed';

  return { collapsed, open, close, toggle };
}

function readStoredDocPanel(): PanelMode {
  try {
    const v = localStorage.getItem(DOC_PANEL_KEY);
    return v === 'closed' ? 'closed' : 'open';
  } catch {
    return 'open';
  }
}

function writeStoredDocPanel(mode: PanelMode) {
  try {
    localStorage.setItem(DOC_PANEL_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Document panel column collapse: toggles [data-panel="open"|"closed"] on <html>, persisted. */
export function useDocPanelCollapse() {
  const [mode, setMode] = useState<PanelMode>(readStoredDocPanel);

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-panel', mode);
    writeStoredDocPanel(mode);
    reflowColumns();
  }, [mode]);

  const collapse = useCallback(() => setMode('closed'), []);
  const expand = useCallback(() => setMode('open'), []);
  const toggle = useCallback(() => {
    setMode((current) => (current === 'open' ? 'closed' : 'open'));
  }, []);
  const collapsed = mode === 'closed';

  return { collapsed, collapse, expand, toggle };
}

/** @internal test seam */
export function __readStoredLayoutForTest(): StoredLayout {
  return readStoredLayout();
}

/** @internal test seam */
export function __writeStoredLayoutForTest(patch: StoredLayout): void {
  writeStoredLayout(patch);
}

/** @internal test seam */
export function __readStoredDocPanelForTest(): PanelMode {
  return readStoredDocPanel();
}

/** @internal test seam */
export function __writeStoredDocPanelForTest(mode: PanelMode): void {
  writeStoredDocPanel(mode);
}

/** @internal test seam */
export function __readStoredSidebarForTest(): SidebarMode {
  return readStoredSidebar();
}

/** @internal test seam */
export function __writeStoredSidebarForTest(mode: SidebarMode): void {
  writeStoredSidebar(mode);
}
