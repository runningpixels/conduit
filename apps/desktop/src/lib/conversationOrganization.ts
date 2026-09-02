/**
 * Partition the history rail: Pinned → Folders → Recent (day groups) → Archived.
 *
 * Archived chats leave the default list even if they are also pinned or filed.
 * Pinned chats sit at the top even if they belong to a folder; unpinning returns
 * them to that folder. Empty folders stay in the Folders section as drop targets.
 */
import type { ConversationFolder, ConversationSummary } from '../ipc/contracts';
import { conversationGroup } from './dayGroup';

export interface FolderSection {
  folder: ConversationFolder;
  rows: ConversationSummary[];
}

export interface OrganizedHistory {
  pinned: ConversationSummary[];
  folders: FolderSection[];
  recentGroups: [string, ConversationSummary[]][];
  archived: ConversationSummary[];
  total: number;
  allArchived: boolean;
}

export function isPinned(row: ConversationSummary): boolean {
  return Boolean(row.pinnedAt);
}

export function isArchived(row: ConversationSummary): boolean {
  return Boolean(row.archivedAt);
}

/** Badge for FTS hits and palette rows. Archived wins over pinned. */
export function organizationBadge(row: {
  pinned?: boolean;
  archived?: boolean;
  pinnedAt?: string;
  archivedAt?: string;
  folderName?: string;
}): string | undefined {
  if (row.archived || row.archivedAt) return 'Archived';
  if (row.pinned || row.pinnedAt) return 'Pinned';
  if (row.folderName) return row.folderName;
  return undefined;
}

function byUpdatedDesc(a: ConversationSummary, b: ConversationSummary): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function groupRecent(
  rows: ConversationSummary[],
  now: Date,
): [string, ConversationSummary[]][] {
  const buckets = new Map<string, ConversationSummary[]>();
  for (const row of rows) {
    const group = conversationGroup(row.updatedAt, now);
    const list = buckets.get(group) ?? [];
    list.push(row);
    buckets.set(group, list);
  }
  return Array.from(buckets.entries());
}

export function organizeConversations(
  rows: ConversationSummary[],
  folders: ConversationFolder[],
  now: Date = new Date(),
): OrganizedHistory {
  const archived: ConversationSummary[] = [];
  const pinned: ConversationSummary[] = [];
  const byFolder = new Map<string, ConversationSummary[]>();
  const recent: ConversationSummary[] = [];

  const sorted = [...rows].sort(byUpdatedDesc);
  for (const row of sorted) {
    if (isArchived(row)) {
      archived.push(row);
      continue;
    }
    if (isPinned(row)) {
      pinned.push(row);
      continue;
    }
    if (row.folderId) {
      const list = byFolder.get(row.folderId) ?? [];
      list.push(row);
      byFolder.set(row.folderId, list);
      continue;
    }
    recent.push(row);
  }

  pinned.sort((a, b) => {
    const pin = Date.parse(b.pinnedAt ?? '') - Date.parse(a.pinnedAt ?? '');
    return pin !== 0 ? pin : byUpdatedDesc(a, b);
  });

  const folderSections = [...folders]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((folder) => ({ folder, rows: byFolder.get(folder.id) ?? [] }));

  const visibleInFolders = folderSections.reduce((n, section) => n + section.rows.length, 0);
  const allArchived =
    rows.length > 0 && pinned.length === 0 && recent.length === 0 && visibleInFolders === 0;

  return {
    pinned,
    folders: folderSections,
    recentGroups: groupRecent(recent, now),
    archived,
    total: rows.length,
    allArchived,
  };
}
