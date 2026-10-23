import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LibraryAgent } from '../ipc/contracts';
import { AgentEditorDialog, VALIDATE_DEBOUNCE_MS } from './AgentEditorDialog';

const ipc = vi.hoisted(() => ({
  createLibraryAgent: vi.fn(),
  updateLibraryAgent: vi.fn(),
  validateLibraryAgent: vi.fn(),
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  listInstalledConnectors: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const stamp = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', usedBy: [],
  chat: { tasks: 0, failed: 0, tokens: 0, lastActive: null, currentTask: null, currentConversationId: null } };
const writer: LibraryAgent = {
  agent: { id: 'writer', name: 'Writer', instructions: 'Write it up.', tools: [] },
  ...stamp,
};
const researcher: LibraryAgent = {
  agent: { id: 'researcher', name: 'Researcher', instructions: 'Find facts', tools: ['web_search'] },
  ...stamp,
};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.validateLibraryAgent.mockResolvedValue([]);
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listInstalledConnectors.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(VALIDATE_DEBOUNCE_MS + 10);
  });
}

describe('AgentEditorDialog', () => {
  it('saves a new agent with an empty id so the backend makes one', async () => {
    ipc.createLibraryAgent.mockImplementation(async (agent) => ({ ...stamp, agent: { ...agent, id: 'editor' } }));
    const onSaved = vi.fn();
    render(<AgentEditorDialog agent={null} library={[researcher]} onClose={() => {}} onSaved={onSaved} />);
    await settle();
    fireEvent.change(screen.getByPlaceholderText('Name, like Researcher'), { target: { value: 'Editor' } });
    fireEvent.change(screen.getByPlaceholderText('What this agent does and how'), { target: { value: 'Tighten the text.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Researcher' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await settle();
    expect(ipc.createLibraryAgent).toHaveBeenCalledWith({
      id: '',
      name: 'Editor',
      instructions: 'Tighten the text.',
      tools: ['web_search', 'web_fetch'],
      agents: ['researcher'],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('updates an existing agent and lists only the other agents to hand work to', async () => {
    ipc.updateLibraryAgent.mockImplementation(async (agent) => ({ ...stamp, agent }));
    const onSaved = vi.fn();
    render(<AgentEditorDialog agent={writer} library={[researcher, writer]} onClose={() => {}} onSaved={onSaved} />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Edit agent' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Writer' })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Write it up.'), { target: { value: 'Write it down.' } });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent).toHaveBeenCalledWith({ ...writer.agent, instructions: 'Write it down.' });
    expect(ipc.createLibraryAgent).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('shows what is wrong as the user types, and does not save until it is fixed', async () => {
    ipc.validateLibraryAgent.mockResolvedValue(['Give the agent a name.']);
    render(<AgentEditorDialog agent={null} library={[]} onClose={() => {}} onSaved={() => {}} />);
    await settle();
    // Nothing is flagged before the user has touched the form.
    expect(screen.queryByText('Give the agent a name.')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('What this agent does and how'), { target: { value: 'x' } });
    await settle();
    expect(screen.getByText('Give the agent a name.')).toBeTruthy();
    // The check ran against a provisional id, since a new agent has none yet.
    expect(ipc.validateLibraryAgent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'agent', instructions: 'x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await settle();
    expect(ipc.createLibraryAgent).not.toHaveBeenCalled();
  });

  it("shows the backend's problems when saving is refused, one per line", async () => {
    ipc.createLibraryAgent.mockRejectedValue(new Error('One problem.\nAnother problem.'));
    render(<AgentEditorDialog agent={null} library={[]} onClose={() => {}} onSaved={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await settle();
    expect(screen.getByText('One problem.')).toBeTruthy();
    expect(screen.getByText('Another problem.')).toBeTruthy();
  });

  it('notes that the computer needs a folder once it is ticked, and closes on Escape or Cancel', async () => {
    const onClose = vi.fn();
    render(<AgentEditorDialog agent={null} library={[]} onClose={onClose} onSaved={() => {}} />);
    await settle();
    expect(screen.queryByText(/needs a folder/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Use the computer/ }));
    expect(screen.getByText(/needs a folder/)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
