import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import type { DraftBlock, DraftDetail } from '../ipc/contracts';
import { DraftEditor, type DraftEditorProps } from './DraftEditor';
import { blocksField } from './editorBlocks';

// jsdom has no layout: CodeMirror measures through these.
beforeAll(() => {
  const rect = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => rect as DOMRect;
});

const MARKDOWN = '## Intro\n\nFirst paragraph.\n\nSecond paragraph.';

function block(id: string, start: number, end: number, over: Partial<DraftBlock> = {}): DraftBlock {
  return { id, kind: 'paragraph', owner: 'ai', pinned: false, start, end, ...over };
}

function blocksFor(markdown: string, extra: Partial<Record<string, Partial<DraftBlock>>> = {}): DraftBlock[] {
  const out: DraftBlock[] = [];
  let at = 0;
  markdown.split('\n\n').forEach((text, i) => {
    const id = `b${i + 1}`;
    out.push(block(id, at, at + text.length, { kind: i === 0 ? 'heading' : 'paragraph', ...extra[id] }));
    at += text.length + 2;
  });
  return out;
}

function draft(over: Partial<DraftDetail> = {}): DraftDetail {
  const markdown = over.markdown ?? MARKDOWN;
  return {
    id: 'd1',
    title: 'Monorepo',
    conversationId: 'c1',
    stage: 'draft',
    brief: 'A post',
    outline: [],
    markdown,
    blocks: blocksFor(markdown),
    words: 5,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    sources: { webSearch: false, researchRunIds: [] },
    ...over,
  };
}

function props(over: Partial<DraftEditorProps> = {}): DraftEditorProps {
  return {
    draft: draft(),
    readOnly: false,
    showAiText: true,
    onSave: vi.fn(async (markdown: string) => draft({ markdown, blocks: blocksFor(markdown) })),
    onUnpin: vi.fn(),
    onSelectionRequest: vi.fn(),
    ...over,
  };
}

function view(): EditorView {
  const el = document.querySelector('.cm-editor') as HTMLElement;
  const found = EditorView.findFromDOM(el);
  if (!found) throw new Error('no editor');
  return found;
}

