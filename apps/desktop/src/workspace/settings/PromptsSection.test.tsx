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

import { listPrompts, listPromptFolders } from '../../ipc/client';

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
  await waitFor(() => expect(screen.getByText(prompts[0].title)).toBeTruthy());
  return onInsertPrompt;
}

describe('inserting a prompt that declares variables', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the values instead of inserting the raw tokens', async () => {
    const onInsertPrompt = await renderWith([prompt()]);

    fireEvent.click(screen.getByTitle(/insert/i));

    // The dialog is up and nothing has reached the composer yet.
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    expect(onInsertPrompt).not.toHaveBeenCalled();
  });

  it('inserts the filled body, with no tokens left behind', async () => {
    const onInsertPrompt = await renderWith([prompt()]);
    fireEvent.click(screen.getByTitle(/insert/i));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/place/i), { target: { value: 'Conduit' } });
    // Scope to the dialog: the prompt row has its own Insert button.
    const dialog = screen.getByRole('dialog', { name: /fill in variables/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /insert/i }));

    await waitFor(() => expect(onInsertPrompt).toHaveBeenCalledTimes(1));
    const inserted = vi.mocked(onInsertPrompt).mock.calls[0][0] as string;
    expect(inserted).toBe('Hello Ada, welcome to Conduit.');
    expect(inserted).not.toContain('{{');
  });

  it('inserts nothing when the fill is cancelled', async () => {
    const onInsertPrompt = await renderWith([prompt()]);
    fireEvent.click(screen.getByTitle(/insert/i));
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

    fireEvent.click(screen.getByTitle(/insert/i));

    expect(onInsertPrompt).toHaveBeenCalledWith('Summarise the last message.');
    expect(screen.queryByLabelText(/name/i)).toBeNull();
  });
});
