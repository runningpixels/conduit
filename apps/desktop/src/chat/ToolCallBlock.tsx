import { useEffect, useState } from 'react';
import type { ToolCallState } from './streamState';
import { approveConnectorToolCall, denyConnectorToolCall } from '../ipc/client';
import { splitToolDisplayName } from './connectorTools';
import {
  DOCUMENT_TOOL_NAMES,
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

/** v5 `.tool` card: head (icon + name + status pill), args, optional result,
 *  and the `.consent` approval gate for side-effecting tools.
 *
 *  Phase 4: the consent gate is driven by the real MCP runtime. When the
 *  runtime emits `ConnectorRuntimeEvent::consentRequested`, `streamState`
 *  flips the tool call to `consent: 'pending'` + a redacted `consentPrompt`.
 *  Approve/Deny here call the runtime's `approve`/`deny_connector_tool_call`
 *  IPC — the runtime then invokes the tool (or records `Cancelled`) and emits
 *  `toolCallFinished`, which resolves the gate. The prompt's
 *  `consentCopy`/`expectedEffect`/`dataSummary` are untrusted display data.
 *
 *  V6 (P3.3/3.4/3.5): completed calls collapse by default (click head to
 *  expand, animated via the `.tool-collapse` grid-rows trick), each call shows
 *  its duration, and consecutive same-name calls render as one grouped card. */
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
  const statusTone =
    status === 'completed' ? 'ran'
    : status === 'failed' || status === 'cancelled' ? 'hold'
    : consent === 'pending' ? 'hold'
    : 'ran';
  const statusLabel =
    status === 'completed' ? 'ran'
    : status === 'failed' ? 'failed'
    : status === 'cancelled' ? 'cancelled'
    : consent === 'pending' ? 'approval'
    : toolCall.complete ? 'ran'
    : 'running';

  const toolIcon = toolCall.name.toLowerCase().startsWith('slack') ? <SlackIcon /> : <GithubIcon />;
  const displayName = splitToolDisplayName(toolCall.name);
  const isDocumentTool = DOCUMENT_TOOL_NAMES.has(toolCall.name);
  const docSummary = isDocumentTool ? summarizeDocumentToolCall(toolCall) : undefined;

  const activeCalls = group?.calls ?? [toolCall];
  const anyRunning = activeCalls.some((c) => callTone(c) === 'run');
  const anyFailed = activeCalls.some((c) => callTone(c) === 'fail');
  const tone = anyFailed ? 'hold' : anyRunning ? 'running' : 'ran';
  const label = anyFailed ? 'failed' : anyRunning ? 'running' : 'ran';
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

  // Grouped card: one head + sub-rows per call.
  if (group) {
    const groupName = group.name;
    return (
      <div className={`tool${open ? ' open' : ''}${anyRunning ? ' running' : ''}`}>
        <button
          type="button"
          className="tool-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tico">{toolIcon}</span>
          <span className="tname">{displayName.connector} - <span>{displayName.tool || groupName}</span></span>
          {group.calls.length > 1 && <span className="t-count">×{group.calls.length}</span>}
          <span className={`pill ${tone}`}>
            {anyRunning && <span className="running-dot" aria-hidden="true" />}
            {label}
          </span>
          <span className="t-duration">{totalDur}</span>
          <svg className="t-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div className="tool-collapse"><div className="tool-collapse-inner">
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
        </div></div>
      </div>
    );
  }

  return (
    <div className={`tool${open ? ' open' : ''}${isRunning ? ' running' : ''}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tico">{toolIcon}</span>
        <span className="tname">
          {isDocumentTool && docSummary ? (
            <>
              Documents · <span>{docSummary.action} {docSummary.kind}</span>
            </>
          ) : (
            <>
              {displayName.connector} - <span>{displayName.tool || toolCall.toolId}</span>
            </>
          )}
        </span>
        <span className={`pill ${statusTone}`}>
          {isRunning && <span className="running-dot" aria-hidden="true" />}
          {statusLabel}
        </span>
        <span className="t-duration">{formatDuration(toolCall.startedAt, toolCall.endedAt, isRunning)}</span>
        <svg className="t-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div className="tool-collapse"><div className="tool-collapse-inner">
        <div className="tool-detail">
          {isDocumentTool && docSummary ? (
            <details className="artifact-fence-block">
              <summary>
                {docSummary.kind} document · {docSummary.filename || docSummary.title || 'untitled'} · {docSummary.lineCount} lines
              </summary>
              <div className="doc-meta">
                {docSummary.title && <div>Title: {docSummary.title}</div>}
                {docSummary.filename && <div>File: {docSummary.filename}</div>}
                {toolCall.arguments && typeof toolCall.arguments.artifact_id === 'string' && toolCall.arguments.artifact_id.trim() !== '' && (
                  <div>Artifact: {toolCall.arguments.artifact_id}</div>
                )}
              </div>
              <details className="doc-full-args">
                <summary>Show full arguments</summary>
                <pre>{JSON.stringify(redactDocumentToolArguments(toolCall.arguments ?? {}, toolCall.name), null, 2)}</pre>
              </details>
            </details>
          ) : (
            <div className="args">
              {toolCall.complete ? JSON.stringify(toolCall.arguments ?? {}, null, 2) : toolCall.argumentsText || '{}'}
            </div>
          )}
        </div>
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
          <div className="tool-result">
            <b>Denied.</b> The tool call was not executed.
          </div>
        )}
        {toolCall.complete && consent !== 'denied' && (
          <div className="tool-result">
            {isDocumentTool ? (
              status === 'failed' ? (
                <>
                  <b>Document tool failed.</b>{' '}
                  {toolCall.error ?? 'The document was not created or updated.'}
                </>
              ) : status === 'cancelled' ? (
                <b>Document tool cancelled.</b>
              ) : (
                <b>Document updated.</b>
              )
            ) : (
              <>
                <b>Tool call complete.</b> {toolCall.error ? toolCall.error : 'Result stored locally.'}
              </>
            )}
            {/* M2 seam — "Promote to artifact" on a succeeded tool call: deferred.
                The tool-result content is not present in `ToolCallState` (the
                runtime's `toolCallFinished` carries only `size_bytes`/`mime_hints`,
                and `messageToTurn` flattens message parts into a joined string,
                discarding the `tool_call_id` → result linkage). A functional
                promote needs either a `get_tool_call_result(tool_call_id)` IPC or
                threading the toolResult part content from `getConversationMessages`
                into the tool-call state — out of scope for this milestone. The
                fenced-block promote flow (AssistantMessage) is the primary path. */}
          </div>
        )}
      </div></div>
    </div>
  );
}
