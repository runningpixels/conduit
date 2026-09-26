import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Rail } from './Rail';

describe('Rail', () => {
  it('marks where you are and navigates on click', () => {
    const onNavigate = vi.fn();
    render(<Rail destination="chats" onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    expect(onNavigate).toHaveBeenCalledWith('library');
  });

  it('is one tab stop, moved with the arrow keys', () => {
    render(<Rail destination="chats" onNavigate={() => {}} />);
    const chats = screen.getByRole('button', { name: 'Chats' });
    const ideas = screen.getByRole('button', { name: 'Ideas' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(chats.tabIndex).toBe(0);
    expect(ideas.tabIndex).toBe(-1);
    chats.focus();
    fireEvent.keyDown(chats, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(ideas);
    fireEvent.keyDown(ideas, { key: 'End' });
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(settings, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(chats);
  });

  it('announces something new on a destination', () => {
    render(<Rail destination="chats" onNavigate={() => {}} dots={{ ideas: true }} />);
    expect(screen.getByRole('button', { name: 'Ideas (new)' })).toBeTruthy();
  });

  it('leaves out hidden destinations', () => {
    render(<Rail destination="chats" onNavigate={() => {}} hidden={['memory']} />);
    expect(screen.queryByRole('button', { name: 'Memory' })).toBeNull();
  });
});
