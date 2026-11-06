/// A chart from a spreadsheet's computed view, drawn as hand-written SVG: bar
/// (grouped), line and pie, with a title, axis ticks and labels, and a legend
/// when there is more than one series (or a pie). Colours come from theme
/// tokens through the `sheet-chart-*` classes in spreadsheet.css, so dark and
/// light both read. The figure is one `role="img"` with a text summary.

import { useT } from '../../i18n';
import { useFormatters } from '../../i18n/formatters';
import { clipLabel, niceScale, pieSlices, slicePath } from './chartGeometry';
import type { SpreadsheetChartView } from './types';

const WIDTH = 520;
const HEIGHT = 300;
const PALETTE_SIZE = 6;
const TICK_CHAR = 6.4;
const LABEL_CHAR = 6.2;

const KIND_KEY = {
  bar: 'artifacts.spreadsheet.chartKindBar',
  line: 'artifacts.spreadsheet.chartKindLine',
  pie: 'artifacts.spreadsheet.chartKindPie',
} as const;

const COLOR_CLASSES = ['sheet-chart-c0', 'sheet-chart-c1', 'sheet-chart-c2', 'sheet-chart-c3', 'sheet-chart-c4', 'sheet-chart-c5'];

const colorClass = (i: number) => COLOR_CLASSES[i % PALETTE_SIZE];

export interface SpreadsheetChartProps {
  chart: SpreadsheetChartView;
}

export function SpreadsheetChart({ chart }: SpreadsheetChartProps) {
  const t = useT();
  const fmt = useFormatters();

  const points = chart.categories.length;
  const finite = chart.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const kindName = t(KIND_KEY[chart.type]);
  const label = t('artifacts.spreadsheet.chartLabel', {
    kind: kindName,
    title: chart.title || t('artifacts.spreadsheet.chartUntitled'),
    series: chart.series.length,
    points,
  });

  if (chart.error) {
    return (
      <figure className="sheet-chart sheet-chart-broken" data-chart-id={chart.id}>
        <figcaption className="sheet-chart-caption">{chart.title || kindName}</figcaption>
        <p role="alert" className="sheet-chart-message">
          {t('artifacts.spreadsheet.chartBroken')}
        </p>
      </figure>
    );
  }
  if (finite.length === 0) {
    return (
      <figure className="sheet-chart" data-chart-id={chart.id}>
        <figcaption className="sheet-chart-caption">{chart.title || kindName}</figcaption>
        <p className="sheet-chart-message">{t('artifacts.spreadsheet.chartNoData')}</p>
      </figure>
    );
  }

  const seriesName = (i: number) => chart.series[i]?.name || t('artifacts.spreadsheet.chartSeriesN', { n: i + 1 });
  const value = (v: number) => (Math.abs(v) >= 10000 ? fmt.compact(v) : fmt.count(v));
  const titleHeight = chart.title ? 30 : 0;

  let body;
  if (chart.type === 'pie') {
    body = renderPie(chart, titleHeight, value, fmt.count);
  } else {
    body = renderAxes(chart, titleHeight, finite, value, seriesName);
  }

  return (
    <figure className="sheet-chart" data-chart-id={chart.id}>
      <svg
        className="sheet-chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={label}
        data-chart-type={chart.type}
      >
        {chart.title && (
          <text className="sheet-chart-title" x={WIDTH / 2} y={20} textAnchor="middle">
            {chart.title}
          </text>
        )}
        {body}
      </svg>
    </figure>
  );
}

