import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { hideQuickAsk, submitQuickAsk } from './quickAskIpc';
import { QuickAskApp } from './QuickAskApp';

vi.mock('./quickAskIpc', () => ({
  submitQuickAsk: vi.fn(async () => true),
  hideQuickAsk: vi.fn(async () => {}),
}));
vi.mock('../ipc/client', () => ({
  getSettings: vi.fn(async () => ({ theme: 'light' })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /^Ask / }) as HTMLTextAreaElement;
}

describe('QuickAskApp', () => {
  it('takes the cursor and follows the app theme', async () => {
    render(<QuickAskApp />);
    expect(box()).toHaveFocus();
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
  });

  it('sends the trimmed text on Enter and clears the box', () => {
    render(<QuickAskApp />);
    fireEvent.change(box(), { target: { value: '  what is a monad?  ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(submitQuickAsk).toHaveBeenCalledWith('what is a monad?');
    expect(box().value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    render(<QuickAskApp />);
    fireEvent.change(box(), { target: { value: 'line one' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(submitQuickAsk).not.toHaveBeenCalled();
    expect(box().value).toBe('line one');
  });

  it('ignores Enter on an empty or blank box', () => {
    render(<QuickAskApp />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(submitQuickAsk).not.toHaveBeenCalled();
  });

  it('hides on Esc without sending', () => {
    render(<QuickAskApp />);
    fireEvent.change(box(), { target: { value: 'never mind' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(hideQuickAsk).toHaveBeenCalledTimes(1);
    expect(submitQuickAsk).not.toHaveBeenCalled();
  });
});
