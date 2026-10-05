import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContextWindow } from './useContextWindow';

// The backend's snapshot lookup, reduced to what these tests ask about:
// DeepSeek V4 at 1M (models.dev), and nothing known for anything else.
vi.mock('../ipc/client', () => ({
  resolveContextWindows: vi.fn(async (providerId: string, modelIds: string[]) => {
    if (providerId === 'broken') throw new Error('no backend');
    return modelIds.map((id) => (providerId === 'deepseek' && id.startsWith('deepseek-v4') ? 1_000_000 : null));
  }),
}));

describe('useContextWindow', () => {
  it('prefers the snapshot window over the family table', async () => {
    const { result } = renderHook(() => useContextWindow('deepseek', 'deepseek-v4-pro'));
    await waitFor(() => expect(result.current).toBe(1_000_000));
  });

  it('falls back to the family table when the snapshot does not know the model', async () => {
    const { result } = renderHook(() => useContextWindow('deepseek', 'deepseek-chat'));
    await waitFor(() => expect(result.current).toBe(128_000));
    expect(renderHook(() => useContextWindow('anthropic', 'claude-sonnet-4')).result.current).toBe(200_000);
  });

  it('falls back to the family table when the backend fails', async () => {
    const { result } = renderHook(() => useContextWindow('broken', 'gpt-4.1'));
    await waitFor(() => expect(result.current).toBe(1_000_000));
    expect(renderHook(() => useContextWindow('broken', 'not-a-model')).result.current).toBeNull();
  });
});
