/// The approval card for a click, typing or choice an agent wants to make in
/// its browser (Browser B2). It leads with what the agent says it is for, then
/// the action in plain words, the full text it would type, the page it is on,
/// and one chip saying why it asks. A form submit or a money-and-accounts word
/// makes "Don’t" the main button; "Always on <site>" is offered only for the
/// first action on a site (`request.offerSite`).

import { useEffect, useId, useRef, useState } from 'react';
import { useT, type Translate } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { answerWorkflowAction } from '../ipc/client';
import type { BrowserRequest, WorkflowAction } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { formatNextRun } from './ScheduleSection';
import '../styles/computer-card.css';

/// Most earlier actions shown in "So far in this run".
const SO_FAR_MAX = 4;

/// The run-details label for each action ("Clicked"), shared with the chat's tool rows.
const DONE_LABEL: Record<string, string> = {
  click: 'chat.toolCall.browser.clicked',
  type_text: 'chat.toolCall.browser.typed',
  choose_option: 'chat.toolCall.browser.chose',
  scroll: 'chat.toolCall.browser.scrolled',
  go_back: 'chat.toolCall.browser.wentBack',
  ask_to_sign_in: 'chat.toolCall.browser.askedSignIn',
  open_page: 'chat.toolCall.browser.opened',
  read_page: 'chat.toolCall.browser.read',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/// What the action does, in plain words ("Click “Place order” (button)").
export function browserActionText(request: BrowserRequest, t: Translate): string {
  const name = text(request.elementName);
  const role = text(request.elementRole);
  switch (request.action) {
    case 'click':
      if (name && role) return t('workspace.workflows.browser.do.click', { name, role });
      if (name) return t('workspace.workflows.browser.do.clickName', { name });
      return t('workspace.workflows.browser.do.clickPlain');
    case 'type_text':
      if (name && role) return t('workspace.workflows.browser.do.type', { name, role });
      if (name) return t('workspace.workflows.browser.do.typeName', { name });
      return t('workspace.workflows.browser.do.typePlain');
    case 'choose_option':
      return name
        ? t('workspace.workflows.browser.do.choose', { option: request.option ?? '', name })
        : t('workspace.workflows.browser.do.choosePlain', { option: request.option ?? '' });
    case 'scroll':
      return t('workspace.workflows.browser.do.scroll');
    case 'go_back':
      return t('workspace.workflows.browser.do.goBack');
    default:
      return request.action;
  }
}

/// Why it asks, as the chip says it.
function reasonText(request: BrowserRequest, t: Translate): string {
  switch (request.reason) {
    case 'submit':
      return t('workspace.workflows.browser.reason.submit');
    case 'risky':
      return request.riskyWord
        ? t('workspace.workflows.browser.reason.risky', { word: request.riskyWord })
        : t('workspace.workflows.browser.reason.riskyPlain');
    case 'newSite':
      return t('workspace.workflows.browser.reason.newSite', { host: request.host });
    default:
      return '';
  }
}

/// One earlier action of this step, from whatever shape the backend sent ("Clicked “Search”").
function soFarItem(entry: unknown, t: Translate): string | null {
  if (typeof entry === 'string') return text(entry) ?? null;
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const action = text(e.action) ?? text(e.tool);
  const label = action && Object.prototype.hasOwnProperty.call(DONE_LABEL, action) ? t(DONE_LABEL[action]) : action;
  const what = text(e.elementName) ?? text(e.element) ?? text(e.name) ?? text(e.option) ?? text(e.url) ?? text(e.host);
  const parts = [label, what ? `“${what}”` : undefined].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' ') : null;
}

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
  // A submit or a money-and-accounts word: lead with Don't.
  const careful = request.reason === 'submit' || request.reason === 'risky';
  const offerSite = text(request.offerSite);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function answer(send: boolean, remember = false) {
    setSending(true);
    setRefused(null);
    try {
      const taken = await answerWorkflowAction(action.runId, action.stepId, {
        send,
        ...(send && remember && offerSite ? { remember: true } : {}),
      });
      onAnswered(action, taken);
    } catch (e) {
      if (alive.current) setRefused(t('workspace.workflows.action.failed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  const title = text(request.pageTitle);
  const sofar = (request.soFar ?? [])
    .map((entry) => soFarItem(entry, t))
    .filter((s): s is string => s !== null)
    .slice(-SO_FAR_MAX)
    .join(' · ');
  const doIt = t('workspace.workflows.browser.doIt');
  const dont = t('workspace.workflows.browser.dont');

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
      <b id={headingId} className="cc-headline">
        {text(request.why) ?? t('workspace.workflows.browser.title')}
      </b>
      <p className="approval-sentence">{browserActionText(request, t)}</p>
      {request.action === 'type_text' && request.text !== undefined ? (
        <pre className="cc-term" aria-label={t('workspace.workflows.browser.textLabel')}>
          {request.text}
        </pre>
      ) : null}
      <p className="wf-muted" title={request.pageUrl}>
        {title
          ? t('workspace.workflows.browser.page', { title, host: request.host })
          : t('workspace.workflows.browser.pageHost', { host: request.host })}
      </p>

      <p className={`cc-chip${careful ? ' warn' : ''}`} role="note">
        {reasonText(request, t)}
      </p>
      {text(request.readBefore) ? (
        <p className="wf-muted">{t('workspace.workflows.browser.readBefore', { what: text(request.readBefore) ?? '' })}</p>
      ) : null}

      <p className="wf-muted">
        {t('workspace.workflows.browser.deadline', { when: formatNextRun(action.expiresAt, fmt.locale) })}
      </p>

      <div className="wf-offer-actions">
        {careful ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(false)}>
              {dont}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => void answer(true)}>
              {doIt}
            </button>
            {offerSite ? (
              <button type="button" className="btn" disabled={sending} onClick={() => void answer(true, true)}>
                {t('workspace.workflows.browser.always', { site: offerSite })}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(true)}>
              {doIt}
            </button>
            {offerSite ? (
              <button type="button" className="btn" disabled={sending} onClick={() => void answer(true, true)}>
                {t('workspace.workflows.browser.always', { site: offerSite })}
              </button>
            ) : null}
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void answer(false)}>
              {dont}
            </button>
          </>
        )}
      </div>
      {sofar ? <p className="wf-muted cc-sofar">{t('workspace.workflows.computer.soFar', { items: sofar })}</p> : null}
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}
