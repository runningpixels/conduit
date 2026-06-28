import type { AssistantStreamState, ToolCallState } from './streamState';
import type { SearchSource } from './streamState';

interface SearchCallBlockProps {
  toolCall: ToolCallState;
  sources: SearchSource[];
  unavailable?: AssistantStreamState['searchUnavailable'];
  cost?: number;
}

/** Renders a hosted `web_search` tool call. Reuses the tool-call envelope
 *  so users see the query as it streams and the result once it lands, but
 *  swaps the args dump for a search-specific view:
 *
 *  - Header: a magnifying-glass icon + "Searched the web" + status pill.
 *  - Body: the parsed query (and other `arguments` keys when present).
 *  - Optional sources list when the provider returned them and the user opted
 *    in via `include_sources` (currently the default is off).
 *  - Optional footnote when the endpoint refused or stripped the tool — the
 *    adapter emits `SearchUnavailable` and we surface it as a non-blocking
 *    inline note so the user understands why search did not happen.
 *
 *  Citations are NOT rendered here. They ride the message text via the
 *  ContentBlock citation rendering; per spec §10.3 they belong to the
 *  prose, not the search block.
 */
export function SearchCallBlock({ toolCall, sources, unavailable, cost }: SearchCallBlockProps) {
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query : '';
  const status = typeof args.status === 'string' ? args.status : '';

  const statusTone = toolCall.complete ? 'ran' : 'running';
  const statusLabel = toolCall.complete
    ? status === 'completed'
      ? 'ran'
      : status || 'ran'
    : 'running';

  return (
    <div className="tool">
      <div className="tool-head">
        <span className="tico" aria-hidden>⌕</span>
        <span className="tname">
          Searched the web
          {cost !== undefined && cost > 0 ? (
            <span className="search-count"> · {cost} {cost === 1 ? 'query' : 'queries'}</span>
          ) : null}
        </span>
        <span className={`pill ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="tool-detail">
        <div className="args">
          {query ? (
            <span className="search-query">{query}</span>
          ) : toolCall.argumentsText ? (
            <code>{toolCall.argumentsText}</code>
          ) : (
            <span className="muted">searching…</span>
          )}
        </div>
        {sources.length > 0 && (
          <details className="search-sources">
            <summary>{sources.length} {sources.length === 1 ? 'source' : 'sources'}</summary>
            <ol className="search-sources-list">
              {sources.map((src, i) => {
                const title = pickString(src.raw, ['title', 'name']) ?? `Source ${i + 1}`;
                const url = pickString(src.raw, ['url', 'link']) ?? '';
                return (
                  <li key={i}>
                    <span className="src-title">{title}</span>
                    {url && (
                      <>
                        {' — '}
                        <a
                          className="src-url"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {hostOf(url)}
                        </a>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </details>
        )}
        {unavailable && (
          <div className="search-unavailable" role="status">
            <b>Web search unavailable.</b> {unavailable.message}
          </div>
        )}
      </div>
    </div>
  );
}

function pickString(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

/** True when a tool call is a hosted `web_search` call. The adapter tags
 *  these with `tool_id = "web_search"` regardless of the provider. */
export function isWebSearchToolCall(toolCall: ToolCallState): boolean {
  return toolCall.toolId === 'web_search' || toolCall.name === 'web_search';
}