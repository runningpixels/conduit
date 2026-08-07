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

// `buildCitationSegments` lived here. It split prose at citation offsets so each
// piece could be rendered independently — which cannot work, because
// `renderMarkdown` parses blocks: slicing mid-list closed and reopened the
// `<ul>` around every citation. `ChatProse` substitutes placeholders and parses
// once instead (§8.4).
