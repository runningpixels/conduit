import { describe, expect, it } from 'vitest';
import type { ConversationFolder, ConversationSummary } from '../ipc/contracts';
import {
  organizeConversations,
  organizationBadge,
} from './conversationOrganization';

const NOW = new Date('2026-09-02T12:00:00Z');

function row(
  id: string,
  title: string,
  updatedAt: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return { id, displayTitle: title, updatedAt, messageCount: 1, ...extra };
}

const work: ConversationFolder = {
  id: 'f-work',
  name: 'Work',
  createdAt: '2026-09-01T00:00:00Z',
};
const personal: ConversationFolder = {
  id: 'f-personal',
  name: 'Personal',
  createdAt: '2026-09-01T00:00:00Z',
};

describe('organizeConversations', () => {
  it('puts pinned chats above day groups and keeps them there', () => {
    const organized = organizeConversations(
      [
        row('recent', 'Recent', '2026-09-02T10:00:00Z'),
        row('pin', 'Pinned', '2026-08-01T10:00:00Z', {
          pinnedAt: '2026-09-02T11:00:00Z',
        }),
      ],
      [],
      NOW,
    );
    expect(organized.pinned.map((r) => r.id)).toEqual(['pin']);
    expect(organized.recentGroups[0][0]).toBe('Today');
    expect(organized.recentGroups[0][1].map((r) => r.id)).toEqual(['recent']);
  });

  it('hides archived chats from the default rail even when pinned or filed', () => {
    const organized = organizeConversations(
      [
        row('a', 'Archived pin', '2026-09-02T10:00:00Z', {
          pinnedAt: '2026-09-02T09:00:00Z',
          archivedAt: '2026-09-02T11:00:00Z',
          folderId: 'f-work',
        }),
        row('b', 'Live', '2026-09-02T08:00:00Z'),
      ],
      [work],
      NOW,
    );
    expect(organized.archived.map((r) => r.id)).toEqual(['a']);
    expect(organized.pinned).toEqual([]);
    expect(organized.folders[0].rows).toEqual([]);
    expect(organized.recentGroups[0][1].map((r) => r.id)).toEqual(['b']);
  });

  it('keeps empty folders as drop targets and files unpinned chats under them', () => {
    const organized = organizeConversations(
      [row('c', 'Client notes', '2026-09-02T10:00:00Z', { folderId: 'f-work', folderName: 'Work' })],
      [personal, work],
      NOW,
    );
    expect(organized.folders.map((s) => s.folder.name)).toEqual(['Personal', 'Work']);
    expect(organized.folders[0].rows).toEqual([]);
    expect(organized.folders[1].rows.map((r) => r.id)).toEqual(['c']);
    expect(organized.recentGroups).toEqual([]);
  });

  it('reports allArchived when every chat is archived', () => {
    const organized = organizeConversations(
      [row('a', 'Gone', '2026-09-02T10:00:00Z', { archivedAt: '2026-09-02T11:00:00Z' })],
      [],
      NOW,
    );
    expect(organized.allArchived).toBe(true);
    expect(organized.archived).toHaveLength(1);
  });
});

describe('organizationBadge', () => {
  it('prefers Archived over Pinned, then folder name', () => {
    expect(organizationBadge({ archived: true, pinned: true, folderName: 'Work' })).toBe(
      'Archived',
    );
    expect(organizationBadge({ pinned: true, folderName: 'Work' })).toBe('Pinned');
    expect(organizationBadge({ folderName: 'Work' })).toBe('Work');
    expect(organizationBadge({})).toBeUndefined();
  });
});
