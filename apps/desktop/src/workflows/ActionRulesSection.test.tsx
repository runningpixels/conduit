import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules, WorkflowStep } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ getWorkflowActionRules: vi.fn(), setWorkflowActionRules: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import { ActionRulesSection } from './ActionRulesSection';

const connectorStep: WorkflowStep = { id: 'c', type: 'connector_tool', connector: 'slack', tool: 'post', arguments: {} };
const plainStep: WorkflowStep = { id: 's', type: 'template', template: 'x' };
const rules: WorkflowActionRules = {
  allowAll: false,
  allowed: [
    { connectorId: 'slack', connectorName: 'Slack', tool: 'post_message' },
    { connectorId: 'mail', connectorName: 'Mail', tool: 'send' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
});

describe('ActionRulesSection', () => {
  it('lists what is allowed and removes one', async () => {
    ipc.getWorkflowActionRules.mockResolvedValue(rules);
    render(<ActionRulesSection workflowId="w1" steps={[connectorStep]} />);
    expect(await screen.findByText('“post_message” in Slack')).toBeInTheDocument();
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
    ipc.getWorkflowActionRules.mockResolvedValue({ allowAll: false, allowed: [] });
    render(<ActionRulesSection workflowId="w1" steps={[connectorStep]} />);
    const box = await screen.findByRole('checkbox', { name: 'Ask me before each outside action' });
    expect(box).toBeChecked();
    expect(screen.getByText('Nothing is allowed without asking.')).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', { allowAll: true, allowed: [] }));
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('says when it could not save', async () => {
    ipc.getWorkflowActionRules.mockResolvedValue(rules);
    ipc.setWorkflowActionRules.mockRejectedValue('Disk is full');
    render(<ActionRulesSection workflowId="w1" steps={[connectorStep]} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Ask me before each outside action' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full');
  });

  it('is hidden without connector steps, unless the rules are not the default', async () => {
    ipc.getWorkflowActionRules.mockResolvedValue({ allowAll: false, allowed: [] });
    const { unmount } = render(<ActionRulesSection workflowId="w1" steps={[plainStep]} />);
    await waitFor(() => expect(ipc.getWorkflowActionRules).toHaveBeenCalled());
    expect(screen.queryByText('Outside actions')).toBeNull();
    unmount();
    ipc.getWorkflowActionRules.mockResolvedValue(rules);
    render(<ActionRulesSection workflowId="w1" steps={[plainStep]} />);
    expect(await screen.findByText('Outside actions')).toBeInTheDocument();
  });

  it('shows for an agent step with a connector tool, inside a loop', async () => {
    ipc.getWorkflowActionRules.mockResolvedValue({ allowAll: false, allowed: [] });
    const loop: WorkflowStep = {
      id: 'l',
      type: 'for_each',
      items: '{{inputs.x}}',
      steps: [{ id: 'a', type: 'agent', prompt: 'p', tools: ['web_search', 'slack/post_message'] }],
    };
    render(<ActionRulesSection workflowId="w1" steps={[loop]} />);
    expect(await screen.findByText('Outside actions')).toBeInTheDocument();
  });
});
