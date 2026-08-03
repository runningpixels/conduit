import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Artifact, ProviderDescriptor } from '../ipc/contracts';
import { CommandPalette } from './CommandPalette';
import { listProviderDescriptors, listProviderModels } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  listProviderDescriptors: vi.fn(),
  listProviderModels: vi.fn(),
}));

const anthropic: ProviderDescriptor = {
  id: 'anthropic',
  displayName: 'Anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  credentialMode: 'required',
  isLocal: false,
  showBaseUrlField: false,
  tier: 1,
  description: 'Anthropic models',
};

const ollama: ProviderDescriptor = {
  id: 'ollama',
  displayName: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434',
  credentialMode: 'none',
  isLocal: true,
  showBaseUrlField: false,
  tier: 2,
  description: 'Local models',
};

const artifact: Artifact = {
  id: 'a1',
  conversationId: 'c1',
  kind: 'markdown',
  title: 'triage-notes.md',
  sourceMessageId: 'm1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  mimeType: 'text/markdown',
  contentText: '# Hi',
  contentHash: 'h',
  sizeBytes: 8412,
};

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleDocPanel: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleWebSearch: vi.fn(),
    onForkConversationHere: vi.fn(),
    onRenameChat: vi.fn(),
    onExportDiagnostics: vi.fn(),
    onCopyConversationAsMarkdown: vi.fn(),
    onDeleteChat: vi.fn(),
    onDeleteAllHistory: vi.fn(),
    onSelectModel: vi.fn(),
    conversations: [
      { id: 'c1', title: 'Triage notes' },
      { id: 'c2', title: 'API overview' },
    ],
    onSelectConversation: vi.fn(),
    artifacts: [artifact],
    onOpenArtifact: vi.fn(),
    onSearchMessages: vi.fn().mockResolvedValue([]),
    onSelectSearchResult: vi.fn(),
    ...overrides,
  };
  render(<CommandPalette {...props} />);
  return props;
}

function type(value: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  (listProviderDescriptors as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([anthropic, ollama]);
  (listProviderModels as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
    id === 'anthropic'
      ? [{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }]
      : [{ id: 'qwen3:14b' }],
  );
});

describe('CommandPalette default corpus', () => {
  it('lists recent conversations and New chat with an empty query', () => {
    renderPalette();
    expect(screen.getByText('Triage notes')).toBeInTheDocument();
    expect(screen.getByText('API overview')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /New chat/ })).toBeInTheDocument();
  });

  it('selecting a conversation closes the palette', () => {
    const props = renderPalette();
    fireEvent.click(screen.getByRole('option', { name: 'Triage notes' }));
    expect(props.onSelectConversation).toHaveBeenCalledWith('c1');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('arrow keys navigate and Enter runs the selected item', () => {
    const props = renderPalette();
    const input = screen.getByRole('searchbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSelectConversation).toHaveBeenCalledWith('c1');
  });
});

describe('CommandPalette prefix modes', () => {
  it('shows the mode badge for >, @ and /', async () => {
    renderPalette();
    type('>');
    expect(screen.getByText('commands', { selector: '.pal-mode' })).toBeInTheDocument();
    type('@');
    expect(screen.getByText('artifacts', { selector: '.pal-mode' })).toBeInTheDocument();
    type('/');
    await waitFor(() => expect(screen.getByText('models', { selector: '.pal-mode' })).toBeInTheDocument());
  });

  it('> filters the command corpus only', () => {
    renderPalette();
    type('>');
    expect(screen.getByRole('option', { name: /New chat/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Fork conversation here/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Delete this chat/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Triage notes' })).not.toBeInTheDocument();
  });

  it('runs command callbacks from the > corpus', () => {
    const props = renderPalette();
    type('>delete');
    fireEvent.click(screen.getByRole('option', { name: /Delete this chat/ }));
    expect(props.onDeleteChat).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('> exposes Delete all chats… wired to onDeleteAllHistory', () => {
    const props = renderPalette();
    type('>delete all');
    fireEvent.click(screen.getByRole('option', { name: /Delete all chats…/ }));
    expect(props.onDeleteAllHistory).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('@ lists artifacts with a size tail', () => {
    renderPalette();
    type('@');
    expect(screen.getByRole('option', { name: /triage-notes.md/ })).toBeInTheDocument();
    expect(screen.getByText('8.2 KB')).toBeInTheDocument();
  });

  it('/ lists models grouped by provider with price or local tails', async () => {
    const props = renderPalette();
    type('/');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Anthropic \/ Claude Sonnet 4/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Ollama \/ qwen3:14b/ })).toBeInTheDocument();
    });
    expect(screen.getByText('$3 / $15')).toBeInTheDocument();
    expect(screen.getByText('local')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Anthropic \/ Claude Sonnet 4/ }));
    expect(props.onSelectModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows the empty-state instruction when a corpus has no matches', () => {
    renderPalette();
    type('>zzzz');
    expect(screen.getByText(/No matches/)).toBeInTheDocument();
    expect(screen.getByText(/for commands/)).toBeInTheDocument();
  });
});
