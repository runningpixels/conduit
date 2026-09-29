import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Rail, type RailProps } from './Rail';

function renderRail(props: Partial<RailProps> = {}) {
  return render(
    <Rail destination="chats" onNavigate={() => {}} effectiveTheme="dark" onToggleTheme={() => {}} {...props} />,
  );
}

describe('Rail', () => {
  it('marks where you are and navigates on click', () => {
    const onNavigate = vi.fn();
    renderRail({ onNavigate });
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(onNavigate).toHaveBeenCalledWith('library');
  });

  it('labels every destination, and leaves Ideas to the new-chat screen', () => {
    const { container } = renderRail();
    const labels = [...container.querySelectorAll('.rail-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Chats', 'Documents', 'Library', 'Workflows', 'Connectors', 'Memory', 'Settings']);
    expect(screen.queryByRole('button', { name: 'Ideas' })).toBeNull();
  });

  it('shows the product mark and name', () => {
    const { container } = renderRail();
    expect(container.querySelector('.rail-brand-name')?.textContent).toBe('Conduit');
  });

  it('is one tab stop, moved with the arrow keys', () => {
    renderRail();
    const chats = screen.getByRole('button', { name: 'Chats' });
    const documents = screen.getByRole('button', { name: 'Documents' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(chats.tabIndex).toBe(0);
    expect(documents.tabIndex).toBe(-1);
    chats.focus();
    fireEvent.keyDown(chats, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(documents);
    fireEvent.keyDown(documents, { key: 'End' });
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(settings, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(chats);
  });

  it('announces something new or running on a destination', () => {
    renderRail({ dots: { workflows: true } });
    expect(screen.getByRole('button', { name: 'Workflows (new)' })).toBeTruthy();
  });

  it('leaves out hidden destinations', () => {
    renderRail({ hidden: ['memory'] });
    expect(screen.queryByRole('button', { name: 'Memory' })).toBeNull();
  });

  it('toggles light and dark from its own button, outside the destination toolbar', () => {
    const onToggleTheme = vi.fn();
    renderRail({ onToggleTheme });
    const toggle = screen.getByRole('button', { name: /theme|light|dark/i });
    expect(screen.getByRole('toolbar').contains(toggle)).toBe(false);
    fireEvent.click(toggle);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });
});
