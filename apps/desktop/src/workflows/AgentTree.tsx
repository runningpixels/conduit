/// The agents of a workflow run as a tree: each step's agent and the helpers it
/// handed work to (and they to others), from `list_agent_calls`. A node says who
/// it is, the model, how it is going, how long, tokens and cost; a running helper
/// can be stopped or redirected.

import { useMemo, type ReactNode } from 'react';
import { HelperControls } from '../agents/HelperControls';
import { useNodeCosts, type NodeUsage } from '../agents/helperCost';
import { ProviderBadge, splitModel } from '../agents/ProviderBadge';
import { useNow } from '../agents/useNow';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { AgentCallRow } from '../ipc/contracts';

const STATUS_KEYS = {
  running: 'chat.handoff.status.running',
  done: 'chat.handoff.status.done',
  failed: 'chat.handoff.status.failed',
  stopped: 'chat.handoff.status.stopped',
} as const;

interface TreeNode {
  row: AgentCallRow;
  children: TreeNode[];
}

/// Rows nested by `parentId`, oldest first. A row whose parent is not among them is a root.
export function buildAgentTree(rows: readonly AgentCallRow[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(rows.map((row) => [row.id, { row, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.row.parentId ? nodes.get(node.row.parentId) : undefined;
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  const byStart = (a: TreeNode, b: TreeNode) => a.row.startedAt.localeCompare(b.row.startedAt);
  const sort = (list: TreeNode[]) => {
    list.sort(byStart);
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/// The rows of one step: those the step's `stepId` names. Repeats of a looping step are told
/// apart by when they started.
export function rowsOfStep(
  rows: readonly AgentCallRow[],
  step: { stepId: string; iteration: number | null; startedAt: string; finishedAt: string | null },
): AgentCallRow[] {
  return rows.filter((r) => {
    if (r.stepId !== step.stepId) return false;
    if (step.iteration == null) return true;
    return r.startedAt >= step.startedAt && (step.finishedAt == null || r.startedAt <= step.finishedAt);
  });
}

/// What the rows used, for totals by model.
export function usageOfRows(rows: readonly AgentCallRow[]): NodeUsage[] {
  return rows.map(usageOfRow);
}

function usageOfRow(row: AgentCallRow): NodeUsage {
  return {
    model: row.model ?? '',
    tokens: row.tokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
  };
}

export function AgentTree({ rows }: { rows: readonly AgentCallRow[] }) {
  const t = useT();
  const fmt = useFormatters();
  const tree = useMemo(() => buildAgentTree(rows), [rows]);
  const anyRunning = rows.some((r) => r.status === 'running');
  const now = useNow(anyRunning);
  const usage = useMemo(() => usageOfRows(rows), [rows]);
  const { costOf } = useNodeCosts(usage);

  const render = (node: TreeNode): ReactNode => {
    const { row } = node;
    const running = row.status === 'running';
    const started = Date.parse(row.startedAt);
    const ended = row.finishedAt ? Date.parse(row.finishedAt) : running ? now : started;
    const elapsed =
      Number.isFinite(started) && Number.isFinite(ended) ? fmt.duration(Math.max(0, ended - started)) : '';
    const cents = costOf(usageOfRow(row));
    const { modelId } = splitModel(row.model);
    return (
      <li key={row.id} className="agent-tree-node" data-kind={row.kind} data-status={row.status}>
        <div className="agent-tree-line">
          <span className="agent-tree-name">{row.name || row.agentId}</span>
          <ProviderBadge model={row.model} />
          {modelId ? <span className="agent-tree-model">{modelId}</span> : null}
          <span className="agent-tree-status" data-status={row.status}>{t(STATUS_KEYS[row.status])}</span>
          <span className="agent-tree-nums">
            {[
              elapsed,
              row.tokens > 0 ? t('chat.handoff.tokens', { count: fmt.count(row.tokens) }) : '',
              cents !== null ? fmt.money(cents) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        {row.task ? (
          <p className="agent-tree-task" title={row.task}>
            {row.task}
          </p>
        ) : null}
        {row.error ? <p className="wf-error">{row.error}</p> : null}
        {running && row.kind === 'helper' ? <HelperControls callId={row.id} name={row.name || row.agentId} /> : null}
        {node.children.length > 0 ? <ul className="agent-tree-children">{node.children.map(render)}</ul> : null}
      </li>
    );
  };

  if (tree.length === 0) return null;
  return (
    <section className="agent-tree" aria-label={t('workspace.workflows.runDetail.agentTree')}>
      <ul>{tree.map(render)}</ul>
    </section>
  );
}
