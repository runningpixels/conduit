import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RunStatus } from '../chat/ChatView';
import { NOTIFY_AFTER_MS, useTurnFinishSignals, type TurnFinishSignalsOptions } from './useTurnFinishSignals';

function setup(initial: Partial<TurnFinishSignalsOptions> = {}) {
  const clock = { now: 1_000_000, focused: true };
  const notify = vi.fn();
  const base: TurnFinishSignalsOptions = {
    runStatus: null,
    activeConversationId: 'c1',
    titleOf: (id) => `Chat ${id}`,
    notifyEnabled: true,
    notify,
    notifyTitle: 'Reply finished',
    hasFocus: () => clock.focused,
    now: () => clock.now,
    ...initial,
  };
  const hook = renderHook((props: TurnFinishSignalsOptions) => useTurnFinishSignals(props), { initialProps: base });
  const rerender = (over: Partial<TurnFinishSignalsOptions>) => {
    Object.assign(base, over);
    hook.rerender({ ...base });
  };
  return { hook, rerender, clock, notify };
}

const running = (conversationId: string): RunStatus => ({ conversationId, needsYou: false });

describe('useTurnFinishSignals', () => {
  it('marks a chat done when its turn finishes while the user is in another chat, until they open it', () => {
    const { hook, rerender } = setup();
    rerender({ runStatus: running('c1') });
    rerender({ activeConversationId: 'c2' });
    rerender({ runStatus: null });
    expect(hook.result.current.finishedUnseen.has('c1')).toBe(true);
    rerender({ activeConversationId: 'c1' });
    expect(hook.result.current.finishedUnseen.has('c1')).toBe(false);
  });

  it('does not mark the chat the user is looking at', () => {
    const { hook, rerender } = setup();
    rerender({ runStatus: running('c1') });
    rerender({ runStatus: null });
    expect(hook.result.current.finishedUnseen.size).toBe(0);
  });

  it('notifies only when the window is in the background and the turn ran long', () => {
    const { rerender, clock, notify } = setup();
    rerender({ runStatus: running('c1') });
    clock.now += NOTIFY_AFTER_MS - 1;
    clock.focused = false;
    rerender({ runStatus: null });
    expect(notify).not.toHaveBeenCalled();

    rerender({ runStatus: running('c1') });
    clock.now += NOTIFY_AFTER_MS;
    rerender({ runStatus: null });
    expect(notify).toHaveBeenCalledWith('Reply finished', 'Chat c1');
  });

  it('respects the setting', () => {
    const { rerender, clock, notify } = setup({ notifyEnabled: false });
    rerender({ runStatus: running('c1') });
    clock.now += NOTIFY_AFTER_MS * 2;
    clock.focused = false;
    rerender({ runStatus: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a window coming back into focus counts as seeing the open chat', () => {
    const { hook, rerender, clock } = setup();
    rerender({ runStatus: running('c1') });
    clock.focused = false;
    rerender({ runStatus: null });
    expect(hook.result.current.finishedUnseen.has('c1')).toBe(true);
    clock.focused = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(hook.result.current.finishedUnseen.has('c1')).toBe(false);
  });

  it('shows a document as editing while the turn runs and done after it ends', () => {
    const { hook, rerender } = setup();
    rerender({ runStatus: running('c1') });
    act(() => {
      hook.result.current.noteDocumentActivity({ phase: 'start', toolName: 'patch_document', artifactId: 'a1' });
    });
    expect(hook.result.current.documentEditState('c1', 'a1')).toBe('editing');
    expect(hook.result.current.documentEditState('c1', 'a2')).toBeUndefined();
    expect(hook.result.current.documentEditState('c2', 'a1')).toBeUndefined();
    rerender({ runStatus: null });
    expect(hook.result.current.documentEditState('c1', 'a1')).toBe('done');
    // The next turn starts clean.
    rerender({ runStatus: running('c1') });
    expect(hook.result.current.documentEditState('c1', 'a1')).toBeUndefined();
  });

  it('ignores document activity when no turn runs', () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.noteDocumentActivity({ phase: 'start', toolName: 'patch_document', artifactId: 'a1' });
    });
    expect(hook.result.current.documentEditState('c1', 'a1')).toBeUndefined();
  });
});
