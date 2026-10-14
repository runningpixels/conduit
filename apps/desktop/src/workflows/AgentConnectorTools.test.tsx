import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { connectorToolRef, parseConnectorToolRef, withBuiltinTool, withConnectorTool } from './editorModel';

const ipc = vi.hoisted(() => ({ getConnectorRuntimeStates: vi.fn(), listWorkflowConnectorTools: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import { AgentConnectorTools } from './AgentConnectorTools';

const tool = (name: string, level: 'readOnly' | 'sideEffectful' | 'sensitive') => ({
  name,
  description: null,
  inputSchema: {},
  readOnly: level === 'readOnly',
  permissionLevel: level,
});

beforeEach(() => {
  vi.resetAllMocks();
  ipc.getConnectorRuntimeStates.mockResolvedValue([
    {
      connectorVersionId: 'v1',
      connectorId: 'slack',
      connectorName: 'Slack',
      version: '1',
      transport: 'stdio',
      restartCount: 0,
      grantStatus: 'active',
      running: true,
      health: 'healthy',
    },
  ]);
  ipc.listWorkflowConnectorTools.mockResolvedValue([
    tool('list_channels', 'readOnly'),
    tool('post_message', 'sideEffectful'),
    tool('delete_workspace', 'sensitive'),
  ]);
});

function renderPicker(initial: string[]) {
  const latest = { tools: initial };
  function Harness() {
    const [tools, setTools] = useState(initial);
    latest.tools = tools;
    return <AgentConnectorTools tools={tools} onToggle={(ref, on) => setTools((p) => withConnectorTool(p, ref, on))} />;
  }
  render(<Harness />);
  return latest;
}

describe('AgentConnectorTools', () => {
  it('adds and removes a connector tool, and marks the ones that change things', async () => {
    const latest = renderPicker(['web_search']);
    expect(await screen.findByRole('checkbox', { name: 'list_channels' })).not.toBeChecked();
    const post = screen.getByRole('checkbox', { name: 'post_message — changes things, asks you first' });
    expect(screen.getByRole('checkbox', { name: 'delete_workspace — always asks you first' })).toBeInTheDocument();
    fireEvent.click(post);
    expect(latest.tools).toEqual(['web_search', 'slack/post_message']);
    fireEvent.click(post);
    expect(latest.tools).toEqual(['web_search']);
  });

  it('stops at 10 connector tools', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `slack/t${i}`);
    renderPicker(many);
    const box = await screen.findByRole('checkbox', { name: 'list_channels' });
    expect(box).toBeDisabled();
    expect(screen.getByText('A step can use up to 10 connector tools.')).toBeInTheDocument();
  });

  it('shows an entry whose tool is gone so it can be removed', async () => {
    const latest = renderPicker(['slack/old_tool', 'ghost/anything']);
    await screen.findByRole('checkbox', { name: 'list_channels' });
    expect(await screen.findByText('“old_tool” in Slack isn’t available any more.')).toBeInTheDocument();
    expect(screen.getByText('“anything” in ghost isn’t available any more.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove “old_tool”' }));
    await waitFor(() => expect(latest.tools).toEqual(['ghost/anything']));
  });

  it('shows nothing when there are no connectors and no entries', async () => {
    ipc.getConnectorRuntimeStates.mockResolvedValue([]);
    const { container } = render(<AgentConnectorTools tools={['web_search']} onToggle={() => undefined} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('tool entries', () => {
  it('builds and parses connector entries', () => {
    expect(connectorToolRef('slack', 'post')).toBe('slack/post');
    expect(parseConnectorToolRef('slack/post')).toEqual({ connectorId: 'slack', tool: 'post' });
    expect(parseConnectorToolRef('web_search')).toBeNull();
  });

  it('keeps connector entries when a built-in tool is toggled', () => {
    expect(withBuiltinTool(['slack/post', 'calculator'], 'web_search', true)).toEqual(['web_search', 'calculator', 'slack/post']);
    expect(withBuiltinTool(['web_search', 'slack/post'], 'web_search', false)).toEqual(['slack/post']);
  });
});
