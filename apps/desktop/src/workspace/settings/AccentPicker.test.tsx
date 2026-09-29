/**
 * The main colour picker (ADR-011): one accent per mode, curated swatches or a
 * custom colour, refusing a colour that would not be legible.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AccentPicker } from './AccentPicker';

describe('AccentPicker', () => {
  it('shows one swatch group per mode with the defaults checked when nothing is set', () => {
    render(<AccentPicker value={{}} onChange={vi.fn()} />);
    const dark = screen.getByRole('radiogroup', { name: 'Dark mode' });
    const light = screen.getByRole('radiogroup', { name: 'Light mode' });
    expect(within(dark).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
    expect(within(light).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
  });

  it('picking a swatch sets that mode and keeps the other mode as it was', () => {
    const onChange = vi.fn();
    render(<AccentPicker value={{ light: '#0b7a67' }} onChange={onChange} />);
    const dark = screen.getByRole('radiogroup', { name: 'Dark mode' });
    fireEvent.click(within(dark).getByRole('radio', { name: 'Colour #2fd3b5' }));
    expect(onChange).toHaveBeenCalledWith({ dark: '#2fd3b5', light: '#0b7a67' });
  });

  it('stores the default as no override', () => {
    const onChange = vi.fn();
    render(<AccentPicker value={{ dark: '#2fd3b5' }} onChange={onChange} />);
    const dark = screen.getByRole('radiogroup', { name: 'Dark mode' });
    fireEvent.click(within(dark).getByRole('radio', { name: 'Default' }));
    expect(onChange).toHaveBeenCalledWith({ dark: undefined, light: undefined });
  });

  it('marks a custom colour as selected', () => {
    render(<AccentPicker value={{ dark: '#3f7fd0' }} onChange={vi.fn()} />);
    const dark = screen.getByRole('radiogroup', { name: 'Dark mode' });
    expect(within(dark).queryByRole('radio', { checked: true })).toBeNull();
    expect(dark.querySelector('.accent-custom--selected')).not.toBeNull();
  });

  it('refuses an illegible custom colour and says why, without saving', () => {
    const onChange = vi.fn();
    render(<AccentPicker value={{}} onChange={onChange} />);
    const dark = screen.getByRole('radiogroup', { name: 'Dark mode' });
    const input = dark.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#1a1d26' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('too close to the background');
  });

  it('accepts a legible custom colour', () => {
    const onChange = vi.fn();
    render(<AccentPicker value={{}} onChange={onChange} />);
    const light = screen.getByRole('radiogroup', { name: 'Light mode' });
    const input = light.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#1f5f99' } });
    expect(onChange).toHaveBeenCalledWith({ dark: undefined, light: '#1f5f99' });
  });
});
