import { useEffect, useState } from 'react';
import type { ToolCallState } from './streamState';
import { approveConnectorToolCall, denyConnectorToolCall } from '../ipc/client';
import { splitToolDisplayName } from './connectorTools';
import {
  DOCUMENT_TOOL_NAMES,
  explainToolError,
  redactDocumentToolArguments,
  summarizeDocumentToolCall,
} from './agentTools';
import { GithubIcon, SlackIcon } from '../icons';

interface ToolCallBlockProps {
  toolCall: ToolCallState;
  /** P3.3 — group label + sub-calls (consecutive same-name calls). */
  group?: { name: string; calls: ToolCallState[] };
  /** P3.4 — collapse completed calls by default; running calls auto-expand. */
  defaultCollapsed?: boolean;
}

function formatDuration(startedAt?: number, endedAt?: number, running = false): string {
  if (running) return '…';
  if (startedAt == null || endedAt == null) return '';
  const ms = Math.max(0, endedAt - startedAt);
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function callLabel(toolCall: ToolCallState): string {
  const args = toolCall.arguments ?? {};
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  if (typeof args.filename === 'string') return args.filename;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.query === 'string') return args.query;
  if (typeof args.title === 'string') return args.title;
  return toolCall.toolCallId.slice(0, 8);
}

function callTone(toolCall: ToolCallState): 'ok' | 'fail' | 'run' {
  if (toolCall.status === 'failed' || toolCall.status === 'cancelled') return 'fail';
  if (toolCall.complete) return 'ok';
  return 'run';
}

/** kv rows for the tool's arguments — mono, flat, one level of disclosure. */
function kvRows(rows: [string, string][]): React.ReactNode {
  return rows.map(([k, v]) => (
    <dl className="kv" key={k}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </dl>
  ));
}

/** V7 tool call (§8.4): ONE collapsed line, ONE level of expansion.
 *  The head answers "did it do the right thing?" (name · summary · duration);
 *  expanding shows everything in a flat list — queries, a `<dl class="kv">` of
 *  arguments, and a `.tool-out` result block. No second-level disclosures. */
