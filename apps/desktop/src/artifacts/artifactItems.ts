/// The Artifacts page's items: everything made, from every place it is kept.
/// Pure: lists in, items out.
///
/// Chat artifacts come from every chat (`list_all_artifacts`); decks, Writing
/// drafts and saved apps from their own lists. Each item says what kind of
/// thing it is, which tab it sits under, and how to open it.

import type { AppSummary, Artifact, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';

/** The page's tabs, in order. `all` holds every item. */
export const ARTIFACT_TABS = ['all', 'pages', 'decks', 'documents', 'sheets', 'images'] as const;
export type ArtifactTab = (typeof ARTIFACT_TABS)[number];

/** What an item is, as its label and thumbnail show it. */
export type ArtifactItemKind = 'page' | 'app' | 'deck' | 'document' | 'sheet' | 'image' | 'code';

export type ArtifactOpen =
  | { type: 'artifact'; conversationId: string; artifactId: string }
  | { type: 'deck'; id: string }
  | { type: 'draft'; id: string }
  | { type: 'app'; id: string };

export interface ArtifactItem {
  key: string;
  kind: ArtifactItemKind;
  /** The tab it is listed under besides All; code and data only show in All. */
  tab: Exclude<ArtifactTab, 'all'> | null;
  title: string | null;
  /** ISO time it last changed (or was opened, for an app). */
  when: string;
  /** The chat it was made in, when it was made in one. */
  chatTitle: string | null;
  open: ArtifactOpen;
}

const KIND_OF_ARTIFACT: Record<string, ArtifactItemKind> = {
  html: 'page',
  markdown: 'document',
  text: 'document',
  spreadsheet: 'sheet',
  image: 'image',
  code: 'code',
  json: 'code',
};

const TAB_OF_KIND: Record<ArtifactItemKind, ArtifactItem['tab']> = {
  page: 'pages',
  app: 'pages',
  deck: 'decks',
  document: 'documents',
  sheet: 'sheets',
  image: 'images',
  code: null,
};

/** A page's title comes from its HTML `<title>`, entities and all (`Maple &amp; Rye`). */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

export function buildArtifactItems(
  artifacts: readonly Artifact[],
  decks: readonly DeckSummary[],
  drafts: readonly DraftSummary[],
  apps: readonly AppSummary[],
  conversations: readonly ConversationSummary[],
): ArtifactItem[] {
  const chatTitles = new Map(conversations.map((c) => [c.id, c.displayTitle ?? null]));
  const items: ArtifactItem[] = [];
  for (const a of artifacts) {
    const kind = KIND_OF_ARTIFACT[a.kind] ?? 'code';
    items.push({
      key: `artifact:${a.id}`,
      kind,
      tab: TAB_OF_KIND[kind],
      title: decodeEntities(a.title?.trim() ?? '') || null,
      when: a.updatedAt ?? a.createdAt,
      chatTitle: chatTitles.get(a.conversationId) ?? null,
      open: { type: 'artifact', conversationId: a.conversationId, artifactId: a.id },
    });
  }
  for (const d of decks) {
    items.push({
      key: `deck:${d.id}`,
      kind: 'deck',
      tab: 'decks',
      title: d.title?.trim() || null,
      when: d.updatedAt,
      chatTitle: null,
      open: { type: 'deck', id: d.id },
    });
  }
  for (const d of drafts) {
    items.push({
      key: `draft:${d.id}`,
      kind: 'document',
      tab: 'documents',
      title: d.title?.trim() || null,
      when: d.updatedAt,
      chatTitle: null,
      open: { type: 'draft', id: d.id },
    });
  }
  for (const app of apps) {
    items.push({
      key: `app:${app.id}`,
      kind: 'app',
      tab: 'pages',
      title: app.name?.trim() || null,
      when: app.lastOpenedAt ?? app.createdAt,
      chatTitle: null,
      open: { type: 'app', id: app.id },
    });
  }
  return items;
}

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export type ArtifactSort = 'recent' | 'name';

/** One tab's items, matching the search, in the chosen order. */
export function filterArtifactItems(
  items: readonly ArtifactItem[],
  tab: ArtifactTab,
  query: string,
  sort: ArtifactSort,
  untitled: string,
): ArtifactItem[] {
  const q = query.trim().toLocaleLowerCase();
  const shown = items.filter(
    (item) =>
      (tab === 'all' || item.tab === tab) &&
      (q === '' ||
        (item.title ?? untitled).toLocaleLowerCase().includes(q) ||
        (item.chatTitle ?? '').toLocaleLowerCase().includes(q)),
  );
  return shown.sort((a, b) =>
    sort === 'name'
      ? (a.title ?? untitled).localeCompare(b.title ?? untitled, undefined, { sensitivity: 'base' })
      : time(b.when) - time(a.when),
  );
}

/** How many items each tab holds. */
export function countByTab(items: readonly ArtifactItem[]): Record<ArtifactTab, number> {
  const counts = Object.fromEntries(ARTIFACT_TABS.map((tab) => [tab, 0])) as Record<ArtifactTab, number>;
  for (const item of items) {
    counts.all += 1;
    if (item.tab) counts[item.tab] += 1;
  }
  return counts;
}