function type(at: number, text: string) {
  act(() => {
    view().dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DraftEditor', () => {
  it('shows the draft text with code blocks and AI-written lines marked', () => {
    const markdown = '## Intro\n\n```\ncode\n```';
    render(
      <DraftEditor
        {...props({
          draft: draft({ markdown, blocks: [block('b1', 0, 8, { kind: 'heading' }), block('b2', 10, 22, { kind: 'code', owner: 'user' })] }),
        })}
      />,
    );
    expect(view().state.doc.toString()).toBe(markdown);
    expect(document.querySelectorAll('.draft-line-code')).toHaveLength(3);
    expect(document.querySelectorAll('.draft-line-ai')).toHaveLength(1);
  });

  it('drops the AI tint when "Show AI-written text" is off', () => {
    const p = props();
    const { rerender } = render(<DraftEditor {...p} />);
    expect(document.querySelectorAll('.draft-line-ai').length).toBeGreaterThan(0);
    rerender(<DraftEditor {...p} showAiText={false} />);
    expect(document.querySelectorAll('.draft-line-ai')).toHaveLength(0);
  });

  it('saves 800 ms after typing stops, once, with the whole text', async () => {
    const p = props();
    render(<DraftEditor {...p} />);
    type(MARKDOWN.length, ' More.');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    type(MARKDOWN.length + 6, ' Again.');
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(p.onSave).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onSave).toHaveBeenCalledWith(`${MARKDOWN} More. Again.`);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('keeps the caret where it was when the save reply replaces the blocks', async () => {
    let resolveSave: (d: DraftDetail) => void = () => {};
    const p = props({ onSave: vi.fn(() => new Promise<DraftDetail>((r) => (resolveSave = r))) });
    render(<DraftEditor {...p} />);
    type(12, 'X');
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const sent = (p.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Typing continues while the save is out.
    type(sent.length, '!');
    const caret = view().state.selection.main.head;
    await act(async () => {
      resolveSave(draft({ markdown: sent, blocks: blocksFor(sent, { b2: { owner: 'mixed', pinned: true } }) }));
      await Promise.resolve();
    });
    expect(view().state.doc.toString()).toBe(`${sent}!`);
    expect(view().state.selection.main.head).toBe(caret);
    // The reply's pin landed on the right block, moved by nothing typed before it.
    const pinned = view().state.field(blocksField).find((b) => b.pinned);
    expect(pinned?.id).toBe('b2');
    expect(view().state.sliceDoc(pinned!.from, pinned!.to)).toBe('FiXrst paragraph.');
  });

  it('takes text written elsewhere without moving the caret', () => {
    const p = props();
    const { rerender } = render(<DraftEditor {...p} />);
    act(() => {
      view().dispatch({ selection: EditorSelection.cursor(3) });
    });
    const next = `${MARKDOWN}\n\nA third paragraph from the AI.`;
    rerender(<DraftEditor {...p} draft={draft({ markdown: next, blocks: blocksFor(next) })} />);
    expect(view().state.doc.toString()).toBe(next);
    expect(view().state.selection.main.head).toBe(3);
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('is read-only with a note while the assistant runs, and saves pending typing first', async () => {
    const p = props();
    const { rerender } = render(<DraftEditor {...p} />);
    type(MARKDOWN.length, ' Mine.');
    rerender(<DraftEditor {...p} readOnly />);
    expect(screen.getByRole('status')).toHaveTextContent('The assistant is editing…');
    expect(p.onSave).toHaveBeenCalledWith(`${MARKDOWN} Mine.`);
    expect(view().state.readOnly).toBe(true);
    expect(view().contentDOM.getAttribute('contenteditable')).toBe('false');
    rerender(<DraftEditor {...p} readOnly={false} />);
    expect(screen.queryByText('The assistant is editing…')).toBeNull();
    expect(view().state.readOnly).toBe(false);
  });

  it('marks pinned blocks in the gutter and offers Let AI edit', () => {
    const p = props({
      draft: draft({ blocks: blocksFor(MARKDOWN, { b2: { owner: 'user', pinned: true } }) }),
    });
    render(<DraftEditor {...p} />);
    // The gutter's sizing spacer is a marker too; the real ones name their block.
    const pins = document.querySelectorAll('.draft-pin[data-block="b2"]');
    expect(pins.length).toBeGreaterThan(0);
    expect((pins[0] as HTMLElement).title).toBe('You wrote this. The AI keeps it.');
    fireEvent.mouseDown(pins[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Let AI edit' }));
    expect(p.onUnpin).toHaveBeenCalledWith('b2');
  });

  it('offers Let AI edit for the pinned block the caret is in', () => {
    const p = props({
      draft: draft({ blocks: blocksFor(MARKDOWN, { b3: { owner: 'mixed', pinned: true } }) }),
    });
    render(<DraftEditor {...p} />);
    act(() => {
      view().dispatch({ selection: EditorSelection.cursor(MARKDOWN.length - 2) });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Let AI edit' }));
    expect(p.onUnpin).toHaveBeenCalledWith('b3');
  });

  it('sends a selection action with the selected blocks and text', async () => {
    const p = props({
      draft: draft({ blocks: blocksFor(MARKDOWN, { b3: { owner: 'user', pinned: true } }) }),
    });
    render(<DraftEditor {...p} />);
    const from = MARKDOWN.indexOf('paragraph.');
    const to = MARKDOWN.indexOf('Second') + 6;
    act(() => {
      view().dispatch({ selection: EditorSelection.range(from, to) });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Shorter' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(p.onSelectionRequest).toHaveBeenCalledWith({
      action: 'shorter',
      instruction: undefined,
      blockIds: ['b2', 'b3'],
      pinnedIds: ['b3'],
      text: MARKDOWN.slice(from, to),
    });
    // The selection is dropped, so the bar can't come back over the
    // rewritten text once the turn ends and the editor is editable again.
    expect(view().state.selection.main.empty).toBe(true);
    expect(screen.queryByRole('button', { name: 'Shorter' })).toBeNull();
  });

  it('hides the selection toolbar while read-only', () => {
    const p = props();
    const { rerender } = render(<DraftEditor {...p} />);
    act(() => {
      view().dispatch({ selection: EditorSelection.range(10, 20) });
    });
    expect(screen.getByRole('toolbar', { name: 'Change the selected text' })).toBeInTheDocument();
    rerender(<DraftEditor {...p} readOnly />);
    expect(screen.queryByRole('toolbar', { name: 'Change the selected text' })).toBeNull();
  });
});
