/// The one-line summary a data step shows on its collapsed run row, read from
/// what it recorded: a file read gives its name and size, a table its row
/// count and columns. Steps that recorded neither get nothing.

import type { Translate } from '../i18n';
import type { WorkflowRunStep } from '../ipc/contracts';

/// Columns named on the row before "…".
const MAX_COLUMNS = 4;

export function dataStepSummary(
  step: Pick<WorkflowRunStep, 'output'>,
  t: Translate,
  formatSize: (bytes: number) => string,
): string | null {
  const out = step.output;
  if (!out || typeof out !== 'object') return null;
  const o = out as Record<string, unknown>;
  if (Array.isArray(o.columns) && typeof o.count === 'number') {
    const names = o.columns.filter((c): c is string => typeof c === 'string');
    const shown = names.slice(0, MAX_COLUMNS).join(', ') + (names.length > MAX_COLUMNS ? '…' : '');
    return t('workspace.workflows.runDetail.table', { count: o.count, columns: shown });
  }
  if (typeof o.name === 'string' && typeof o.bytes === 'number' && typeof o.text === 'string') {
    return t('workspace.workflows.runDetail.file', { name: o.name, size: formatSize(o.bytes) });
  }
  return null;
}
