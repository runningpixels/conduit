/// The computed view of a spreadsheet artifact, as Rust returns it from
/// `get_spreadsheet_view` (serde `camelCase`). Hand-written to match
/// spreadsheets-spec.md §5a; the workbook spec itself (the artifact's JSON
/// content) never reaches the renderer.

export type CellStyle = 'header' | 'input' | 'total' | 'note' | 'good' | 'bad';

export interface SpreadsheetCellView {
  /** Formatted as Excel would show it ("$510.00", "28.6%", "#DIV/0!"). */
  display: string;
  kind: 'number' | 'text' | 'bool' | 'error';
  /** With the leading "=", when the cell is a formula. */
  formula?: string;
  style?: CellStyle;
}

export interface SpreadsheetSheetView {
  name: string;
  freezeHeader: boolean;
  /** Characters, one per column up to `colCount` (default 10). */
  columnWidths: number[];
  /** Used rows in the sheet. */
  rowCount: number;
  /** Used columns. */
  colCount: number;
  /** Up to 5,000 rows; `null` is an empty cell. */
  rows: (SpreadsheetCellView | null)[][];
  /** Rows not sent (`rowCount - rows.length`). */
  truncatedRows: number;
}

export interface SpreadsheetFormulaError {
  sheet: string;
  cell: string;
  formula: string;
  error: string;
}

export interface SpreadsheetView {
  title: string | null;
  /** Hidden sheets are left out. */
  sheets: SpreadsheetSheetView[];
  /** The first 20. */
  errors: SpreadsheetFormulaError[];
}

/** Result of `export_spreadsheet_xlsx`: `saved` is false when the dialog was cancelled. */
export interface SpreadsheetExportResult {
  saved: boolean;
  path?: string;
}
