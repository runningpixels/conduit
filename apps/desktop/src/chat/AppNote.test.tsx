import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppNote } from './AppNote';
import { appPrompt, appPromptBody } from './appPrompt';

describe('AppNote', () => {
  it('opens to show what was sent, and closes again', () => {
    const sent = appPrompt('Reviewer found 2 things to fix in “Plan”', '1. Day 3 is not a rest day\n2. Over the limit');
    render(<AppNote messageId="m1" label="Reviewer found 2 things to fix in “Plan”" body={appPromptBody(sent)} />);
    const note = screen.getByRole('button', { name: 'Reviewer found 2 things to fix in “Plan”' });
    expect(note).toHaveAttribute('aria-expanded', 'false');
    expect(note).toHaveAttribute('title', 'Show what was sent');
    expect(screen.queryByText(/Day 3 is not a rest day/)).toBeNull();
    fireEvent.click(note);
    expect(note).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/1\. Day 3 is not a rest day\s+2\. Over the limit/)).toBeInTheDocument();
    fireEvent.click(note);
    expect(screen.queryByText(/Day 3 is not a rest day/)).toBeNull();
  });

  it('is plain text when nothing was sent with it', () => {
    const { container } = render(<AppNote messageId="m2" label="Build slides" body="  " />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-message-id="m2"] .app-note-text')?.textContent).toBe('Build slides');
  });
});

describe('appPromptBody', () => {
  it('is the text after the label line, and empty for a typed message', () => {
    expect(appPromptBody(appPrompt('Note', 'line one\nline two'))).toBe('line one\nline two');
    expect(appPromptBody('typed by the user')).toBe('');
  });
});
