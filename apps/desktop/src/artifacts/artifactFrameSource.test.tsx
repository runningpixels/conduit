import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((path: string, protocol: string) => `${protocol}://localhost/${path}`),
}));
const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);
vi.mock('../ipc/errors', () => ipc);

import { useArtifactFrameSource } from './artifactFrameSource';

let next = 0;
// Cleared before each test, not after: RTL unmounts the previous test's hook
// after `afterEach` hooks run, and that unmount releases tokens too.
beforeEach(() => {
  vi.clearAllMocks();
  next = 0;
  core.isTauri.mockReturnValue(true);
  ipc.invokeCommand.mockImplementation(async (command: string) =>
    command === 'put_artifact_frame' ? `token${++next}` : undefined,
  );
});

const dropped = () =>
  ipc.invokeCommand.mock.calls.filter(([c]) => c === 'drop_artifact_frame').map(([, a]) => a.token);

describe('useArtifactFrameSource', () => {
  it('serves the document from the conduit-artifact scheme inside Tauri', async () => {
    const { result } = renderHook(() => useArtifactFrameSource('<p>a</p>'));
    await waitFor(() => expect(result.current.src).toBe('conduit-artifact://localhost/token1'));
    expect(result.current.srcDoc).toBeUndefined();
    expect(ipc.invokeCommand).toHaveBeenCalledWith('put_artifact_frame', { html: '<p>a</p>' });
  });

  it('keeps the old document until the new one is served, then releases the old token', async () => {
    const { result, rerender } = renderHook(({ doc }) => useArtifactFrameSource(doc), {
      initialProps: { doc: 'one' },
    });
    await waitFor(() => expect(result.current.src).toContain('token1'));
    rerender({ doc: 'two' });
    expect(result.current.src).toContain('token1');
    await waitFor(() => expect(result.current.src).toContain('token2'));
    expect(dropped()).toEqual(['token1']);
  });

  it('releases its token on unmount, including one that arrives after unmount', async () => {
    let resolve!: (token: string) => void;
    ipc.invokeCommand.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { unmount } = renderHook(() => useArtifactFrameSource('late'));
    unmount();
    await act(async () => resolve('tokenLate'));
    expect(dropped()).toEqual(['tokenLate']);
  });

  it('falls back to srcdoc outside Tauri', () => {
    core.isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useArtifactFrameSource('<p>x</p>'));
    expect(result.current).toEqual({ srcDoc: '<p>x</p>' });
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it('does not serve an empty document', () => {
    const { result } = renderHook(() => useArtifactFrameSource(''));
    expect(result.current).toEqual({ srcDoc: '' });
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it('falls back to srcdoc when the document cannot be served', async () => {
    ipc.invokeCommand.mockRejectedValueOnce(new Error('too large'));
    const { result } = renderHook(() => useArtifactFrameSource('<p>x</p>'));
    await waitFor(() => expect(result.current).toEqual({ srcDoc: '<p>x</p>' }));
  });
});
