/// A simple line diff for showing a file change: which lines were kept, taken
/// out and put in. Long stretches of unchanged lines fold into one "skipped" row.

export type DiffRow =
  | { kind: 'same' | 'add' | 'del'; text: string }
  | { kind: 'skip'; count: number };

/// Unchanged lines kept on each side of a change.
const CONTEXT = 2;
/// Above this many line pairs the exact diff is skipped: everything old is out and everything new is in.
const MAX_CELLS = 4_000_000;

function lines(text: string): string[] {
  if (text === '') return [];
  const list = text.replace(/\r\n/g, '\n').split('\n');
  if (list[list.length - 1] === '') list.pop();
  return list;
}

/// The rows turning `previous` into `next`.
export function lineDiff(previous: string, next: string): DiffRow[] {
  const a = lines(previous);
  const b = lines(next);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows: DiffRow[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));

  if (midA.length * midB.length > MAX_CELLS) {
    rows.push(...midA.map((text): DiffRow => ({ kind: 'del', text })), ...midB.map((text): DiffRow => ({ kind: 'add', text })));
  } else {
    // Longest common subsequence of the middle.
    const w = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * w + j] =
          midA[i] === midB[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        rows.push({ kind: 'same', text: midA[i] });
        i += 1;
        j += 1;
      } else if (j < midB.length && (i === midA.length || table[i * w + j + 1] >= table[(i + 1) * w + j])) {
        rows.push({ kind: 'add', text: midB[j] });
        j += 1;
      } else {
        rows.push({ kind: 'del', text: midA[i] });
        i += 1;
      }
    }
  }
  rows.push(...a.slice(endA).map((text): DiffRow => ({ kind: 'same', text })));
  return fold(rows);
}

/// Replaces long runs of unchanged lines with a count, keeping a little around each change.
function fold(rows: DiffRow[]): DiffRow[] {
  const keep = rows.map(() => false);
  let any = false;
  rows.forEach((row, i) => {
    if (row.kind === 'same') return;
    any = true;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k += 1) keep[k] = true;
  });
  if (!any) return rows;
  const out: DiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ kind: 'skip', count: skipped });
  return out;
}
