import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules, WorkflowComputer } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({
  setWorkflowActionRules: vi.fn(),
  previewCommandRule: vi.fn(),
  suggestCommandRules: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

import { ActionRulesSection } from './ActionRulesSection';

const rules: WorkflowActionRules = {
  allowAll: false,
  allowed: [],
  commands: { allow: ['git status', 'git log *'], deny: ['git push *'] },
};

function Harness({ initial = rules, computer }: { initial?: WorkflowActionRules; computer?: WorkflowComputer }) {
  const [current, setCurrent] = useState(initial);
  return <ActionRulesSection workflowId="w1" steps={[]} usesComputer computer={computer} rules={current} onRules={setCurrent} />;
}

const ALLOW = /New rule for: Runs without asking/;
const DENY = /New rule for: Always ask first/;

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  ipc.suggestCommandRules.mockResolvedValue([]);
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
  ipc.previewCommandRule.mockResolvedValue({ error: null, covers: ['git log --oneline'], doesNotCover: ['git push'] });
});

describe('ActionRulesSection: this computer', () => {
  it('shows the group, both lists and the always-ask wording', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'This computer' })).toBeInTheDocument();
    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.getByText('git push *')).toBeInTheDocument();
    expect(screen.getByText('A matching command asks every time, even when a rule above allows it.')).toBeInTheDocument();
    expect(screen.queryByText(/never run/i)).toBeNull();
    expect(screen.queryByText(/refused/i)).toBeNull();
  });

  it('says how often an allow rule was used, or that it was not', () => {
    const withUses: WorkflowActionRules = {
      ...rules,
      commands: {
        ...rules.commands!,
        uses: [{ rule: 'git status', count: 4, lastUsedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }],
      },
    };
    render(<Harness initial={withUses} />);
    expect(screen.getByText(/^Used 4× · /)).toBeInTheDocument();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
  });

  it('summarises files and confinement from the computer settings', () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByText('Files: asks before changing')).toBeInTheDocument();
    expect(screen.getByText('Commands stay in the folder with almost no network')).toBeInTheDocument();
    unmount();
    render(<Harness computer={{ editMode: 'free', allowOutside: true }} />);
    expect(screen.getByText('Files: changes freely in the folder')).toBeInTheDocument();
    expect(screen.getByText('Not confined')).toBeInTheDocument();
  });

  it('lists the built-in protections in a collapsed section', () => {
    render(<Harness />);
    const details = screen.getByText('Built in: always asks').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent(/Deleting files/);
    expect(details).toHaveTextContent(/Programs that run code/);
  });

  it('previews while typing and saves the new allow rule with the rest', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: ALLOW }), { target: { value: 'git diff *' } });
    expect(await screen.findByText('git log --oneline')).toBeInTheDocument();
    expect(ipc.previewCommandRule).toHaveBeenLastCalledWith('git diff *');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to: Runs without asking/ }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status', 'git log *', 'git diff *'], deny: ['git push *'] },
      }),
    );
  });

  it('removes an always-ask rule', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule git push *' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status', 'git log *'], deny: [] },
      }),
    );
  });

  it('shows what the preview says is wrong and refuses to add', async () => {
    ipc.previewCommandRule.mockResolvedValue({ error: 'Only a trailing * is allowed', covers: [], doesNotCover: [] });
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: DENY }), { target: { value: 'g*t' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a trailing * is allowed');
    expect(screen.getByRole('button', { name: /Add a rule to: Always ask first/ })).toBeDisabled();
  });

  it('shows the backend error when saving is refused', async () => {
    ipc.setWorkflowActionRules.mockRejectedValue({ message: 'Rule "x y" does not parse' });
    render(<Harness />);
    const box = screen.getByRole('textbox', { name: ALLOW });
    fireEvent.change(box, { target: { value: 'x y' } });
    await screen.findByText('git log --oneline');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to: Runs without asking/ }));
    expect(await screen.findByText('Rule "x y" does not parse')).toBeInTheDocument();
    expect(box).toHaveValue('x y');
  });
});

describe('ActionRulesSection: suggestions', () => {
  const suggestion = { rule: 'git diff *', times: 2, example: 'git diff --stat' };

  it('adds a suggested rule and keeps the always-ask list', async () => {
    ipc.suggestCommandRules.mockResolvedValue([suggestion]);
    render(<Harness />);
    expect(await screen.findByText('You approved git diff --stat 2×')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow git diff *' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status', 'git log *', 'git diff *'], deny: ['git push *'] },
      }),
    );
    await waitFor(() => expect(screen.queryByText('You approved git diff --stat 2×')).toBeNull());
  });

  it('remembers “Not now” for this workflow', async () => {
    ipc.suggestCommandRules.mockResolvedValue([suggestion]);
    const { unmount } = render(<Harness />);
    await screen.findByText('You approved git diff --stat 2×');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText('You approved git diff --stat 2×')).toBeNull());
    unmount();
    render(<Harness />);
    await waitFor(() => expect(ipc.suggestCommandRules).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('You approved git diff --stat 2×')).toBeNull();
  });
});
