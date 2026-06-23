/*
 * v5 workspace layout interactions:
 *  - column-resize: pointer-event drag of --chat-w persisted to localStorage
 *  - rail-expand: [data-rail] toggle on <html>
 * Ported from docs/design/conduit-chat-v5.html.
 */
import { useCallback, useEffect, useState } from 'react';

const LAYOUT_KEY = 'conduit:v5-layout';
const RAIL_KEY = 'conduit:v5-rail';

type RailMode = 'collapsed' | 'expanded';

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

function setChatVar(px: number): number {
  const max = Math.max(420, window.innerWidth - 520);
  const clamped = Math.max(420, Math.min(max, px));
  document.documentElement.style.setProperty('--chat-w', `${clamped}px`);
  return clamped;
}

/** Column-resize: drag of --chat-w persisted to localStorage. Disabled below 820px. */
export function useColumnResize() {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 820px)').matches) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: PointerEvent) => setChatVar(ev.clientX);
    const onUp = (ev: PointerEvent) => {
      const width = setChatVar(ev.clientX);
      writeStoredChatWidth(width);
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
  }, []);

  // Restore persisted width on mount.
  useEffect(() => {
    const saved = readStoredChatWidth();
    if (saved !== null) setChatVar(saved);
  }, []);

  return { onPointerDown, dragging };
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