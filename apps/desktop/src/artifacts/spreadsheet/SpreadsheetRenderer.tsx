/// Preview renderer for `spreadsheet` artifacts. Read-only: Rust loads the
/// workbook spec, computes every formula and returns a view (`get_spreadsheet_view`,
/// `types.ts`); this draws it as a grid with sticky column letters and row
/// numbers, a formula bar, and sheet tabs along the bottom.
///
/// Rows are windowed (`useRowWindow`): a sheet sends up to 5,000 rows, and only
/// the ones in view are in the DOM. Cells are selected by click or arrow keys;
/// Ctrl/Cmd+C copies the selected cell's display text.
///
/// The view reloads when the artifact's version changes (`updatedAt`, hash or
/// size), so a tool call that edits the workbook updates an open panel.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import type { Artifact } from '../../ipc/contracts';
import { getSpreadsheetView } from '../../ipc/client';
import { useT } from '../../i18n';
import { cellRefLabel, columnLabel } from './cellRef';
import { useRowWindow } from './useRowWindow';
import type { CellStyle, SpreadsheetCellView, SpreadsheetSheetView, SpreadsheetView } from './types';

export interface SpreadsheetRendererProps {
  artifact: Artifact;
}

/** Pixel metrics. `ROW_HEIGHT` is also the `--sheet-row-h` the stylesheet uses. */
export const SHEET_ROW_HEIGHT = 24;
const GUTTER_WIDTH = 48;
const CHAR_WIDTH = 7.5;
const CELL_PADDING = 12;
const DEFAULT_COLUMN_CHARS = 10;
const MAX_COLUMN_PX = 640;
const PAGE_ROWS = 10;

/** A column's width in px, from the spec's width in characters. */
export function columnPixelWidth(chars: number | undefined): number {
  const n = chars !== undefined && Number.isFinite(chars) && chars > 0 ? chars : DEFAULT_COLUMN_CHARS;
  return Math.min(MAX_COLUMN_PX, Math.round(n * CHAR_WIDTH) + CELL_PADDING);
}

interface Selection {
  row: number;
  col: number;
}

const KIND_CLASS: Record<SpreadsheetCellView['kind'], string> = {
  number: 'sheet-cell-number',
  text: 'sheet-cell-text',
  bool: 'sheet-cell-bool',
  error: 'sheet-cell-error',
};

const STYLE_CLASS: Record<CellStyle, string> = {
  header: 'sheet-style-header',
  input: 'sheet-style-input',
  total: 'sheet-style-total',
  note: 'sheet-style-note',
  good: 'sheet-style-good',
  bad: 'sheet-style-bad',
};

/// Extra px a text cell may draw into: the run of empty cells to its right, as
/// in Excel. Zero when the text fits or the next cell has content.
export function spillWidth(
  cells: readonly (SpreadsheetCellView | null)[],
  widths: readonly number[],
  col: number,
): number {
  const text = cells[col]?.display ?? '';
  const need = text.length * CHAR_WIDTH + CELL_PADDING;
  let room = widths[col] ?? 0;
  let extra = 0;
  for (let c = col + 1; c < widths.length && room < need; c += 1) {
    if ((cells[c]?.display ?? '') !== '') break;
    room += widths[c];
    extra += widths[c];
  }
  return extra;
}

function cellClass(cell: SpreadsheetCellView | null, selected: boolean): string {
  const parts = ['sheet-cell'];
  if (cell) {
    parts.push(KIND_CLASS[cell.kind] ?? KIND_CLASS.text);
    if (cell.style && STYLE_CLASS[cell.style]) parts.push(STYLE_CLASS[cell.style]);
  }
  if (selected) parts.push('is-selected');
  return parts.join(' ');
}

