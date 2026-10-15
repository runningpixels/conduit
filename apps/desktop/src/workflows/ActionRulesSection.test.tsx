import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules, WorkflowStep } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ setWorkflowActionRules: vi.fn(), suggestCommandRules: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import { ActionRulesSection, hasPermissions } from './ActionRulesSection';

const connectorStep: WorkflowStep = { id: 'c', type: 'connector_tool', connector: 'slack', tool: 'post', arguments: {} };
const plainStep: WorkflowStep = { id: 's', type: 'template', template: 'x' };
const rules: WorkflowActionRules = {
  allowAll: false,
  allowed: [
    { connectorId: 'slack', connectorName: 'Slack', tool: 'post_message' },
    { connectorId: 'mail', connectorName: 'Mail', tool: 'send' },
  ],
};

function Harness({ initial, steps }: { initial: WorkflowActionRules; steps: WorkflowStep[] }) {
  const [current, setCurrent] = useState(initial);
  return <ActionRulesSection workflowId="w1" steps={steps} rules={current} onRules={setCurrent} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  ipc.suggestCommandRules.mockResolvedValue([]);
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
});

describe('ActionRulesSection connectors', () => {
  it('has its own heading and summary, lists what is allowed and removes one', async () => {
    render(<Harness initial={rules} steps={[connectorStep]} />);
    expect(screen.getByRole('region', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.getByText('Asks before each outside action, except 2 you allowed')).toBeInTheDocument();
    expect(screen.queryByText('This computer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop allowing “post_message” in Slack' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        allowAll: false,
        allowed: [{ connectorId: 'mail', connectorName: 'Mail', tool: 'send' }],
      }),
    );
    await waitFor(() => expect(screen.queryByText('“post_message” in Slack')).toBeNull());
  });

  it('turns asking off and on', async () => {
    render(<Harness initial={{ allowAll: false, allowed: [] }} steps={[connectorStep]} />);
    const box = screen.getByRole('checkbox', { name: 'Ask me before each outside action' });
    expect(box).toBeChecked();
    expect(screen.getByText('Nothing is allowed without asking.')).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', { allowAll: true, allowed: [] }));
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('says when it could not save', async () => {
    ipc.setWorkflowActionRules.mockRejectedValue('Disk is full');
    render(<Harness initial={rules} steps={[connectorStep]} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ask me before each outside action' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full');
  });
});

describe('hasPermissions', () => {
  const none: WorkflowActionRules = { allowAll: false, allowed: [], commands: { allow: [], deny: [] } };

  it('is false without connector steps, computer or rules', () => {
    expect(hasPermissions([plainStep], false, none)).toBe(false);
    expect(hasPermissions([plainStep], false, null)).toBe(false);
  });

  it('is true for a connector step, the computer, or rules that are not the default', () => {
    expect(hasPermissions([connectorStep], false, none)).toBe(true);
    expect(hasPermissions([plainStep], true, none)).toBe(true);
    expect(hasPermissions([plainStep], false, rules)).toBe(true);
  });

  it('is true for an agent step with a connector tool, inside a loop', () => {
    const loop: WorkflowStep = {
      id: 'l',
      type: 'for_each',
      items: '{{inputs.x}}',
      steps: [{ id: 'a', type: 'agent', prompt: 'p', tools: ['web_search', 'slack/post_message'] }],
    };
    expect(hasPermissions([loop], false, none)).toBe(true);
  });
});
