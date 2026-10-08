import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftSummary } from '../ipc/contracts';
import { WritingPage } from './WritingPage';

const ipc = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  renameDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

const draft: DraftSummary = {
  id: 'd1',
  title: 'Why we moved to a monorepo',
  stage: 'draft',
  words: 1240,
  updatedAt: '2026-10-01T11:00:00Z',
};

const outlining: DraftSummary = {
  id: 'd2',
  title: 'Q3 report',
  stage: 'outline',
  words: 0,
  updatedAt: '2026-10-01T10:00:00Z',
};

const BOX = 'What are you writing?';

beforeEach(() => {
  Object.values(ipc).forEach((fn) => fn.mockReset());
  ipc.listDrafts.mockResolvedValue([draft, outlining]);
});

describe('WritingPage', () => {
  it('lists drafts with their word count and stage, and opens one', async () => {
    const onOpenDraft = vi.fn();
    render(<WritingPage onOpenDraft={onOpenDraft} onStartDraft={vi.fn()} />);
    expect(await screen.findByText('Why we moved to a monorepo')).toBeInTheDocument();
    expect(screen.getByText('1,240 words')).toBeInTheDocument();
    expect(screen.getByText('Outline in progress')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Why we moved to a monorepo' }));
    expect(onOpenDraft).toHaveBeenCalledWith('d1');
  });

  it('reads the list again when a workflow changed a draft', async () => {
    const view = render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={vi.fn()} refreshKey={0} />);
    await screen.findByText('Q3 report');
    expect(ipc.listDrafts).toHaveBeenCalledTimes(1);
    ipc.listDrafts.mockResolvedValue([{ ...draft, words: 1500 }, outlining]);
    view.rerender(<WritingPage onOpenDraft={vi.fn()} onStartDraft={vi.fn()} refreshKey={1} />);
    expect(await screen.findByText('1,500 words')).toBeInTheDocument();
    expect(ipc.listDrafts).toHaveBeenCalledTimes(2);
  });

  it('shows the empty state', async () => {
    ipc.listDrafts.mockResolvedValue([]);
    render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={vi.fn()} />);
    expect(await screen.findByText('No drafts yet')).toBeInTheDocument();
  });

  it('fills the box from a starter chip, keeping what was typed', async () => {
    render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={vi.fn()} />);
    await screen.findByText('Q3 report');
    const box = screen.getByLabelText(BOX) as HTMLTextAreaElement;
    const chips = within(screen.getByRole('group', { name: 'Starting points' }));
    expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Blog post',
      'Technical doc',
      'Report',
      'Newsletter',
      'Essay',
    ]);
    fireEvent.click(chips.getByRole('button', { name: 'Blog post' }));
    expect(box.value).toMatch(/^A blog post about \[topic\]\.\n/);
    fireEvent.click(chips.getByRole('button', { name: 'Essay' }));
    expect(box.value).toContain('A blog post about');
    expect(box.value).toContain('An essay arguing that');
  });

  it('creates a draft from the trimmed brief and clears the box', async () => {
    const onStartDraft = vi.fn().mockResolvedValue(undefined);
    render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={onStartDraft} />);
    await screen.findByText('Q3 report');
    const start = screen.getByRole('button', { name: 'Start draft' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText(BOX), { target: { value: '  A post on monorepos \n' } });
    fireEvent.click(start);
    await waitFor(() => expect(onStartDraft).toHaveBeenCalledWith('A post on monorepos'));
    await waitFor(() => expect((screen.getByLabelText(BOX) as HTMLTextAreaElement).value).toBe(''));
    expect(ipc.listDrafts).toHaveBeenCalledTimes(2);
  });

  it('starts with Ctrl+Enter, and reports a failure without losing the brief', async () => {
    const onStatus = vi.fn();
    const onStartDraft = vi.fn().mockRejectedValue(new Error('no model'));
    render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={onStartDraft} onStatus={onStatus} />);
    await screen.findByText('Q3 report');
    const box = screen.getByLabelText(BOX) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'An essay' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('no model'));
    expect(box.value).toBe('An essay');
  });

  it('renames and deletes a draft', async () => {
    ipc.renameDraft.mockResolvedValue({});
    ipc.deleteDraft.mockResolvedValue(undefined);
    const onStatus = vi.fn();
    render(<WritingPage onOpenDraft={vi.fn()} onStartDraft={vi.fn()} onStatus={onStatus} />);
    await screen.findByText('Q3 report');
    fireEvent.click(screen.getByRole('button', { name: 'Rename Q3 report' }));
    const input = screen.getByRole('textbox', { name: 'Rename Q3 report' });
    fireEvent.change(input, { target: { value: 'Q3 report, final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(ipc.renameDraft).toHaveBeenCalledWith('d2', 'Q3 report, final'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Q3 report' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(ipc.deleteDraft).toHaveBeenCalledWith('d2'));
    expect(onStatus).toHaveBeenCalledWith('Deleted “Q3 report”');
  });
});
