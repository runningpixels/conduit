import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({
  getWorkflowActionRules: vi.fn(),
  setWorkflowActionRules: vi.fn(),
  previewCommandRule: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

import { ActionRulesSection } from './ActionRulesSection';

const rules: WorkflowActionRules = {
  allowAll: false,
  allowed: [],
  commands: { allow: ['git status'], deny: ['git push *'] },
};

beforeEach(() => {
  vi.resetAllMocks();
  ipc.getWorkflowActionRules.mockResolvedValue(rules);
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
  ipc.previewCommandRule.mockResolvedValue({ error: null, covers: ['git log --oneline'], doesNotCover: ['git push'] });
});

describe('ActionRulesSection command rules', () => {
  it('shows allow and deny lists when the workflow uses the computer', async () => {
    render(<ActionRulesSection workflowId="w1" steps={[]} usesComputer />);
    expect(await screen.findByText('git status')).toBeInTheDocument();
    expect(screen.getByText('git push *')).toBeInTheDocument();
  });

  it('stays hidden without connectors, computer or rules', async () => {
    ipc.getWorkflowActionRules.mockResolvedValue({ allowAll: false, allowed: [], commands: { allow: [], deny: [] } });
    const { container } = render(<ActionRulesSection workflowId="w1" steps={[]} />);
    await waitFor(() => expect(ipc.getWorkflowActionRules).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('previews while typing and saves the new allow rule with the rest', async () => {
    render(<ActionRulesSection workflowId="w1" steps={[]} usesComputer />);
    await screen.findByText('git status');
    fireEvent.change(screen.getByRole('textbox', { name: /New rule for: Commands that run without asking/ }), {
      target: { value: 'git log *' },
    });
    expect(await screen.findByText('git log --oneline')).toBeInTheDocument();
    expect(ipc.previewCommandRule).toHaveBeenLastCalledWith('git log *');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to: Commands that run without asking/ }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status', 'git log *'], deny: ['git push *'] },
      }),
    );
  });

  it('removes a deny rule', async () => {
    render(<ActionRulesSection workflowId="w1" steps={[]} usesComputer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the rule git push *' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        commands: { allow: ['git status'], deny: [] },
      }),
    );
  });

  it('shows what the preview says is wrong and refuses to add', async () => {
    ipc.previewCommandRule.mockResolvedValue({ error: 'Only a trailing * is allowed', covers: [], doesNotCover: [] });
    render(<ActionRulesSection workflowId="w1" steps={[]} usesComputer />);
    await screen.findByText('git status');
    fireEvent.change(screen.getByRole('textbox', { name: /New rule for: Commands that never run/ }), {
      target: { value: 'g*t' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a trailing * is allowed');
    expect(screen.getByRole('button', { name: /Add a rule to: Commands that never run/ })).toBeDisabled();
  });

  it('shows the backend error when saving is refused', async () => {
    ipc.setWorkflowActionRules.mockRejectedValue({ message: 'Rule "x y" does not parse' });
    render(<ActionRulesSection workflowId="w1" steps={[]} usesComputer />);
    await screen.findByText('git status');
    const box = screen.getByRole('textbox', { name: /New rule for: Commands that run without asking/ });
    fireEvent.change(box, { target: { value: 'x y' } });
    await screen.findByText('git log --oneline');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to: Commands that run without asking/ }));
    expect(await screen.findByText('Rule "x y" does not parse')).toBeInTheDocument();
    expect(box).toHaveValue('x y');
  });
});
