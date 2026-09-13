import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  NARROW_BREAKPOINT,
  PANEL_BREAKPOINT,
  PANEL_DEFAULT,
  PANEL_MAX,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  THREAD_MIN,
  reflowColumns,
  useColumnResize,
  useDocPanelCollapse,
  useSidebarCollapse,
  useSidebarResize,
  __readStoredLayoutForTest,
  __writeStoredLayoutForTest,
  __readStoredDocPanelForTest,
  __writeStoredDocPanelForTest,
  __readStoredSidebarForTest,
  __writeStoredSidebarForTest,
} from './useLayout';

describe('useDocPanelCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-panel');
  });

  it('defaults to open and persists collapse to localStorage', () => {
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.getAttribute('data-panel')).toBe('open');

    act(() => result.current.collapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-panel')).toBe('closed');
    expect(__readStoredDocPanelForTest()).toBe('closed');

    act(() => result.current.expand());
    expect(result.current.collapsed).toBe(false);
    expect(__readStoredDocPanelForTest()).toBe('open');
  });

  it('restores persisted collapsed mode on mount', () => {
    __writeStoredDocPanelForTest('closed');
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-panel')).toBe('closed');
  });

  it('toggle flips between open and closed', () => {
    const { result } = renderHook(() => useDocPanelCollapse());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
  });
});

describe('useSidebarCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-sidebar');
  });

  it('defaults to open and persists collapse to localStorage', () => {
    const { result } = renderHook(() => useSidebarCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('open');

    act(() => result.current.close());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('closed');
    expect(__readStoredSidebarForTest()).toBe('closed');

    act(() => result.current.open());
    expect(result.current.collapsed).toBe(false);
    expect(__readStoredSidebarForTest()).toBe('open');
  });

  it('restores persisted collapsed mode on mount', () => {
    __writeStoredSidebarForTest('closed');
    const { result } = renderHook(() => useSidebarCollapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('closed');
  });
});

/* ── Column resize ────────────────────────────────────────────────────── */

function key(name: string, shiftKey = false) {
  return { key: name, shiftKey, preventDefault() {} } as unknown as React.KeyboardEvent<HTMLDivElement>;
}

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

function cssPx(name: string): number {
  return parseFloat(document.documentElement.style.getPropertyValue(name));
}

/** Both columns plus both collapses, wired the way App.tsx wires them. */
function renderLayout() {
  return renderHook(() => {
    const sidebar = useSidebarCollapse();
    const panel = useDocPanelCollapse();
    const sidebarResize = useSidebarResize({ open: sidebar.open, close: sidebar.close });
    const panelResize = useColumnResize();
    return { sidebar, panel, sidebarResize, panelResize };
  });
}

