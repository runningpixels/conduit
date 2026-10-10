import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((path: string, protocol: string) => `${protocol}://localhost/${path}`),
}));
const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);
vi.mock('../ipc/errors', () => ipc);

import { pageServerOrigin, useArtifactFrameSource } from './artifactFrameSource';

let next = 0;
// Cleared before each test, not after: RTL unmounts the previous test's hook
// after `afterEach` hooks run, and that unmount releases tokens too.
beforeEach(() => {
  vi.clearAllMocks();
  next = 0;
  core.isTauri.mockReturnValue(true);
  ipc.invokeCommand.mockImplementation(async (command: string) =>
    command === 'put_artifact_frame' ? { token: `token${++next}`, url: null } : undefined,
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
    let resolve!: (served: { token: string }) => void;
    ipc.invokeCommand.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { unmount } = renderHook(() => useArtifactFrameSource('late'));
    unmount();
    await act(async () => resolve({ token: 'tokenLate' }));
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

  it('serves a full-access page with a principal from its own origin', async () => {
    const page = 'http://0123456789abcdef0123456789abcdef.page.localhost:4321';
    ipc.invokeCommand.mockImplementation(async (command: string) =>
      command === 'put_artifact_frame' ? { token: 'tokenP', url: `${page}/tokenP` } : undefined,
    );
    const { result } = renderHook(() => useArtifactFrameSource('<p>a</p>', true, 'app:one'));
    await waitFor(() => expect(result.current.src).toBe(`${page}/tokenP`));
    expect(result.current.pageOrigin).toBe(page);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('put_artifact_frame', {
      html: '<p>a</p>',
      fullAccess: true,
      principal: 'app:one',
    });
  });

  it('keeps a full-access page without a principal on the scheme, with no origin of its own', async () => {
    const { result } = renderHook(() => useArtifactFrameSource('<p>a</p>', true));
    await waitFor(() => expect(result.current.src).toBe('conduit-artifact://localhost/token1'));
    expect(result.current.pageOrigin).toBeUndefined();
    expect(ipc.invokeCommand).toHaveBeenCalledWith('put_artifact_frame', { html: '<p>a</p>', fullAccess: true });
  });

  it('never gives a srcdoc frame an origin', () => {
    core.isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useArtifactFrameSource('<p>x</p>', true, 'app:one'));
    expect(result.current).toEqual({ srcDoc: '<p>x</p>' });
  });
});

describe('pageServerOrigin', () => {
  it('accepts only http page-server URLs', () => {
    expect(pageServerOrigin('http://abc.page.localhost:1234/t')).toBe('http://abc.page.localhost:1234');
    expect(pageServerOrigin('https://abc.page.localhost:1234/t')).toBeUndefined();
    expect(pageServerOrigin('http://tauri.localhost/t')).toBeUndefined();
    expect(pageServerOrigin('http://abc.page.localhost.evil.com/t')).toBeUndefined();
    expect(pageServerOrigin('not a url')).toBeUndefined();
  });
});
