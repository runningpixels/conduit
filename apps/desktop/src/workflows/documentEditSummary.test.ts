import { describe, expect, it } from 'vitest';
import { documentEditSummary } from './documentEditSummary';

const t = ((key: string, vars?: Record<string, unknown>) =>
  `${key.split('.').pop()}${vars ? ` ${JSON.stringify(vars)}` : ''}`) as never;

describe('documentEditSummary', () => {
  it('counts the slides a deck update changed and says the layout is checked later', () => {
    const out = {
      deckId: 'deck-1',
      title: 'Q3',
      changed: ['s1', 's3'],
      skippedPinned: [],
      reply: 'Updated the chart.',
      layoutChecked: false,
    };
    expect(documentEditSummary({ output: out }, t)).toEqual({
      text: 'changedSlides {"count":2}',
      note: 'layoutLater',
      target: { kind: 'deck', id: 'deck-1' },
      beforeSnapshotId: null,
    });
  });

  it('counts the sections a draft update changed, with no layout note', () => {
    const out = { draftId: 'draft-1', title: 'Report', changed: ['b9'], skippedPinned: [], reply: 'Added.' };
    expect(documentEditSummary({ output: out }, t)).toEqual({
      text: 'changedSections {"count":1}',
      note: null,
      target: { kind: 'draft', id: 'draft-1' },
      beforeSnapshotId: null,
    });
  });

  it('says "No changes" and skips the layout note when nothing changed', () => {
    const out = { deckId: 'deck-1', title: 'Q3', changed: [], skippedPinned: ['s2'], reply: 'Nothing to do.', layoutChecked: false };
    expect(documentEditSummary({ output: out }, t)).toEqual({
      text: 'noChanges',
      note: null,
      target: { kind: 'deck', id: 'deck-1' },
      beforeSnapshotId: null,
    });
  });

  it('counts a draft update by the sections that changed when it says which', () => {
    const out = {
      draftId: 'draft-1',
      title: 'Report',
      changed: ['b7', 'b8', 'b9'],
      changedSections: ['This week'],
      skippedPinned: [],
      reply: 'Added.',
    };
    expect(documentEditSummary({ output: out }, t)?.text).toBe('changedSections {"count":1}');
  });

  it('falls back to the blocks for runs recorded before sections were listed', () => {
    const out = { draftId: 'draft-1', title: 'Report', changed: ['b7', 'b8'], skippedPinned: [], reply: 'Added.' };
    expect(documentEditSummary({ output: out }, t)?.text).toBe('changedSections {"count":2}');
  });

  it('passes on the history entry that holds the document from before the step', () => {
    const deck = { deckId: 'deck-1', changed: ['s1'], beforeSnapshotId: 'snap-9', layoutChecked: false };
    expect(documentEditSummary({ output: deck }, t)?.beforeSnapshotId).toBe('snap-9');
    const draft = { draftId: 'draft-1', changed: [], beforeSnapshotId: 'snap-3' };
    expect(documentEditSummary({ output: draft }, t)?.beforeSnapshotId).toBe('snap-3');
    expect(documentEditSummary({ output: { deckId: 'deck-1', changed: [], beforeSnapshotId: '' } }, t)?.beforeSnapshotId).toBeNull();
  });

  it('reads nothing from other steps or a failed one', () => {
    expect(documentEditSummary({ output: null }, t)).toBeNull();
    expect(documentEditSummary({ output: { text: 'hi' } }, t)).toBeNull();
    expect(documentEditSummary({ output: { changed: ['a'] } }, t)).toBeNull();
    expect(documentEditSummary({ output: 'x' }, t)).toBeNull();
  });
});
