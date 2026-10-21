import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { AppSettings } from '@conduit/config-schema';
import { Composer } from './Composer';
import { listLibraryAgents } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  loadProviderCredentialReference: vi.fn().mockResolvedValue({ providerId: 'anthropic', credentialRef: 'k', storedInKeychain: true }),
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  listProviderModels: vi.fn().mockResolvedValue([]),
  resolveModelPrices: vi.fn().mockResolvedValue([]),
  attachmentDelivery: vi.fn(),
  deleteAttachment: vi.fn(),
  saveAttachment: vi.fn(),
  saveDroppedAttachment: vi.fn(),
  listKnowledgeDocuments: vi.fn().mockResolvedValue([]),
  listLibraryAgents: vi.fn(),
}));

const settings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  providerEndpoints: {},
  modelPriceOverrides: [],
  webSearchEnabled: false,
  webSearch: { mode: 'auto', localBackend: 'duckduckgo' },
  accent: {},
} as unknown as AppSettings;

function agent(id: string, name: string, instructions: string) {
  return { agent: { id, name, instructions, tools: [] }, createdAt: '', updatedAt: '', usedBy: [], chat: {} };
}

function renderHarness(initialAgent: { id: string; name: string } | null = null) {
  const onSend = vi.fn();
  const onSelectAgent = vi.fn();
  function Harness() {
    const [prompt, setPrompt] = useState('');
    const [selected, setSelected] = useState(initialAgent);
    return (
      <Composer
        settings={settings}
        onSelectModel={vi.fn()}
        conversationId="conv-1"
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={onSend}
        onStop={vi.fn()}
        streaming={false}
        webSearchOn={false}
        onWebSearchToggle={vi.fn()}
        selectedAgent={selected}
        onSelectAgent={(next) => {
          onSelectAgent(next);
          setSelected(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { onSend, onSelectAgent };
}

const textareaLabel = 'Message the active provider';

describe('Composer @ agent picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLibraryAgents).mockResolvedValue([
      agent('researcher', 'Researcher', 'Find facts.\nCite sources.'),
      agent('writer', 'Writer', 'Write it up.'),
    ] as never);
  });

  it('opens on @, filters by name, and Enter picks the agent and removes the @query', async () => {
    const { onSelectAgent } = renderHarness();
    const textarea = screen.getByLabelText(textareaLabel);
    fireEvent.change(textarea, { target: { value: 'ask @res' } });
    expect(await screen.findByRole('option', { name: 'Researcher · Find facts.' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Writer/ })).toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSelectAgent).toHaveBeenCalledWith({ id: 'researcher', name: 'Researcher' });
    await waitFor(() => expect(textarea).toHaveValue('ask '));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
  });

  it('a bare @ moves with the arrow keys before Enter picks', async () => {
    const { onSelectAgent } = renderHarness();
    const textarea = screen.getByLabelText(textareaLabel);
    fireEvent.change(textarea, { target: { value: '@' } });
    await screen.findByRole('option', { name: /Writer/ });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSelectAgent).toHaveBeenCalledWith({ id: 'writer', name: 'Writer' });
  });

  it('Enter on a bare @ that was never navigated is not a pick; it sends', async () => {
    const { onSelectAgent, onSend } = renderHarness();
    const textarea = screen.getByLabelText(textareaLabel);
    fireEvent.change(textarea, { target: { value: '@' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSend).toHaveBeenCalled();
  });

  it('typing a full name and a space does not select anything', async () => {
    const { onSelectAgent } = renderHarness();
    const textarea = screen.getByLabelText(textareaLabel);
    fireEvent.change(textarea, { target: { value: '@Researcher ' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it('shows one disabled row when the library is empty', async () => {
    vi.mocked(listLibraryAgents).mockResolvedValue([]);
    renderHarness();
    fireEvent.change(screen.getByLabelText(textareaLabel), { target: { value: '@' } });
    expect(await screen.findByText('You have no agents yet')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('shows the selected agent as a removable chip', () => {
    const { onSelectAgent } = renderHarness({ id: 'researcher', name: 'Researcher' });
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't send this message to Researcher" }));
    expect(onSelectAgent).toHaveBeenCalledWith(null);
  });
});
