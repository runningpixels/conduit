import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TitleBar } from './TitleBar';

describe('TitleBar', () => {
  it('has a light/dark toggle that calls the theme handler', () => {
    const onToggleTheme = vi.fn();
    const { container } = render(<TitleBar effectiveTheme="dark" onToggleTheme={onToggleTheme} />);
    const toggle = screen.getByRole('button', { name: /theme|light|dark/i });
    expect(container.querySelector('.titlebar')!.contains(toggle)).toBe(true);
    // A button takes its own clicks: it must not be tagged as a drag region.
    expect(toggle.hasAttribute('data-tauri-drag-region')).toBe(false);
    fireEvent.click(toggle);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it('shows no toggle without a handler', () => {
    render(<TitleBar />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
