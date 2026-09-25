import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useHotkeys, type HotkeyHandlers } from './useHotkeys';

function Harness({ handlers }: { handlers: HotkeyHandlers }) {
  useHotkeys(handlers);
  return <textarea aria-label="composer" />;
}

describe('useHotkeys', () => {
  it('leaves keystrokes to the input method mid-composition', () => {
    const newChat = vi.fn();
    const { getByLabelText } = render(<Harness handlers={{ newChat }} />);
    fireEvent.keyDown(getByLabelText('composer'), { key: 'n', ctrlKey: true, isComposing: true });
    expect(newChat).not.toHaveBeenCalled();
  });

  it('ignores plain typing', () => {
    const newChat = vi.fn();
    const { getByLabelText } = render(<Harness handlers={{ newChat }} />);
    fireEvent.keyDown(getByLabelText('composer'), { key: 'n' });
    expect(newChat).not.toHaveBeenCalled();
  });
});
