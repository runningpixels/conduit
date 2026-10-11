/// What a finished run produced, as the Results views show it.

import type { WorkflowRun, WorkflowRunOutput } from '../ipc/contracts';

/// The output a run is known by: the last one that is new, else the last one
/// (a run that only kept what it saved last time still has something to open).
export function primaryOutput(run: Pick<WorkflowRun, 'outputs'>): WorkflowRunOutput | null {
  const outputs = run.outputs ?? [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    if (!outputs[i].unchanged) return outputs[i];
  }
  return outputs[outputs.length - 1] ?? null;
}

/// The outputs other than the primary one, in the order they were saved.
export function otherOutputs(run: Pick<WorkflowRun, 'outputs'>): WorkflowRunOutput[] {
  const primary = primaryOutput(run);
  return (run.outputs ?? []).filter((o) => o !== primary);
}

/// A run nobody has opened: finished, with something to show or a failure, and not marked seen.
export function isUnread(run: Pick<WorkflowRun, 'seenAt'>): boolean {
  return !run.seenAt;
}

/// The key a result list uses to tell outputs apart.
export function outputKey(output: WorkflowRunOutput): string {
  return `${output.stepId}:${output.artifactId ?? output.deckId ?? output.draftId ?? output.path ?? output.title}`;
}
