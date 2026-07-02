import { useState } from 'react';
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
 *  `consentCopy`/`expectedEffect`/`dataSummary` are untrusted display data. */
export function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [resolving, setResolving] = useState(false);

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

  const isRunning = statusLabel === 'running';
  const toolIcon = toolCall.name.toLowerCase().startsWith('slack') ? <SlackIcon /> : <GithubIcon />;
  const displayName = splitToolDisplayName(toolCall.name);
  const isDocumentTool = DOCUMENT_TOOL_NAMES.has(toolCall.name);
  const docSummary = isDocumentTool ? summarizeDocumentToolCall(toolCall) : undefined;

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

  return (
    <div className="tool">
      <div className="tool-head">
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
      </div>
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
    </div>
  );
}