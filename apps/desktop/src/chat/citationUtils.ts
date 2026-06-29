import type { CitationAnnotation } from './streamState';

/** Deduplicate citations by URL for footnotes; remap inline markers to shared indices. */
export function dedupeCitationsByUrl(citations: CitationAnnotation[]): CitationAnnotation[] {
  const urlToIndex = new Map<string, number>();
  const footnotes: CitationAnnotation[] = [];

  return citations.map((c) => {
    const existing = urlToIndex.get(c.url);
    if (existing !== undefined) {
      return { ...c, index: existing };
    }
    const index = footnotes.length + 1;
    urlToIndex.set(c.url, index);
    const entry = { ...c, index };
    footnotes.push(entry);
    return entry;
  });
}

/** Unique footnote rows for the citation list at the end of a block. */
export function uniqueFootnotes(citations: CitationAnnotation[]): CitationAnnotation[] {
  const seen = new Set<string>();
  const rows: CitationAnnotation[] = [];
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    rows.push(c);
  }
  return rows.sort((a, b) => a.index - b.index);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export interface CitationSegment {
  text: string;
  citationsAtStart: CitationAnnotation[];
}

/** Split prose into segments with citations that begin at each segment's start offset. */
export function buildCitationSegments(
  raw: string,
  citations: CitationAnnotation[],
): CitationSegment[] {
  const sorted = [...citations].sort((a, b) => a.startIndex - b.startIndex);
  const byStart = new Map<number, CitationAnnotation[]>();
  for (const c of sorted) {
    const list = byStart.get(c.startIndex) ?? [];
    list.push(c);
    byStart.set(c.startIndex, list);
  }

  const boundaries = new Set<number>([0, raw.length]);
  for (const c of sorted) {
    boundaries.add(c.startIndex);
    boundaries.add(c.endIndex);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const segments: CitationSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (start === end) continue;
    segments.push({
      text: raw.slice(start, end),
      citationsAtStart: byStart.get(start) ?? [],
    });
  }
  return segments;
}
