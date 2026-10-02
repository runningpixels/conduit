import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DeckDock } from './DeckDock';

const dock = (tab: 'ask' | 'script' | 'history', onTab = vi.fn()) => (
  <DeckDock tab={tab} onTab={onTab} script={<p>script body</p>} history={<p>history body</p>}>
    <p>chat body</p>
  </DeckDock>
);

describe('DeckDock', () => {
  it('shows the chat under Ask and keeps the other panels mounted but hidden', () => {
    render(dock('ask'));
    expect(screen.getByRole('tab', { name: 'Ask' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('chat body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('script body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText('history body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows Script and History when selected', () => {
    const { rerender } = render(dock('script'));
    expect(screen.getByText('script body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('chat body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    rerender(dock('history'));
    expect(screen.getByText('history body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
  });

  it('reports tab clicks and arrow-key moves', () => {
    const onTab = vi.fn();
    render(dock('ask', onTab));
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(onTab).toHaveBeenCalledWith('history');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onTab).toHaveBeenLastCalledWith('script');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onTab).toHaveBeenLastCalledWith('history');
  });
});
