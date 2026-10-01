import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePageBridge } from './usePageBridge';

const ipc = vi.hoisted(() => ({
  pageStorageGet: vi.fn(),
  pageStorageSet: vi.fn(),
  pageStorageDelete: vi.fn(),
  pageStorageKeys: vi.fn(),
  // The real mapping (ipc/client.ts's bridgeErrorFromIpc): a "code: message"
  // prefix maps to that code, anything else to 'unavailable'.
  bridgeErrorFromIpc: vi.fn((e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    const at = text.indexOf(': ');
    if (at > 0) {
      const code = text.slice(0, at);
      if (['invalid', 'quota', 'rate_limited', 'unavailable'].includes(code)) {
        return { code, message: text.slice(at + 2) };
      }
    }
    return { code: 'unavailable', message: text };
  }),
}));

vi.mock('../ipc/client', () => ipc);

describe('usePageBridge', () => {
  it('returns undefined when there is no principal', () => {
    const { result } = renderHook(() => usePageBridge(null));
    expect(result.current).toBeUndefined();
  });

  it('routes each storage method to its IPC call', async () => {
    ipc.pageStorageGet.mockResolvedValue('dark');
    ipc.pageStorageSet.mockResolvedValue(undefined);
    ipc.pageStorageDelete.mockResolvedValue(undefined);
    ipc.pageStorageKeys.mockResolvedValue(['a', 'b']);
    const { result } = renderHook(() => usePageBridge('artifact:a1'));
    const bridge = result.current!;

    await expect(bridge('storage.get', { key: 'theme' })).resolves.toEqual({ ok: true, result: 'dark' });
    expect(ipc.pageStorageGet).toHaveBeenCalledWith('artifact:a1', 'theme');

    await expect(bridge('storage.set', { key: 'theme', value: 'dark' })).resolves.toEqual({ ok: true, result: null });
    expect(ipc.pageStorageSet).toHaveBeenCalledWith('artifact:a1', 'theme', 'dark');

    await expect(bridge('storage.delete', { key: 'theme' })).resolves.toEqual({ ok: true, result: null });
    expect(ipc.pageStorageDelete).toHaveBeenCalledWith('artifact:a1', 'theme');

    await expect(bridge('storage.keys', { prefix: 'todo:' })).resolves.toEqual({ ok: true, result: ['a', 'b'] });
    expect(ipc.pageStorageKeys).toHaveBeenCalledWith('artifact:a1', 'todo:');
  });

  it('maps "quota: too big" to a quota error', async () => {
    ipc.pageStorageSet.mockRejectedValue(new Error('quota: too big'));
    const { result } = renderHook(() => usePageBridge('app:a1'));
    const bridge = result.current!;
    await expect(bridge('storage.set', { key: 'x', value: 1 })).resolves.toEqual({
      ok: false,
      error: { code: 'quota', message: 'too big' },
    });
  });

  it('maps an unrecognised rejection to unavailable rather than guessing', async () => {
    ipc.pageStorageGet.mockRejectedValue(new Error('the database is on fire'));
    const { result } = renderHook(() => usePageBridge('app:a1'));
    const bridge = result.current!;
    await expect(bridge('storage.get', { key: 'x' })).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'the database is on fire' },
    });
  });

  it('routes llm.complete to the given llm handler', async () => {
    const llm = vi.fn().mockResolvedValue({ ok: true, result: { text: 'answer' } });
    const { result } = renderHook(() => usePageBridge('artifact:a1', llm));
    const bridge = result.current!;
    await expect(bridge('llm.complete', { prompt: 'hi' })).resolves.toEqual({ ok: true, result: { text: 'answer' } });
    expect(llm).toHaveBeenCalledWith({ prompt: 'hi' });
  });

  it('answers unavailable for llm.complete when no llm handler is given', async () => {
    const { result } = renderHook(() => usePageBridge('artifact:a1'));
    const bridge = result.current!;
    await expect(bridge('llm.complete', { prompt: 'hi' })).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'This page has no model access.' },
    });
  });
});
