import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConversationSummary } from '../ipc/contracts';
import { Sidebar, conversationGroup } from './Sidebar';

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
    onRevealWorkspace: vi.fn(),
    onOpenSettings: vi.fn(),
  };

  beforeEach(() => {
    props.onSelectConversation.mockClear();
    props.onNewChat.mockClear();
    props.onRevealWorkspace.mockClear();
    props.onOpenSettings.mockClear();
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

  it('New chat calls onNewChat', () => {
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
    expect(props.onNewChat).toHaveBeenCalled();
  });
});
