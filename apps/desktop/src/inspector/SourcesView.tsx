import { useMemo } from 'react';
import type { ChatTurn } from '../chat/conversationHydration';
import type { KnowledgeCitation } from '../ipc/contracts';
import { openExternalUrl } from '../ipc/client';
import { KnowledgeCitations } from '../chat/KnowledgeCitations';
import { hostOf } from '../chat/citationUtils';
import { useT } from '../i18n';
import { isHttpUrl, searchSourceEntry } from './turnActivity';

export interface SourcesViewProps {
  turns: ChatTurn[];
  /** Knowledge-base citations per **user** turn id (ChatView's `turnCitations`).
   *  Shown under the assistant turn that answered that message. */
  knowledgeCitations?: Record<string, KnowledgeCitation[]>;
  /** Surfaces a refused or failed link open on the status line. */
  onStatus?: (message: string) => void;
}

interface WebSource {
  url: string;
  title?: string;
}

interface SourceGroup {
  id: string;
  index: number;
  web: WebSource[];
  knowledge: KnowledgeCitation[];
}

/** Web sources a turn surfaced: search results first, then URL citations, one row per URL. */
function webSourcesOf(turn: ChatTurn): WebSource[] {
  const state = turn.streamState;
  if (!state) return [];
  const byUrl = new Map<string, WebSource>();
  const add = (url: string | undefined, title: string | undefined) => {
    if (!isHttpUrl(url)) return;
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return;
    }
    byUrl.set(url, { url, title });
  };
  for (const tc of state.toolCalls) {
    for (const src of tc.sources ?? []) {
      const entry = searchSourceEntry(src);
      add(entry.url, entry.title);
    }
  }
  for (const src of state.searchSources) {
    const entry = searchSourceEntry(src);
    add(entry.url, entry.title);
  }
  for (const block of state.blocks) {
    for (const c of block.citations) add(c.url, c.title || undefined);
  }
  return [...byUrl.values()];
}

/** Inspector → Sources: web sources and document citations for the whole chat, newest turn first. */
export function SourcesView({ turns, knowledgeCitations = {}, onStatus }: SourcesViewProps) {
  const t = useT();

  const groups = useMemo<SourceGroup[]>(() => {
    const out: SourceGroup[] = [];
    let pendingKnowledge: KnowledgeCitation[] = [];
    let index = 0;
    for (const turn of turns) {
      if (turn.role === 'user') {
        pendingKnowledge = [...pendingKnowledge, ...(knowledgeCitations[turn.id] ?? [])];
        continue;
      }
      index += 1;
      const web = webSourcesOf(turn);
      if (web.length > 0 || pendingKnowledge.length > 0) {
        out.push({ id: turn.id, index, web, knowledge: pendingKnowledge });
      }
      pendingKnowledge = [];
    }
    // A message still waiting for its answer can already carry citations.
    if (pendingKnowledge.length > 0) {
      out.push({ id: 'pending', index: index + 1, web: [], knowledge: pendingKnowledge });
    }
    return out.reverse();
  }, [turns, knowledgeCitations]);

  async function open(url: string) {
    try {
      await openExternalUrl(url);
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : String(err));
    }
  }

  if (groups.length === 0) {
    return (
      <section className="inspector-view sources-view" aria-label={t('inspector.sources.ariaLabel')}>
        <p className="inspector-empty">{t('inspector.sources.empty')}</p>
      </section>
    );
  }

  return (
    <section className="inspector-view sources-view" aria-label={t('inspector.sources.ariaLabel')}>
      {groups.map((group) => (
        <div key={group.id} className="inspector-section">
          <h3 className="inspector-heading">{t('inspector.turnLabel', { index: group.index })}</h3>
          {group.web.length > 0 && (
            <ul className="inspector-list">
              {group.web.map((src, i) => {
                const title = src.title || t('chat.search.sourceFallbackTitle', { index: i + 1 });
                return (
                  <li key={src.url} className="source-row">
                    <a
                      className="source-link"
                      href={src.url}
                      title={src.url}
                      onClick={(event) => {
                        event.preventDefault();
                        void open(src.url);
                      }}
                    >
                      <span className="source-link-title">{title}</span>
                      <span className="source-link-host">{hostOf(src.url)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {group.knowledge.length > 0 && (
            <>
              <h4 className="inspector-subheading">{t('inspector.sources.documents')}</h4>
              <KnowledgeCitations citations={group.knowledge} />
            </>
          )}
        </div>
      ))}
    </section>
  );
}
