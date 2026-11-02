import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Artifact } from '../../ipc/contracts';
import { SpreadsheetRenderer, columnPixelWidth } from './SpreadsheetRenderer';
import type { SpreadsheetCellView, SpreadsheetSheetView, SpreadsheetView } from './types';

vi.mock('../../ipc/client', () => ({
  getSpreadsheetView: vi.fn(),
}));

import { getSpreadsheetView } from '../../ipc/client';

const mockView = vi.mocked(getSpreadsheetView);

function art(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'sheet-1',
    conversationId: 'c1',
    kind: 'spreadsheet',
    title: 'Menu board',
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    contentHash: 'h1',
    ...over,
  };
}

const text = (display: string, style?: SpreadsheetCellView['style']): SpreadsheetCellView => ({
  display,
  kind: 'text',
  ...(style ? { style } : {}),
});
const num = (display: string, over: Partial<SpreadsheetCellView> = {}): SpreadsheetCellView => ({
  display,
  kind: 'number',
  ...over,
});

function budgetSheet(over: Partial<SpreadsheetSheetView> = {}): SpreadsheetSheetView {
  return {
    name: 'Budget',
    freezeHeader: true,
    columnWidths: [28, 8, 12],
    rowCount: 5,
    colCount: 3,
    truncatedRows: 0,
    rows: [
      [text('Item', 'header'), text('Qty', 'header'), text('Cost', 'header')],
      [text('Display'), num('2', { style: 'input' }), num('$700.00', { formula: '=B2*350' })],
      [text('Note'), null, text('check later', 'note')],
      [text('Ratio'), { display: '#DIV/0!', kind: 'error', formula: '=A1/0' }, { display: 'TRUE', kind: 'bool' }],
      [text('Total', 'total'), null, num('$700.00', { formula: '=SUM(C2:C4)', style: 'total' })],
    ],
    ...over,
  };
}

function viewOf(sheets: SpreadsheetSheetView[], errors: SpreadsheetView['errors'] = []): SpreadsheetView {
  return { title: 'Menu board', sheets, errors };
}

function cells() {
  return screen.getAllByRole('gridcell');
}
function cellByText(label: string): HTMLElement {
  const match = cells().find((el) => el.textContent === label);
  if (!match) throw new Error(`no cell "${label}"`);
  return match;
}

