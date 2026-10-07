/// "Needs you": one quiet strip, a line per kind of thing waiting on the
/// reader. Rendered only when something is.

import { useId } from 'react';
import { useT } from '../i18n';
import type { HomeAction } from './areaInfo';

/// A workflow run waiting on the reader: what to call it, and where to find it.
export interface WaitingRun {
  name: string;
  workflowId: string;
  runId: string;
}

/// Where "Answer"/"Review" should land on the Workflows page.
export interface WorkflowTarget {
  workflowId: string;
  runId: string;
}

export interface NeedsYouState {
  /// One per pending review.
  reviews: WaitingRun[];
  /// One per pending question.
  questions: WaitingRun[];
  /// Memory suggestions waiting to be accepted.
  memory: number;
}

export const NO_NEEDS: NeedsYouState = { reviews: [], questions: [], memory: 0 };

export function hasNeeds(n: NeedsYouState): boolean {
  return n.reviews.length > 0 || n.questions.length > 0 || n.memory > 0;
}

function targetOf(run: WaitingRun): WorkflowTarget {
  return { workflowId: run.workflowId, runId: run.runId };
}

export function NeedsYou({ needs, onAction }: { needs: NeedsYouState; onAction: (action: HomeAction, target?: WorkflowTarget) => void }) {
  const t = useT();
  const labelId = useId();
  const lines: Array<{ id: string; text: string; button: string; action: HomeAction; target?: WorkflowTarget }> = [];
  if (needs.reviews.length === 1) {
    lines.push({
      id: 'reviews',
      text: t('home.needs.review.one', { name: needs.reviews[0].name }),
      button: t('home.needs.review.button'),
      action: 'open-reviews',
      target: targetOf(needs.reviews[0]),
    });
  } else if (needs.reviews.length > 1) {
    lines.push({
      id: 'reviews',
      text: t('home.needs.review.many', { count: needs.reviews.length }),
      button: t('home.needs.review.button'),
      action: 'open-reviews',
      target: targetOf(needs.reviews[0]),
    });
  }
  if (needs.questions.length === 1) {
    lines.push({
      id: 'questions',
      text: t('home.needs.question.one', { name: needs.questions[0].name }),
      button: t('home.needs.question.button'),
      action: 'open-reviews',
      target: targetOf(needs.questions[0]),
    });
  } else if (needs.questions.length > 1) {
    lines.push({
      id: 'questions',
      text: t('home.needs.question.many', { count: needs.questions.length }),
      button: t('home.needs.question.button'),
      action: 'open-reviews',
      target: targetOf(needs.questions[0]),
    });
  }
  if (needs.memory > 0) {
    lines.push({
      id: 'memory',
      text: t('home.needs.memory', { count: needs.memory }),
      button: t('home.needs.memory.button'),
      action: 'review-memory',
    });
  }
  if (lines.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby={labelId}>
      <h3 id={labelId} className="home-section-title">
        {t('home.needs.title')}
      </h3>
      <ul className="home-needs">
        {lines.map((line) => (
          <li key={line.id} className="home-needs-row">
            <span className="home-needs-dot" aria-hidden="true" />
            <span className="home-needs-text">{line.text}</span>
            <button type="button" className="btn home-needs-button" onClick={() => (line.target ? onAction(line.action, line.target) : onAction(line.action))}>
              {line.button}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
