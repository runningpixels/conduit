import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ARTIFACT_FRAME_CLOSED, type ArtifactFetchMessage } from '../artifacts/networkBridge';

const artifactFetch = vi.fn();
const getArtifactNetworkState = vi.fn();
const grantArtifactNetwork = vi.fn();
const revokeArtifactNetworkGrant = vi.fn();

vi.mock('../ipc/client', () => ({
  artifactFetch: (...args: unknown[]) => artifactFetch(...args),
  getArtifactNetworkState: (...args: unknown[]) => getArtifactNetworkState(...args),
  grantArtifactNetwork: (...args: unknown[]) => grantArtifactNetwork(...args),
  revokeArtifactNetworkGrant: (...args: unknown[]) => revokeArtifactNetworkGrant(...args),
}));

const { useArtifactNetwork } = await import('./useArtifactNetwork');

let nextArtifact = 0;
function message(url: string, extra: Partial<ArtifactFetchMessage> = {}): ArtifactFetchMessage {
  return { id: 1, url, method: 'GET', headers: [], body: null, ...extra };
}

beforeEach(() => {
  artifactFetch.mockReset().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json']],
    body: btoa('{"temp":21}'),
    url: 'https://api.open-meteo.com/v1/forecast',
  });
  getArtifactNetworkState.mockReset().mockResolvedValue({ blockedReason: null, always: [], session: [] });
  grantArtifactNetwork.mockReset().mockResolvedValue(undefined);
  revokeArtifactNetworkGrant.mockReset().mockResolvedValue(undefined);
  nextArtifact += 1;
});

