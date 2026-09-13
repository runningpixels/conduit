import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuProps } from './Menu';

function Harness(props: Partial<MenuProps> & { withInput?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { withInput, ...menuProps } = props;
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen((v) => !v)}>
        Trigger
      </button>
      <button type="button">Elsewhere</button>
      <Menu open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Things" {...menuProps}>
        <button type="button" role="menuitem">One</button>
        <button type="button" role="menuitem">Two</button>
        {withInput ? <input aria-label="Model id" defaultValue="gpt" /> : null}
      </Menu>
    </div>
  );
}

describe('Menu', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the first item on open and hands focus back on Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'One' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays open on an outside press unless asked to dismiss', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes on an outside press with dismissOnOutsidePress, but leaves a trigger press to the trigger', () => {
    render(<Harness dismissOnOutsidePress />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    fireEvent.click(trigger);
    // The trigger's own press must not close it first and let the click reopen it.
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Two' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('enters the menu with ArrowDown from the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    fireEvent.click(trigger);
    trigger.focus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'One' }));
  });

  it('leaves Home, End and arrows to a text field inside the menu', () => {
    render(<Harness withInput />);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    const input = screen.getByRole('textbox', { name: 'Model id' });
    input.focus();
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('clamps a point-anchored menu inside the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true, writable: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 150,
      top: 0,
      left: 0,
      right: 200,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    render(<Harness anchorPoint={{ x: 750, y: 580 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    const menu = screen.getByRole('menu');
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe(`${800 - 200 - 8}px`);
    expect(menu.style.top).toBe(`${600 - 150 - 8}px`);
  });
});

/**
 * One keyboard model behind every menu. Five menus used to hand-roll their own
 * open/close, Escape and outside-press handling, and only some of them did
 * focus or arrow keys: the sidebar's row menu had neither, the composer's
 * folder menu did not close on Escape. A `role="menu"` written anywhere but
 * `Menu` is how that starts again.
 */
describe('every menu', () => {
  it('is a Menu', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(p) && !/\.test\./.test(p)) out.push(p);
      }
      return out;
    };
    const offenders = walk(srcRoot)
      .filter((file) => !file.endsWith(join('workspace', 'Menu.tsx')))
      .filter((file) => /role=["']menu["']/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcRoot, file).replace(/\\/g, '/'));
    expect(offenders, 'render these through workspace/Menu.tsx').toEqual([]);
  });
});
