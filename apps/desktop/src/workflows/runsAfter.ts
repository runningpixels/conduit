/// "Runs after: …" in words, for the list views: which steps a top-level step
/// waits for when that is not simply the step before it.

import type { Translate } from '../i18n';
import type { WorkflowStep } from '../ipc/contracts';
import { STEP_TYPE_KEY } from './stepTypes';
import { dependencies, parseEntry } from './stepGraph';

/** A step as the list names it: "2. Fetch pages". */
export function stepName(steps: readonly WorkflowStep[], id: string, t: Translate): string {
  const index = steps.findIndex((s) => s.id === id);
  return index < 0 ? id : t('workspace.workflows.editor.cardTitle', { n: index + 1, type: t(STEP_TYPE_KEY[steps[index].type]) });
}

/** One `after` entry in words: the step, or "<step>: if yes" / "if no". */
export function entryName(steps: readonly WorkflowStep[], entry: string, t: Translate): string {
  const { id, arm } = parseEntry(entry);
  const name = stepName(steps, id, t);
  return arm ? t(arm === 'yes' ? 'workspace.workflows.editor.runsAfter.yes' : 'workspace.workflows.editor.runsAfter.no', { step: name }) : name;
}

/**
 * The muted line under a top-level step that does not just follow the step
 * before it ("Runs after: 1. Fetch pages, 2. Summarize", "If yes: 3. If…
 * otherwise"), or `null` when it does.
 */
export function runsAfterLine(steps: readonly WorkflowStep[], index: number, t: Translate): string | null {
  const step = steps[index];
  if (!step || step.after === undefined) return null;
  const entries = dependencies(steps).get(step.id) ?? [];
  const previous = index > 0 ? [steps[index - 1].id] : [];
  if (entries.length === previous.length && entries.every((e, i) => e === previous[i])) return null;
  if (entries.length === 0) return t('workspace.workflows.editor.runsAfter.line', { steps: t('workspace.workflows.editor.runsAfter.start') });
  if (entries.length === 1) {
    const { id, arm } = parseEntry(entries[0]);
    if (arm) return t(arm === 'yes' ? 'workspace.workflows.editor.runsAfter.lineYes' : 'workspace.workflows.editor.runsAfter.lineNo', { step: stepName(steps, id, t) });
  }
  return t('workspace.workflows.editor.runsAfter.line', { steps: entries.map((e) => entryName(steps, e, t)).join(', ') });
}