describe('useArtifactNetwork', () => {
  it('holds a request to an undecided site until the reader allows it', async () => {
    const id = `artifact:page-${nextArtifact}` as const;
    const { result } = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    let settled: unknown = null;
    act(() => {
      void result.current.handler
        .request(message('https://api.open-meteo.com/v1/forecast?x=1'))
        .then((r) => (settled = r));
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0].origin).toBe('https://api.open-meteo.com');
    expect(artifactFetch).not.toHaveBeenCalled();
    expect(settled).toBeNull();

    await act(async () => {
      await result.current.decide(['https://api.open-meteo.com'], 'session');
    });
    expect(grantArtifactNetwork).toHaveBeenCalledWith(id, 'https://api.open-meteo.com', 'session');
    await waitFor(() => expect(settled).toMatchObject({ ok: true, status: 200 }));
    expect(new TextDecoder().decode((settled as { body: ArrayBuffer }).body)).toBe('{"temp":21}');
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.state?.session).toContain('https://api.open-meteo.com');
    await waitFor(() => expect(result.current.log[0]).toMatchObject({ status: 200, sinceChange: false }));
  });

  it('goes straight to Rust for a site already allowed', async () => {
    getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['https://api.open-meteo.com'], session: [] });
    const { result } = renderHook(() => useArtifactNetwork(`artifact:page-${nextArtifact}` as const, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const res = await result.current.handler.request(
      message('https://api.open-meteo.com/v1', { method: 'POST', body: new TextEncoder().encode('hi').buffer }),
    );
    expect(res).toMatchObject({ ok: true });
    expect(artifactFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: btoa('hi') }));
    expect(result.current.pending).toHaveLength(0);
  });

  it('refuses held and later requests once the reader says no', async () => {
    const { result } = renderHook(() => useArtifactNetwork(`artifact:page-${nextArtifact}` as const, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    let first: unknown = null;
    act(() => {
      void result.current.handler.request(message('https://tracker.example/p')).then((r) => (first = r));
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(async () => {
      await result.current.decide(['https://tracker.example'], 'deny');
    });
    await waitFor(() => expect(first).toMatchObject({ ok: false }));
    const again = await result.current.handler.request(message('https://tracker.example/q'));
    expect(again).toMatchObject({ ok: false });
    expect(result.current.denied.has('https://tracker.example')).toBe(true);
    expect(grantArtifactNetwork).not.toHaveBeenCalled();
    expect(artifactFetch).not.toHaveBeenCalled();
  });

  it('refuses everything, without asking, when requests are blocked', async () => {
    getArtifactNetworkState.mockResolvedValue({
      blockedReason: "Local-only mode is on, so pages can't connect to the internet.",
      always: ['https://api.open-meteo.com'],
      session: [],
    });
    const { result } = renderHook(() => useArtifactNetwork(`artifact:page-${nextArtifact}` as const, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const res = await result.current.handler.request(message('https://api.open-meteo.com/v1'));
    expect(res).toEqual({ ok: false, error: "Local-only mode is on, so pages can't connect to the internet." });
    expect(result.current.pending).toHaveLength(0);
    expect(artifactFetch).not.toHaveBeenCalled();
  });

  it('asks about the site a redirect leads to, then re-sends the request', async () => {
    getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['https://api.frankfurter.app'], session: [] });
    artifactFetch.mockRejectedValueOnce(
      'redirect:https://api.frankfurter.dev The server redirected to api.frankfurter.dev, which this page has not been allowed to contact.',
    );
    const id = `artifact:page-${nextArtifact}` as const;
    const { result } = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    let settled: unknown = null;
    act(() => {
      void result.current.handler.request(message('https://api.frankfurter.app/latest')).then((r) => (settled = r));
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]).toMatchObject({
      origin: 'https://api.frankfurter.dev',
      redirectFrom: 'https://api.frankfurter.app',
    });
    expect(settled).toBeNull();
    expect(result.current.log.at(-1)?.error).toMatch(/^The server redirected/);

    await act(async () => {
      await result.current.decide(['https://api.frankfurter.dev'], 'page');
    });
    expect(grantArtifactNetwork).toHaveBeenCalledWith(id, 'https://api.frankfurter.dev', 'page');
    await waitFor(() => expect(settled).toMatchObject({ ok: true, status: 200 }));
    expect(artifactFetch).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://api.frankfurter.app/latest' }));
  });

  it('allows any public site with one decision', async () => {
    const id = `artifact:page-${nextArtifact}` as const;
    const { result } = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const results: unknown[] = [];
    act(() => {
      void result.current.handler.request(message('https://a.example/1')).then((r) => results.push(r));
      void result.current.handler.request(message('https://b.example/2')).then((r) => results.push(r));
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(2));
    await act(async () => {
      await result.current.decide(['https://a.example'], 'session', true);
    });
    expect(grantArtifactNetwork).toHaveBeenCalledTimes(1);
    expect(grantArtifactNetwork).toHaveBeenCalledWith(id, '*', 'session');
    await waitFor(() => expect(results).toHaveLength(2));
    expect(result.current.pending).toHaveLength(0);
    // A new site goes straight through.
    await expect(result.current.handler.request(message('https://c.example/'))).resolves.toMatchObject({ ok: true });
    expect(result.current.pending).toHaveLength(0);
  });

  it('refuses plain http without asking', async () => {
    const { result } = renderHook(() => useArtifactNetwork(`artifact:page-${nextArtifact}` as const, '<html>'));
    const res = await result.current.handler.request(message('http://example.com/'));
    expect(res).toMatchObject({ ok: false });
    expect(result.current.pending).toHaveLength(0);
  });

  it('marks requests made after the page changed', async () => {
    getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['https://api.open-meteo.com'], session: [] });
    const { result, rerender } = renderHook(({ content }) => useArtifactNetwork(`artifact:page-${nextArtifact}` as const, content), {
      initialProps: { content: '<v1>' },
    });
    await waitFor(() => expect(result.current.state).not.toBeNull());
    // Content that arrives before the first request is the baseline.
    rerender({ content: '<v2>' });
    await act(async () => {
      await result.current.handler.request(message('https://api.open-meteo.com/v1'));
    });
    expect(result.current.log.at(-1)).toMatchObject({ sinceChange: false, status: 200 });
    rerender({ content: '<v3>' });
    await act(async () => {
      await result.current.handler.request(message('https://api.open-meteo.com/v1'));
    });
    expect(result.current.log.at(-1)).toMatchObject({ sinceChange: true, status: 200 });
  });
});

describe('useArtifactNetwork when the page stops waiting', () => {
  async function heldRequest(url: string) {
    const id = `artifact:page-${nextArtifact}` as const;
    const hook = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(hook.result.current.state).not.toBeNull());
    const controller = new AbortController();
    let settled: unknown = null;
    act(() => {
      void hook.result.current.handler.request(message(url), controller.signal).then((r) => (settled = r));
    });
    await waitFor(() => expect(hook.result.current.pending).toHaveLength(1));
    return { ...hook, controller, settled: () => settled };
  }

  it('drops a held request the page aborted and starts the page over once the site is allowed', async () => {
    const { result, controller, settled } = await heldRequest('https://hacker-news.firebaseio.com/v0/top.json');
    act(() => controller.abort());
    await waitFor(() => expect(settled()).toMatchObject({ ok: false }));
    // The reader still has to decide on the site.
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.reloadToken).toBe(0);

    await act(async () => {
      await result.current.decide(['https://hacker-news.firebaseio.com'], 'page');
    });
    expect(grantArtifactNetwork).toHaveBeenCalledTimes(1);
    expect(artifactFetch).not.toHaveBeenCalled();
    expect(result.current.reloadToken).toBe(1);
    expect(result.current.pending).toHaveLength(0);
  });

  it('releases requests still waiting without starting the page over', async () => {
    const { result, settled } = await heldRequest('https://hacker-news.firebaseio.com/v0/top.json');
    await act(async () => {
      await result.current.decide(['https://hacker-news.firebaseio.com'], 'session');
    });
    await waitFor(() => expect(settled()).toMatchObject({ ok: true, status: 200 }));
    expect(artifactFetch).toHaveBeenCalledTimes(1);
    expect(result.current.reloadToken).toBe(0);
  });

  it('does not start the page over when the reader refuses the site', async () => {
    const { result, controller } = await heldRequest('https://hacker-news.firebaseio.com/v0/top.json');
    act(() => controller.abort());
    await act(async () => {
      await result.current.decide(['https://hacker-news.firebaseio.com'], 'deny');
    });
    expect(result.current.reloadToken).toBe(0);
    expect(artifactFetch).not.toHaveBeenCalled();
  });

  it('starts the page over on allowing any site, without sending what was still held', async () => {
    const { result, controller } = await heldRequest('https://a.example/1');
    let other: unknown = null;
    act(() => {
      void result.current.handler.request(message('https://b.example/2')).then((r) => (other = r));
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(2));
    act(() => controller.abort());
    await act(async () => {
      await result.current.decide(['https://a.example'], 'session', true);
    });
    expect(result.current.reloadToken).toBe(1);
    // The restarted page asks again itself; sending this too would repeat it.
    await waitFor(() => expect(other).toMatchObject({ ok: false }));
    expect(artifactFetch).not.toHaveBeenCalled();
  });

  it('forgets a request whose frame went away without starting the page over', async () => {
    const { result, controller, settled } = await heldRequest('https://hacker-news.firebaseio.com/v0/top.json');
    act(() => controller.abort(ARTIFACT_FRAME_CLOSED));
    await waitFor(() => expect(settled()).toMatchObject({ ok: false }));
    await act(async () => {
      await result.current.decide(['https://hacker-news.firebaseio.com'], 'page');
    });
    expect(result.current.reloadToken).toBe(0);
    expect(artifactFetch).not.toHaveBeenCalled();
  });
});

