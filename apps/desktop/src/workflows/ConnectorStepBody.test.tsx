import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowStep } from '../ipc/contracts';
import { ConnectorStepBody } from './ConnectorStepBody';

const ipc = vi.hoisted(() => ({ getConnectorRuntimeStates: vi.fn(), listWorkflowConnectorTools: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

type ConnectorStep = Extract<WorkflowStep, { type: 'connector_tool' }>;

const schema = {
  type: 'object',
  required: ['repo'],
  properties: { repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, limit: { type: 'integer' } },
};

beforeEach(() => {
  ipc.getConnectorRuntimeStates.mockResolvedValue([
    {
      connectorVersionId: 'v1',
      connectorId: 'gh',
      connectorName: 'Issues',
      version: '1',
      transport: 'stdio',
      restartCount: 0,
      grantStatus: 'active',
      running: true,
      health: 'healthy',
    },
  ]);
  ipc.listWorkflowConnectorTools.mockResolvedValue([
    { name: 'list_issues', description: null, inputSchema: schema, readOnly: true, permissionLevel: 'readOnly' },
    { name: 'close_issue', description: null, inputSchema: schema, readOnly: false, permissionLevel: 'sideEffectful' },
    { name: 'mystery', description: null, inputSchema: schema, readOnly: false, permissionLevel: 'sensitive' },
  ]);
});

function renderBody(initial: ConnectorStep) {
  const latest = { step: initial };
  function Harness() {
    const [step, setStep] = useState<ConnectorStep>(initial);
    latest.step = step;
    return (
      <ConnectorStepBody
        step={step}
        update={(fn) => setStep((s) => fn(s) as ConnectorStep)}
        renderText={(p) => (
          <label>
            {p.label}
            <input aria-label={p.label} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
          </label>
        )}
      />
    );
  }
  render(<Harness />);
  return latest;
}

const base: ConnectorStep = { id: 'c', type: 'connector_tool', connector: 'gh', tool: '', arguments: {} };

describe('ConnectorStepBody', () => {
  it('disables tools that change things or cannot be told apart', async () => {
    renderBody(base);
    const option = async (text: RegExp) => (await screen.findByRole('option', { name: text })) as HTMLOptionElement;
    expect((await option(/^list_issues$/)).disabled).toBe(false);
    expect((await option(/close_issue/)).disabled).toBe(true);
    expect((await option(/mystery/)).disabled).toBe(true);
  });

  it('says why the tools could not be loaded', async () => {
    ipc.listWorkflowConnectorTools.mockRejectedValue('Files is turned off. Open Connectors to turn it back on.');
    renderBody(base);
    expect(await screen.findByRole('alert')).toHaveTextContent('Files is turned off. Open Connectors to turn it back on.');
  });

  it('builds the form from the schema and writes the arguments', async () => {
    const latest = renderBody({ ...base, tool: 'list_issues' });
    const repo = await screen.findByLabelText(/repo/);
    fireEvent.change(repo, { target: { value: '{{inputs.repo}}' } });
    fireEvent.change(screen.getByLabelText('state'), { target: { value: 'open' } });
    fireEvent.change(screen.getByLabelText('limit'), { target: { value: '20' } });
    expect(latest.step.arguments).toEqual({ repo: '{{inputs.repo}}', state: 'open', limit: 20 });
  });

  it('switches to JSON for the whole object and back', async () => {
    const latest = renderBody({ ...base, tool: 'list_issues', arguments: { repo: 'a/b' } });
    await screen.findByLabelText(/repo/);
    fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({ repo: 'a/b' });
    fireEvent.change(box, { target: { value: '{"repo":"c/d","extra":1}' } });
    expect(latest.step.arguments).toEqual({ repo: 'c/d', extra: 1 });
    fireEvent.change(box, { target: { value: '{"repo":' } });
    expect(latest.step.arguments).toEqual({ repo: 'c/d', extra: 1 });
    await waitFor(() => expect(screen.getByText(/valid JSON object/)).toBeTruthy());
  });

  it('clears the tool and arguments when the connector changes', async () => {
    const latest = renderBody({ ...base, tool: 'list_issues', arguments: { repo: 'a/b' } });
    await screen.findByLabelText(/repo/);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '' } });
    expect(latest.step).toMatchObject({ connector: '', tool: '', arguments: {} });
  });
});
