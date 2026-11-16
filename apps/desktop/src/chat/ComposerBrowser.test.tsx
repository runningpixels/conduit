import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerBrowser } from './ComposerBrowser';
import type { ConversationBrowser } from '../ipc/contracts';

const on: ConversationBrowser = { use: true, act: false, sites: [] };

function show(browser: ConversationBrowser, onPaceChange = vi.fn()) {
  render(
    <ComposerBrowser
      open
      browser={browser}
      computerOn
      localOnly={false}
      onClose={vi.fn()}
      onChange={vi.fn()}
      onPaceChange={onPaceChange}
    />,
  );
  return { onPaceChange, select: screen.getByRole('combobox') as HTMLSelectElement };
}

describe('ComposerBrowser pace', () => {
  it('follows Settings until the chat picks its own pace', () => {
    const { select, onPaceChange } = show(on);
    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'fast' } });
    expect(onPaceChange).toHaveBeenCalledWith('fast');
  });

  it('goes back to Settings with the first choice', () => {
    const { select, onPaceChange } = show({ ...on, pace: 'human' });
    expect(select.value).toBe('human');
    fireEvent.change(select, { target: { value: '' } });
    expect(onPaceChange).toHaveBeenCalledWith(null);
  });

  it('is off while the browser is off for the chat', () => {
    const { select } = show({ ...on, use: false });
    expect(select.disabled).toBe(true);
  });
});
