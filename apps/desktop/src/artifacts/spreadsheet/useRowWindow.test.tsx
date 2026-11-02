import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { columnLabel, cellRefLabel } from './cellRef';
import { computeRowWindow, DEFAULT_VIEWPORT_HEIGHT, useRowWindow } from './useRowWindow';

describe('computeRowWindow', () => {
  const base = { viewportHeight: 240, rowHeight: 24, overscan: 2 };

  it('covers the visible rows plus overscan at the top', () => {
    // 240 / 24 = 10 visible rows (0..9), overscan 2 below.
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 1000 })).toEqual({ start: 0, end: 12 });
  });

  it('follows the scroll position', () => {
    // top row = 100, bottom edge = row 110.
    expect(computeRowWindow({ ...base, scrollTop: 2400, rowCount: 1000 })).toEqual({ start: 98, end: 112 });
  });

  it('includes a partly visible row at each edge', () => {
    // 12px into row 5; the viewport ends 12px into row 15.
    expect(computeRowWindow({ ...base, overscan: 0, scrollTop: 5 * 24 + 12, rowCount: 1000 })).toEqual({
      start: 5,
      end: 16,
    });
  });

  it('never goes past either end', () => {
    expect(computeRowWindow({ ...base, scrollTop: 99_999_999, rowCount: 50 })).toEqual({ start: 50, end: 50 });
    expect(computeRowWindow({ ...base, scrollTop: -500, rowCount: 5 })).toEqual({ start: 0, end: 5 });
  });

  it('is empty for no rows or a zero row height', () => {
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 0 })).toEqual({ start: 0, end: 0 });
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 10, rowHeight: 0 })).toEqual({ start: 0, end: 0 });
  });

  it('stays small for a huge sheet', () => {
    const w = computeRowWindow({ viewportHeight: 800, rowHeight: 24, scrollTop: 24 * 40_000, rowCount: 100_000 });
    expect(w.end - w.start).toBeLessThan(60);
    expect(w.start).toBeGreaterThan(39_000);
  });
});

function Harness({ rowCount }: { rowCount: number }) {
  const w = useRowWindow(rowCount, 24, 1);
  return (
    <div>
      <div data-testid="scroller" ref={w.scrollRef} onScroll={w.onScroll} />
      <button type="button" onClick={w.reset}>
        reset
      </button>
      <output data-testid="window">{`${w.start}-${w.end}`}</output>
    </div>
  );
}

describe('useRowWindow', () => {
  afterEach(cleanup);

  it('starts at the top with the fallback viewport height (no layout in jsdom)', () => {
    render(<Harness rowCount={10_000} />);
    const rows = Math.ceil(DEFAULT_VIEWPORT_HEIGHT / 24) + 1;
    expect(screen.getByTestId('window').textContent).toBe(`0-${rows}`);
  });

  it('moves the window on scroll and back on reset', () => {
    render(<Harness rowCount={10_000} />);
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 24 * 500;
    fireEvent.scroll(scroller);
    const [start, end] = (screen.getByTestId('window').textContent ?? '').split('-').map(Number);
    expect(start).toBe(499);
    expect(end - start).toBeLessThan(40);

    fireEvent.click(screen.getByText('reset'));
    expect(screen.getByTestId('window').textContent?.startsWith('0-')).toBe(true);
  });

  it('clamps to a short sheet', () => {
    render(<Harness rowCount={3} />);
    expect(screen.getByTestId('window').textContent).toBe('0-3');
  });
});

describe('column and cell labels', () => {
  it('counts like a spreadsheet', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(27)).toBe('AB');
    expect(columnLabel(51)).toBe('AZ');
    expect(columnLabel(52)).toBe('BA');
    expect(columnLabel(701)).toBe('ZZ');
    expect(columnLabel(702)).toBe('AAA');
  });

  it('writes A1 references from 0-based row and column', () => {
    expect(cellRefLabel(0, 0)).toBe('A1');
    expect(cellRefLabel(6, 1)).toBe('B7');
    expect(cellRefLabel(99, 26)).toBe('AA100');
  });
});
