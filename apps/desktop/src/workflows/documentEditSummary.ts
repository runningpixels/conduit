/// What an "Update a deck / draft" step shows on its collapsed run row, read
/// from its recorded output: how much it changed, a note that the deck's
/// layout is still to be checked, and which document "Open" goes to.

import type { Translate } from '../i18n';
import type { WorkflowRunStep } from '../ipc/contracts';

export interface DocumentEditSummary {
  /** "Changed 2 slides", "Changed 1 section" or "No changes". */
  text: string;
  /** "Layout is checked when you next open the deck." for a deck that changed. */
  note: string | null;
  /** The document the step changed, when its id was recorded. */
  target: { kind: 'deck' | 'draft'; id: string } | null;
  /** The history entry that holds the document as it was before the step ran ("Undo this update"). */
  beforeSnapshotId: string | null;
}

export function documentEditSummary(step: Pick<WorkflowRunStep, 'output'>, t: Translate): DocumentEditSummary | null {
  const out = step.output;
  if (!out || typeof out !== 'object') return null;
  const o = out as Record<string, unknown>;
  const deckId = typeof o.deckId === 'string' && o.deckId ? o.deckId : null;
  const draftId = typeof o.draftId === 'string' && o.draftId ? o.draftId : null;
  if (!Array.isArray(o.changed) || (!deckId && !draftId)) return null;
  const isDeck = deckId !== null;
  // A draft counts the sections that changed; older runs only recorded blocks.
  const count = !isDeck && Array.isArray(o.changedSections) ? o.changedSections.length : o.changed.length;
  const text =
    count === 0
      ? t('workspace.workflows.runDetail.noChanges')
      : t(isDeck ? 'workspace.workflows.runDetail.changedSlides' : 'workspace.workflows.runDetail.changedSections', { count });
  const note = isDeck && count > 0 && o.layoutChecked === false ? t('workspace.workflows.runDetail.layoutLater') : null;
  const beforeSnapshotId = typeof o.beforeSnapshotId === 'string' && o.beforeSnapshotId ? o.beforeSnapshotId : null;
  return { text, note, target: { kind: isDeck ? 'deck' : 'draft', id: (deckId ?? draftId) as string }, beforeSnapshotId };
}
