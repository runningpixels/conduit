import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillDraftDialog } from './SkillDraftDialog';

const { draftSkillFromChat, cancelSkillDraft, saveSkillDraft } = vi.hoisted(() => ({
  draftSkillFromChat: vi.fn(),
  cancelSkillDraft: vi.fn(),
  saveSkillDraft: vi.fn(),
}));

vi.mock('../ipc/client', () => ({ draftSkillFromChat, cancelSkillDraft, saveSkillDraft }));

const drafted = {
  name: 'weekly-report',
  description: 'Writes the weekly report. Use when the user asks for it.',
  body: '1. Gather the numbers.\n2. Write it up.',
};

const saved = {
  id: 'conduit:weekly-sales',
  name: 'weekly-sales',
  description: drafted.description,
  source: 'conduit',
  path: '/data/skills/weekly-sales',
  hasScripts: false,
  hasReferences: false,
  hasAssets: false,
};

describe('SkillDraftDialog', () => {
  beforeEach(() => {
    draftSkillFromChat.mockReset();
    cancelSkillDraft.mockReset().mockResolvedValue(true);
    saveSkillDraft.mockReset();
  });

  it('shows Drafting… and stops the draft when cancelled', async () => {
    draftSkillFromChat.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<SkillDraftDialog conversationId="c1" onClose={onClose} onSaved={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Make a skill from this chat' })).toBeInTheDocument();
    expect(screen.getByText('Drafting…')).toBeInTheDocument();
    expect(draftSkillFromChat).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelSkillDraft).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(saveSkillDraft).not.toHaveBeenCalled();
  });

  it('lets the draft be edited, then saves it for the chat', async () => {
    draftSkillFromChat.mockResolvedValue(drafted);
    saveSkillDraft.mockResolvedValue(saved);
    const onSaved = vi.fn();
    render(<SkillDraftDialog conversationId="c1" onClose={vi.fn()} onSaved={onSaved} />);
    const name = await screen.findByLabelText(/^Name/);
    expect(name).toHaveValue('weekly-report');
    expect(screen.getByLabelText('Description')).toHaveValue(drafted.description);
    expect(screen.getByLabelText('Instructions')).toHaveValue(drafted.body);
    fireEvent.change(name, { target: { value: 'weekly-sales' } });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Just the totals.' } });
    expect(saveSkillDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveSkillDraft).toHaveBeenCalledWith(
        { name: 'weekly-sales', description: drafted.description, body: 'Just the totals.' },
        'c1',
        false,
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });

  it('asks before replacing a skill of the same name', async () => {
    draftSkillFromChat.mockResolvedValue(drafted);
    saveSkillDraft
      .mockRejectedValueOnce({ code: 'error.skills.exists', params: { name: 'weekly-report' }, fallback: 'exists' })
      .mockResolvedValueOnce(saved);
    const onSaved = vi.fn();
    render(<SkillDraftDialog conversationId="c1" onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByLabelText(/^Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A skill named weekly-report exists. Replace it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(saveSkillDraft).toHaveBeenLastCalledWith(drafted, 'c1', true));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows a failed draft and can try again', async () => {
    draftSkillFromChat.mockRejectedValueOnce('Drafting took too long.').mockResolvedValueOnce(drafted);
    render(<SkillDraftDialog conversationId="c1" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Couldn't draft a skill: Drafting took too long.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('weekly-report');
    expect(draftSkillFromChat).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape without saving', async () => {
    draftSkillFromChat.mockResolvedValue(drafted);
    const onClose = vi.fn();
    render(<SkillDraftDialog conversationId="c1" onClose={onClose} onSaved={vi.fn()} />);
    await screen.findByLabelText(/^Name/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(cancelSkillDraft).not.toHaveBeenCalled();
    expect(saveSkillDraft).not.toHaveBeenCalled();
  });
});
