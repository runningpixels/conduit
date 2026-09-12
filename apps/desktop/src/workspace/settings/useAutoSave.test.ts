import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { useAutoSave } from './useAutoSave';

vi.mock('../../ipc/client', () => ({ updateSettings: vi.fn() }));
import { updateSettings } from '../../ipc/client';

/// The debounce is a timer owned by a component that can go away before it
/// fires. What happens then is not a detail: this hook is the only writer
/// behind the Settings sheet and behind onboarding's provider step, and both
/// unmount while an edit can still be pending.

const settings = { activeProvider: 'anthropic', theme: 'dark' } as unknown as AppSettings;

/** Minimal harness: mount the hook, hand the caller its `save`. */
function mountHook(onSettingsChange = vi.fn()) {
  let save!: (next: AppSettings) => void;
  function Harness() {
    save = useAutoSave(onSettingsChange, vi.fn());
    return null;
  }
  const view = render(createElement(Harness));
  return { save: (next: AppSettings) => save(next), unmount: view.unmount, onSettingsChange };
}

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(updateSettings).mockReset();
    vi.mocked(updateSettings).mockResolvedValue(settings);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces rather than writing per change', () => {
    const { save } = mountHook();
    save({ ...settings, theme: 'light' } as AppSettings);
    save({ ...settings, theme: 'system' } as AppSettings);
    expect(updateSettings).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(250));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'system' }));
  });

  it('flushes a pending write when the caller unmounts', () => {
    /* Close the Settings sheet within 250ms of a change and the edit must still
     * land. The debounce exists to batch keystrokes, not to discard the last
     * one. */
    const { save, unmount } = mountHook();
    save({ ...settings, theme: 'light' } as AppSettings);
    expect(updateSettings).not.toHaveBeenCalled();

    act(() => unmount());
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
  });

  it('leaves no timer running after unmount', () => {
    /* The regression that turned main red. A surviving timer writes at an
     * arbitrary later moment — in the app, after onboarding's language switch
     * has re-mounted everything and already persisted a newer value, so the
     * stale flush overwrites it; in the suite, during whichever test happened
     * to be running 250ms later, which is how it was found. */
    const { save, unmount } = mountHook();
    save({ ...settings, theme: 'light' } as AppSettings);
    act(() => unmount());
    expect(updateSettings).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(5_000));
    expect(updateSettings, 'a second write arrived after unmount').toHaveBeenCalledTimes(1);
  });

  it('does nothing on unmount when the write already went out', () => {
    const { save, unmount } = mountHook();
    save({ ...settings, theme: 'light' } as AppSettings);
    act(() => void vi.advanceTimersByTime(250));
    expect(updateSettings).toHaveBeenCalledTimes(1);

    act(() => unmount());
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
