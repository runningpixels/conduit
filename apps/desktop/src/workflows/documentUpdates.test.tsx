import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckDetail, DeckSnapshotSummary } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ listDeckSnapshots: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return tauri.unlisten;
  }),
}));

import {
  checkedSnapshots,
  DECK_CHANGED_EVENT,
  deckEditInProgress,
  documentUpdateAction,
  draftEditInProgress,
  DRAFT_CHANGED_EVENT,
  isWorkflowSnapshot,
  markLayoutChecked,
  pendingLayoutSnapshot,
  useLayoutFollowUp,
  useWorkflowDocumentEvents,
} from './documentUpdates';

const snap = (id: string, cause: DeckSnapshotSummary['cause'], label: string): DeckSnapshotSummary => ({
  id,
  cause,
  label,
  slideCount: 3,
  createdAt: '2026-10-07T08:00:00Z',
});

const deck = (updatedAt = '2026-10-07T08:00:00Z'): DeckDetail =>
  ({
    id: 'deck-1',
    conversationId: 'conv-1',
    updatedAt,
    slides: [{ id: 's1' }, { id: 's2' }],
  }) as unknown as DeckDetail;

beforeEach(() => {
  localStorage.clear();
  ipc.listDeckSnapshots.mockReset();
  tauri.handlers.clear();
});

describe('documentUpdateAction', () => {
  it('ignores a document that is not open, reloads one nobody is editing, and notes one being edited', () => {
    expect(documentUpdateAction(false, false)).toBe('ignore');
    expect(documentUpdateAction(false, true)).toBe('ignore');
    expect(documentUpdateAction(true, false)).toBe('reload');
    expect(documentUpdateAction(true, true)).toBe('note');
  });
});

describe('deckEditInProgress', () => {
  it('is true only while a slide text field has the focus', () => {
    document.body.innerHTML =
      '<div class="deck-script-editor" contenteditable="true" tabindex="0" id="a"></div><button id="b">x</button>';
    expect(deckEditInProgress(document.getElementById('b'))).toBe(false);
    expect(deckEditInProgress(document.getElementById('a'))).toBe(true);
    expect(deckEditInProgress(null)).toBe(false);
    document.body.innerHTML = '';
  });
});

