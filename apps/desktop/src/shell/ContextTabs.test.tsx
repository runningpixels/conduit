import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContextTabs } from './ContextTabs';
import { ComingSoonPage } from '../pages/ComingSoonPage';

describe('ContextTabs', () => {
  it('lists the four Context pages and marks the open one', () => {
    render(<ContextTabs current="connectors" onNavigate={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Context sections' });
    const tabs = [...nav.querySelectorAll('button')];
    expect(tabs.map((b) => b.textContent)).toEqual(['Documents', 'Library', 'Connectors', 'Memory']);
    expect(screen.getByRole('button', { name: 'Connectors' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Memory' })).not.toHaveAttribute('aria-current');
  });

  it('goes to a tab as a destination of its own', () => {
    const onNavigate = vi.fn();
    render(<ContextTabs current="documents" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(onNavigate).toHaveBeenCalledWith('memory');
  });
});

describe('ComingSoonPage', () => {
  it('says what Inbox will be and points to Workflows meanwhile', () => {
    const onAction = vi.fn();
    render(<ComingSoonPage copy="shell.inbox" onAction={onAction} />);
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.getByText(/Approvals, questions, results and problems/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Workflows' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('says what Agents will be', () => {
    render(<ComingSoonPage copy="shell.agents" onAction={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText(/asks before anything leaves your computer/)).toBeTruthy();
  });
});
