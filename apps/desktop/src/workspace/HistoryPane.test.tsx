import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ConversationSummary } from '../ipc/contracts';

vi.mock('../ipc/client', () => ({
  listConversations: vi.fn(),
  discoverConnector: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  startConnector: vi.fn(),
  stopConnector: vi.fn(),
}));

import { listConversations } from '../ipc/client';
import { RailPanes } from './RailPanes';

const mockRows: ConversationSummary[] = [
  {
    id: 'conv-1',
    displayTitle: 'Refactor the auth module',
    updatedAt: new Date().toISOString(),
    messageCount: 3,
    lastMessagePreview: 'Here is a plan...',
  },
  {
    id: 'conv-2',
    title: 'Named chat',
    displayTitle: 'Named chat',
    updatedAt: new Date().toISOString(),
    messageCount: 1,
  },
  {
    id: 'conv-3',
    displayTitle: 'Python artifact chat',
    updatedAt: new Date().toISOString(),
    messageCount: 2,
    lastMessagePreview:
      "Here's the artifact. HTML artifact · Python overview · 42 lines",
  },
];

function renderHistoryPane(overrides: {
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void | Promise<void>;
  onDeleteAllHistory?: () => void | Promise<void>;
} = {}) {
  const onSelectConversation = overrides.onSelectConversation ?? vi.fn();
  const onDeleteConversation = overrides.onDeleteConversation ?? vi.fn().mockResolvedValue(undefined);
  const onDeleteAllHistory = overrides.onDeleteAllHistory ?? vi.fn().mockResolvedValue(undefined);

  document.documentElement.setAttribute('data-tab', 'history');

  render(
    <RailPanes
      active="history"
      artifacts={[]}
      fileStateMap={{}}
      onOpenArtifact={vi.fn()}
      activeConversationId="conv-1"
      onSelectConversation={onSelectConversation}
      onDeleteConversation={onDeleteConversation}
      onDeleteAllHistory={onDeleteAllHistory}
      onNewChat={vi.fn()}
    />,
  );

  return { onSelectConversation, onDeleteConversation, onDeleteAllHistory };
}

describe('HistoryPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConversations).mockResolvedValue(mockRows);
  });

  it('renders display titles including fallback from first user prompt', async () => {
    renderHistoryPane();
    expect(await screen.findByText('Refactor the auth module')).toBeInTheDocument();
    expect(screen.getByText('Named chat')).toBeInTheDocument();
  });

  it('selects a conversation when its row is clicked', async () => {
    const { onSelectConversation } = renderHistoryPane();
    fireEvent.click(await screen.findByText('Named chat'));
    expect(onSelectConversation).toHaveBeenCalledWith('conv-2');
  });

  it('renders summarized artifact previews instead of raw artifact bodies', async () => {
    vi.mocked(listConversations).mockResolvedValue([
      {
        id: 'conv-artifact',
        displayTitle: 'create an html artifact',
        updatedAt: new Date().toISOString(),
        messageCount: 2,
        lastMessagePreview:
          "Here's the artifact.\n```html\n<!DOCTYPE html><html><head><title>Python overview</title></head><body><p>lots</p></body></html>\n```",
      },
    ]);
    renderHistoryPane();
    expect(await screen.findByText(/HTML artifact · Python overview/)).toBeInTheDocument();
    expect(screen.queryByText(/<!DOCTYPE html>/)).not.toBeInTheDocument();
  });

  it('deletes a single conversation from the row action', async () => {
    const onDeleteConversation = vi.fn().mockResolvedValue(undefined);
    renderHistoryPane({ onDeleteConversation });

    const deleteButtons = await screen.findAllByLabelText(/delete/i);
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(onDeleteConversation).toHaveBeenCalledWith('conv-1');
    });
  });

  it('deletes all history from the bulk action', async () => {
    const onDeleteAllHistory = vi.fn().mockResolvedValue(undefined);
    renderHistoryPane({ onDeleteAllHistory });

    fireEvent.click(await screen.findByRole('button', { name: /delete all history/i }));
    await waitFor(() => {
      expect(onDeleteAllHistory).toHaveBeenCalled();
    });
  });
});