describe('useArtifactNetwork full web access (ADR-007)', () => {
  const page = () => `artifact:page-${nextArtifact}` as const;
  const cdn = { kind: 'scripts' as const, origin: 'https://cdnjs.cloudflare.com' };

  it('is unknown until the state is read, then follows it', async () => {
    let resolve: (v: unknown) => void = () => {};
    getArtifactNetworkState.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useArtifactNetwork(page(), '<html>'));
    expect(result.current.fullAccess).toBeUndefined();
    await act(async () => resolve({ blockedReason: null, always: ['full'], session: [], fullAccess: true }));
    expect(result.current.fullAccess).toBe(true);
  });

  it('counts as not granted when the state cannot be read, and false with no page', async () => {
    getArtifactNetworkState.mockRejectedValue(new Error('ipc down'));
    const { result } = renderHook(() => useArtifactNetwork(page(), '<html>'));
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    const none = renderHook(() => useArtifactNetwork(null, ''));
    expect(none.result.current.fullAccess).toBe(false);
  });

  it('offers full access for what was stopped, deduped', async () => {
    const { result } = renderHook(() => useArtifactNetwork(page(), '<html>'));
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    expect(result.current.fullAccessRequest).toEqual([]);
    act(() => {
      result.current.reportBlocked(cdn);
      result.current.reportBlocked(cdn);
      result.current.reportBlocked({ kind: 'images', origin: 'https://upload.wikimedia.org' });
    });
    expect(result.current.fullAccessRequest).toEqual([cdn, { kind: 'images', origin: 'https://upload.wikimedia.org' }]);
  });

  it('allowing stores the grant on the page and starts it over with full access', async () => {
    const id = page();
    const { result } = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    act(() => result.current.reportBlocked(cdn));
    const before = result.current.reloadToken;
    await act(async () => {
      await result.current.allowFullAccess();
    });
    expect(grantArtifactNetwork).toHaveBeenCalledWith(id, 'full', 'page');
    expect(result.current.fullAccess).toBe(true);
    expect(result.current.reloadToken).toBe(before + 1);
    expect(result.current.fullAccessRequest).toEqual([]);
    expect(result.current.state?.always).toContain('full');
    // Full access implies any site: fetch() no longer asks.
    const res = await result.current.handler.request(message('https://api.example.com/x'));
    expect(res).toMatchObject({ ok: true });
    expect(result.current.pending).toHaveLength(0);
  });

  it('a failed grant changes nothing and does not restart the page', async () => {
    grantArtifactNetwork.mockRejectedValue(new Error('This page no longer exists.'));
    const { result } = renderHook(() => useArtifactNetwork(page(), '<html>'));
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    act(() => result.current.reportBlocked(cdn));
    await act(async () => {
      await result.current.allowFullAccess();
    });
    expect(result.current.reloadToken).toBe(0);
    expect(result.current.fullAccess).toBe(false);
  });

  it('"Not now" stops offering it for this page this session', async () => {
    const id = page();
    const { result, unmount } = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    act(() => result.current.reportBlocked(cdn));
    act(() => result.current.dismissFullAccess());
    expect(result.current.fullAccessRequest).toEqual([]);
    unmount();
    const again = renderHook(() => useArtifactNetwork(id, '<html>'));
    await waitFor(() => expect(again.result.current.fullAccess).toBe(false));
    act(() => again.result.current.reportBlocked(cdn));
    expect(again.result.current.fullAccessRequest).toEqual([]);
  });

  it('does not offer it while pages cannot connect, or when already granted by the switch', async () => {
    getArtifactNetworkState.mockResolvedValue({ blockedReason: 'Local-only mode is on.', always: [], session: [], fullAccess: false });
    const blocked = renderHook(() => useArtifactNetwork(page(), '<html>'));
    await waitFor(() => expect(blocked.result.current.fullAccess).toBe(false));
    act(() => blocked.result.current.reportBlocked(cdn));
    expect(blocked.result.current.fullAccessRequest).toEqual([]);

    nextArtifact += 1;
    getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [], fullAccess: true });
    const everyPage = renderHook(() => useArtifactNetwork(page(), '<html>'));
    await waitFor(() => expect(everyPage.result.current.fullAccess).toBe(true));
    act(() => everyPage.result.current.reportBlocked(cdn));
    expect(everyPage.result.current.fullAccessRequest).toEqual([]);
    const res = await everyPage.result.current.handler.request(message('https://api.example.com/x'));
    expect(res).toMatchObject({ ok: true });
  });

  it('re-reads the state when the policy key changes (the Settings switch)', async () => {
    const { result, rerender } = renderHook(({ key }) => useArtifactNetwork(page(), '<html>', key), {
      initialProps: { key: 'false:true:false' },
    });
    await waitFor(() => expect(result.current.fullAccess).toBe(false));
    getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [], fullAccess: true });
    rerender({ key: 'false:true:true' });
    await waitFor(() => expect(result.current.fullAccess).toBe(true));
  });
});
