import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { appName } from '../brand';
import { useWindowTitle } from './useWindowTitle';

describe('useWindowTitle', () => {
  afterEach(() => {
    document.title = '';
  });

  it('names the open chat before the app', () => {
    renderHook(() => useWindowTitle('Triage notes'));
    expect(document.title).toBe(`Triage notes — ${appName()}`);
  });

  it('falls back to the app name before a chat has one', () => {
    renderHook(() => useWindowTitle(undefined));
    expect(document.title).toBe(appName());
  });

  it('follows the chat as it changes', () => {
    const { rerender } = renderHook(({ title }) => useWindowTitle(title), {
      initialProps: { title: 'First' as string | undefined },
    });
    rerender({ title: 'Second' });
    expect(document.title).toBe(`Second — ${appName()}`);
  });
});
