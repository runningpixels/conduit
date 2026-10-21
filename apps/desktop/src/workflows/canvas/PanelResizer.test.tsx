import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_PANEL_WIDTH, PanelResizer, usePanelWidth } from './PanelResizer';

const KEY = 'conduit.workflows.panelWidth';

/// A 1200px-wide layout with the resizer, showing the width it holds.
function Layout() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = usePanelWidth();
  return (
    <div
      ref={(el) => {
        box.current = el;
        if (el) el.getBoundingClientRect = () => ({ left: 0, right: 1200, width: 1200, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
      }}
    >
      <PanelResizer container={box} width={width} onChange={setWidth} />
      <output>{width ?? 'default'}</output>
    </div>
  );
}

describe('PanelResizer', () => {
  afterEach(() => localStorage.removeItem(KEY));

  it('widens and narrows with the arrow keys, keeps the width, and resets on double-click', () => {
    localStorage.setItem(KEY, '400');
    render(<Layout />);
    const bar = screen.getByRole('separator', { name: 'Resize the panel' });
    expect(screen.getByText('400')).toBeTruthy();
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(screen.getByText('416')).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBe('416');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(screen.getByText('384')).toBeTruthy();
    fireEvent.doubleClick(bar);
    expect(screen.getByText('default')).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('never goes below the narrowest panel or leaves the canvas too little room', () => {
    localStorage.setItem(KEY, String(MIN_PANEL_WIDTH));
    render(<Layout />);
    const bar = screen.getByRole('separator', { name: 'Resize the panel' });
    fireEvent.keyDown(bar, { key: 'Home' });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(screen.getByText(String(MIN_PANEL_WIDTH))).toBeTruthy();
    // 1200 wide: the canvas keeps 360, the panel is capped at 760.
    fireEvent.keyDown(bar, { key: 'End' });
    expect(screen.getByText('760')).toBeTruthy();
  });

  it('ignores a stored width it cannot use', () => {
    localStorage.setItem(KEY, 'wide');
    render(<Layout />);
    expect(screen.getByText('default')).toBeTruthy();
  });
});
