/**
 * The appearance mode picker (ADR-011: one design, two modes). A `radiogroup`
 * of three cards — Dark, Light, System — that writes `AppSettings.theme`.
 * Arrow keys move the selection and focus together, as a native radio group
 * does.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ModePicker } from './ModePicker';

describe('ModePicker', () => {
  it('renders three radios with the right one checked', () => {
    render(<ModePicker value="light" onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
    expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false');
  });

  it('clicking a card calls onChange with its mode', () => {
    const onChange = vi.fn();
    render(<ModePicker value="dark" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('ArrowRight moves to the next option, wrapping from the last back to the first', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ModePicker value="dark" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Dark' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('light');

    rerender(<ModePicker value="system" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('dark');
  });

  it('ArrowLeft moves to the previous option, wrapping from the first back to the last', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ModePicker value="light" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('dark');

    rerender(<ModePicker value="dark" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Dark' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('system');
  });

  it('Home moves to the first option and End moves to the last', () => {
    const onChange = vi.fn();
    render(<ModePicker value="system" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('dark');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('system');
  });
});
