import { useEffect, useState } from 'react';
import type { PermissionLevel } from '@conduit/config-schema';
import type { ToolCallState } from './streamState';
import { approveConnectorToolCall, denyConnectorToolCall } from '../ipc/client';
import { splitToolDisplayName } from './connectorTools';
import {
  DOCUMENT_TOOL_NAMES,
  explainToolError,
  redactDocumentToolArguments,
  summarizeDocumentToolCall,
} from './agentTools';
import { ConnectorsIcon, FilePlainIcon, GithubIcon, SlackIcon } from '../icons';
import { useRichT, useT } from '../i18n';
import { documentKindLabel } from '../lib/documentKind';
import type { Translate } from '../i18n';

interface ToolCallBlockProps {
  toolCall: ToolCallState;
  /** P3.3 — group label + sub-calls (consecutive same-name calls). */
  group?: { name: string; calls: ToolCallState[] };
  /** P3.4 — collapse completed calls by default; running calls auto-expand. */
  defaultCollapsed?: boolean;
  /** Active conversation — used when remembering an approval for this chat. */
  conversationId?: string | null;
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

/** Catalog key for each `PermissionLevel`'s consent-prompt description. */
const PERMISSION_LEVEL_KEYS: Record<PermissionLevel, string> = {
  readOnly: 'consent.permission.readOnly',
  sideEffectful: 'consent.permission.sideEffectful',
  sensitive: 'consent.permission.sensitive',
};

/** Compose the consent prompt's expected-effect sentence from the facts Rust
 *  now sends — the permission level and the tool's own description — instead
 *  of the English sentence Rust used to compose (D9/D10 item 2). Mirrors the
 *  former `mcp_runtime::consent::expected_effect`: the level's sentence,
 *  followed by the description on its own line when non-empty. */
function expectedEffectText(t: Translate, level: PermissionLevel, description: string): string {
  const kind = t(PERMISSION_LEVEL_KEYS[level]);
  return description.trim().length === 0 ? kind : `${kind}\n${description}`;
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
  conversationId = null,
}: ToolCallBlockProps) {
  const t = useT();
  const tr = useRichT();
  const [resolving, setResolving] = useState(false);
  const [rememberScope, setRememberScope] = useState<'none' | 'conversation' | 'always'>('none');
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

  const displayName = splitToolDisplayName(toolCall.name);
  const isDocumentTool = DOCUMENT_TOOL_NAMES.has(toolCall.name);
  // A connector logo is a claim about where the tool came from. Defaulting to
  // GitHub gave the octocat to `uuid`, `calculator`, the clipboard tools and
  // every Documents card — none of which touch GitHub.
  const toolIcon = (() => {
    const lower = toolCall.name.toLowerCase();
    if (lower.startsWith('slack')) return <SlackIcon />;
    if (lower.startsWith('github')) return <GithubIcon />;
    if (isDocumentTool) return <FilePlainIcon />;
    return <ConnectorsIcon />;
  })();
  const docSummary = isDocumentTool ? summarizeDocumentToolCall(toolCall) : undefined;

  const activeCalls = group?.calls ?? [toolCall];
  const anyRunning = activeCalls.some((c) => callTone(c) === 'run');
  const anyFailed = activeCalls.some((c) => callTone(c) === 'fail');
  const running = anyRunning;
  const statusSuffix = anyFailed
    ? t('chat.toolCall.status.failed')
    : anyRunning
      ? t('chat.toolCall.status.running')
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
        await approveConnectorToolCall(toolCall.toolCallId, {
          remember: rememberScope === 'none' ? undefined : rememberScope,
          conversationId: conversationId ?? undefined,
        });
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
    summary = t('chat.toolCall.callCount', { count: group.calls.length });
    body = (
      <div className="tool-sub">
        {group.calls.map((c) => (
          <div className="tool-sub-row" key={c.toolCallId}>
            <span className={`t-sub-ok${callTone(c) === 'fail' ? ' fail' : ''}`}>
              {callTone(c) === 'ok' ? '✓' : callTone(c) === 'fail' ? '✕' : '…'}
            </span>
            <span className="t-sub-label" title={callLabel(c)}>{callLabel(c)}</span>
            <span className="t-sub-dur">{formatDuration(c.startedAt, c.endedAt, callTone(c) === 'run')}</span>
          </div>
        ))}
      </div>
    );
  } else if (isDocumentTool && docSummary) {
    name = t('chat.toolCall.documentsName');
    summary = `${t('chat.toolCall.document.action', { action: docSummary.action })} · ${
      docSummary.filename || docSummary.title || documentKindLabel(docSummary.kind, t)
    }`;
    const rows: [string, string][] = [];
    if (docSummary.title) rows.push(['title', docSummary.title]);
    if (docSummary.filename) rows.push(['file', docSummary.filename]);
    if (docSummary.lineCount != null) rows.push(['lines', String(docSummary.lineCount)]);
    if (toolCall.arguments && typeof toolCall.arguments.artifact_id === 'string') {
      rows.push(['artifact', toolCall.arguments.artifact_id]);
    }
    const redacted = redactDocumentToolArguments(toolCall.arguments ?? {}, toolCall.name);
    const json = JSON.stringify(redacted, null, 2);
    const docFallback = t('chat.toolCall.document.fallbackError');
    const docExplained = explainToolError(toolCall.error, docFallback, t);
    resultText =
      status === 'failed' ? (
        <>
          {tr('chat.toolCall.document.failed', {
            action: docSummary.action,
            explained: docExplained,
          })}
          {toolCall.error && toolCall.error !== docExplained && (
            <div className="tool-raw">{toolCall.error}</div>
          )}
        </>
      ) : status === 'cancelled' ? (
        <b>{t('chat.toolCall.document.cancelled')}</b>
      ) : (
        <b>{t('chat.toolCall.document.updated')}</b>
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
    // `splitToolDisplayName` returns {connector: name, tool: name} for a bare
    // name — no `__` or `.` — so a built-in like `uuid` read "uuid · uuid".
    // The grouped branch above already avoids this, which meant one call and two
    // consecutive calls of the same tool were labelled differently.
    name =
      displayName.tool && displayName.tool !== displayName.connector
        ? `${displayName.connector} · ${displayName.tool}`
        : displayName.connector;
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
              tr('chat.toolCall.generic.failed', {
                explained: explainToolError(toolCall.error, t('chat.toolCall.generic.fallbackError'), t),
              })
            ) : status === 'cancelled' ? (
              <b>{t('chat.toolCall.generic.cancelled')}</b>
            ) : (
              tr('chat.toolCall.generic.complete', {
                detail: toolCall.error ? toolCall.error : t('chat.toolCall.generic.resultStored'),
              })
            )}
          </div>
        )}
      </>
    );
  }

  // The one summary string the collapsed line carries. Detail, status and
  // duration are joined rather than boxed separately (V9 §2.5); each part is
  // still omitted when it has nothing to say, so a finished tool with no detail
  // shows only its duration and a running one only "running…".
  const toolSummary = [summary, statusSuffix, totalDur].filter(Boolean).join(' · ');

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
        {/* V9 §2.5: one summary string rather than a chip each for the detail,
            the status and the duration. The facts are unchanged — "2 queries ·
            5 sources · 1.4s" is what the mockup shows — but they stop being
            three separately-boxed things reporting on one line. */}
        {toolSummary && (
          <span className={`tool-sum${anyFailed ? ' err' : ''}`} title={toolSummary}>
            {toolSummary}
          </span>
        )}
        <svg className="tool-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <div className="tool-body">
        <div>
          <div className="tool-inner">
            {body}
            {showConsentGate && (
              <div className="consent">
                <p>
                  {tr('chat.toolCall.consent.prompt', {
                    connectorName: prompt?.connectorName ?? t('chat.toolCall.consent.defaultConnectorName'),
                    toolName: prompt?.toolName ?? toolCall.name,
                    expectedEffect: prompt
                      ? expectedEffectText(t, prompt.permissionLevel, prompt.toolDescription)
                      : t('chat.toolCall.consent.defaultExpectedEffect'),
                  })}
                </p>
                {prompt?.dataSummary && (
                  <p className="data-summary">
                    <small>{t('chat.toolCall.consent.dataSummary', { dataSummary: prompt.dataSummary })}</small>
                  </p>
                )}
                {prompt?.consentCopy && (
                  <p className="consent-copy">
                    <small>{prompt.consentCopy}</small>
                  </p>
                )}
                <p>{t('chat.toolCall.consent.safetyNote')}</p>
                <div className="consent-remember">
                  <label>
                    <input
                      type="checkbox"
                      checked={rememberScope === 'conversation'}
                      disabled={resolving || !conversationId}
                      onChange={(e) =>
                        setRememberScope(e.target.checked ? 'conversation' : 'none')
                      }
                    />
                    {t('chat.toolCall.consent.rememberChat')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={rememberScope === 'always'}
                      disabled={resolving}
                      onChange={(e) => setRememberScope(e.target.checked ? 'always' : 'none')}
                    />
                    {t('chat.toolCall.consent.rememberAlways')}
                  </label>
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolve('approved')}
                  >
                    {t('chat.toolCall.consent.approveButton')}
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolve('denied')}
                  >
                    {t('chat.toolCall.consent.denyButton')}
                  </button>
                </div>
              </div>
            )}
            {toolCall.sideEffecting && consent === 'denied' && (
              <div className="tool-out">
                {tr('chat.toolCall.deniedNotice')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