describe('SpreadsheetRenderer', () => {
  beforeEach(() => {
    mockView.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('shows a loading state, then the grid', async () => {
    let resolve!: (v: SpreadsheetView) => void;
    mockView.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    expect(container.querySelector('.artifact-skeleton')).not.toBeNull();
    resolve(viewOf([budgetSheet()]));
    await screen.findByRole('grid');
    expect(mockView).toHaveBeenCalledWith('sheet-1');
  });

  it('shows the error when the view cannot be loaded', async () => {
    mockView.mockRejectedValue(new Error('boom'));
    render(<SpreadsheetRenderer artifact={art()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Error: boom');
  });

  it('draws column letters, row numbers and display text', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual(['', 'A', 'B', 'C']);
    expect(screen.getAllByRole('rowheader').map((el) => el.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(cellByText('$700.00')).toBeTruthy();
    expect(cellByText('Display')).toBeTruthy();
  });

  it('labels columns past Z', async () => {
    const wide = budgetSheet({ colCount: 28, columnWidths: [], rows: [[text('x')]] });
    mockView.mockResolvedValue(viewOf([wide]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    const heads = screen.getAllByRole('columnheader').map((el) => el.textContent);
    expect(heads.slice(26)).toEqual(['Z', 'AA', 'AB']);
  });

  it('sizes columns from the spec widths', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    const [a, b] = screen.getAllByRole('columnheader').slice(1);
    expect(a.style.width).toBe(`${columnPixelWidth(28)}px`);
    expect(b.style.width).toBe(`${columnPixelWidth(8)}px`);
    expect(columnPixelWidth(undefined)).toBe(columnPixelWidth(10));
    expect(columnPixelWidth(28)).toBeGreaterThan(columnPixelWidth(8));
  });

  it('aligns numbers right, text left, and marks errors, with the style classes', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(cellByText('Item').className).toContain('sheet-style-header');
    expect(cellByText('Display').className).toContain('sheet-cell-text');
    expect(cellByText('2').className).toContain('sheet-cell-number');
    expect(cellByText('2').className).toContain('sheet-style-input');
    expect(cellByText('check later').className).toContain('sheet-style-note');
    expect(cellByText('Total').className).toContain('sheet-style-total');
    expect(cellByText('#DIV/0!').className).toContain('sheet-cell-error');
  });

  it('keeps the header row in the sticky top block when freezeHeader is set', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    const top = container.querySelector('.sheet-top') as HTMLElement;
    expect(top.textContent).toContain('Item');
    expect(container.querySelector('.sheet-window')?.textContent).not.toContain('Item');
  });

  it('leaves the header in the scrolling body when freezeHeader is off', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet({ freezeHeader: false })]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect((container.querySelector('.sheet-top') as HTMLElement).textContent).not.toContain('Item');
    expect(container.querySelector('.sheet-window')?.textContent).toContain('Item');
  });

  it('shows the cell reference and formula in the formula bar when a cell is clicked', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(container.querySelector('.sheet-ref')?.textContent).toBe('');
    fireEvent.mouseDown(cellByText('$700.00'));
    expect(container.querySelector('.sheet-ref')?.textContent).toBe('C2');
    expect(screen.getByTestId('sheet-formula').textContent).toBe('=B2*350');
    // A plain value shows its display text.
    fireEvent.mouseDown(cellByText('Display'));
    expect(container.querySelector('.sheet-ref')?.textContent).toBe('A2');
    expect(screen.getByTestId('sheet-formula').textContent).toBe('Display');
    expect(cellByText('Display').getAttribute('aria-selected')).toBe('true');
  });

  it('moves the selection with the arrow keys and stays inside the sheet', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    const grid = await screen.findByRole('grid');
    const ref = () => container.querySelector('.sheet-ref')?.textContent;
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // first key selects A1
    expect(ref()).toBe('A1');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(ref()).toBe('B2');
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(ref()).toBe('B1');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(ref()).toBe('A1');
    fireEvent.keyDown(grid, { key: 'End' });
    expect(ref()).toBe('C1');
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(ref()).toBe('C5');
    expect(screen.getByTestId('sheet-formula').textContent).toBe('=SUM(C2:C4)');
  });

  it('copies the selected cell display text with Ctrl+C', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    render(<SpreadsheetRenderer artifact={art()} />);
    const grid = await screen.findByRole('grid');
    fireEvent.mouseDown(cellByText('$700.00'));
    fireEvent.keyDown(grid, { key: 'c', ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith('$700.00');
  });

  it('switches sheets from the tabs and resets the selection', async () => {
    const assumptions = budgetSheet({
      name: 'Assumptions',
      freezeHeader: false,
      colCount: 2,
      columnWidths: [],
      rowCount: 1,
      rows: [[text('Tax rate'), num('8.5%', { style: 'input' })]],
    });
    mockView.mockResolvedValue(viewOf([budgetSheet(), assumptions]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((el) => el.textContent)).toEqual(['Budget', 'Assumptions']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(cellByText('$700.00'));
    expect(container.querySelector('.sheet-ref')?.textContent).toBe('C2');

    fireEvent.click(tabs[1]);
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(cellByText('Tax rate')).toBeTruthy();
    expect(container.querySelector('.sheet-ref')?.textContent).toBe('');
    expect(screen.getByTestId('sheet-formula').textContent).toBe('');
  });

  it('notes truncated rows', async () => {
    const big = budgetSheet({ rowCount: 6000, truncatedRows: 995 });
    big.rows = Array.from({ length: 5005 }, (_, i) => [text(`r${i}`)]);
    mockView.mockResolvedValue(viewOf([big]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(screen.getByRole('status').textContent).toContain('5,005');
    expect(screen.getByRole('status').textContent).toContain('6,000');
  });

  it('shows no truncation note when every row was sent', async () => {
    mockView.mockResolvedValue(viewOf([budgetSheet()]));
    render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('summarises formula errors', async () => {
    mockView.mockResolvedValue(
      viewOf([budgetSheet()], [{ sheet: 'Budget', cell: 'B4', formula: '=A1/0', error: '#DIV/0!' }]),
    );
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(container.querySelector('.sheet-note-error')?.textContent).toBe('1 formula error');
  });

  it('renders only the rows in view for a long sheet', async () => {
    const long = budgetSheet({ freezeHeader: false, rowCount: 5000, truncatedRows: 0 });
    long.rows = Array.from({ length: 5000 }, (_, i) => [text(`row ${i + 1}`), num(String(i))]);
    mockView.mockResolvedValue(viewOf([long]));
    const { container } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(screen.getAllByRole('rowheader').length).toBeLessThan(80);
    expect(cellByText('row 1')).toBeTruthy();
    expect((container.querySelector('.sheet-body') as HTMLElement).style.height).toBe(`${5000 * 24}px`);

    const scroller = container.querySelector('.sheet-scroll') as HTMLElement;
    scroller.scrollTop = 24 * 3000;
    fireEvent.scroll(scroller);
    expect(cellByText('row 3001')).toBeTruthy();
    expect(cells().some((el) => el.textContent === 'row 1')).toBe(false);
    expect(screen.getAllByRole('rowheader').length).toBeLessThan(80);
  });

  it('reloads when the artifact version changes and keeps the grid meanwhile', async () => {
    mockView.mockResolvedValueOnce(viewOf([budgetSheet()]));
    const { rerender } = render(<SpreadsheetRenderer artifact={art()} />);
    await screen.findByRole('grid');
    expect(mockView).toHaveBeenCalledTimes(1);

    const next = budgetSheet();
    next.rows = [...next.rows, [text('Added row')]];
    mockView.mockResolvedValueOnce(viewOf([next]));
    rerender(<SpreadsheetRenderer artifact={art({ updatedAt: '2026-11-02T00:01:00Z', contentHash: 'h2' })} />);
    expect(screen.getByRole('grid')).toBeTruthy();
    await waitFor(() => expect(cellByText('Added row')).toBeTruthy());
    expect(mockView).toHaveBeenCalledTimes(2);
  });

  it('says so when the workbook has no sheets or a sheet is empty', async () => {
    mockView.mockResolvedValueOnce(viewOf([]));
    const first = render(<SpreadsheetRenderer artifact={art()} />);
    expect(await screen.findByText('This spreadsheet has no sheets yet.')).toBeTruthy();
    first.unmount();

    mockView.mockResolvedValueOnce(viewOf([budgetSheet({ rows: [], rowCount: 0, colCount: 0 })]));
    render(<SpreadsheetRenderer artifact={art({ id: 'sheet-2' })} />);
    expect(await screen.findByText('This sheet is empty.')).toBeTruthy();
  });
});
