/// The approval card for a click, typing or choice an agent wants to make in
/// its browser (Browser B2). The content and buttons are shared with the
/// chat's inline card (`BrowserActionContent`); this adds the workflow's meta
/// line, the deadline and "So far in this run". "Allow on all sites" lets the
/// workflow act anywhere (risky words and sign-in forms still ask).

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { answerWorkflowAction } from '../ipc/client';
import type { BrowserRemember, BrowserRequest, WorkflowAction } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { formatNextRun } from './ScheduleSection';
import { ANY_SITE } from './BrowserSitesEditor';
import {
  BrowserActionButtons,
  BrowserActionDetails,
  browserRequestCareful,
  browserSoFarText,
} from './BrowserActionContent';
import '../styles/computer-card.css';

export { browserActionText } from './BrowserActionContent';

export function BrowserActionCard({
  action,
  request,
  onAnswered,
}: {
  action: WorkflowAction;
  request: BrowserRequest;
  onAnswered: (action: WorkflowAction, taken: boolean) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const headingId = useId();
  const careful = browserRequestCareful(request);
  const offerSite = request.offerSite?.trim() || undefined;
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /// `remember`: "site" adds `offerSite` to the list, "all" allows every site.
  async function answer(send: boolean, remember?: BrowserRemember) {
    setSending(true);
    setRefused(null);
    try {
      const taken = await answerWorkflowAction(action.runId, action.stepId, {
        send,
        ...(send && remember && offerSite ? { remember: true } : {}),
        ...(send && remember === 'all' && offerSite ? { rule: ANY_SITE } : {}),
      });
      onAnswered(action, taken);
    } catch (e) {
      if (alive.current) setRefused(t('workspace.workflows.action.failed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  const sofar = browserSoFarText(request, t);

  return (
    <section
      className={`wf-offer wf-review wf-action wf-computer wf-browser-action${careful ? ' cc-risky' : ''}`}
      role="group"
      aria-labelledby={headingId}
      data-run-id={action.runId}
    >
      <p className="cc-meta">
        {t('workspace.workflows.computer.meta', {
          workflow: action.workflowName,
          step: action.stepId,
          when: fmt.timeAgo(action.requestedAt),
        })}
      </p>
      <BrowserActionDetails request={request} headingId={headingId} t={t} />

      <p className="wf-muted">
        {t('workspace.workflows.browser.deadline', { when: formatNextRun(action.expiresAt, fmt.locale) })}
      </p>

      <BrowserActionButtons request={request} sending={sending} onAnswer={(send, remember) => void answer(send, remember)} t={t} />
      {sofar ? <p className="wf-muted cc-sofar">{t('workspace.workflows.computer.soFar', { items: sofar })}</p> : null}
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}
