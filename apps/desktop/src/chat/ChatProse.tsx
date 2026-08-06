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
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onStatus,
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
        // Documents render as a card; snippets stay readable as source. While
        // streaming the source always wins — it is the only place generation
        // is visible until the turn completes (§8.5).
        const fenceStreaming = streaming && isLast;
        if (shouldRenderAsCard(seg.candidate, fenceStreaming)) {
          const promoted = messageId
            ? findPromotedArtifact(artifacts ?? [], messageId, seg.candidate)
            : undefined;
          return (
            <InlineArtifactCard
              key={`f${idx}`}
              candidate={seg.candidate}
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
            candidate={seg.candidate}
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
