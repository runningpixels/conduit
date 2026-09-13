import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { bindingHint, ShortcutsSheet } from './ShortcutsSheet';
import { HOTKEYS, matchHotkey, useHotkeys, type HotkeyHandlers } from './useHotkeys';
import { EN_MESSAGES } from '../i18n';

function keydown(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('the hotkey registry', () => {
  it.each(HOTKEYS.map((binding) => [binding.id, binding] as const))('fires %s from its own chord', (id, binding) => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ [id]: handler } as HotkeyHandlers));
    const event = keydown({ key: binding.key, ctrlKey: true, shiftKey: binding.shift === true });
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the chords apart: Shift changes what a key does', () => {
    expect(matchHotkey(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }))?.id).toBe('newChat');
    expect(matchHotkey(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(matchHotkey(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }))?.id).toBe('forkConversationHere');
    expect(matchHotkey(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))).toBeUndefined();
  });

  // "/" is Shift+7 on a German keyboard.
  it('accepts Mod+/ with or without Shift', () => {
    expect(matchHotkey(new KeyboardEvent('keydown', { key: '/', ctrlKey: true }))?.id).toBe('shortcuts');
    expect(matchHotkey(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, shiftKey: true }))?.id).toBe('shortcuts');
  });

  it('accepts Cmd as well as Ctrl', () => {
    expect(matchHotkey(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))?.id).toBe('historySearch');
  });

  it('leaves shortcuts alone while typing, but not Escape', () => {
    const newChat = vi.fn();
    const escape = vi.fn();
    renderHook(() => useHotkeys({ newChat, escape }));
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    keydown({ key: 'n', ctrlKey: true }, input);
    keydown({ key: 'Escape' }, input);
    expect(newChat).not.toHaveBeenCalled();
    expect(escape).toHaveBeenCalledOnce();
    input.remove();
  });

  it('binds no chord twice', () => {
    const chords = HOTKEYS.map((b) => `${b.key}:${b.shift}`);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('names every binding in the catalog', () => {
    expect(HOTKEYS.map((b) => b.labelId).filter((id) => !(id in EN_MESSAGES))).toEqual([]);
  });

  /**
   * The table is the single source of truth only if nothing else matches
   * keys: a chord added straight into the handler would be bound but missing
   * from the sheet, which is the drift the table exists to stop.
   */
  it('is the only place keys are matched', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'useHotkeys.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function useHotkeys'));
    expect(body).not.toMatch(/key\s*===\s*'[a-z,\\/]'/);
  });
});

describe('ShortcutsSheet', () => {
  it('lists every binding, grouped, with its platform hint', () => {
    render(<ShortcutsSheet open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const binding of HOTKEYS) {
      const label = EN_MESSAGES[binding.labelId];
      const row = Array.from(dialog.querySelectorAll<HTMLElement>('.shortcuts-row')).find(
        (candidate) => candidate.querySelector('dt')?.textContent === label,
      );
      expect(row, `no row for ${binding.id}`).toBeDefined();
      if (!row) continue;
      expect(within(row).getByText(bindingHint(binding))).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('region', { name: 'General' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Layout' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(within(dialog).getByText('Esc')).toBeInTheDocument();
  });

  it('shows Shift in the hint only for chords that need it', () => {
    const fork = HOTKEYS.find((b) => b.id === 'forkConversationHere')!;
    const slash = HOTKEYS.find((b) => b.id === 'shortcuts')!;
    expect(bindingHint(fork)).toBe('Ctrl+Shift+F');
    expect(bindingHint(slash)).toBe('Ctrl+/');
  });

  it('takes focus, and closes on Escape, the close button and the backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsSheet open onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(container.querySelector('.cu-dialog-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('renders nothing while closed', () => {
    render(<ShortcutsSheet open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