function renderAxes(
  chart: SpreadsheetChartView,
  titleHeight: number,
  finite: number[],
  value: (v: number) => string,
  seriesName: (i: number) => string,
) {
  const scale = niceScale(Math.min(...finite), Math.max(...finite));
  const tickLabels = scale.ticks.map(value);
  const left = Math.max(...tickLabels.map((l) => l.length)) * TICK_CHAR + 16;
  const legend = chart.series.length > 1;
  const top = titleHeight + 12;
  const bottom = 40 + (legend ? 24 : 0);
  const x0 = left;
  const x1 = WIDTH - 16;
  const y0 = top;
  const y1 = HEIGHT - bottom;
  const y = (v: number) => y1 - ((v - scale.min) / (scale.max - scale.min)) * (y1 - y0);
  const band = (x1 - x0) / chart.categories.length;
  const center = (i: number) => x0 + band * (i + 0.5);
  // Label every nth category when they would overlap, each cut to fit its slot.
  const longest = Math.min(10, Math.max(...chart.categories.map((c) => Array.from(c).length), 1));
  const every = Math.max(1, Math.ceil((chart.categories.length * longest * LABEL_CHAR) / (x1 - x0)));
  const maxChars = Math.min(14, Math.max(3, Math.floor((band * every) / LABEL_CHAR) - 1));
  const zero = y(0);
  const seriesCount = chart.series.length;

  return (
    <>
      {scale.ticks.map((tick, i) => (
        <g key={tick}>
          <line className={tick === 0 ? 'sheet-chart-axis' : 'sheet-chart-grid'} x1={x0} x2={x1} y1={y(tick)} y2={y(tick)} />
          <text className="sheet-chart-text" x={x0 - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      <line className="sheet-chart-axis" x1={x0} x2={x0} y1={y0} y2={y1} />
      {chart.categories.map((category, i) =>
        i % every === 0 ? (
          <text key={i} className="sheet-chart-text" x={center(i)} y={y1 + 16} textAnchor="middle">
            {clipLabel(category, maxChars)}
          </text>
        ) : null,
      )}
      {chart.type === 'bar'
        ? chart.series.map((s, si) => {
            const group = band * 0.76;
            const width = group / seriesCount;
            return (
              <g key={si} className={colorClass(si)}>
                {s.values.map((v, i) =>
                  v === null ? null : (
                    <rect
                      key={i}
                      className="sheet-chart-bar"
                      x={center(i) - group / 2 + si * width + 0.5}
                      y={Math.min(y(v), zero)}
                      width={Math.max(1, width - 1)}
                      height={Math.max(0.5, Math.abs(y(v) - zero))}
                      fill="currentColor"
                    >
                      <title>{`${chart.categories[i] ?? ''}: ${value(v)}`}</title>
                    </rect>
                  ),
                )}
              </g>
            );
          })
        : chart.series.map((s, si) => {
            // A gap breaks the line.
            const runs: string[][] = [[]];
            s.values.forEach((v, i) => {
              if (v === null) {
                if (runs[runs.length - 1].length > 0) runs.push([]);
              } else {
                runs[runs.length - 1].push(`${center(i).toFixed(2)},${y(v).toFixed(2)}`);
              }
            });
            return (
              <g key={si} className={colorClass(si)}>
                {runs
                  .filter((run) => run.length > 1)
                  .map((run, r) => (
                    <polyline key={r} className="sheet-chart-line" points={run.join(' ')} fill="none" stroke="currentColor" />
                  ))}
                {s.values.map((v, i) =>
                  v === null ? null : (
                    <circle key={i} className="sheet-chart-dot" cx={center(i)} cy={y(v)} r={3.5} fill="currentColor">
                      <title>{`${chart.categories[i] ?? ''}: ${value(v)}`}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
      {legend && (
        <g className="sheet-chart-legend">
          {legendLayout(chart.series.map((_, i) => seriesName(i)), x0).map((item) => (
            <g key={item.index} className={colorClass(item.index)} transform={`translate(${item.x} ${HEIGHT - 14})`}>
              <rect width={10} height={10} y={-9} rx={2} fill="currentColor" />
              <text className="sheet-chart-text" x={15} y={0}>
                {clipLabel(item.text, 18)}
              </text>
            </g>
          ))}
        </g>
      )}
    </>
  );
}

/** x positions for a row of legend entries that stays inside the figure. */
function legendLayout(names: string[], start: number): { index: number; x: number; text: string }[] {
  let x = start;
  return names.map((text, index) => {
    const item = { index, x, text };
    x += 15 + Math.min(Array.from(text).length, 18) * LABEL_CHAR + 18;
    return item;
  });
}

function renderPie(
  chart: SpreadsheetChartView,
  titleHeight: number,
  value: (v: number) => string,
  count: (v: number) => string,
) {
  const values = chart.series[0]?.values ?? [];
  const slices = pieSlices(values);
  const top = titleHeight + 12;
  const radius = Math.min(HEIGHT - top - 16, WIDTH * 0.5 - 24) / 2;
  const cx = 24 + radius;
  const cy = top + (HEIGHT - top - 16) / 2;
  const legendX = cx + radius + 24;
  const rowHeight = 18;
  const shown = slices.slice(0, Math.floor((HEIGHT - top - 16) / rowHeight));
  const legendTop = cy - (shown.length * rowHeight) / 2;
  const percent = (f: number) => `${count(Math.round(f * 1000) / 10)}%`;
  return (
    <>
      <g>
        {slices.map((slice) => (
          <path
            key={slice.index}
            className={`sheet-chart-slice ${colorClass(slice.index)}`}
            d={slicePath(cx, cy, radius, slice)}
            fill="currentColor"
          >
            <title>{`${chart.categories[slice.index] ?? ''}: ${value(slice.value)} (${percent(slice.fraction)})`}</title>
          </path>
        ))}
      </g>
      <g className="sheet-chart-legend">
        {shown.map((slice, row) => (
          <g key={slice.index} className={colorClass(slice.index)} transform={`translate(${legendX} ${legendTop + row * rowHeight + 12})`}>
            <rect width={10} height={10} y={-9} rx={2} fill="currentColor" />
            <text className="sheet-chart-text" x={15} y={0}>
              {`${clipLabel(chart.categories[slice.index] ?? '', 18)} ${percent(slice.fraction)}`}
            </text>
          </g>
        ))}
      </g>
    </>
  );
}
