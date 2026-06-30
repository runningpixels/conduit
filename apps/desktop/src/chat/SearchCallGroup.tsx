import { useState } from 'react';
import type { AssistantStreamState, ToolCallState } from './streamState';
import { isWebSearchToolCall } from './SearchCallBlock';
import { hostOf } from './citationUtils';
import type { SearchSource } from './streamState';

interface SearchCallGroupProps {
  toolCalls: ToolCallState[];
  unavailable?: AssistantStreamState['searchUnavailable'];
  cost?: number;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function queryText(tc: ToolCallState): string {
  const args = (tc.arguments ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query : '';
  return query || tc.argumentsText || 'searching…';
}

function totalSourceCount(searchCalls: ToolCallState[]): number {
  return searchCalls.reduce((acc, tc) => acc + (tc.sources?.length ?? 0), 0);
}

function renderSources(sources: SearchSource[]) {
  if (sources.length === 0) return null;
  return (
    <details className="search-sources">
      <summary>
        {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </summary>
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
                  <a className="src-url" href={url} target="_blank" rel="noopener noreferrer">
                    {hostOf(url)}
                  </a>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Compact grouped view for one or more hosted web_search tool calls. */
export function SearchCallGroup({ toolCalls, unavailable, cost }: SearchCallGroupProps) {
  const [queriesOpen, setQueriesOpen] = useState(false);
  const searchCalls = toolCalls.filter(isWebSearchToolCall);
  if (searchCalls.length === 0) return null;

  const allComplete = searchCalls.every((tc) => tc.complete);
  const statusTone = allComplete ? 'ran' : 'running';
  const queryCount = cost ?? searchCalls.length;
  const latestCall = searchCalls[searchCalls.length - 1];
  const latestQuery = queryText(latestCall);
  const sourceCount = totalSourceCount(searchCalls);

  return (
    <div className="tool search-call-group">
      <div className="tool-head">
        <span className="tico" aria-hidden>
          ⌕
        </span>
        <span className="tname">
          Searched the web
          {queryCount > 0 ? (
            <span className="search-count">
              {' '}
              · {queryCount} {queryCount === 1 ? 'query' : 'queries'}
            </span>
          ) : null}
        </span>
        <span className={`pill ${statusTone}`}>{allComplete ? 'ran' : 'running'}</span>
      </div>
      <div className="tool-detail">
        {!queriesOpen && (
          <div className="search-query-preview" aria-live="polite">
            <span className={`search-query-status ${latestCall.complete ? 'done' : 'pending'}`}>
              {latestCall.complete ? '✓' : '…'}
            </span>
            <span className="search-query">{latestQuery}</span>
            {sourceCount > 0 && (
              <span className="search-source-count">
                {' '}
                · {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
              </span>
            )}
          </div>
        )}
        <details
          className="search-queries"
          open={queriesOpen}
          onToggle={(e) => setQueriesOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Search queries</summary>
          <ol className="search-query-list">
            {searchCalls.map((tc) => (
              <li key={tc.toolCallId} className="search-query-item">
                <span className={`search-query-status ${tc.complete ? 'done' : 'pending'}`}>
                  {tc.complete ? '✓' : '…'}
                </span>
                <span className="search-query">{queryText(tc)}</span>
                {tc.sources && tc.sources.length > 0 && renderSources(tc.sources)}
              </li>
            ))}
          </ol>
        </details>
        {unavailable && (
          <div className="search-unavailable" role="status">
            <b>Web search unavailable.</b> {unavailable.message}
          </div>
        )}
      </div>
    </div>
  );
}
