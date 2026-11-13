/// A chat's browser asks on the tool row (Browser B3): the approval card for a
/// click, typing or choice (the workflow card's content and buttons, shared),
/// and the question for a human check or a sign-in (Continue, or the decline
/// choice as a quiet button). Answering sends the answer to the running turn;
/// the turn's `browserPromptResolved` event takes the card away.

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { answerBrowserAction, answerBrowserQuestion } from '../ipc/client';
import type { BrowserRemember, BrowserRequest } from '../ipc/contracts';
import {
  BrowserActionButtons,
  BrowserActionDetails,
  browserRequestCareful,
  browserSoFarText,
} from '../workflows/BrowserActionContent';
import { rejectionText } from '../workflows/CommandRuleList';
import '../styles/computer-card.css';

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function BrowserApprovalGate({ toolCallId, request }: { toolCallId: string; request: BrowserRequest }) {
  const t = useT();
  const headingId = useId();
  const alive = useAlive();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const careful = browserRequestCareful(request);

  async function answer(send: boolean, remember?: BrowserRemember) {
    setSending(true);
    setFailed(null);
    try {
      await answerBrowserAction(toolCallId, send, send ? remember : undefined);
    } catch (e) {
      if (alive.current) setFailed(t('workspace.workflows.action.failed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  const sofar = browserSoFarText(request, t);
  return (
    <div
      className={`consent browser-consent${careful ? ' cc-risky' : ''}`}
      role="group"
      aria-labelledby={headingId}
    >
      <BrowserActionDetails request={request} headingId={headingId} t={t} inChat />
      <BrowserActionButtons
        request={request}
        sending={sending}
        onAnswer={(send, remember) => void answer(send, remember)}
        t={t}
        className="row"
      />
      {sofar ? <p className="wf-muted cc-sofar">{t('chat.browser.soFar', { items: sofar })}</p> : null}
      {failed ? (
        <p className="wf-error" role="alert">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

/// The declining choices the backend sends (in English), by translation key.
const DECLINE_KEYS: Record<string, string> = {
  'Skip this page': 'chat.browser.decline.skipPage',
  "Don't sign in": 'chat.browser.decline.dontSignIn',
};

/// The questions the backend sends a code for; anything else shows its English.
const QUESTION_KEYS = new Set([
  'chat.browser.question.humanCheck',
  'chat.browser.question.signIn',
  'chat.browser.question.signInWhy',
]);

export function BrowserQuestionGate({
  toolCallId,
  question,
  decline,
  code,
  params,
}: {
  toolCallId: string;
  question: string;
  decline: string;
  code?: string;
  params?: Record<string, string>;
}) {
  const t = useT();
  const headingId = useId();
  const alive = useAlive();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function answer(goOn: boolean) {
    setSending(true);
    setFailed(null);
    try {
      await answerBrowserQuestion(toolCallId, goOn);
    } catch (e) {
      if (alive.current) setFailed(t('workspace.workflows.action.failed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  return (
    <div className="consent browser-question" role="group" aria-labelledby={headingId}>
      <p id={headingId} className="approval-sentence">
        {code && QUESTION_KEYS.has(code) ? t(code, params ?? {}) : question}
      </p>
      <div className="row">
        <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(true)}>
          {t('common.actions.continue')}
        </button>
        <button type="button" className="btn ghost" disabled={sending} onClick={() => void answer(false)}>
          {DECLINE_KEYS[decline] ? t(DECLINE_KEYS[decline]) : decline}
        </button>
      </div>
      {failed ? (
        <p className="wf-error" role="alert">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