export function ToolCallBlock({
  toolCall,
  group,
  defaultCollapsed = true,
}: ToolCallBlockProps) {
  const [resolving, setResolving] = useState(false);
  // Running calls (or a pending consent gate) start expanded; completed calls
  // start collapsed per `defaultCollapsed`.
  const isRunning = toolCall.status === 'running' || (!toolCall.complete && !toolCall.consent);
  const hasConsentGate = toolCall.sideEffecting && toolCall.consent === 'pending';
  const [open, setOpen] = useState(isRunning || hasConsentGate ? true : !defaultCollapsed);

  useEffect(() => {
    if (isRunning || hasConsentGate) setOpen(true);
  }, [isRunning, hasConsentGate]);

  const status = toolCall.status;
  const consent = toolCall.consent;

  const toolIcon = toolCall.name.toLowerCase().startsWith('slack') ? <SlackIcon /> : <GithubIcon />;
  const displayName = splitToolDisplayName(toolCall.name);
  const isDocumentTool = DOCUMENT_TOOL_NAMES.has(toolCall.name);
  const docSummary = isDocumentTool ? summarizeDocumentToolCall(toolCall) : undefined;

  const activeCalls = group?.calls ?? [toolCall];
  const anyRunning = activeCalls.some((c) => callTone(c) === 'run');
  const anyFailed = activeCalls.some((c) => callTone(c) === 'fail');
  const running = anyRunning;
  const statusSuffix = anyFailed
    ? 'failed'
    : anyRunning
      ? 'running…'
      : '';

  const totalMs = activeCalls.reduce((acc, c) => {
    if (c.startedAt == null || c.endedAt == null) return acc;
    return acc + Math.max(0, c.endedAt - c.startedAt);
  }, 0);
  const totalDur =
    totalMs > 0
      ? totalMs < 1000
        ? `${Math.round(totalMs)}ms`
        : `${(totalMs / 1000).toFixed(1)}s`
      : activeCalls.some((c) => c.startedAt != null && c.endedAt == null)
        ? '…'
        : '';

  async function resolve(decision: 'approved' | 'denied') {
    setResolving(true);
    try {
      if (decision === 'approved') {
        await approveConnectorToolCall(toolCall.toolCallId);
      } else {
        await denyConnectorToolCall(toolCall.toolCallId);
      }
    } finally {
      setResolving(false);
    }
  }

  const prompt = toolCall.consentPrompt;
  const showConsentGate = toolCall.sideEffecting && consent === 'pending';

  let name: string;
  let summary: string | undefined;
  let body: React.ReactNode;
  let resultText: React.ReactNode;

  if (group) {
    name = splitToolDisplayName(group.name).tool || group.name;
    summary = `${group.calls.length} call${group.calls.length > 1 ? 's' : ''}`;
    body = (
      <div className="tool-sub">
        {group.calls.map((c) => (
          <div className="tool-sub-row" key={c.toolCallId}>
            <span className={`t-sub-ok${callTone(c) === 'fail' ? ' fail' : ''}`}>
              {callTone(c) === 'ok' ? '✓' : callTone(c) === 'fail' ? '✕' : '…'}
            </span>
            <span className="t-sub-label">{callLabel(c)}</span>
            <span className="t-sub-dur">{formatDuration(c.startedAt, c.endedAt, callTone(c) === 'run')}</span>
          </div>
        ))}
      </div>
    );
  } else if (isDocumentTool && docSummary) {
    name = 'Documents';
    summary = `${docSummary.action} · ${docSummary.filename || docSummary.title || docSummary.kind}`;
    const rows: [string, string][] = [];
    if (docSummary.title) rows.push(['title', docSummary.title]);
    if (docSummary.filename) rows.push(['file', docSummary.filename]);
    if (docSummary.lineCount != null) rows.push(['lines', String(docSummary.lineCount)]);
    if (toolCall.arguments && typeof toolCall.arguments.artifact_id === 'string') {
      rows.push(['artifact', toolCall.arguments.artifact_id]);
    }
    const redacted = redactDocumentToolArguments(toolCall.arguments ?? {}, toolCall.name);
    const json = JSON.stringify(redacted, null, 2);
    const docFallback = 'The document was not created or updated.';
    const docExplained = explainToolError(toolCall.error, docFallback);
    resultText =
      status === 'failed' ? (
        <>
          <b>Couldn&rsquo;t {docSummary.action.toLowerCase()} the document.</b> {docExplained}
          {toolCall.error && toolCall.error !== docExplained && (
            <div className="tool-raw">{toolCall.error}</div>
          )}
        </>
      ) : status === 'cancelled' ? (
        <b>Document tool cancelled.</b>
      ) : (
        <b>Document updated.</b>
      );
    body = (
      <>
        {kvRows(rows)}
        {toolCall.complete && (
          <div className={`tool-out${status === 'failed' ? ' tool-out-prose' : ''}`}>{resultText}</div>
        )}
        {!toolCall.complete && json && json !== '{}' && (
          <div className="tool-out">{json}</div>
        )}
      </>
    );
  } else {
    name = `${displayName.connector}${displayName.tool ? ` · ${displayName.tool}` : ''}`;
    const rows: [string, string][] = Object.entries(toolCall.arguments ?? {})
      .slice(0, 6)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
    summary = rows.length > 0 ? rows[0][1] : undefined;
    body = (
      <>
        {kvRows(rows)}
        {toolCall.complete && consent !== 'denied' && (
          <div className={`tool-out${status === 'failed' ? ' tool-out-prose' : ''}`}>
            {status === 'failed' ? (
              <>
                <b>Tool call failed.</b>{' '}
                {explainToolError(toolCall.error, 'The tool returned no result.')}
              </>
            ) : status === 'cancelled' ? (
              <b>Tool call cancelled.</b>
            ) : (
              <>
                <b>Tool call complete.</b> {toolCall.error ? toolCall.error : 'Result stored locally.'}
              </>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={`tool${running ? ' running' : ''}`}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-icon">{toolIcon}</span>
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-sum">{summary}</span>}
        {statusSuffix && <span className={`tool-status${anyFailed ? ' err' : ''}`}>{statusSuffix}</span>}
        {totalDur && <span className="tool-time">{totalDur}</span>}
        <svg className="tool-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <div className="tool-body">
        <div>
          <div className="tool-inner">
            {body}
            {showConsentGate && (
              <div className="consent">
                <p>
                  <b>{prompt?.connectorName ?? 'A connector'}</b> wants to run <b>{prompt?.toolName ?? toolCall.name}</b>.
                  {' '}
                  {prompt?.expectedEffect ?? 'This writes to an external service.'}
                </p>
                {prompt?.dataSummary && (
                  <p className="data-summary">
                    <small>Data being sent: {prompt.dataSummary}</small>
                  </p>
                )}
                {prompt?.consentCopy && (
                  <p className="consent-copy">
                    <small>{prompt.consentCopy}</small>
                  </p>
                )}
                <p>
                  Conduit never runs a side-effecting tool without your approval. Tool output is
                  sandboxed and never re-injected into the prompt.
                </p>
                <div className="row">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolve('approved')}
                  >
                    Approve and run
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolve('denied')}
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
            {toolCall.sideEffecting && consent === 'denied' && (
              <div className="tool-out">
                <b>Denied.</b> The tool call was not executed.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
