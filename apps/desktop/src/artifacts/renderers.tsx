/// Pure artifact renderers (M6): PlainText, Code, JSON, Markdown. Each takes
/// primitive content props (no IPC, no context) and renders escaped output —
/// no `dangerouslySetInnerHTML`. They slot into the DocumentPanel Preview/Source
/// panes via `selectRenderer.ts`. The sandboxed HTML/JS renderer lives in
/// `HtmlArtifactRenderer.tsx`.

import { Fragment, type ReactNode } from 'react';
import { renderMarkdown } from './markdown/safeMarkdown';

export interface PlainTextRendererProps {
  text: string;
}

/// Plain text in a `<pre>` (whitespace preserved). React escapes text children
/// by construction — no injected markup possible.
export function PlainTextRenderer({ text }: PlainTextRendererProps) {
  return <pre className="artifact-plain">{text}</pre>;
}

export interface MarkdownRendererProps {
  source: string;
}

/// Markdown → safe-subset React nodes (see `markdown/safeMarkdown.ts`).
export function MarkdownRenderer({ source }: MarkdownRendererProps) {
  return <div className="artifact-markdown">{renderMarkdown(source)}</div>;
}

export interface CodeRendererProps {
  code: string;
  language?: string;
}

/// Monospace code block with a line-number gutter + a language chip from the
/// fence info string. No token highlighting this phase (deferred per the plan).
export function CodeRenderer({ code, language }: CodeRendererProps) {
  const lines = code.length === 0 ? [''] : code.split('\n');
  return (
    <div className="artifact-code">
      <div className="artifact-code-head">
        {language ? <span className="lang-chip">{language}</span> : <span className="lang-chip muted">text</span>}
      </div>
      <pre className="artifact-code-body">
        <code>
          {lines.map((line, idx) => (
            <Fragment key={idx}>
              <span className="line-no" aria-hidden="true">{String(idx + 1).padStart(3, ' ')}</span>
              <span className="line-text">{line || ' '}</span>
              {idx < lines.length - 1 ? '\n' : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

export interface JsonRendererProps {
  data: unknown;
}

/// Recursive JSON tree with `<details>` summaries + type-tinted value spans.
/// Falls back to a pretty-printed `<pre>` for primitives or malformed input.
export function JsonRenderer({ data }: JsonRendererProps) {
  return <div className="artifact-json">{renderJson(data, '$')}</div>;
}

function renderJson(value: unknown, key: string): ReactNode {
  if (value === null) return <div key={key} className="json-line"><span className="json-null">null</span></div>;
  const t = typeof value;
  if (t === 'boolean') return <div key={key} className="json-line"><span className="json-bool">{String(value)}</span></div>;
  if (t === 'number') return <div key={key} className="json-line"><span className="json-num">{String(value)}</span></div>;
  if (t === 'string') return <div key={key} className="json-line"><span className="json-str">{JSON.stringify(value)}</span></div>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <div key={key} className="json-line">[ ]</div>;
    return (
      <details key={key} open className="json-node">
        <summary className="json-summary">Array({value.length})</summary>
        <div className="json-children">
          {value.map((v, i) => (
            <div key={`el-${i}`} className="json-entry">
              <span className="json-index">{i}</span>
              {renderJson(v, `el-${i}-v`)}
            </div>
          ))}
        </div>
      </details>
    );
  }
  if (t === 'object' && value) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <div key={key} className="json-line">{ '{ }' }</div>;
    return (
      <details key={key} open className="json-node">
        <summary className="json-summary">Object({entries.length})</summary>
        <div className="json-children">
          {entries.map(([k, v]) => (
            <div key={`k-${k}`} className="json-entry">
              <span className="json-key">{JSON.stringify(k)}</span>
              <span className="json-colon">: </span>
              {renderJson(v, `k-${k}-v`)}
            </div>
          ))}
        </div>
      </details>
    );
  }
  // Fallback for anything unexpected (undefined, bigint, symbol, functions).
  return <div key={key} className="json-line"><pre>{JSON.stringify(value, null, 2) ?? 'undefined'}</pre></div>;
}