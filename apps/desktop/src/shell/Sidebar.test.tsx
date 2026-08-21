import { describe, expect, it, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConversationSummary } from '../ipc/contracts';
import { Sidebar } from './Sidebar';
import { conversationGroup } from '../lib/dayGroup';

const NOW = new Date('2026-08-03T12:00:00Z');

function row(id: string, title: string, updatedAt: string): ConversationSummary {
  return { id, displayTitle: title, updatedAt, messageCount: 1 };
}

describe('conversationGroup', () => {
  it('buckets Today and Yesterday', () => {
    const today = '2026-08-03T08:00:00Z';
    const yesterday = '2026-08-02T08:00:00Z';
    expect(conversationGroup(today, NOW)).toBe('Today');
    expect(conversationGroup(yesterday, NOW)).toBe('Yesterday');
  });

  it('uses month names for older rows in the same year', () => {
    const july = '2026-07-15T08:00:00Z';
    expect(conversationGroup(july, NOW)).toBe('July');
  });

  it('falls back to the year for rows older than the current year', () => {
    const old = '2025-12-01T08:00:00Z';
    expect(conversationGroup(old, NOW)).toBe('2025');
  });

  it('handles unparseable dates as Earlier', () => {
    expect(conversationGroup('not-a-date', NOW)).toBe('Earlier');
  });
});

