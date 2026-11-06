import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Artifact } from '../../ipc/contracts';
import { SpreadsheetRenderer } from './SpreadsheetRenderer';
import { clipLabel, niceScale, pieSlices, slicePath } from './chartGeometry';
import type { SpreadsheetChartView, SpreadsheetSheetView, SpreadsheetView } from './types';

vi.mock('../../ipc/client', () => ({
  getSpreadsheetView: vi.fn(),
}));

import { getSpreadsheetView } from '../../ipc/client';

const mockView = vi.mocked(getSpreadsheetView);

const artifact: Artifact = {
  id: 'sheet-1',
  conversationId: 'c1',
  kind: 'spreadsheet',
  title: 'Sales',
  createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  contentHash: 'h1',
};

function sheetWith(charts: SpreadsheetChartView[] | undefined): SpreadsheetSheetView {
  return {
    name: 'Sales',
    freezeHeader: false,
    columnWidths: [10, 10],
    rowCount: 1,
    colCount: 2,
    truncatedRows: 0,
    rows: [[{ display: 'x', kind: 'text' }, { display: '1', kind: 'number' }]],
    ...(charts ? { charts } : {}),
  };
}

function show(charts: SpreadsheetChartView[] | undefined) {
  const view: SpreadsheetView = { title: 'Sales', sheets: [sheetWith(charts)], errors: [] };
  mockView.mockResolvedValue(view);
  return render(<SpreadsheetRenderer artifact={artifact} />);
}

const bar: SpreadsheetChartView = {
  id: 'bars',
  type: 'bar',
  title: 'Units by region',
  categories: ['North', 'South', 'East'],
  series: [
    { name: 'Q1', values: [10, 20, null] },
    { name: 'Q2', values: [15, -5, 30] },
  ],
  anchor: 'E2',
};
const line: SpreadsheetChartView = {
  id: 'trend',
  type: 'line',
  title: 'Revenue',
  categories: ['Jan', 'Feb', 'Mar', 'Apr'],
  series: [{ values: [100, 150, null, 200] }],
  anchor: 'E20',
};
const pie: SpreadsheetChartView = {
  id: 'share',
  type: 'pie',
  title: 'Share',
  categories: ['A', 'B', 'C'],
  series: [{ name: 'Units', values: [50, 30, 20] }],
  anchor: 'N2',
};

describe('spreadsheet charts in the panel', () => {
  beforeEach(() => mockView.mockReset());
  afterEach(() => cleanup());

  it('draws nothing extra for a sheet without charts', async () => {
    show(undefined);
    await screen.findByRole('grid');
    expect(screen.queryByRole('group', { name: 'Charts' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws a grouped bar chart with ticks, labels, a legend and an accessible summary', async () => {
    const { container } = show([bar]);
    const svg = await screen.findByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Bar chart: Units by region. 2 series, 3 data points.');
    expect(svg.getAttribute('data-chart-type')).toBe('bar');
    // One rect per number: a gap draws none (5 of 6).
    expect(container.querySelectorAll('rect.sheet-chart-bar')).toHaveLength(5);
    expect(container.querySelectorAll('.sheet-chart-c0 rect.sheet-chart-bar')).toHaveLength(2);
    expect(container.querySelectorAll('.sheet-chart-c1 rect.sheet-chart-bar')).toHaveLength(3);
    // Title, category labels and value ticks (the axis includes the negative).
    const texts = Array.from(svg.querySelectorAll('text')).map((el) => el.textContent);
    expect(texts).toContain('Units by region');
    expect(texts).toEqual(expect.arrayContaining(['North', 'South', 'East']));
    expect(texts).toEqual(expect.arrayContaining(['0', '10', '30', '-10']));
    // Legend entries for two series.
    expect(texts).toEqual(expect.arrayContaining(['Q1', 'Q2']));
    // Series colours come from theme tokens through classes, not literals.
    expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // The negative bar hangs below the zero line.
    const rects = Array.from(container.querySelectorAll('.sheet-chart-c1 rect.sheet-chart-bar'));
    const zeroLine = Array.from(container.querySelectorAll('line.sheet-chart-axis')).find(
      (l) => l.getAttribute('y1') === l.getAttribute('y2'),
    );
    expect(Number(rects[1].getAttribute('y'))).toBeCloseTo(Number(zeroLine?.getAttribute('y1')), 1);
  });

  it('draws a line chart that breaks at a gap and has no legend for one series', async () => {
    const { container } = show([line]);
    const svg = await screen.findByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Line chart: Revenue. 1 series, 4 data points.');
    // Jan-Feb is one run; Apr alone has no line segment but keeps its dot.
    expect(container.querySelectorAll('polyline.sheet-chart-line')).toHaveLength(1);
    expect(container.querySelectorAll('circle.sheet-chart-dot')).toHaveLength(3);
    expect(container.querySelector('.sheet-chart-legend')).toBeNull();
    expect(svg.querySelectorAll('text').length).toBeGreaterThan(5);
  });

  it('draws a pie chart with one slice per positive number and a legend with percentages', async () => {
    const { container } = show([pie]);
    const svg = await screen.findByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Pie chart: Share. 1 series, 3 data points.');
    expect(container.querySelectorAll('path.sheet-chart-slice')).toHaveLength(3);
    const legend = Array.from(container.querySelectorAll('.sheet-chart-legend text')).map((el) => el.textContent);
    expect(legend).toEqual(['A 50%', 'B 30%', 'C 20%']);
    // Pies have no axes.
    expect(container.querySelector('line.sheet-chart-axis')).toBeNull();
  });

  it('says so when a chart has lost its rows or has no numbers, and keeps drawing the rest', async () => {
    show([
      { ...bar, id: 'gone', categories: [], series: [], error: 'Rows were deleted' },
      { ...line, id: 'blank', series: [{ values: [null, null, null, null] }] },
      pie,
    ]);
    await screen.findByRole('group', { name: 'Charts' });
    expect(screen.getByRole('alert').textContent).toBe('This chart can’t be drawn because the rows it used were deleted.');
    expect(screen.getByText('There are no numbers to chart yet.')).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    const group = screen.getByRole('group', { name: 'Charts' });
    expect(within(group).getAllByRole('figure')).toHaveLength(3);
  });
});

describe('chart geometry', () => {
  it('builds a round axis that includes zero', () => {
    expect(niceScale(3, 87)).toEqual({ min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] });
    expect(niceScale(-5, 30).ticks).toEqual([-10, 0, 10, 20, 30]);
    expect(niceScale(0.1, 0.7).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceScale(0, 0)).toMatchObject({ min: 0, max: 1 });
    expect(niceScale(5, 5).min).toBe(0);
  });

  it('cuts pie slices from positive numbers only', () => {
    const slices = pieSlices([50, null, -3, 25, 25]);
    expect(slices.map((s) => s.index)).toEqual([0, 3, 4]);
    expect(slices[0].fraction).toBeCloseTo(0.5);
    expect(slices[2].end).toBeCloseTo(Math.PI * 2);
    expect(pieSlices([null, 0, -1])).toEqual([]);
    const [only] = pieSlices([7]);
    expect(slicePath(10, 10, 5, only)).toContain('A 5 5 0 1 1');
    expect(slicePath(10, 10, 5, slices[0])).toMatch(/^M 10 10 L /);
  });

  it('clips long labels', () => {
    expect(clipLabel('short', 10)).toBe('short');
    expect(clipLabel('a very long label', 8)).toBe('a very …');
  });
});
