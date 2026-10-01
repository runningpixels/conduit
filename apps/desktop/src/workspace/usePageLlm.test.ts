import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const pageLlmState = vi.fn();
const grantPageLlm = vi.fn();
const revokePageLlm = vi.fn();
const pageLlmComplete = vi.fn();
// The real mapping (ipc/client.ts's bridgeErrorFromIpc): a "code: message"
// prefix maps to that code, anything else to 'unavailable'.
const bridgeErrorFromIpc = vi.fn((e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  const at = text.indexOf(': ');
  if (at > 0) {
    const code = text.slice(0, at);
    if (['invalid', 'quota', 'rate_limited', 'unavailable', 'not_granted', 'timeout'].includes(code)) {
      return { code, message: text.slice(at + 2) };
    }
  }
  return { code: 'unavailable', message: text };
});

vi.mock('../ipc/client', () => ({
  pageLlmState: (...args: unknown[]) => pageLlmState(...args),
  grantPageLlm: (...args: unknown[]) => grantPageLlm(...args),
  revokePageLlm: (...args: unknown[]) => revokePageLlm(...args),
  pageLlmComplete: (...args: unknown[]) => pageLlmComplete(...args),
  bridgeErrorFromIpc: (e: unknown) => bridgeErrorFromIpc(e),
}));

const { usePageLlm } = await import('./usePageLlm');

const CLOUD_STATE = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  isLocal: false,
  blockedReason: null,
  granted: null,
};

let nextId = 0;
function principal() {
  nextId += 1;
  return `artifact:page-${nextId}` as const;
}

/** Each test resets and re-seeds the mocks explicitly, rather than a shared
 *  `beforeEach`, since several tests need a different `pageLlmState` result
 *  before the hook even mounts. */
function freshMocks() {
  pageLlmState.mockReset().mockResolvedValue(CLOUD_STATE);
  grantPageLlm.mockReset().mockResolvedValue(undefined);
  revokePageLlm.mockReset().mockResolvedValue(undefined);
  pageLlmComplete.mockReset().mockResolvedValue({ text: 'answer' });
  bridgeErrorFromIpc.mockClear();
}

describe('usePageLlm', () => {
  it('blocked (local-only with a cloud provider, or no provider) answers unavailable', async () => {
    freshMocks();
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, blockedReason: 'Local-only mode is on.' });
    const { result } = renderHook(() => usePageLlm(principal()));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const outcome = await result.current.handler({ prompt: 'hi' });
    expect(outcome).toEqual({ ok: false, error: { code: 'unavailable', message: 'Local-only mode is on.' } });
    expect(pageLlmComplete).not.toHaveBeenCalled();
  });

  it('granted goes straight to pageLlmComplete', async () => {
    freshMocks();
    const id = principal();
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'always' });
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const outcome = await result.current.handler({ prompt: 'Summarize this.' });
    expect(outcome).toEqual({ ok: true, result: { text: 'answer' } });
    expect(pageLlmComplete).toHaveBeenCalledWith(id, { prompt: 'Summarize this.' });
    expect(grantPageLlm).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it('quick slot checks consent for the slot provider and passes the slot through', async () => {
    freshMocks();
    const id = principal();
    const LOCAL = { ...CLOUD_STATE, providerId: 'ollama', providerName: 'Ollama', isLocal: true, granted: 'always' };
    pageLlmState.mockImplementation(async (_p: unknown, slot?: string) => (slot === 'quick' ? LOCAL : CLOUD_STATE));
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const outcome = await result.current.handler({ prompt: 'Hi', slot: 'quick' });
    expect(outcome).toEqual({ ok: true, result: { text: 'answer' } });
    expect(pageLlmState).toHaveBeenCalledWith(id, 'quick');
    expect(pageLlmComplete).toHaveBeenCalledWith(id, { prompt: 'Hi', slot: 'quick' });
    expect(result.current.pending).toBe(false);
  });

  it('not granted holds the call until decide("session") grants then runs it', async () => {
    freshMocks();
    const id = principal();
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    let settled: unknown = null;
    act(() => {
      void result.current.handler({ prompt: 'hi' }).then((r) => (settled = r));
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(pageLlmComplete).not.toHaveBeenCalled();
    expect(settled).toBeNull();

    // The state reflects the grant once the decision lands (used by AppView's
    // strip fact and DocumentPanel to stop asking).
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'session' });
    await act(async () => {
      await result.current.decide('session');
    });
    expect(grantPageLlm).toHaveBeenCalledWith(id, 'session', 'default');
    await waitFor(() => expect(settled).toEqual({ ok: true, result: { text: 'answer' } }));
    expect(result.current.pending).toBe(false);
    expect(result.current.state?.granted).toBe('session');
  });

  it('grants the provider of each slot that is waiting', async () => {
    freshMocks();
    const id = principal();
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => {
      void result.current.handler({ prompt: 'a', slot: 'quick' });
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'always' });
    await act(async () => {
      await result.current.decide('page');
    });
    expect(grantPageLlm).toHaveBeenCalledTimes(1);
    expect(grantPageLlm).toHaveBeenCalledWith(id, 'page', 'quick');
  });

  it('deny answers not_granted and does not re-prompt on the next call', async () => {
    freshMocks();
    const id = principal();
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    let first: unknown = null;
    act(() => {
      void result.current.handler({ prompt: 'hi' }).then((r) => (first = r));
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      await result.current.decide('deny');
    });
    expect(grantPageLlm).not.toHaveBeenCalled();
    expect(first).toEqual({
      ok: false,
      error: { code: 'not_granted', message: "You didn't allow this page to use your model." },
    });
    expect(result.current.pending).toBe(false);

    // No re-prompt: the second call is refused immediately, not held.
    const second = await result.current.handler({ prompt: 'again' });
    expect(second).toEqual({
      ok: false,
      error: { code: 'not_granted', message: "You didn't allow this page to use your model." },
    });
    expect(result.current.pending).toBe(false);
  });

  it('maps a pageLlmComplete rejection through bridgeErrorFromIpc', async () => {
    freshMocks();
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'always' });
    pageLlmComplete.mockRejectedValue(new Error('rate_limited: Too many calls.'));
    const { result } = renderHook(() => usePageLlm(principal()));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const outcome = await result.current.handler({ prompt: 'hi' });
    expect(outcome).toEqual({ ok: false, error: { code: 'rate_limited', message: 'Too many calls.' } });
  });

  it('rejects an invalid request locally without calling pageLlmComplete', async () => {
    freshMocks();
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'always' });
    const { result } = renderHook(() => usePageLlm(principal()));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const outcome = await result.current.handler({ prompt: '' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(pageLlmComplete).not.toHaveBeenCalled();
  });

  it('revoke clears the grant and re-reads state', async () => {
    freshMocks();
    const id = principal();
    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: 'always' });
    const { result } = renderHook(() => usePageLlm(id));
    await waitFor(() => expect(result.current.state?.granted).toBe('always'));

    pageLlmState.mockResolvedValue({ ...CLOUD_STATE, granted: null });
    await act(async () => {
      await result.current.revoke();
    });
    expect(revokePageLlm).toHaveBeenCalledWith(id);
    expect(result.current.state?.granted).toBeNull();
  });
});
