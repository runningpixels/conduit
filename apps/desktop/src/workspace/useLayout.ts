/*
 * V7 workspace layout interactions:
 *  - panel-resize: pointer drag of --panel-w persisted to localStorage
 *  - sidebar-collapse: [data-sidebar] on <html> (open|closed)
 *  - panel-collapse: [data-panel] on <html> (open|closed)
 *
 * Column collapse is a width animation, not a mount/unmount: the grid
 * columns are driven by `--sidebar-w` / `--panel-w` and the html attributes
 * zero them out (conduit-v7-design-spec §4.1).
 */
import { useCallback, useEffect, useState } from 'react';

const LAYOUT_KEY = 'conduit:v5-layout';
const SIDEBAR_KEY = 'conduit:v5-sidebar';
const DOC_PANEL_KEY = 'conduit:v5-doc-panel';

type SidebarMode = 'open' | 'closed';
type PanelMode = 'open' | 'closed';

const PANEL_MIN = 280;
const PANEL_MAX = 560;
const PANEL_STEP = 10;

function readStoredPanelWidth(): number | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { panelW?: number };
    return typeof parsed.panelW === 'number' ? parsed.panelW : null;
  } catch {
    return null;
  }
}

function writeStoredPanelWidth(px: number) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ panelW: px }));
  } catch {
    /* storage may be unavailable; fail silently */
  }
}

function panelMax(): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - 320));
}

function setPanelVar(px: number): number {
  const max = panelMax();
  const clamped = Math.max(PANEL_MIN, Math.min(max, px));
  document.documentElement.style.setProperty('--panel-w', `${clamped}px`);
  return clamped;
}

function widthToPercent(px: number): number {
  const max = panelMax();
  if (max <= PANEL_MIN) return 0;
  return Math.round(((px - PANEL_MIN) / (max - PANEL_MIN)) * 100);
}

/** Document-panel column resize: drag of --panel-w persisted to localStorage.
 *  Disabled below 820px (breakpoint §4.3 force-collapses both side columns). */
export function useColumnResize() {
  const [dragging, setDragging] = useState(false);
  const [panelWidthPx, setPanelWidthPx] = useState(() => {
    if (typeof window === 'undefined') return PANEL_MIN;
    return readStoredPanelWidth() ?? PANEL_MIN;
  });

  const applyWidth = useCallback((px: number, persist: boolean) => {
    const next = setPanelVar(px);
    setPanelWidthPx(next);
    if (persist) writeStoredPanelWidth(next);
    return next;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 820px)').matches) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: PointerEvent) => {
      applyWidth(window.innerWidth - ev.clientX, false);
    };
    const onUp = (ev: PointerEvent) => {
      applyWidth(window.innerWidth - ev.clientX, true);
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      setDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [applyWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 820px)').matches) return;
    const max = panelMax();
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = panelWidthPx - PANEL_STEP;
    else if (e.key === 'ArrowRight') next = panelWidthPx + PANEL_STEP;
    else if (e.key === 'Home') next = PANEL_MIN;
    else if (e.key === 'End') next = max;
    if (next == null) return;
    e.preventDefault();
    applyWidth(next, true);
  }, [applyWidth, panelWidthPx]);

  // Restore persisted width on mount.
  useEffect(() => {
    const saved = readStoredPanelWidth();
    if (saved !== null) applyWidth(saved, false);
  }, [applyWidth]);

  const max = typeof window !== 'undefined' ? panelMax() : PANEL_MIN;
  return {
    onPointerDown,
    onKeyDown,
    dragging,
    panelWidthPx,
    ariaValueNow: widthToPercent(panelWidthPx),
    ariaValueMin: 0,
    ariaValueMax: 100,
    panelMin: PANEL_MIN,
    panelMax: max,
  };
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

  useEffect(() => {
    document.documentElement.setAttribute('data-sidebar', mode);
    writeStoredSidebar(mode);
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

  useEffect(() => {
    document.documentElement.setAttribute('data-panel', mode);
    writeStoredDocPanel(mode);
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
