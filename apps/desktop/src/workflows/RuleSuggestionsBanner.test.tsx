import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ setWorkflowActionRules: vi.fn(), suggestCommandRules: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import { RuleSuggestionsBanner } from './RuleSuggestionsBanner';

const rules: WorkflowActionRules = { allowAll: false, allowed: [], commands: { allow: ['git status'], deny: ['git push *'] } };
const suggestions = [
  { rule: 'git diff *', times: 2, example: 'git diff --stat' },
  { rule: 'npm test', times: 1, example: 'npm test' },
];

function Harness({ enabled = true }: { enabled?: boolean }) {
  const [current, setCurrent] = useState(rules);
  return <RuleSuggestionsBanner workflowId="w1" rules={current} runKey="r1" enabled={enabled} onRules={setCurrent} />;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  ipc.suggestCommandRules.mockResolvedValue(suggestions);
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
});

describe('RuleSuggestionsBanner', () => {
  it('counts the questions and allows only the ticked rules', async () => {
    render(<Harness />);
    expect(await screen.findByText('This workflow asked you 3 times. Allow these from now on?')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /git diff \*/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /npm test/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow selected' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status', 'git diff *'], deny: ['git push *'] },
      }),
    );
    await waitFor(() => expect(screen.queryByText(/asked you/)).toBeNull());
  });

  it('hides for good on “Not now”', async () => {
    const { unmount } = render(<Harness />);
    await screen.findByText(/asked you/);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText(/asked you/)).toBeNull());
    unmount();
    render(<Harness />);
    await waitFor(() => expect(ipc.suggestCommandRules).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/asked you/)).toBeNull();
  });

  it('asks nothing while a run is going or there is nothing to suggest', async () => {
    const { unmount } = render(<Harness enabled={false} />);
    expect(ipc.suggestCommandRules).not.toHaveBeenCalled();
    unmount();
    ipc.suggestCommandRules.mockResolvedValue([]);
    const { container } = render(<Harness />);
    await waitFor(() => expect(ipc.suggestCommandRules).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
