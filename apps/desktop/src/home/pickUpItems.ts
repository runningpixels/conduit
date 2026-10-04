/// "Pick up where you left off": the few things most recently worked on, chats,
/// decks, drafts and apps mixed by recency. Pure: lists in, items out.

import type { AppSummary, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';

/// How many items Home shows.
export const PICK_UP_LIMIT = 6;

export type PickUpItem =
  | { kind: 'chat'; id: string; title: string | null; when: string; messageCount: number }
  | { kind: 'deck'; id: string; title: string; when: string; slideCount: number; building: boolean }
  | { kind: 'draft'; id: string; title: string; when: string; words: number; outlining: boolean }
  | { kind: 'app'; id: string; title: string; when: string; icon?: string; category: AppSummary['category'] };

/// A chat someone wrote in (or named). The empty chat the app opens on is not one.
export function isStartedChat(c: ConversationSummary): boolean {
  return Boolean(c.displayTitle) || c.messageCount > 0;
}

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function buildPickUp(
  conversations: readonly ConversationSummary[],
  decks: readonly DeckSummary[],
  apps: readonly AppSummary[],
  limit = PICK_UP_LIMIT,
  drafts: readonly DraftSummary[] = [],
): PickUpItem[] {
  const items: PickUpItem[] = [];
  for (const c of conversations) {
    if (c.archivedAt) continue;
    // A chat nobody wrote in is not something to pick up.
    if (!isStartedChat(c)) continue;
    items.push({ kind: 'chat', id: c.id, title: c.displayTitle ?? null, when: c.updatedAt, messageCount: c.messageCount });
  }
  for (const d of decks) {
    items.push({
      kind: 'deck',
      id: d.id,
      title: d.title,
      when: d.lastOpenedAt ?? d.updatedAt,
      slideCount: d.slideCount,
      building: d.stage === 'storyline',
    });
  }
  for (const d of drafts) {
    items.push({ kind: 'draft', id: d.id, title: d.title, when: d.updatedAt, words: d.words, outlining: d.stage === 'outline' });
  }
  for (const a of apps) {
    if (!a.lastOpenedAt) continue;
    items.push({ kind: 'app', id: a.id, title: a.name, when: a.lastOpenedAt, icon: a.icon, category: a.category });
  }
  return items.sort((a, b) => time(b.when) - time(a.when)).slice(0, limit);
}