export function SpreadsheetRenderer({ artifact }: SpreadsheetRendererProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<{ id: string; view: SpreadsheetView } | null>(null);
  const [failed, setFailed] = useState<{ id: string; detail: string } | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Load, and load again when the artifact's version changes. The previous
  // view stays on screen meanwhile, so an edit does not flash a skeleton.
  useEffect(() => {
    let cancelled = false;
    getSpreadsheetView(artifact.id)
      .then((next) => {
        if (cancelled) return;
        setFailed(null);
        setLoaded({ id: artifact.id, view: next });
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed({ id: artifact.id, detail: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.updatedAt, artifact.contentHash, artifact.sizeBytes]);

  const view = loaded && loaded.id === artifact.id ? loaded.view : null;
  const error = failed && failed.id === artifact.id ? failed.detail : null;

  if (error && !view) {
    return (
      <div className="sheet-state sheet-state-error" role="alert">
        {t('artifacts.spreadsheet.loadFailed', { detail: error })}
      </div>
    );
  }
  if (!view) {
    return <div className="artifact-skeleton" role="status" aria-label={t('common.status.loading')} />;
  }
  if (view.sheets.length === 0) {
    return <div className="sheet-state">{t('artifacts.spreadsheet.noSheets')}</div>;
  }

  const index = Math.max(0, view.sheets.findIndex((sheet) => sheet.name === sheetName));
  return (
    <SpreadsheetBook
      view={view}
      sheet={view.sheets[index]}
      sheetIndex={index}
      selection={selection}
      onSelect={setSelection}
      onSelectSheet={(name) => {
        setSheetName(name);
        setSelection(null);
      }}
    />
  );
}

interface SpreadsheetBookProps {
  view: SpreadsheetView;
  sheet: SpreadsheetSheetView;
  sheetIndex: number;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onSelectSheet: (name: string) => void;
}

function SpreadsheetBook({ view, sheet, sheetIndex, selection, onSelect, onSelectSheet }: SpreadsheetBookProps) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const frozen = sheet.freezeHeader && sheet.rows.length > 0;
  const bodyStart = frozen ? 1 : 0;
  const bodyCount = Math.max(0, sheet.rows.length - bodyStart);
  const windowed = useRowWindow(bodyCount, SHEET_ROW_HEIGHT);
  const { reset: resetWindow, scrollRef: windowScrollRef } = windowed;

  const colCount = Math.max(sheet.colCount, 0);
  const widths = useMemo(
    () => Array.from({ length: colCount }, (_, c) => columnPixelWidth(sheet.columnWidths[c])),
    [colCount, sheet.columnWidths],
  );
  const gridWidth = GUTTER_WIDTH + widths.reduce((sum, w) => sum + w, 0);

  // A different sheet starts at the top.
  useEffect(() => {
    resetWindow();
    if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
  }, [sheetIndex, resetWindow]);

  const setScroller = useCallback(
    (element: HTMLDivElement | null) => {
      scrollerRef.current = element;
      windowScrollRef(element);
    },
    [windowScrollRef],
  );

  const maxRow = sheet.rows.length - 1;
  const maxCol = colCount - 1;
  const selected =
    selection && selection.row <= maxRow && selection.col <= maxCol && maxRow >= 0 && maxCol >= 0 ? selection : null;
  const selectedCell = selected ? (sheet.rows[selected.row]?.[selected.col] ?? null) : null;

  function scrollIntoView(next: Selection) {
    const el = scrollerRef.current;
    if (!el || el.clientHeight === 0) return;
    const topHeight = SHEET_ROW_HEIGHT + (frozen ? SHEET_ROW_HEIGHT : 0);
    if (!(frozen && next.row === 0)) {
      const b = next.row - bodyStart;
      const rowTop = b * SHEET_ROW_HEIGHT;
      const room = el.clientHeight - topHeight;
      if (rowTop < el.scrollTop) el.scrollTop = rowTop;
      else if (rowTop + SHEET_ROW_HEIGHT > el.scrollTop + room) el.scrollTop = rowTop + SHEET_ROW_HEIGHT - room;
    }
    const left = widths.slice(0, next.col).reduce((sum, w) => sum + w, 0);
    const width = widths[next.col] ?? 0;
    const roomX = el.clientWidth - GUTTER_WIDTH;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (left + width > el.scrollLeft + roomX) el.scrollLeft = left + width - roomX;
  }

  function move(next: Selection) {
    const clamped = {
      row: Math.min(Math.max(next.row, 0), maxRow),
      col: Math.min(Math.max(next.col, 0), maxCol),
    };
    onSelect(clamped);
    scrollIntoView(clamped);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (maxRow < 0 || maxCol < 0) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (selectedCell) {
        event.preventDefault();
        void navigator.clipboard?.writeText(selectedCell.display)?.catch(() => undefined);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const from = selected ?? { row: 0, col: 0 };
    let next: Selection | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = selected ? { row: from.row + 1, col: from.col } : from;
        break;
      case 'ArrowUp':
        next = selected ? { row: from.row - 1, col: from.col } : from;
        break;
      case 'ArrowRight':
        next = selected ? { row: from.row, col: from.col + 1 } : from;
        break;
      case 'ArrowLeft':
        next = selected ? { row: from.row, col: from.col - 1 } : from;
        break;
      case 'Home':
        next = { row: from.row, col: 0 };
        break;
      case 'End':
        next = { row: from.row, col: maxCol };
        break;
      case 'PageDown':
        next = { row: from.row + PAGE_ROWS, col: from.col };
        break;
      case 'PageUp':
        next = { row: from.row - PAGE_ROWS, col: from.col };
        break;
      default:
        return;
    }
    event.preventDefault();
    move(next);
  }

  function renderRow(r: number) {
    const cells = sheet.rows[r] ?? [];
    return (
      <div className="sheet-row" role="row" key={r} aria-rowindex={r + 2}>
        <div className="sheet-gutter sheet-rowhead" role="rowheader">
          {r + 1}
        </div>
        {widths.map((width, c) => {
          const cell = cells[c] ?? null;
          const isSelected = selected?.row === r && selected.col === c;
          const spill = cell?.kind === 'text' ? spillWidth(cells, widths, c) : 0;
          return (
            <div
              key={c}
              role="gridcell"
              aria-selected={isSelected}
              aria-colindex={c + 2}
              className={cellClass(cell, isSelected) + (spill > 0 ? ' sheet-cell-spill' : '')}
              style={{ width, minWidth: width }}
              onMouseDown={() => {
                onSelect({ row: r, col: c });
                scrollerRef.current?.focus({ preventScroll: true });
              }}
            >
              {spill > 0 ? (
                <span className="sheet-spill" title={cell?.display} style={{ width: width + spill - CELL_PADDING }}>
                  {cell?.display}
                </span>
              ) : (
                (cell?.display ?? '')
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const bodyRows: ReactElement[] = [];
  for (let b = windowed.start; b < windowed.end; b += 1) bodyRows.push(renderRow(b + bodyStart));

  const formulaText = selectedCell ? (selectedCell.formula ?? selectedCell.display) : '';
  const errorCount = view.errors.length;
  const viewStyle = { '--sheet-row-h': `${SHEET_ROW_HEIGHT}px`, '--sheet-gutter-w': `${GUTTER_WIDTH}px` } as CSSProperties;

  return (
    <div className="sheet-view" style={viewStyle}>
      <div className="sheet-formula-bar" aria-label={t('artifacts.spreadsheet.formulaBarLabel')}>
        <span className="sheet-ref">{selected ? cellRefLabel(selected.row, selected.col) : ''}</span>
        <span className="sheet-formula" data-testid="sheet-formula">
          {formulaText}
        </span>
      </div>
      {sheet.rows.length === 0 ? (
        <div className="sheet-state">{t('artifacts.spreadsheet.emptySheet')}</div>
      ) : (
        <div
          className="sheet-scroll"
          ref={setScroller}
          onScroll={windowed.onScroll}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="grid"
          aria-label={t('artifacts.spreadsheet.gridLabel')}
          aria-rowcount={sheet.rowCount + 1}
          aria-colcount={colCount + 1}
        >
          <div className="sheet-canvas" style={{ width: gridWidth }}>
            <div className="sheet-top">
              <div className="sheet-row sheet-colheads" role="row" aria-rowindex={1}>
                <div className="sheet-gutter sheet-corner" role="columnheader" />
                {widths.map((width, c) => (
                  <div className="sheet-colhead" role="columnheader" key={c} style={{ width, minWidth: width }}>
                    {columnLabel(c)}
                  </div>
                ))}
              </div>
              {frozen && renderRow(0)}
            </div>
            <div className="sheet-body" style={{ height: bodyCount * SHEET_ROW_HEIGHT }}>
              <div className="sheet-window" style={{ transform: `translateY(${windowed.start * SHEET_ROW_HEIGHT}px)` }}>
                {bodyRows}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="sheet-foot">
        <div className="sheet-tabs" role="tablist" aria-label={t('artifacts.spreadsheet.tabsLabel')}>
          {view.sheets.map((tab, i) => (
            <button
              key={tab.name}
              type="button"
              role="tab"
              className={i === sheetIndex ? 'sheet-tab active' : 'sheet-tab'}
              aria-selected={i === sheetIndex}
              onClick={() => onSelectSheet(tab.name)}
            >
              {tab.name}
            </button>
          ))}
        </div>
        <div className="sheet-notes">
          {sheet.truncatedRows > 0 && (
            <span className="sheet-note" role="status">
              {t('artifacts.spreadsheet.truncated', { shown: sheet.rows.length, total: sheet.rowCount })}
            </span>
          )}
          {errorCount > 0 && (
            <span className="sheet-note sheet-note-error">{t('artifacts.spreadsheet.formulaErrors', { count: errorCount })}</span>
          )}
        </div>
      </div>
    </div>
  );
}
