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
    fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    expect(onNavigate).toHaveBeenCalledWith('context');
  });

  it('marks Context while one of its tabs is open', () => {
    renderRail({ destination: 'library' });
    const context = screen.getByRole('button', { name: 'Context' });
    expect(context).toHaveAttribute('aria-current', 'page');
    expect(context.tabIndex).toBe(0);
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
  });

  it('groups the destinations in bands, with Settings on its own at the bottom', () => {
    const { container } = renderRail();
    const bands = [...container.querySelectorAll('.rail-band')].map((band) => ({
      id: band.getAttribute('data-band'),
      items: [...band.querySelectorAll('.rail-btn')].map((el) => el.getAttribute('data-destination')),
    }));
    expect(bands).toEqual([
      { id: 'make', items: ['chats', 'slides', 'writing'] },
      { id: 'apps', items: ['apps', 'manage'] },
      { id: 'automate', items: ['workflows', 'inbox', 'agents'] },
      { id: 'context', items: ['context'] },
    ]);
    expect(container.querySelector('.rail-band [data-destination="settings"]')).toBeNull();
  });

  it('splits the groups with hairlines, one between each pair', () => {
    const { container } = renderRail();
    const rules = container.querySelectorAll('.rail-rule');
    expect(rules).toHaveLength(4);
    rules.forEach((rule) => expect(rule).toHaveAttribute('aria-hidden', 'true'));
  });

  it('fills the icon of the current destination only', () => {
    const { container, rerender } = renderRail({ destination: 'workflows' });
    const filled = () => [...container.querySelectorAll('.rail-icon[data-filled]')].map((el) => el.closest('.rail-btn')?.getAttribute('data-destination'));
    expect(filled()).toEqual(['workflows']);
    rerender(<Rail destination="memory" onNavigate={() => {}} effectiveTheme="dark" onToggleTheme={() => {}} />);
    expect(filled()).toEqual(['context']);
  });

  it('names Manage in full for assistive tech, and keeps the short label on screen', () => {
    const onNavigate = vi.fn();
    renderRail({ onNavigate });
    const manage = screen.getByRole('button', { name: 'Manage apps' });
    expect(manage.querySelector('.rail-label')?.textContent).toBe('Manage');
    fireEvent.click(manage);
    expect(onNavigate).toHaveBeenCalledWith('manage');
  });

  it('labels every destination, and leaves Ideas to the new-chat screen', () => {
    const { container } = renderRail();
    const labels = [...container.querySelectorAll('.rail-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Home', 'Chats', 'Slides', 'Writing', 'Apps', 'Manage', 'Workflows', 'Inbox', 'Agents', 'Context', 'Settings']);
    expect(screen.queryByRole('button', { name: 'Ideas' })).toBeNull();
  });

  it('puts Writing right after Slides and goes there on click', () => {
    const onNavigate = vi.fn();
    const { container } = renderRail({ onNavigate });
    const order = [...container.querySelectorAll('.rail-btn')].map((el) => el.getAttribute('data-destination'));
    expect(order.indexOf('writing')).toBe(order.indexOf('slides') + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
    expect(onNavigate).toHaveBeenCalledWith('writing');
  });

  it('puts Home first, ahead of Chats', () => {
    const { container } = renderRail({ destination: 'home' });
    const first = container.querySelector('.rail-btn');
    expect(first?.getAttribute('data-destination')).toBe('home');
    expect(first).toHaveAttribute('aria-current', 'page');
  });

  it('shows the product mark and name', () => {
    const { container } = renderRail();
    expect(container.querySelector('.rail-brand-name')?.textContent).toBe('Conduit');
  });

  it('is one tab stop, moved with the arrow keys', () => {
    renderRail();
    const chats = screen.getByRole('button', { name: 'Chats' });
    const slides = screen.getByRole('button', { name: 'Slides' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(chats.tabIndex).toBe(0);
    expect(slides.tabIndex).toBe(-1);
    chats.focus();
    fireEvent.keyDown(chats, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(slides);
    fireEvent.keyDown(slides, { key: 'End' });
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(settings, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Home' }));
  });

  it('announces something new or running on a destination', () => {
    renderRail({ dots: { workflows: true } });
    expect(screen.getByRole('button', { name: 'Workflows (new)' })).toBeTruthy();
  });

  it('leaves out hidden destinations', () => {
    renderRail({ hidden: ['agents'] });
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
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
