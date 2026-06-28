import type { ContentBlockState } from './streamState';

interface ContentBlockProps {
  block: ContentBlockState;
  streaming?: boolean;
  /// When true (default), inline `[n]` citation markers and a footnote list
  /// are rendered. Set to false on streaming-during blocks where citations
  /// may still arrive.
  showCitations?: boolean;
}

/** Escapes a string for safe insertion into HTML text. Model-generated content
 *  is never rendered as raw HTML in this phase. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Renders a prose paragraph with inline `[n]` citation markers, plus a
 *  footnote list at the end of the block. Citation `startIndex`/`endIndex`
 *  are honored exactly as the provider specified — we do not rewrite the
 *  ranges or reorder citations.
 *
 *  Per `docs/specs/agent-web-search.md` §10.3, citations are an attribute
 *  of the text block, not a standalone UI element. We use character-level
 *  slicing to insert the markers without disturbing the prose. */
export function ContentBlock({ block, streaming, showCitations = true }: ContentBlockProps) {
  const raw = block.content || (streaming ? '' : '…');
  const citations = showCitations ? block.citations : [];
  const nodes = renderTextWithCitations(raw, citations, streaming);
  return (
    <div className="prose">
      <p>{nodes}</p>
      {showCitations && citations.length > 0 && !streaming && (
        <ol className="citations">
          {citations.map((c) => (
            <li key={c.index}>
              <a
                className="citation-link"
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title={c.title || c.url}
              >
                {c.title || c.url}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function renderTextWithCitations(
  raw: string,
  citations: ContentBlockState['citations'],
  streaming: boolean | undefined,
): React.ReactNode[] {
  // Build a sorted, deduplicated set of citation boundary points so we can
  // slice the text deterministically. We rely on startIndex (markers) and
  // endIndex (the source attribution end). Per spec §10.3 the marker sits
  // at `startIndex`; the footnote list at the end lists each entry by index.
  const sorted = [...citations].sort((a, b) => a.startIndex - b.startIndex);
  // Build the slice plan: a list of (start, end, citation|undefined). We start
  // at 0, then walk each citation, then end at raw.length. Streaming cursor
  // is appended after the final slice.
  const plan: { start: number; end: number; citation: ContentBlockState['citations'][number] | undefined }[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.startIndex > cursor) {
      plan.push({ start: cursor, end: c.startIndex, citation: undefined });
    }
    // The marker attaches at startIndex; nothing more to slice into for the
    // citation itself. The actual text from startIndex through endIndex is
    // still part of the prose.
    cursor = Math.max(cursor, c.startIndex);
  }
  if (cursor < raw.length) {
    plan.push({ start: cursor, end: raw.length, citation: undefined });
  }

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < plan.length; i++) {
    const slice = plan[i];
    const text = raw.slice(slice.start, slice.end);
    if (text) {
      nodes.push(renderTextWithInlineCode(text, `t${i}`));
    }
    // After each slice's text, emit any citations whose startIndex falls
    // exactly at this slice's start position (markers go inline at start).
    const markersHere = sorted.filter((c) => c.startIndex === slice.start);
    for (const c of markersHere) {
      nodes.push(
        <sup key={`cite-${c.index}`} className="citation-marker">
          <a
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            title={c.title || c.url}
          >
            [{c.index}]
          </a>
        </sup>,
      );
    }
  }
  if (streaming) {
    nodes.push(<span key="cursor" className="cursor" />);
  }
  return nodes;
}

function renderTextWithInlineCode(text: string, keyPrefix: string): React.ReactNode {
  const parts = text.split('`');
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} dangerouslySetInnerHTML={{ __html: escapeHtml(part) }} />,
      );
    } else if (part) {
      nodes.push(
        <span
          key={`${keyPrefix}-t${i}`}
          dangerouslySetInnerHTML={{ __html: escapeHtml(part) }}
        />,
      );
    }
  });
  return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
}