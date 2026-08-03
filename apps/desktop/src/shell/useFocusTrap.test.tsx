import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';

function TrapFixture({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div>
      <button type="button" data-testid="outside">Outside</button>
      <div ref={ref} data-testid="trap">
        <button type="button" data-testid="first">First</button>
        <button type="button" data-testid="second">Second</button>
        <a href="#x" data-testid="link">Link</a>
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('wraps Tab forward from the last to the first focusable', () => {
    render(<TrapFixture active />);
    const last = screen.getByTestId('link');
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('wraps Shift+Tab backward from the first to the last focusable', () => {
    render(<TrapFixture active />);
    const first = screen.getByTestId('first');
    first.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('link'));
  });

  it('does not trap when inactive', () => {
    render(<TrapFixture active={false} />);
    const last = screen.getByTestId('link');
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the previously focused element on deactivate', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { rerender } = render(<TrapFixture active />);
    rerender(<TrapFixture active={false} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('ignores non-Tab keys', () => {
    render(<TrapFixture active />);
    const first = screen.getByTestId('first');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  it('does not trap or preventDefault when focus is inside and not on an edge', () => {
    // jsdom has no native Tab navigation, so the assertion is that the trap
    // leaves the event alone (not canceled) for a middle element. fireEvent
    // returns dispatchEvent's result: true = default was NOT prevented.
    render(<TrapFixture active />);
    const second = screen.getByTestId('second');
    second.focus();
    const notPrevented = fireEvent.keyDown(second, { key: 'Tab' });
    expect(notPrevented).toBe(true);
  });
});
