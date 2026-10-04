import { describe, expect, it } from 'vitest';
import { ChangeSet, EditorState } from '@codemirror/state';
import {
  blocksField,
  blocksInRange,
  mapBlocks,
  minimalChange,
  pinnedLineStarts,
  setBlocksEffect,
  toEditorBlocks,
  type EditorBlock,
} from './editorBlocks';

const blocks: EditorBlock[] = [
  { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, from: 0, to: 8 },
  { id: 'b2', kind: 'paragraph', owner: 'user', pinned: true, from: 10, to: 20 },
  { id: 'b3', kind: 'paragraph', owner: 'ai', pinned: false, from: 22, to: 30 },
];

describe('minimalChange', () => {
  it('replaces only what differs', () => {
    expect(minimalChange('abc', 'abc')).toBeNull();
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
    const cut = minimalChange('one two three', 'one three')!;
    expect(cut.insert).toBe('');
    expect('one two three'.slice(0, cut.from) + 'one two three'.slice(cut.to)).toBe('one three');
    expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' });
  });
});

describe('block ranges', () => {
  it('clamps backend offsets to the text and sorts them', () => {
    const out = toEditorBlocks(
      [
        { id: 'b2', kind: 'paragraph', owner: 'ai', pinned: false, start: 5, end: 99 },
        { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 3 },
      ],
      10,
    );
    expect(out.map((b) => [b.id, b.from, b.to])).toEqual([
      ['b1', 0, 3],
      ['b2', 5, 10],
    ]);
  });

  it('keeps text typed at a block edge inside that block', () => {
    const insertAtStart = ChangeSet.of({ from: 10, insert: 'Hey ' }, 30);
    const moved = mapBlocks(blocks, insertAtStart);
    expect(moved[1]).toMatchObject({ from: 10, to: 24 });
    expect(moved[2]).toMatchObject({ from: 26, to: 34 });
    const insertAtEnd = ChangeSet.of({ from: 20, insert: '!' }, 30);
    expect(mapBlocks(blocks, insertAtEnd)[1]).toMatchObject({ from: 10, to: 21 });
  });

  it('finds the blocks a selection touches, or the one a caret is in', () => {
    expect(blocksInRange(blocks, 5, 12).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(blocksInRange(blocks, 15, 15).map((b) => b.id)).toEqual(['b2']);
    expect(blocksInRange(blocks, 9, 9)).toEqual([]);
  });

  it('lives in editor state: mapped through edits, replaced by an effect', () => {
    let state = EditorState.create({ doc: '## Title\n\nMy words!!\n\nAI text.', extensions: [blocksField.init(() => blocks)] });
    state = state.update({ changes: { from: 0, insert: 'X' } }).state;
    expect(state.field(blocksField)[1]).toMatchObject({ from: 11, to: 21 });
    expect(pinnedLineStarts(state)).toEqual([11]);
    state = state.update({ effects: setBlocksEffect.of([]) }).state;
    expect(state.field(blocksField)).toEqual([]);
  });
});
