import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { appPromptLabel } from '../chat/appPrompt';
import { useT } from '../i18n';
import { selectionMessage, type SelectionRequest } from './selectionMessage';
import { SelectionToolbar } from './SelectionToolbar';

function t() {
  return renderHook(() => useT()).result.current;
}

const base: SelectionRequest = {
  action: 'shorter',
  blockIds: ['b4', 'b5'],
  pinnedIds: [],
  text: 'We moved forty repositories into one over a single quarter.',
};

describe('selectionMessage', () => {
  it('names the blocks, quotes the text and says what to do', () => {
    const message = selectionMessage(t(), base);
    expect(appPromptLabel(message)).toBe('Make “We moved forty repositories into one over a sin…” shorter');
    const body = message.slice(message.indexOf('\n') + 1);
    expect(body).toContain('Make the selected text shorter.');
    expect(body).toContain('Selected blocks: b4, b5');
    expect(body).toContain(`"""\n${base.text}\n"""`);
    expect(body).toContain('Use edit_blocks on these blocks only');
    expect(body).not.toContain('release_pinned');
  });

  it('says the user is asking to change their own text when the selection is pinned', () => {
    const message = selectionMessage(t(), { ...base, action: 'rewrite', pinnedIds: ['b5'] });
    expect(message).toContain('The user wrote blocks b5 themselves, and is asking to change that text.');
    expect(message).toContain('release_pinned: ["b5"]');
  });

  it('sends the instruction typed for Ask…', () => {
    const message = selectionMessage(t(), { ...base, action: 'ask', instruction: '  Add a number  ' });
    expect(appPromptLabel(message)).toBe('Add a number');
    const body = message.slice(message.indexOf('\n') + 1);
    expect(body.startsWith('Add a number\n')).toBe(true);
    expect(body).toContain('Selected blocks: b4, b5');
  });
});

describe('SelectionToolbar', () => {
  it('offers the six actions and reports the one clicked', () => {
    const onAction = vi.fn();
    render(<SelectionToolbar position={{ top: 0, left: 0 }} touchesPinned={false} onAction={onAction} onDismiss={vi.fn()} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Rewrite', 'Shorter', 'Longer', 'Clearer', 'Fix grammar', 'Ask…']);
    fireEvent.click(screen.getByRole('button', { name: 'Fix grammar' }));
    expect(onAction).toHaveBeenCalledWith('grammar');
  });

  it('Ask… takes an instruction and sends it', () => {
    const onAction = vi.fn();
    render(<SelectionToolbar position={{ top: 0, left: 0 }} touchesPinned={false} onAction={onAction} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask…' }));
    const input = screen.getByLabelText('What should change?');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Use a metaphor' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAction).toHaveBeenCalledWith('ask', 'Use a metaphor');
  });

  it('warns that the selection includes the user’s own text', () => {
    render(<SelectionToolbar position={{ top: 0, left: 0 }} touchesPinned onAction={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Includes text you wrote: the AI may change it for this request.')).toBeInTheDocument();
  });

  it('Escape closes it', () => {
    const onDismiss = vi.fn();
    render(<SelectionToolbar position={{ top: 0, left: 0 }} touchesPinned={false} onAction={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Rewrite' }), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });
});
