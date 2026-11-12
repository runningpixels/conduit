import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrowserQuestionGate } from './BrowserPromptBlock';
import { answerBrowserQuestion } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  answerBrowserQuestion: vi.fn(async () => undefined),
  answerBrowserAction: vi.fn(async () => undefined),
}));

describe('BrowserQuestionGate', () => {
  it('says a known question from its code and values', () => {
    render(
      <BrowserQuestionGate
        toolCallId="call-1"
        question="(English from the backend)"
        decline="Don't sign in"
        code="chat.browser.question.signIn"
        params={{ site: 'github.com' }}
      />,
    );
    expect(screen.getByText(/Sign in to github\.com in the agent’s browser window/)).toBeInTheDocument();
    expect(screen.queryByText('(English from the backend)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t sign in' }));
    expect(answerBrowserQuestion).toHaveBeenCalledWith('call-1', false);
  });

  it('shows the backend text for a question without a known code', () => {
    render(<BrowserQuestionGate toolCallId="call-1" question="Something new" decline="Skip this page" code="x.y" />);
    expect(screen.getByText('Something new')).toBeInTheDocument();
  });
});