describe('Sidebar', () => {
  const conversations = [
    row('c1', 'Triage notes', '2026-08-03T10:00:00Z'),
    row('c2', 'API overview', '2026-08-02T10:00:00Z'),
    row('c3', 'JSON schema review', '2026-07-10T10:00:00Z'),
    row('c4', 'Old notes', '2025-11-01T10:00:00Z'),
  ];

  const props = {
    conversations,
    activeConversationId: 'c1',
    convoProviders: { c1: 'anthropic', c2: 'ollama' },
    providerCount: 2,
    connectorCount: 1,
    onSelectConversation: vi.fn(),
    onNewChat: vi.fn(),
    onOpenPalette: vi.fn(),
    onCollapse: vi.fn(),
    onRevealWorkspace: vi.fn(),
    onOpenSettings: vi.fn(),
    onExportDiagnostics: vi.fn(),
    onDeleteConversation: vi.fn(),
    onDeleteAllHistory: vi.fn(),
  };

  // `conversationGroup` is called with the real clock inside the component, so
  // the fixtures above only mean "Today" and "Yesterday" on 2026-08-03. Pin the
  // clock to that date: the pure-function tests already pass an explicit NOW,
  // and without this the suite breaks every time the date rolls over.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    props.onSelectConversation.mockClear();
    props.onNewChat.mockClear();
    props.onOpenPalette.mockClear();
    props.onCollapse.mockClear();
    props.onRevealWorkspace.mockClear();
    props.onOpenSettings.mockClear();
    props.onExportDiagnostics.mockClear();
    props.onDeleteConversation.mockClear();
    props.onDeleteAllHistory.mockClear();
  });

  it('renders grouped rows with group labels', () => {
    render(<Sidebar {...props} />);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    expect(screen.getByText('July')).toBeTruthy();
    expect(screen.getByText('2025')).toBeTruthy();
    expect(screen.getByText('Triage notes')).toBeTruthy();
    expect(screen.getByText('JSON schema review')).toBeTruthy();
  });

  it('marks the active row with aria-current and calls onSelectConversation', () => {
    render(<Sidebar {...props} />);
    const active = screen.getByText('Triage notes').closest('button');
    expect(active?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(active!);
    expect(props.onSelectConversation).toHaveBeenCalledWith('c1');
  });

  it('sets the per-row provider dot attribute from convoProviders', () => {
    render(<Sidebar {...props} />);
    const ollamaRow = screen.getByText('API overview').closest('button');
    expect(ollamaRow?.getAttribute('data-provider')).toBe('ollama');
    const fallbackRow = screen.getByText('Old notes').closest('button');
    expect(fallbackRow?.getAttribute('data-provider')).toBe('custom');
  });

  it('renders the empty state when there are no conversations', () => {
    render(<Sidebar {...props} conversations={[]} />);
    expect(screen.getByText(/No chats yet/)).toBeTruthy();
  });

  it('opens the workspace menu and routes menu items to onOpenSettings', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    const providersItem = screen.getByText('Providers & keys').closest('button');
    expect(providersItem).toBeTruthy();
    fireEvent.click(providersItem!);
    expect(props.onOpenSettings).toHaveBeenCalledWith('providers');
  });

  it('reveal in Explorer calls onRevealWorkspace', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    fireEvent.click(screen.getByText('Reveal in Explorer').closest('button')!);
    expect(props.onRevealWorkspace).toHaveBeenCalled();
  });

  it('export diagnostics runs onExportDiagnostics (not the settings sheet)', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    fireEvent.click(screen.getByText('Export diagnostics').closest('button')!);
    expect(props.onExportDiagnostics).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).not.toHaveBeenCalledWith('advanced');
  });

  it('delete all chats routes to onDeleteAllHistory with a danger treatment', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    const item = screen.getByText('Delete all chats').closest('button')!;
    expect(item.className).toContain('danger');
    fireEvent.click(item);
    expect(props.onDeleteAllHistory).toHaveBeenCalledTimes(1);
  });

  it('does not advertise a Switch workspace item (no workspace-switcher IPC)', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    expect(screen.queryByText('Switch workspace')).toBeNull();
    expect(screen.queryByText('⌘⇧O')).toBeNull();
  });

  it('arrow keys navigate the workspace menu items', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(1);
    items[0].focus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('renders the connector count tail on the Connectors item', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
    const connectorsItem = screen.getByText('Connectors').closest('button')!;
    expect(connectorsItem.querySelector('.tail')?.textContent).toBe('1');
  });

  it('New chat calls onNewChat', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    expect(props.onNewChat).toHaveBeenCalled();
  });

  /**
   * V9 deleted the top bar, taking the `.omni` pill with it. Search is that
   * capability's only remaining pointer affordance — it opens the same ⌘K
   * palette — so it has to be here and it has to be wired.
   */
  it('Search opens the command palette', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(props.onOpenPalette).toHaveBeenCalled();
  });

  it('collapses from the head button', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(props.onCollapse).toHaveBeenCalled();
  });

  // The caption row is the window's drag surface; the sidebar head is app
  // content. It was a drag region while the app had no top bar, which obliged
  // every non-interactive child to repeat the attribute.
  it('does not carry the Tauri drag region on its head', () => {
    const { container } = render(<Sidebar {...props} />);
    expect(container.querySelector('.sb-head')).not.toHaveAttribute('data-tauri-drag-region');
  });

  describe('per-row delete', () => {
    it('gives every row its own delete control, labelled with the chat name', () => {
      render(<Sidebar {...props} />);
      // A bare "Delete" label on four identical glyphs tells a screen-reader
      // user nothing about which chat they are about to destroy.
      expect(screen.getByRole('button', { name: 'Delete Triage notes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete Old notes' })).toBeTruthy();
    });

    it('deletes the row that was clicked, not the active chat', () => {
      render(<Sidebar {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Delete API overview' }));
      expect(props.onDeleteConversation).toHaveBeenCalledWith('c2');
      expect(props.onDeleteConversation).toHaveBeenCalledTimes(1);
    });

    it('does not select the conversation on its way to the dialog', () => {
      render(<Sidebar {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Delete Old notes' }));
      // Deleting a chat should not first navigate to it — the click would
      // otherwise bubble to the row button underneath.
      expect(props.onSelectConversation).not.toHaveBeenCalled();
    });

    it('keeps selection working when the delete control is present', () => {
      render(<Sidebar {...props} />);
      fireEvent.click(screen.getByText('API overview').closest('button')!);
      expect(props.onSelectConversation).toHaveBeenCalledWith('c2');
      expect(props.onDeleteConversation).not.toHaveBeenCalled();
    });

    it('omits the control entirely when no handler is supplied', () => {
      const { onDeleteConversation: _omitted, ...withoutDelete } = props;
      render(<Sidebar {...withoutDelete} />);
      expect(screen.queryByRole('button', { name: /^Delete Triage notes$/ })).toBeNull();
      // The list itself is unaffected.
      expect(screen.getByText('Triage notes')).toBeTruthy();
    });
  });
});