describe('draftEditInProgress', () => {
  it('is true with an open editing session, or while the editor has the focus', () => {
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content" tabindex="0" id="a"></div></div><button id="b">x</button>';
    expect(draftEditInProgress('p1', null, document.getElementById('b'))).toBe(false);
    expect(draftEditInProgress('p1', 'p2', document.getElementById('b'))).toBe(false);
    expect(draftEditInProgress('p1', 'p1', document.getElementById('b'))).toBe(true);
    expect(draftEditInProgress('p1', null, document.getElementById('a'))).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('layout follow-up bookkeeping', () => {
  it('recognises the history entry a workflow leaves', () => {
    expect(isWorkflowSnapshot(snap('a', 'ai-turn', 'Workflow: Weekly numbers'))).toBe(true);
    expect(isWorkflowSnapshot(snap('a', 'manual', 'Workflow: Weekly numbers'))).toBe(false);
    expect(isWorkflowSnapshot(snap('a', 'ai-turn', 'Layout check'))).toBe(false);
  });

  it('wants a check only for an unchecked workflow entry at the top of the history', () => {
    const newest = snap('s2', 'ai-turn', 'Workflow: Weekly numbers');
    const older = snap('s1', 'manual', 'Before Weekly numbers');
    expect(pendingLayoutSnapshot('deck-1', [newest, older])?.id).toBe('s2');
    // A later entry of anything else means the deck moved on.
    expect(pendingLayoutSnapshot('deck-1', [snap('s3', 'manual', 'Edited words on slide 2'), newest])).toBeNull();
    expect(pendingLayoutSnapshot('deck-1', [])).toBeNull();
    markLayoutChecked('deck-1', 's2');
    expect(pendingLayoutSnapshot('deck-1', [newest, older])).toBeNull();
    // Another deck has its own record.
    expect(pendingLayoutSnapshot('deck-2', [newest, older])?.id).toBe('s2');
  });

  it('keeps the record short and survives storage that throws', () => {
    for (let i = 0; i < 30; i++) markLayoutChecked('deck-1', `s${i}`);
    expect(checkedSnapshots('deck-1')).toHaveLength(20);
    expect(checkedSnapshots('deck-1')[0]).toBe('s29');
    const broken = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(checkedSnapshots('deck-1')).toEqual([]);
    broken.mockRestore();
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markLayoutChecked('deck-1', 'x')).not.toThrow();
    failing.mockRestore();
  });
});

describe('useLayoutFollowUp', () => {
  const entry = snap('s2', 'ai-turn', 'Workflow: Weekly numbers');

  it('checks the whole deck once per workflow entry, even when the deck is reloaded', async () => {
    ipc.listDeckSnapshots.mockResolvedValue([entry]);
    const check = vi.fn();
    const { rerender } = renderHook((props) => useLayoutFollowUp(props), {
      initialProps: { deck: deck(), active: true, isBusy: () => false, check },
    });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(check.mock.calls[0][1]).toEqual(['s1', 's2']);
    expect(checkedSnapshots('deck-1')).toEqual(['s2']);

    // The deck is reloaded (a new updatedAt): same entry, no second check.
    rerender({ deck: deck('2026-10-07T09:00:00Z'), active: true, isBusy: () => false, check });
    await waitFor(() => expect(ipc.listDeckSnapshots).toHaveBeenCalledTimes(2));
    expect(check).toHaveBeenCalledTimes(1);

    // A new workflow edit leaves a new entry: checked again.
    ipc.listDeckSnapshots.mockResolvedValue([snap('s3', 'ai-turn', 'Workflow: Weekly numbers'), entry]);
    rerender({ deck: deck('2026-10-07T10:00:00Z'), active: true, isBusy: () => false, check });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  });

  it('waits until the deck is open in the studio and no turn is running', async () => {
    ipc.listDeckSnapshots.mockResolvedValue([entry]);
    const check = vi.fn();
    const { rerender } = renderHook((props) => useLayoutFollowUp(props), {
      initialProps: { deck: deck(), active: false, isBusy: () => false, check },
    });
    await Promise.resolve();
    expect(ipc.listDeckSnapshots).not.toHaveBeenCalled();

    rerender({ deck: deck(), active: true, isBusy: () => true, check });
    await waitFor(() => expect(ipc.listDeckSnapshots).toHaveBeenCalled());
    await Promise.resolve();
    expect(check).not.toHaveBeenCalled();
    // Not marked either, so it still runs when the turn is over.
    expect(checkedSnapshots('deck-1')).toEqual([]);
  });

  it('does nothing for a deck whose newest entry is not a workflow edit', async () => {
    ipc.listDeckSnapshots.mockResolvedValue([snap('s9', 'ai-turn', 'Wrote the deck'), entry]);
    const check = vi.fn();
    renderHook((props) => useLayoutFollowUp(props), {
      initialProps: { deck: deck(), active: true, isBusy: () => false, check },
    });
    await waitFor(() => expect(ipc.listDeckSnapshots).toHaveBeenCalled());
    await Promise.resolve();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('useWorkflowDocumentEvents', () => {
  it('hands each event to its own callback and stops listening on unmount', async () => {
    const onDeck = vi.fn();
    const onDraft = vi.fn();
    const { unmount } = renderHook(() => useWorkflowDocumentEvents(onDeck, onDraft));
    await waitFor(() => expect(tauri.handlers.size).toBe(2));
    tauri.handlers.get(DECK_CHANGED_EVENT)?.({ payload: { deckId: 'd1', workflowName: 'W', runId: 'r1' } });
    tauri.handlers.get(DRAFT_CHANGED_EVENT)?.({ payload: { draftId: 'p1', workflowName: 'W', runId: 'r1' } });
    expect(onDeck).toHaveBeenCalledWith({ deckId: 'd1', workflowName: 'W', runId: 'r1' });
    expect(onDraft).toHaveBeenCalledWith({ draftId: 'p1', workflowName: 'W', runId: 'r1' });
    unmount();
    await waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(2));
  });
});
