import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PromptsSection } from './PromptsSection';
import type { Prompt } from '../../ipc/contracts';

/**
 * Inserting a saved prompt.
 *
 * `VariableFillDialog` existed for a long time with no call site at all, so a
 * prompt containing `{{name}}` inserted those tokens verbatim and left the
 * user to find and fix them by hand. These pin the wiring: a prompt with
 * variables is filled in first, one without is inserted straight away, and
 * cancelling inserts nothing.
 */

vi.mock('../../ipc/client', () => ({
  listPrompts: vi.fn(),
  listPromptFolders: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
}));

import { createPrompt, deletePrompt, listPrompts, listPromptFolders, updatePrompt } from '../../ipc/client';

function prompt(over: Partial<Prompt> = {}): Prompt {
  return {
    id: 'p1',
    title: 'Greeting',
    body: 'Hello {{name}}, welcome to {{place}}.',
    variables: ['name', 'place'],
    folder: null,
    tags: [],
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...over,
  } as Prompt;
}

async function renderWith(prompts: Prompt[], onInsertPrompt = vi.fn()) {
  vi.mocked(listPrompts).mockResolvedValue(prompts);
  vi.mocked(listPromptFolders).mockResolvedValue([]);
  render(<PromptsSection onStatus={vi.fn()} onInsertPrompt={onInsertPrompt} />);
  await screen.findByRole('heading', { name: prompts[0].title });
  return onInsertPrompt;
}

describe('inserting a prompt that declares variables', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the values instead of inserting the raw tokens', async () => {
    const onInsertPrompt = await renderWith([prompt()]);

    fireEvent.click(screen.getByRole('button', { name: 'Insert into chat' }));

    // The dialog is up and nothing has reached the composer yet.
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    expect(onInsertPrompt).not.toHaveBeenCalled();
  });

  it('inserts the filled body, with no tokens left behind', async () => {
    const onInsertPrompt = await renderWith([prompt()]);
    fireEvent.click(screen.getByRole('button', { name: 'Insert into chat' }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/place/i), { target: { value: 'Conduit' } });
    // Scope to the dialog: the detail pane has its own Insert button.
    const dialog = screen.getByRole('dialog', { name: /fill in variables/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /insert/i }));

    await waitFor(() => expect(onInsertPrompt).toHaveBeenCalledTimes(1));
    const inserted = vi.mocked(onInsertPrompt).mock.calls[0][0] as string;
    expect(inserted).toBe('Hello Ada, welcome to Conduit.');
    expect(inserted).not.toContain('{{');
  });

  it('inserts nothing when the fill is cancelled', async () => {
    const onInsertPrompt = await renderWith([prompt()]);
    fireEvent.click(screen.getByRole('button', { name: 'Insert into chat' }));
    const dialog = screen.getByRole('dialog', { name: /fill in variables/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(onInsertPrompt).not.toHaveBeenCalled();
  });
});

describe('inserting a prompt with no variables', () => {
  beforeEach(() => vi.clearAllMocks());

  it('goes straight to the composer with no dialog', async () => {
    const onInsertPrompt = await renderWith([
      prompt({ body: 'Summarise the last message.', variables: [] }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Insert into chat' }));

    expect(onInsertPrompt).toHaveBeenCalledWith('Summarise the last message.');
    expect(screen.queryByLabelText(/name/i)).toBeNull();
  });
});

describe('list and detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  const two = () => [
    prompt(),
    prompt({ id: 'p2', title: 'Summary', body: 'Summarise this.', variables: [], folder: 'work', tags: ['daily', 'short'] }),
  ];

  it('selects the first prompt by default and shows its body with variables highlighted', async () => {
    await renderWith(two());
    const items = screen.getAllByRole('button', { name: /Greeting|Summary/ });
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('{{name}}')).toHaveClass('variable-token');
  });

  it('shows the selected prompt when another row is chosen, with its folder and tags', async () => {
    await renderWith(two());
    fireEvent.click(screen.getByRole('button', { name: /^Summary/ }));
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('Summarise this.')).toBeInTheDocument();
    expect(screen.getByText('daily')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Summary/ })).toHaveAttribute('aria-current', 'true');
  });

  it('filters by folder', async () => {
    vi.mocked(listPrompts).mockResolvedValue(two());
    vi.mocked(listPromptFolders).mockResolvedValue(['work']);
    render(<PromptsSection onStatus={vi.fn()} onInsertPrompt={vi.fn()} />);
    const filter = await screen.findByLabelText('Folder');
    fireEvent.change(filter, { target: { value: 'work' } });
    await waitFor(() => expect(listPrompts).toHaveBeenLastCalledWith('work'));
  });

  it('shows the empty state with a New prompt action when there are none', async () => {
    vi.mocked(listPrompts).mockResolvedValue([]);
    vi.mocked(listPromptFolders).mockResolvedValue([]);
    render(<PromptsSection onStatus={vi.fn()} onInsertPrompt={vi.fn()} />);
    expect(await screen.findByText('Save a prompt once, then insert it into any chat.')).toBeInTheDocument();
    // Header action + empty-state action.
    expect(screen.getAllByRole('button', { name: 'New prompt' })).toHaveLength(2);
  });

  it('creates a prompt from the editor, and requires a title and body', async () => {
    const onStatus = vi.fn();
    vi.mocked(listPrompts).mockResolvedValue([]);
    vi.mocked(listPromptFolders).mockResolvedValue([]);
    vi.mocked(createPrompt).mockResolvedValue(prompt({ id: 'new' }));
    render(<PromptsSection onStatus={onStatus} onInsertPrompt={vi.fn()} />);
    await screen.findByText('No prompts yet', { selector: '.page-empty-title' });
    fireEvent.click(screen.getAllByRole('button', { name: 'New prompt' })[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onStatus).toHaveBeenCalledWith('Title and body are required');
    expect(createPrompt).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hi' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Hello {{who}}' } });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'misc' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createPrompt).toHaveBeenCalledWith('Hi', 'Hello {{who}}', 'misc', ['a', 'b']));
    expect(onStatus).toHaveBeenCalledWith('Prompt created');
  });

  it('edits the selected prompt inline', async () => {
    await renderWith(two());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('Greeting');
    fireEvent.change(title, { target: { value: 'Welcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updatePrompt).toHaveBeenCalledWith('p1', 'Welcome', 'Hello {{name}}, welcome to {{place}}.', undefined, []),
    );
  });

  it('deletes the selected prompt after confirming', async () => {
    await renderWith(two());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(deletePrompt).toHaveBeenCalledWith('p1'));
  });

  it('keeps the prompt when the delete is not confirmed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderWith(two());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deletePrompt).not.toHaveBeenCalled();
  });
});
