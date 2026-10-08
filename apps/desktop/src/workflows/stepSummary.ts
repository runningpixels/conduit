/// The one-line summary a data step shows on its collapsed run row, read from
/// what it recorded: a file read gives its name and size, a table its row
/// count and columns. Steps that recorded neither get nothing.

import type { Translate } from '../i18n';
import type { WorkflowRunStep } from '../ipc/contracts';

/// Columns named on the row before "…".
const MAX_COLUMNS = 4;

/// Longest first line a connector step shows on its run row.
const MAX_SUMMARY = 80;

/// Sources a research step rated low credibility ("weak" on the run row).
function weakSources(sources: unknown[]): number {
  return sources.filter(
    (s) => s && typeof s === 'object' && (s as Record<string, unknown>).credibility === 'low',
  ).length;
}

/// A finished research step's report: "Report · 9 sources · 1 weak".
export function researchStepSummary(step: Pick<WorkflowRunStep, 'output'>, t: Translate): string | null {
  const o = step.output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.reportArtifactId !== 'string' || !Array.isArray(o.sources)) return null;
  const weak = weakSources(o.sources);
  return t(weak > 0 ? 'workspace.workflows.runDetail.researchWeak' : 'workspace.workflows.runDetail.research', {
    count: o.sources.length,
    weak,
  });
}

/// A documents search's result: "6 passages from 2 documents".
export function documentsStepSummary(step: Pick<WorkflowRunStep, 'output'>, t: Translate): string | null {
  const o = step.output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.passages) || typeof o.count !== 'number') return null;
  const names = new Set<string>();
  for (const p of o.passages) {
    const doc = p && typeof p === 'object' ? (p as Record<string, unknown>).document : null;
    if (typeof doc === 'string') names.add(doc);
  }
  return t('workspace.workflows.runDetail.passages', { count: o.count, documents: names.size });
}

/// The report a research step saved, so the run row can open it the way a
/// save step's document opens (`conversationId` is the workflow's conversation,
/// recorded beside `reportArtifactId`).
export function researchReport(
  step: Pick<WorkflowRunStep, 'output'>,
): { artifactId: string; conversationId: string } | null {
  const o = step.output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.reportArtifactId !== 'string') return null;
  return typeof o.conversationId === 'string' ? { artifactId: o.reportArtifactId, conversationId: o.conversationId } : null;
}

/// A connector step's result: the first line of its text, or "N items" when it returned a list.
export function connectorStepSummary(step: Pick<WorkflowRunStep, 'output'>, t: Translate): string | null {
  const o = step.output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.tool !== 'string' || !('isError' in o)) return null;
  if (Array.isArray(o.data)) return t('workspace.workflows.runDetail.connectorItems', { count: o.data.length });
  if (typeof o.text !== 'string') return null;
  const first = o.text.split('\n').find((line) => line.trim() !== '')?.trim();
  if (!first) return null;
  return first.length > MAX_SUMMARY ? `${first.slice(0, MAX_SUMMARY - 1)}…` : first;
}

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
