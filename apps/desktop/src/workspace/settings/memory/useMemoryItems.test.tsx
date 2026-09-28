import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../../../ipc/contracts';

const ipc = vi.hoisted(() => ({ listMemoryItems: vi.fn() }));
vi.mock('../../../ipc/client', () => ipc);
// A stable `t`, as the app's provider gives, so only the calls under test happen.
const i18n = vi.hoisted(() => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../../../i18n', () => i18n);

import { useMemoryItems } from './useMemoryItems';

const saved = { id: 'm1', kind: 'note', body: 'saved', pinned: false, status: 'active' } as MemoryItem;

describe('useMemoryItems', () => {
  it('ignores a list response that arrives after a newer one', async () => {
    // The first load is slow and answers with the list from before the save.
    let answerFirst!: (items: MemoryItem[]) => void;
    ipc.listMemoryItems
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue([saved]);
    const onStatus = vi.fn();
    const { result } = renderHook(() => useMemoryItems(onStatus));

    // A save reloads the list, and that newer answer arrives first.
    await act(async () => {
      await result.current.run('Saved', async () => {});
    });
    expect(result.current.items).toEqual([saved]);

    // The stale first answer must not overwrite it.
    await act(async () => answerFirst([]));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.items).toEqual([saved]);
    expect(ipc.listMemoryItems).toHaveBeenCalledTimes(2);
  });

  it('loads once, not again when the status callback or t change identity', async () => {
    ipc.listMemoryItems.mockReset().mockResolvedValue([]);
    const { rerender } = renderHook(({ onStatus }) => useMemoryItems(onStatus), {
      initialProps: { onStatus: vi.fn() },
    });
    await waitFor(() => expect(ipc.listMemoryItems).toHaveBeenCalledTimes(1));
    rerender({ onStatus: vi.fn() });
    rerender({ onStatus: vi.fn() });
    await act(async () => {});
    expect(ipc.listMemoryItems).toHaveBeenCalledTimes(1);
  });
});
