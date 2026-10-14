import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WorkflowDefinition } from '../ipc/contracts';
import { TriggerSection } from './TriggerSection';

const ipc = vi.hoisted(() => ({ getConnectorRuntimeStates: vi.fn(), listWorkflowConnectorTools: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

const schema = {
  type: 'object',
  required: ['repo'],
  properties: { repo: { type: 'string' }, limit: { type: 'integer' } },
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
    { name: 'unknown', description: null, inputSchema: schema, readOnly: null, permissionLevel: null },
  ]);
});

function renderSection(initial: WorkflowDefinition) {
  const latest = { def: initial };
  function Harness() {
    const [def, setDef] = useState(initial);
    latest.def = def;
    return <TriggerSection def={def} onChange={setDef} />;
  }
  render(<Harness />);
  return latest;
}

const empty: WorkflowDefinition = { steps: [] };

describe('TriggerSection connector card', () => {
  it('starts a connector trigger with defaults when the card is chosen', () => {
    const latest = renderSection(empty);
    fireEvent.click(screen.getByLabelText('Something new from a connector'));
    expect(latest.def.trigger).toEqual({ kind: 'connector', connector: '', tool: '', arguments: {}, everyMinutes: 30 });
  });

  it('lists only read-only tools and writes the choices and arguments', async () => {
    const latest = renderSection({
      steps: [],
      trigger: { kind: 'connector', connector: 'gh', tool: '', arguments: {}, everyMinutes: 30 },
    });
    expect(await screen.findByRole('option', { name: 'list_issues' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /close_issue/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /unknown/ })).toBeNull();

    const tool = screen.getByDisplayValue('Choose a tool…');
    fireEvent.change(tool, { target: { value: 'list_issues' } });
    expect(latest.def.trigger).toMatchObject({ tool: 'list_issues', arguments: {} });

    fireEvent.change(await screen.findByLabelText(/repo/), { target: { value: 'a/b' } });
    fireEvent.change(screen.getByLabelText('limit'), { target: { value: '5' } });
    expect(latest.def.trigger).toMatchObject({ arguments: { repo: 'a/b', limit: 5 } });
    expect(screen.queryByRole('button', { name: /insert value/i })).toBeNull();
  });

  it('picking another connector clears the tool and arguments', async () => {
    const latest = renderSection({
      steps: [],
      trigger: { kind: 'connector', connector: 'gh', tool: 'list_issues', arguments: { repo: 'a/b' }, everyMinutes: 30 },
    });
    await screen.findByRole('option', { name: 'list_issues' });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '' } });
    expect(latest.def.trigger).toMatchObject({ connector: '', tool: '', arguments: {} });
  });

  it('shows a tool that is no longer offered, and sets how often to check', async () => {
    const latest = renderSection({
      steps: [],
      trigger: { kind: 'connector', connector: 'gh', tool: 'removed', arguments: {}, everyMinutes: 30 },
    });
    expect(await screen.findByRole('option', { name: /removed.*no longer offered/ })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('30 minutes'), { target: { value: '120' } });
    expect(latest.def.trigger).toMatchObject({ everyMinutes: 120 });
  });
});
