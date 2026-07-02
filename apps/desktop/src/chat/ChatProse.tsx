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

const KIND_LABEL: Record<ArtifactCandidate['kind'], string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

interface ChatProseProps {
  content: string;
  citations?: CitationAnnotation[];
  streaming?: boolean;
  showCitations?: boolean;
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

function renderFenceBlock(
  candidate: ArtifactCandidate,
  streaming: boolean,
  isLast: boolean,
  key: string,
) {
  if (streaming && isLast) {
    const label = KIND_LABEL[candidate.kind] ?? candidate.kind;
    return (
      <div key={key} className="prose">
        <p>
          Writing {label} artifact…
          <span className="cursor" />
        </p>
      </div>
    );
  }
  const label = KIND_LABEL[candidate.kind] ?? candidate.kind;
  const lineCount = candidate.body.split('\n').length;
  return (
    <details key={key} className="artifact-fence-block">
      <summary>{`${label} artifact · ${lineCount} lines`}</summary>
      <pre>{candidate.body}</pre>
    </details>
  );
}

/** Unified assistant prose: safe markdown, artifact fences, and inline citations. */
export function ChatProse({
  content,
  citations = [],
  streaming,
  showCitations = true,
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
              {streaming && isLast && <span className="cursor" />}
            </div>
          );
        }
        return renderFenceBlock(seg.candidate, !!streaming, isLast, `f${idx}`);
      })}
      {showCitations && footnotes.length > 0 && (
        <ol className="citations">
          {footnotes.map((c) => (
            <li key={`fn-${c.index}-${c.url}`}>
              <span className="citation-index">[{c.index}]</span>{' '}
              <a
                className="citation-link"
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title={c.title || c.url}
              >
                {c.title || c.url}
              </a>
              <span className="citation-host"> — {hostOf(c.url)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
