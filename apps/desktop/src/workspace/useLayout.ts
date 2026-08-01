/*
 * v5 workspace layout interactions:
 *  - column-resize: pointer-event drag of --chat-w persisted to localStorage
 *  - rail-expand: [data-rail] toggle on <html>
 * Ported from docs/design/conduit-chat-v5.html.
 */
import { useCallback, useEffect, useState } from 'react';

const LAYOUT_KEY = 'conduit:v5-layout';
const RAIL_KEY = 'conduit:v5-rail';
const DOC_PANEL_KEY = 'conduit:v5-doc-panel';

type RailMode = 'collapsed' | 'expanded';
type DocPanelMode = 'collapsed' | 'open';

const CHAT_MIN = 420;
const CHAT_STEP = 10;

function readStoredChatWidth(): number | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { chatW?: number };
    return typeof parsed.chatW === 'number' ? parsed.chatW : null;
  } catch {
    return null;
  }
}

function writeStoredChatWidth(px: number) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ chatW: px }));
  } catch {
    /* storage may be unavailable; fail silently */
  }
}

function readStoredRail(): RailMode {
  try {
    const v = localStorage.getItem(RAIL_KEY);
    return v === 'expanded' ? 'expanded' : 'collapsed';
  } catch {
    return 'collapsed';
  }
}

function writeStoredRail(mode: RailMode) {
  try {
    localStorage.setItem(RAIL_KEY, mode);
  } catch {
    /* ignore */
  }
}

function chatMax(): number {
  return Math.max(CHAT_MIN, window.innerWidth - 520);
}

function setChatVar(px: number): number {
  const max = chatMax();
  const clamped = Math.max(CHAT_MIN, Math.min(max, px));
  document.documentElement.style.setProperty('--chat-w', `${clamped}px`);
  return clamped;
}

function widthToPercent(px: number): number {
  const max = chatMax();
  if (max <= CHAT_MIN) return 0;
  return Math.round(((px - CHAT_MIN) / (max - CHAT_MIN)) * 100);
}

/** Column-resize: drag of --chat-w persisted to localStorage. Disabled below 820px. */
export function useColumnResize() {
  const [dragging, setDragging] = useState(false);
  const [chatWidthPx, setChatWidthPx] = useState(() => {
    if (typeof window === 'undefined') return CHAT_MIN;
    return readStoredChatWidth() ?? CHAT_MIN;
  });

  const applyWidth = useCallback((px: number, persist: boolean) => {
    const next = setChatVar(px);
    setChatWidthPx(next);
    if (persist) writeStoredChatWidth(next);
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
      applyWidth(ev.clientX, false);
    };
    const onUp = (ev: PointerEvent) => {
      applyWidth(ev.clientX, true);
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
    const max = chatMax();
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = chatWidthPx - CHAT_STEP;
    else if (e.key === 'ArrowRight') next = chatWidthPx + CHAT_STEP;
    else if (e.key === 'Home') next = CHAT_MIN;
    else if (e.key === 'End') next = max;
    if (next == null) return;
    e.preventDefault();
    applyWidth(next, true);
  }, [applyWidth, chatWidthPx]);

  // Restore persisted width on mount.
  useEffect(() => {
    const saved = readStoredChatWidth();
    if (saved !== null) applyWidth(saved, false);
  }, [applyWidth]);

  const max = typeof window !== 'undefined' ? chatMax() : CHAT_MIN;
  return {
    onPointerDown,
    onKeyDown,
    dragging,
    chatWidthPx,
    ariaValueNow: widthToPercent(chatWidthPx),
    ariaValueMin: 0,
    ariaValueMax: 100,
    chatMin: CHAT_MIN,
    chatMax: max,
  };
}

/** Rail expand/collapse: toggles [data-rail] on <html>, persisted. */
export function useRailExpand() {
  const [rail, setRail] = useState<RailMode>(readStoredRail);

  useEffect(() => {
    document.documentElement.setAttribute('data-rail', rail);
    writeStoredRail(rail);
  }, [rail]);

  const toggle = useCallback(() => {
    setRail((current) => (current === 'expanded' ? 'collapsed' : 'expanded'));
  }, []);

  const expanded = rail === 'expanded';
  return { expanded, toggle, ariaExpanded: expanded };
}

function readStoredDocPanel(): DocPanelMode {
  try {
    const v = localStorage.getItem(DOC_PANEL_KEY);
    return v === 'collapsed' ? 'collapsed' : 'open';
  } catch {
    return 'open';
  }
}

function writeStoredDocPanel(mode: DocPanelMode) {
  try {
    localStorage.setItem(DOC_PANEL_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Document panel column collapse: toggles [data-doc-panel] on <html>, persisted. */
export function useDocPanelCollapse() {
  const [mode, setMode] = useState<DocPanelMode>(readStoredDocPanel);

  useEffect(() => {
    document.documentElement.setAttribute('data-doc-panel', mode);
    writeStoredDocPanel(mode);
  }, [mode]);

  const collapse = useCallback(() => setMode('collapsed'), []);
  const expand = useCallback(() => setMode('open'), []);
  const toggle = useCallback(() => {
    setMode((current) => (current === 'collapsed' ? 'open' : 'collapsed'));
  }, []);
  const collapsed = mode === 'collapsed';

  return { collapsed, collapse, expand, toggle };
}

/** @internal test seam */
export function __readStoredDocPanelForTest(): DocPanelMode {
  return readStoredDocPanel();
}

/** @internal test seam */
export function __writeStoredDocPanelForTest(mode: DocPanelMode): void {
  writeStoredDocPanel(mode);
}

/** @internal test seam */
export function __readStoredRailForTest(): RailMode {
  return readStoredRail();
}
