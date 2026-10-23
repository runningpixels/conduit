import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { LibraryAgent, MemoryItem } from '../ipc/contracts';
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
  listMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  listKnowledgeCollections: vi.fn(),
  agentMemoryScope: (id: string) => `agent:${id}`,
}));
vi.mock('../ipc/client', () => ipc);

const writer: LibraryAgent = {
  agent: { id: 'writer', name: 'Writer', instructions: 'Write it up.', tools: [] },
  notes: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  usedBy: [],
  chat: { tasks: 0, failed: 0, tokens: 0, lastActive: null, currentTask: null, currentConversationId: null },
};

const note = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'n1',
  kind: 'note',
  body: 'Prefers short answers',
  pinned: false,
  status: 'active',
  scope: 'agent:writer',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});

const collection = (id: string, name: string, documentCount: number) => ({
  id,
  name,
  documentCount,
  providerId: 'p',
  embeddingModel: 'm',
  embeddingDimensions: 8,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  vi.useFakeTimers();
  ipc.validateLibraryAgent.mockResolvedValue([]);
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listInstalledConnectors.mockResolvedValue([]);
  ipc.listMemoryItems.mockResolvedValue([]);
  ipc.listKnowledgeCollections.mockResolvedValue([]);
  ipc.updateLibraryAgent.mockImplementation(async (agent) => ({ ...writer, agent }));
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

function open(over: { agent?: LibraryAgent | null; onOpenDocuments?: () => void } = {}) {
  const agent = over.agent === undefined ? writer : over.agent;
  return render(
    <AgentEditorDialog
      agent={agent}
      library={agent ? [agent] : []}
      onClose={() => {}}
      onSaved={() => {}}
      onOpenDocuments={over.onOpenDocuments}
    />,
  );
}

describe('Agent memory in the editor', () => {
  it('saves "remembers between runs" and leaves it out when cleared', async () => {
    open();
    await settle();
    const box = screen.getByRole('switch', { name: 'Remembers between runs' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent.mock.calls[0][0]).toMatchObject({ memory: true });
  });

  it('leaves "memory" out of the saved agent when it is switched off', async () => {
    open({ agent: { ...writer, agent: { ...writer.agent, memory: true } } });
    await settle();
    const box = screen.getByRole('switch', { name: 'Remembers between runs' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent.mock.calls[0][0]).not.toHaveProperty('memory');
  });

  it('asks to save a new agent before showing its notes', async () => {
    open({ agent: null });
    await settle();
    expect(screen.getByText('Save the agent to see and edit its notes.')).toBeTruthy();
    expect(ipc.listMemoryItems).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
  });

  it('shows a plain hint when a saved agent has no notes yet', async () => {
    open();
    await settle();
    expect(ipc.listMemoryItems).toHaveBeenCalledWith(null, 'agent:writer');
    expect(screen.getByText('No notes yet. It adds them as it works, or add one yourself.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lists the notes with where each came from', async () => {
    ipc.listMemoryItems.mockResolvedValue([
      note({ id: 'a', body: 'From chat', origin: 'chat' }),
      note({ id: 'b', body: 'From run', origin: 'run' }),
      note({ id: 'c', body: 'From schedule', origin: 'scheduled_run' }),
      note({ id: 'd', body: 'By hand' }),
    ]);
    open();
    await settle();
    expect(screen.getByText('From chat').closest('li')).toHaveTextContent('From a chat');
    expect(screen.getByText('From run').closest('li')).toHaveTextContent('From a run');
    expect(screen.getByText('From schedule').closest('li')).toHaveTextContent('From a scheduled run');
    expect(screen.getByText('By hand').closest('li')).toHaveTextContent('Added by you');
  });

  it('edits a note in place', async () => {
    ipc.listMemoryItems.mockResolvedValue([note({})]);
    ipc.updateMemoryItem.mockResolvedValue(note({ body: 'Prefers tables' }));
    open();
    await settle();
    const row = screen.getByText('Prefers short answers').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'Prefers tables' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateMemoryItem).toHaveBeenCalledWith('n1', 'Prefers tables', 'note', false);
    expect(ipc.listMemoryItems).toHaveBeenCalledTimes(2);
  });

  it('deletes a note', async () => {
    ipc.listMemoryItems.mockResolvedValue([note({})]);
    ipc.deleteMemoryItem.mockResolvedValue(undefined);
    open();
    await settle();
    const row = screen.getByText('Prefers short answers').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await settle();
    expect(ipc.deleteMemoryItem).toHaveBeenCalledWith('n1');
  });

  it("adds a note to the agent's own memory", async () => {
    ipc.createMemoryItem.mockResolvedValue(note({}));
    open();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    const box = screen.getByRole('textbox', { name: 'New note' });
    fireEvent.change(box, { target: { value: '  Likes bullet lists ' } });
    fireEvent.click(within(box.closest('.mem-edit') as HTMLElement).getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.createMemoryItem).toHaveBeenCalledWith('Likes bullet lists', 'note', false, 'agent:writer');
  });

  it('says the notes are not used while memory is off', async () => {
    ipc.listMemoryItems.mockResolvedValue([note({})]);
    open();
    await settle();
    expect(screen.getByText("Memory is off, so these notes aren't used.")).toBeTruthy();
  });
});

describe('What it can read in the editor', () => {
  it('saves the ticked collections and leaves the field out when none are', async () => {
    ipc.listKnowledgeCollections.mockResolvedValue([collection('c1', 'Handbook', 3), collection('c2', 'Contracts', 1)]);
    open();
    await settle();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook (3 documents)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contracts (1 document)' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent.mock.calls[0][0]).toMatchObject({ knowledge: ['c1', 'c2'] });
  });

  it('leaves "knowledge" out once every collection is unticked', async () => {
    ipc.listKnowledgeCollections.mockResolvedValue([collection('c1', 'Handbook', 3)]);
    open({ agent: { ...writer, agent: { ...writer.agent, knowledge: ['c1'] } } });
    await settle();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook (3 documents)' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent.mock.calls[0][0]).not.toHaveProperty('knowledge');
  });

  it('points to Documents when there are no collections yet', async () => {
    const onOpenDocuments = vi.fn();
    open({ onOpenDocuments });
    await settle();
    expect(screen.getByText(/don't have any collections yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Documents' }));
    expect(onOpenDocuments).toHaveBeenCalledTimes(1);
  });

  it('shows a collection that no longer exists as gone, and lets it be unticked', async () => {
    ipc.listKnowledgeCollections.mockResolvedValue([collection('c1', 'Handbook', 3)]);
    const agent = { ...writer, agent: { ...writer.agent, knowledge: ['old'] } };
    open({ agent });
    await settle();
    const gone = screen.getByRole('checkbox', { name: 'A collection that no longer exists' }) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    fireEvent.click(gone);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(ipc.updateLibraryAgent.mock.calls[0][0]).not.toHaveProperty('knowledge');
  });
});
