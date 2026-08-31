import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN, renderMarkdown } from '../artifacts/markdown/safeMarkdown';
import { fenceLang, isMathLang, mermaidSourceFromFence } from '../artifacts/markdown/fenceLang';
import { KatexHtml } from '../artifacts/markdown/KatexHtml';
import { MermaidBlock } from '../artifacts/markdown/MermaidBlock';
import { parseMessageSegments } from './messageSegments';
import type { ArtifactCandidate } from './messageSegments';
import { CitationMarker } from './CitationMarker';
import { dedupeCitationsByUrl, hostOf, uniqueFootnotes } from './citationUtils';
import type { CitationAnnotation } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import { InlineCodeBlock } from './InlineCodeBlock';
import { InlineArtifactCard } from './InlineArtifactCard';
import { findPromotedArtifact, shouldRenderAsCard } from './inlineArtifact';

interface ChatProseProps {
  content: string;
  citations?: CitationAnnotation[];
  streaming?: boolean;
  showCitations?: boolean;
  messageId?: string;
  artifacts?: Artifact[];
  /// Per-artifact file state, for the state dot on inline artifact cards.
  fileStateMap?: Record<string, FileState>;
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
  /// Surfaces artifact-card IPC results on the app status line.
  onStatus?: (message: string) => void;
}

/**
 * Substitute each cited span with a placeholder, so the document can be parsed
 * once and the marker rendered inline where the citation belongs.
 *
 * The provider annotates a *range*, and for hosted web search that range is
 * exactly the `([host](url))` link the model wrote. Two things follow. The span
 * is replaced rather than preceded, so the citation is reported once instead of
 * as a marker plus a redundant `(apnews.com)` plus a footnote row. And the
 * source is never split: `renderMarkdown` is a block parser, so rendering
 * slices independently closed and reopened the enclosing `<ul>` around every
 * citation, tearing a cited list into fragments.
 */
function citedMarkdown(
  raw: string,
  citations: CitationAnnotation[],
): { source: string; byId: Map<string, CitationAnnotation> } {
  const byId = new Map<string, CitationAnnotation>();
  const usable = citations
    .filter((c) => c.startIndex >= 0 && c.endIndex > c.startIndex && c.endIndex <= raw.length)
    .sort((a, b) => a.startIndex - b.startIndex);

  let source = '';
  let cursor = 0;
  usable.forEach((citation, i) => {
    // Overlapping ranges would corrupt the offsets; keep the first.
    if (citation.startIndex < cursor) return;
    const id = String(i);
    source += raw.slice(cursor, citation.startIndex);
    source += `${PLACEHOLDER_OPEN}${id}${PLACEHOLDER_CLOSE}`;
    byId.set(id, citation);
    cursor = citation.endIndex;
  });
  source += raw.slice(cursor);
  return { source, byId };
}

const PLACEHOLDER_ANYWHERE = new RegExp(`${PLACEHOLDER_OPEN}[^${PLACEHOLDER_CLOSE}]*${PLACEHOLDER_CLOSE}`, 'g');

/** Remove any placeholder that leaked into a fence, whose body may be persisted. */
function cleanCandidate(candidate: ArtifactCandidate): ArtifactCandidate {
  if (!candidate.body.includes(PLACEHOLDER_OPEN) && !candidate.title.includes(PLACEHOLDER_OPEN)) {
    return candidate;
  }
  return {
    ...candidate,
    body: candidate.body.replace(PLACEHOLDER_ANYWHERE, ''),
    title: candidate.title.replace(PLACEHOLDER_ANYWHERE, ''),
  };
}

/** Unified assistant prose: safe markdown, inline fenced blocks, and citations. */
export function ChatProse({
  content,
  citations = [],
  streaming,
  showCitations = true,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onStatus,
}: ChatProseProps) {
  const raw = content || '';
  const deduped = showCitations ? dedupeCitationsByUrl(citations) : [];
  const footnotes = showCitations ? uniqueFootnotes(deduped) : [];

  // Offsets are absolute over `content`, so placeholders go in before the
  // message is split into prose and fences. The delimiters are private-use
  // codepoints, so they carry no markdown or fence meaning on the way through.
  const { source, byId } =
    deduped.length > 0
      ? citedMarkdown(raw, deduped)
      : { source: raw, byId: new Map<string, CitationAnnotation>() };
  const segments = parseMessageSegments(source);

  const markdownOptions =
    byId.size > 0
      ? {
          renderPlaceholder: (id: string, key: string) => {
            const citation = byId.get(id);
            return citation ? <CitationMarker key={key} citation={citation} /> : null;
          },
        }
      : undefined;

  return (
    <div className="prose chat-prose">
      {segments.map((seg, idx) => {
        const isLast = idx === segments.length - 1;
        if (seg.type === 'prose') {
          const prose = renderMarkdown(seg.text, markdownOptions);
          return (
            <div key={`p${idx}`} className="chat-prose-segment">
              {prose}
              {streaming && isLast && <span className="streaming" aria-hidden="true" />}
            </div>
          );
        }
        // Documents render as a card; snippets stay readable as source. While
        // streaming the source always wins — it is the only place generation
        // is visible until the turn completes (§8.5).
        const fenceStreaming = streaming && isLast;
        const candidate = cleanCandidate(seg.candidate);
        const lang = fenceLang(candidate.info);
        const mermaidSource = mermaidSourceFromFence(candidate.info, candidate.body);
        if (!fenceStreaming && mermaidSource != null) {
          return (
            <MermaidBlock
              key={`f${idx}`}
              source={mermaidSource}
              fallback={
                <InlineCodeBlock
                  candidate={candidate}
                  streaming={false}
                  messageId={messageId}
                  artifacts={artifacts}
                  onPromote={onPromoteArtifact}
                  onOpenArtifact={onOpenArtifact}
                />
              }
            />
          );
        }
        if (!fenceStreaming && isMathLang(lang)) {
          return (
            <div key={`f${idx}`} className="md-katex-block">
              <KatexHtml tex={candidate.body} displayMode fallback={candidate.body} />
            </div>
          );
        }
        if (shouldRenderAsCard(candidate, fenceStreaming)) {
          const promoted = messageId
            ? findPromotedArtifact(artifacts ?? [], messageId, candidate)
            : undefined;
          return (
            <InlineArtifactCard
              key={`f${idx}`}
              candidate={candidate}
              promoted={promoted}
              messageId={messageId}
              fileState={promoted ? fileStateMap?.[promoted.id] : undefined}
              onPromote={onPromoteArtifact}
              onOpenArtifact={onOpenArtifact}
              onStatus={onStatus}
            />
          );
        }
        return (
          <InlineCodeBlock
            key={`f${idx}`}
            candidate={candidate}
            streaming={fenceStreaming}
            messageId={messageId}
            artifacts={artifacts}
            onPromote={onPromoteArtifact}
            onOpenArtifact={onOpenArtifact}
          />
        );
      })}
      {showCitations && footnotes.length > 0 && (
        <div className="sources">
          {footnotes.map((c) => (
            <a
              key={`src-${c.index}-${c.url}`}
              className="source"
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              title={c.title || c.url}
            >
              <i>{c.index}</i>
              {c.title || c.url}
              <span className="source-host"> · {hostOf(c.url)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
