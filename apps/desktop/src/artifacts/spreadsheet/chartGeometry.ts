/// Pure geometry for the spreadsheet charts (SpreadsheetChart.tsx): the axis
/// scale and the pie's slices. No DOM, so it is tested on its own.

/** Round `raw` up to 1, 2, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

export interface AxisScale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * A value axis that always includes zero (bars grow from it) and ends on tick
 * marks with round numbers. `want` is roughly how many intervals to aim for.
 */
export function niceScale(low: number, high: number, want = 5): AxisScale {
  let min = Math.min(0, low);
  let max = Math.max(0, high);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = 0;
    max = 1;
  }
  const step = niceStep((max - min) / Math.max(1, want));
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Index-based so floating-point steps (0.1) don't drift or loop.
  const count = Math.round((last - first) / step);
  for (let i = 0; i <= count; i += 1) ticks.push(Number((first + i * step).toPrecision(12)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

export interface PieSlice {
  index: number;
  value: number;
  fraction: number;
  /** Radians clockwise from twelve o'clock. */
  start: number;
  end: number;
}

/** Slices for the positive numbers in `values`; gaps, zero and negatives get none. */
export function pieSlices(values: readonly (number | null)[]): PieSlice[] {
  const usable = values.map((v) => (v !== null && Number.isFinite(v) && v > 0 ? v : 0));
  const total = usable.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return [];
  const slices: PieSlice[] = [];
  let angle = 0;
  usable.forEach((value, index) => {
    if (value <= 0) return;
    const fraction = value / total;
    slices.push({ index, value, fraction, start: angle, end: angle + fraction * Math.PI * 2 });
    angle += fraction * Math.PI * 2;
  });
  return slices;
}

/** The SVG path of a pie slice (or a full disc) centred on (cx, cy). */
export function slicePath(cx: number, cy: number, r: number, slice: Pick<PieSlice, 'start' | 'end' | 'fraction'>): string {
  const point = (angle: number) => `${(cx + r * Math.sin(angle)).toFixed(2)} ${(cy - r * Math.cos(angle)).toFixed(2)}`;
  if (slice.fraction >= 0.9999) {
    // Two half arcs: a single 360 degree arc has no direction to draw in.
    return `M ${point(0)} A ${r} ${r} 0 1 1 ${point(Math.PI)} A ${r} ${r} 0 1 1 ${point(0)} Z`;
  }
  const large = slice.end - slice.start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${point(slice.start)} A ${r} ${r} 0 ${large} 1 ${point(slice.end)} Z`;
}

/** Cut a label to `max` characters with an ellipsis. */
export function clipLabel(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}
