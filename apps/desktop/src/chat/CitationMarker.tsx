import { hostOf } from './citationUtils';
import type { CitationAnnotation } from './streamState';

interface CitationMarkerProps {
  citation: CitationAnnotation;
}

export function CitationMarker({ citation }: CitationMarkerProps) {
  const title = citation.title || citation.url;
  const host = hostOf(citation.url);
  return (
    <sup className="cite">
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${title} — ${host}`}
        aria-label={`Citation ${citation.index}: ${title}`}
      >
        {citation.index}
      </a>
    </sup>
  );
}