describe('column resize', () => {
  beforeEach(() => {
    localStorage.clear();
    const root = document.documentElement;
    root.removeAttribute('data-sidebar');
    root.removeAttribute('data-panel');
    root.removeAttribute('data-resizing');
    root.style.removeProperty('--sidebar-open-w');
    root.style.removeProperty('--panel-w');
    setViewportWidth(1600);
  });

  it('applies the defaults when nothing is stored', () => {
    renderLayout();
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_DEFAULT);
    expect(cssPx('--panel-w')).toBe(PANEL_DEFAULT);
  });

  it('restores persisted widths on mount', () => {
    __writeStoredLayoutForTest({ sidebarW: 320, panelW: 500 });
    const { result } = renderLayout();
    expect(cssPx('--sidebar-open-w')).toBe(320);
    expect(cssPx('--panel-w')).toBe(500);
    expect(result.current.sidebarResize.widthPx).toBe(320);
  });

  it('keeps the thread its floor, taking the room from the panel first', () => {
    setViewportWidth(1200);
    __writeStoredLayoutForTest({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
    renderLayout();
    const room = 1200 - 12 - THREAD_MIN;
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_MAX);
    expect(cssPx('--panel-w')).toBe(room - SIDEBAR_MAX);
    // The preference is left alone, so a wider window gives it back.
    expect(__readStoredLayoutForTest()).toEqual({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
    setViewportWidth(1600);
    act(() => reflowColumns());
    expect(cssPx('--panel-w')).toBe(PANEL_MAX);
  });

  it('re-clamps on window resize', async () => {
    __writeStoredLayoutForTest({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
    renderLayout();
    expect(cssPx('--panel-w')).toBe(PANEL_MAX);
    setViewportWidth(1200);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(cssPx('--panel-w')).toBe(1200 - 12 - THREAD_MIN - SIDEBAR_MAX);
  });

  it("gives a collapsed column's room back to the other one", () => {
    setViewportWidth(1200);
    __writeStoredLayoutForTest({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
    const { result } = renderLayout();
    expect(cssPx('--panel-w')).toBeLessThan(PANEL_MAX);
    act(() => result.current.sidebar.close());
    expect(cssPx('--panel-w')).toBe(PANEL_MAX);
  });

  it('moves the sidebar separator with the arrow keys and clamps to its bounds', () => {
    const { result } = renderLayout();
    act(() => result.current.sidebarResize.onKeyDown(key('ArrowRight')));
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_DEFAULT + 10);
    act(() => result.current.sidebarResize.onKeyDown(key('ArrowLeft', true)));
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_DEFAULT + 10 - 50);
    act(() => result.current.sidebarResize.onKeyDown(key('Home')));
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_MIN);
    act(() => result.current.sidebarResize.onKeyDown(key('ArrowLeft')));
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_MIN);
    act(() => result.current.sidebarResize.onKeyDown(key('End')));
    expect(cssPx('--sidebar-open-w')).toBe(SIDEBAR_MAX);
    expect(result.current.sidebarResize.ariaValueNow).toBe(100);
  });

  it('widens the panel with ArrowLeft, since its separator sits on its left edge', () => {
    const { result } = renderLayout();
    act(() => result.current.panelResize.onKeyDown(key('ArrowLeft')));
    expect(cssPx('--panel-w')).toBe(PANEL_DEFAULT + 10);
  });

  it('persists one column without dropping the other', () => {
    __writeStoredLayoutForTest({ panelW: 500 });
    const { result } = renderLayout();
    act(() => result.current.sidebarResize.onKeyDown(key('ArrowRight')));
    expect(__readStoredLayoutForTest()).toEqual({ panelW: 500, sidebarW: SIDEBAR_DEFAULT + 10 });
  });

  it('resets to the default width on double-click', () => {
    __writeStoredLayoutForTest({ sidebarW: 400, panelW: 300 });
    const { result } = renderLayout();
    act(() => result.current.sidebarResize.onDoubleClick());
    act(() => result.current.panelResize.onDoubleClick());
    expect(__readStoredLayoutForTest()).toEqual({ sidebarW: SIDEBAR_DEFAULT, panelW: PANEL_DEFAULT });
  });

  it('does nothing where the column is force-hidden', () => {
    setViewportWidth(NARROW_BREAKPOINT);
    const { result } = renderLayout();
    act(() => result.current.sidebarResize.onKeyDown(key('ArrowRight')));
    expect(__readStoredLayoutForTest()).toEqual({});
    setViewportWidth(PANEL_BREAKPOINT);
    act(() => result.current.panelResize.onKeyDown(key('ArrowLeft')));
    expect(__readStoredLayoutForTest()).toEqual({});
  });

  describe('dragging the sidebar', () => {
    function startDrag(
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void,
      clientX: number,
    ) {
      const handle = document.createElement('div');
      act(() =>
        onPointerDown({
          button: 0,
          pointerId: 1,
          clientX,
          currentTarget: handle,
          preventDefault() {},
        } as unknown as React.PointerEvent<HTMLDivElement>),
      );
      return handle;
    }

    function move(clientX: number) {
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
      });
    }

    function release() {
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
    }

    it('follows the pointer, keeping the grab offset, and persists on release', () => {
      const { result } = renderLayout();
      // Grabbed 2px left of the border.
      const handle = startDrag(result.current.sidebarResize.onPointerDown, SIDEBAR_DEFAULT - 2);
      expect(document.documentElement.getAttribute('data-resizing')).toBe('sidebar');
      expect(handle.classList.contains('dragging')).toBe(true);
      move(348);
      expect(cssPx('--sidebar-open-w')).toBe(350);
      expect(__readStoredLayoutForTest()).toEqual({});
      release();
      expect(__readStoredLayoutForTest()).toEqual({ sidebarW: 350 });
      expect(document.documentElement.hasAttribute('data-resizing')).toBe(false);
      expect(handle.classList.contains('dragging')).toBe(false);
    });

    it('snaps shut below half its min width, and reopens at the width the drag started from', () => {
      __writeStoredLayoutForTest({ sidebarW: 320 });
      const { result } = renderLayout();
      startDrag(result.current.sidebarResize.onPointerDown, 320);
      // Through the min width on the way out, as a real drag does.
      move(SIDEBAR_MIN);
      move(SIDEBAR_MIN / 2 - 1);
      expect(result.current.sidebar.collapsed).toBe(true);
      expect(document.documentElement.getAttribute('data-sidebar')).toBe('closed');
      // Dragging back out reopens it mid-gesture, at the pointer.
      move(260);
      expect(result.current.sidebar.collapsed).toBe(false);
      expect(cssPx('--sidebar-open-w')).toBe(260);
      move(20);
      release();
      expect(result.current.sidebar.collapsed).toBe(true);
      expect(__readStoredLayoutForTest()).toEqual({ sidebarW: 320 });
      act(() => result.current.sidebar.open());
      expect(cssPx('--sidebar-open-w')).toBe(320);
    });

    it('persists nothing for a press without a move', () => {
      setViewportWidth(1200);
      __writeStoredLayoutForTest({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
      const { result } = renderLayout();
      // The panel is viewport-clamped below its preference here.
      expect(cssPx('--panel-w')).toBeLessThan(PANEL_MAX);
      startDrag(result.current.panelResize.onPointerDown, 1200 - cssPx('--panel-w'));
      release();
      expect(__readStoredLayoutForTest()).toEqual({ sidebarW: SIDEBAR_MAX, panelW: PANEL_MAX });
    });
  });
});
