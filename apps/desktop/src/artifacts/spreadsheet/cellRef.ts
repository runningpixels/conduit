/// A1-style labels for the grid. Indexes are 0-based; labels are what a
/// spreadsheet shows (column A, row 1).

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 701 -> "ZZ", 702 -> "AAA". */
export function columnLabel(index: number): string {
  let n = Math.max(0, Math.floor(index)) + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** (row 6, column 1) -> "B7". */
export function cellRefLabel(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}
