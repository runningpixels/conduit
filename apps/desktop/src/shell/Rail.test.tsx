import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Rail, fitRailLabels, type RailProps } from './Rail';

function renderRail(props: Partial<RailProps> = {}) {
  return render(
    <Rail destination="chats" onNavigate={() => {}} {...props} />,
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
    rerender(<Rail destination="memory" onNavigate={() => {}} />);
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
    expect(labels).toEqual(['Home', 'Chats', 'Slides', 'Writing', 'Apps', 'Manage', 'Workflows', 'Inbox', 'Agents', 'Context', 'Settings', 'More']);
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

  it('counts what runs on a destination in a pill, in place of the dot', () => {
    const { container, rerender } = renderRail({ counts: { agents: 3 }, dots: { agents: true } });
    const agents = screen.getByRole('button', { name: 'Agents (3 running)' });
    expect(agents.querySelector('.rail-count')?.textContent).toBe('3');
    expect(agents.querySelector('.rail-dot')).toBeNull();
    // Down to zero: no pill.
    rerender(<Rail destination="chats" onNavigate={() => {}} counts={{ agents: 0 }} />);
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(container.querySelector('.rail-count')).toBeNull();
  });

  it('leaves out hidden destinations', () => {
    renderRail({ hidden: ['agents'] });
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
  });

  it('has no theme toggle: that lives in the title bar', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull();
  });

  it('titles each button with its label and keeps Settings outside the scroll area', () => {
    const { container } = renderRail();
    expect(screen.getByRole('button', { name: 'Chats' }).getAttribute('title')).toBe('Chats');
    const scroll = container.querySelector('.rail-scroll')!;
    expect(scroll.contains(screen.getByRole('button', { name: 'Chats' }))).toBe(true);
    const settings = container.querySelector('[data-destination="settings"]')!;
    expect(scroll.contains(settings)).toBe(false);
    expect(screen.getByRole('toolbar').contains(settings)).toBe(true);
  });

  it('scrolls a focused button into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderRail();
    fireEvent.focus(screen.getByRole('button', { name: 'Agents' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('Rail on a phone', () => {
  function phone() {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }
  afterEach(() => {
    // @ts-expect-error restore jsdom's lack of matchMedia
    delete window.matchMedia;
  });

  it('walks the tabs and More with the arrow keys', () => {
    phone();
    renderRail({ destination: 'slides' });
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-current', 'page');
    expect(more.tabIndex).toBe(0);
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Home' }));
  });

  it('opens a dialog of the other destinations, navigates and closes', () => {
    phone();
    const onNavigate = vi.fn();
    renderRail({ onNavigate, dots: { workflows: true }, onToggleTheme: () => {} });
    expect(screen.getByRole('button', { name: 'More (new)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More (new)' }));
    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.querySelectorAll('.more-row')).toHaveLength(8);
    fireEvent.click(screen.getAllByRole('button', { name: 'Writing' }).find((b) => b.classList.contains('more-row'))!);
    expect(onNavigate).toHaveBeenCalledWith('writing');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the running count in the More sheet, and marks More', () => {
    phone();
    renderRail({ counts: { agents: 2 } });
    fireEvent.click(screen.getByRole('button', { name: 'More (new)' }));
    const row = screen.getAllByRole('button', { name: 'Agents (2 running)' }).find((b) => b.classList.contains('more-row'))!;
    expect(row.querySelector('.rail-count')?.textContent).toBe('2');
  });

  it('closes on Escape and returns focus to More', () => {
    phone();
    renderRail();
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

describe('fitRailLabels', () => {
  function label(text: string, client: number, scroll: number) {
    const el = document.createElement('span');
    el.className = 'rail-label';
    el.textContent = text;
    el.style.lineHeight = '1.15';
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => client });
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scroll });
    return el;
  }

  it('shrinks a word too wide for its box and leaves the rest alone', () => {
    const root = document.createElement('nav');
    root.style.fontSize = '13px';
    const long = label('Einstellungen', 74, 79);
    const fits = label('Chats', 40, 40);
    root.append(long, fits);
    document.body.append(root);
    fitRailLabels(root);
    expect(long.style.fontSize).toBe('12.1px');
    expect(fits.style.fontSize).toBe('');
    root.remove();
  });

  it('never goes below 10px, and resets a label that fits again', () => {
    const root = document.createElement('nav');
    root.style.fontSize = '13px';
    const el = label('Configurações', 40, 86);
    root.append(el);
    document.body.append(root);
    fitRailLabels(root);
    expect(el.style.fontSize).toBe('10px');
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 40 });
    fitRailLabels(root);
    expect(el.style.fontSize).toBe('');
    root.remove();
  });
});
