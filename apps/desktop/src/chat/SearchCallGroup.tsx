import { useState } from 'react';
import type { AssistantStreamState, ToolCallState } from './streamState';
import { isWebSearchToolCall } from './SearchCallBlock';
import { hostOf } from './citationUtils';
import type { SearchSource } from './streamState';
import { SearchIcon } from '../icons';
import { useRichT, useT, type Translate } from '../i18n';

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

function queryText(tc: ToolCallState, t: Translate): string {
  const args = (tc.arguments ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query : '';
  return query || tc.argumentsText || t('chat.search.searchingPlaceholder');
}

function totalSourceCount(searchCalls: ToolCallState[]): number {
  return searchCalls.reduce((acc, tc) => acc + (tc.sources?.length ?? 0), 0);
}

function sourceCountFor(tc: ToolCallState): number {
  return tc.sources?.length ?? 0;
}

function renderSources(sources: SearchSource[], callIndex: number, t: Translate) {
  if (sources.length === 0) return null;
  return (
    <div className="q-sources">
      {sources.map((src, i) => {
        const title = pickString(src.raw, ['title', 'name']) ?? t('chat.search.sourceFallbackTitle', { index: i + 1 });
        const url = pickString(src.raw, ['url', 'link']) ?? '';
        return (
          <span className="q-source" key={`${callIndex}-${i}`}>
            <span className="src-title">{title}</span>
            {url && (
              <>
                {' — '}
                <a className="src-url" href={url} target="_blank" rel="noopener noreferrer">
                  {hostOf(url)}
                </a>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** V7 web-search tool card (§8.4): one collapsed line ("N queries · M
 *  sources"), one level of expansion into a flat list of query rows. */
export function SearchCallGroup({ toolCalls, unavailable, cost }: SearchCallGroupProps) {
  const t = useT();
  const tr = useRichT();
  const [open, setOpen] = useState(false);
  const searchCalls = toolCalls.filter(isWebSearchToolCall);
  if (searchCalls.length === 0) return null;

  const allComplete = searchCalls.every((tc) => tc.complete);
  const queryCount = cost ?? searchCalls.length;
  const sourceCount = totalSourceCount(searchCalls);
  // One summary string, as in ToolCallBlock (V9 §2.5) — the status was a chip
  // of its own until the tool line lost its chrome.
  const summary = [
    t('chat.search.queryCount', { count: queryCount }),
    sourceCount > 0 ? t('chat.search.sourceCount', { count: sourceCount }) : '',
    allComplete ? '' : t('chat.search.running'),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="tool search-call-group"
      data-open={open ? 'true' : 'false'}
      {...(allComplete ? {} : { 'data-running': 'true' })}
    >
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-icon">
          <SearchIcon />
        </span>
        <span className="tool-name">{t('chat.search.title')}</span>
        <span className="tool-sum">{summary}</span>
        <svg className="tool-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <div className="tool-body">
        <div>
          <div className="tool-inner">
            {searchCalls.map((tc, i) => (
              <div key={tc.toolCallId}>
                <div className="q">
                  <span className="q-str">{queryText(tc, t)}</span>
                  {tc.complete && sourceCountFor(tc) > 0 && (
                    <span className="q-n">
                      {t('chat.search.sourceCount', { count: sourceCountFor(tc) })}
                    </span>
                  )}
                </div>
                {tc.complete && tc.sources && renderSources(tc.sources, i, t)}
              </div>
            ))}
            {unavailable && (
              <div className="search-unavailable" role="status">
                {tr('chat.search.unavailable', { message: unavailable.message })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
