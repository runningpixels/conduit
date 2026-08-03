import { Fragment } from 'react';
import { renderMarkdown } from '../artifacts/markdown/safeMarkdown';
import { parseMessageSegments } from './messageSegments';
import type { ArtifactCandidate } from './messageSegments';
import { CitationMarker } from './CitationMarker';
import {
  buildCitationSegments,
  dedupeCitationsByUrl,
  hostOf,
  uniqueFootnotes,
} from './citationUtils';
import type { CitationAnnotation } from './streamState';
import type { Artifact } from '../ipc/contracts';
import { InlineCodeBlock } from './InlineCodeBlock';

interface ChatProseProps {
  content: string;
  citations?: CitationAnnotation[];
  streaming?: boolean;
  showCitations?: boolean;
  messageId?: string;
  artifacts?: Artifact[];
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
}

function renderMarkdownWithCitations(
  raw: string,
  citations: CitationAnnotation[],
  keyPrefix: string,
): React.ReactNode {
  const segments = buildCitationSegments(raw, citations);
  return segments.map((seg, i) => (
    <Fragment key={`${keyPrefix}-seg${i}`}>
      {seg.citationsAtStart.map((c) => (
        <CitationMarker key={`${keyPrefix}-cite-${c.index}-${c.startIndex}`} citation={c} />
      ))}
      {seg.text ? renderMarkdown(seg.text) : null}
    </Fragment>
  ));
}

/** Unified assistant prose: safe markdown, inline fenced blocks, and citations. */
export function ChatProse({
  content,
  citations = [],
  streaming,
  showCitations = true,
  messageId,
  artifacts,
  onPromoteArtifact,
  onOpenArtifact,
}: ChatProseProps) {
  const raw = content || '';
  const deduped = showCitations ? dedupeCitationsByUrl(citations) : [];
  const footnotes = showCitations ? uniqueFootnotes(deduped) : [];
  const segments = parseMessageSegments(raw);

  return (
    <div className="prose chat-prose">
      {segments.map((seg, idx) => {
        const isLast = idx === segments.length - 1;
        if (seg.type === 'prose') {
          const prose =
            deduped.length > 0
              ? renderMarkdownWithCitations(seg.text, deduped, `p${idx}`)
              : renderMarkdown(seg.text || (streaming && isLast ? '' : ''));
          return (
            <div key={`p${idx}`} className="chat-prose-segment">
              {prose}
              {streaming && isLast && <span className="streaming" aria-hidden="true" />}
            </div>
          );
        }
        return (
          <InlineCodeBlock
            key={`f${idx}`}
            candidate={seg.candidate}
            streaming={streaming && isLast}
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
