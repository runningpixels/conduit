/// Whether a run ended because a condition step said "nothing new".
///
/// Kept in one place: the backend decides how a run records this, so reading
/// it should be a one-line change here. Today a run counts when its `outcome`
/// is `nothing_new`; a run detail also counts when one of its condition steps
/// recorded `passed: false`.

import type { WorkflowRun, WorkflowRunDetail, WorkflowRunStep } from '../ipc/contracts';

/// The condition step that stopped the run, if the steps show one.
function stoppingCondition(steps: readonly WorkflowRunStep[]): string | null {
  for (const step of steps) {
    const out = step.output;
    if (step.status === 'completed' && out && typeof out === 'object' && (out as Record<string, unknown>).passed === false) {
      return step.stepId;
    }
  }
  return null;
}

/// A run list entry: only the run itself is known.
export function isNothingNew(run: WorkflowRun): boolean {
  return run.status === 'completed' && run.outcome === 'nothing_new';
}

/// A run detail: `{ stepId }` (the step may be unknown) when nothing new, else `null`.
export function nothingNewStop(detail: WorkflowRunDetail): { stepId: string | null } | null {
  const fromSteps = stoppingCondition(detail.steps);
  if (!isNothingNew(detail.run) && !(detail.run.status === 'completed' && fromSteps)) return null;
  return { stepId: detail.run.outcomeStep ?? fromSteps };
}
