import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DraftDetail } from '../ipc/contracts';
import { WritingStudio, type WritingStudioProps } from './WritingStudio';

beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
});

function draft(over: Partial<DraftDetail> = {}): DraftDetail {
  return {
    id: 'd1',
    title: 'Monorepo post',
    conversationId: 'c1',
    stage: 'outline',
    brief: 'A blog post for backend developers.',
    outline: [{ heading: 'Why', intent: 'The pain', targetWords: 300 }],
    markdown: '',
    blocks: [],
    words: 0,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function props(over: Partial<WritingStudioProps> = {}): WritingStudioProps {
  return {
    draft: draft(),
    busyTool: null,
    streaming: false,
    resetToken: 0,
    onBack: vi.fn(),
    onRename: vi.fn(),
    onSetOutline: vi.fn(),
    onApproveOutline: vi.fn(),
    onSave: vi.fn(async () => null),
    onUnpin: vi.fn(),
    onSelectionRequest: vi.fn(),
    onExport: vi.fn(),
    ...over,
  };
}

const DRAFTED = draft({
  stage: 'draft',
  markdown: '## Why\n\nBecause.',
  blocks: [
    { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 6 },
    { id: 'b2', kind: 'paragraph', owner: 'ai', pinned: false, start: 8, end: 16 },
  ],
  words: 2,
});

describe('WritingStudio', () => {
  it('outline stage: shows the brief and the outline to approve, not the editor', () => {
    const p = props();
    render(<WritingStudio {...p} />);
    expect(screen.getByText('A blog post for backend developers.')).toBeInTheDocument();
    expect(screen.getByLabelText('Section 1 heading')).toHaveValue('Why');
    expect(document.querySelector('.cm-editor')).toBeNull();
    const steps = within(screen.getByRole('list', { name: 'Steps' }));
    expect(steps.getByText('Outline')).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Approve outline' }));
    expect(p.onApproveOutline).toHaveBeenCalled();
    // Nothing to export or tint yet.
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Show AI-written text' })).toBeNull();
  });

  it('draft stage: shows the editor with the draft text', () => {
    render(<WritingStudio {...props({ draft: DRAFTED })} />);
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(document.querySelector('.cm-content')?.textContent).toContain('Because.');
    expect(screen.queryByRole('button', { name: 'Approve outline' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Steps' })).getByText('Draft')).toHaveAttribute('aria-current', 'step');
  });

  it('makes the editor read-only while the assistant streams', () => {
    render(<WritingStudio {...props({ draft: DRAFTED, streaming: true })} />);
    expect(screen.getByText('The assistant is editing…')).toBeInTheDocument();
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByText('Updating…')).toBeInTheDocument();
  });

  it('toggles the AI-written tint, on by default', () => {
    render(<WritingStudio {...props({ draft: DRAFTED })} />);
    const toggle = screen.getByRole('button', { name: 'Show AI-written text' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('.draft-line-ai').length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelectorAll('.draft-line-ai')).toHaveLength(0);
    fireEvent.click(toggle);
  });

  it('exports as Markdown or HTML', () => {
    const p = props({ draft: DRAFTED });
    render(<WritingStudio {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Markdown file (.md)' }));
    expect(p.onExport).toHaveBeenLastCalledWith('markdown');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'HTML file (.html)' }));
    expect(p.onExport).toHaveBeenLastCalledWith('html');
  });

  it('renames on Enter and goes back to the list', () => {
    const p = props();
    render(<WritingStudio {...p} />);
    const title = screen.getByLabelText('Draft title');
    fireEvent.change(title, { target: { value: 'Why one repo' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.blur(title);
    expect(p.onRename).toHaveBeenCalledWith('Why one repo');
    fireEvent.click(screen.getByRole('button', { name: /All drafts/ }));
    expect(p.onBack).toHaveBeenCalled();
  });
});
