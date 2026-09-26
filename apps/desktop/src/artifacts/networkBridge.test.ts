// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_FETCH_ABORT_MESSAGE_TYPE,
  ARTIFACT_FETCH_MESSAGE_TYPE,
  ARTIFACT_FETCH_RESULT_MESSAGE_TYPE,
  ARTIFACT_NETWORK_BRIDGE_SCRIPT,
  isLocalNetworkOrigin,
  parseArtifactFetchAbortMessage,
  parseArtifactFetchMessage,
  requestOrigin,
} from './networkBridge';

/// Runs the in-frame script against a fake window and parent, the way the
/// sandboxed frame would: the page calls `window.fetch`, the script posts to
/// `parent`, and the host answers with a message whose source is `parent`.
function frame() {
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const posted: Array<{ data: Record<string, unknown>; transfer: unknown[] }> = [];
  const parent = {
    postMessage(data: Record<string, unknown>, _origin: string, transfer: unknown[] = []) {
      posted.push({ data, transfer });
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  new Function('window', 'parent', ARTIFACT_NETWORK_BRIDGE_SCRIPT)(win, parent);
  const fetch = win.fetch as (input: string, init?: RequestInit) => Promise<Response>;
  const answer = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners) fn({ source, data });
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { fetch, posted, answer, flush, parent };
}

describe('artifact fetch bridge script', () => {
  it('turns fetch() into a message and the answer into a Response', async () => {
    const f = frame();
    const pending = f.fetch('https://api.open-meteo.com/v1/forecast?latitude=48.85', {
      headers: { accept: 'application/json' },
    });
    await f.flush();
    expect(f.posted).toHaveLength(1);
    const req = f.posted[0].data;
    expect(req.type).toBe(ARTIFACT_FETCH_MESSAGE_TYPE);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.open-meteo.com/v1/forecast?latitude=48.85');
    expect(req.body).toBeNull();
    expect(req.headers).toContainEqual(['accept', 'application/json']);

    const body = new TextEncoder().encode('{"temp":21}').buffer;
    f.answer({
      type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE,
      id: req.id,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      url: 'https://api.open-meteo.com/v1/forecast?latitude=48.85',
      body,
    });
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ temp: 21 });
    expect(res.url).toBe('https://api.open-meteo.com/v1/forecast?latitude=48.85');
  });

  it('sends a POST body as a transferred buffer', async () => {
    const f = frame();
    void f.fetch('https://example.com/api', { method: 'POST', body: '{"city":"Paris"}' });
    await f.flush();
    const { data, transfer } = f.posted[0];
    expect(data.method).toBe('POST');
    expect(new TextDecoder().decode(data.body as ArrayBuffer)).toBe('{"city":"Paris"}');
    expect(transfer).toEqual([data.body]);
  });

  it('rejects like a network error when the host refuses', async () => {
    const f = frame();
    const pending = f.fetch('https://example.com/');
    await f.flush();
    f.answer({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: f.posted[0].data.id, error: 'You didn’t allow it.' });
    await expect(pending).rejects.toThrow(TypeError);
  });

  it('ignores answers that do not come from the parent window', async () => {
    const f = frame();
    let settled = false;
    const pending = f.fetch('https://example.com/').then(
      () => (settled = true),
      () => (settled = true),
    );
    await f.flush();
    f.answer({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: f.posted[0].data.id, error: 'forged' }, {});
    await f.flush();
    expect(settled).toBe(false);
    f.answer({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: f.posted[0].data.id, error: 'real' });
    await pending;
    expect(settled).toBe(true);
  });

  it('gives a 204 an empty body instead of throwing', async () => {
    const f = frame();
    const pending = f.fetch('https://example.com/ping', { method: 'DELETE' });
    await f.flush();
    f.answer({
      type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE,
      id: f.posted[0].data.id,
      status: 204,
      statusText: 'No Content',
      headers: [],
      url: 'https://example.com/ping',
      body: new ArrayBuffer(0),
    });
    const res = await pending;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('refuses non-web addresses without asking the host', async () => {
    const f = frame();
    await expect(f.fetch('data:text/plain,hi')).rejects.toThrow(TypeError);
    expect(f.posted).toHaveLength(0);
  });

  it('aborts: rejects with AbortError and tells the host', async () => {
    const f = frame();
    const controller = new AbortController();
    const pending = f.fetch('https://example.com/', { signal: controller.signal });
    await f.flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.posted[1].data).toEqual({ type: ARTIFACT_FETCH_ABORT_MESSAGE_TYPE, id: f.posted[0].data.id });
  });
});

describe('parseArtifactFetchMessage', () => {
  it('accepts a well-formed request and upper-cases the method', () => {
    const body = new ArrayBuffer(2);
    expect(
      parseArtifactFetchMessage({
        type: ARTIFACT_FETCH_MESSAGE_TYPE,
        id: 3,
        url: 'https://x.test/',
        method: 'post',
        headers: [['a', 'b'], ['bad'], [1, 2]],
        body,
      }),
    ).toEqual({ id: 3, url: 'https://x.test/', method: 'POST', headers: [['a', 'b']], body });
  });

  it('rejects anything malformed', () => {
    for (const data of [
      null,
      'x',
      { type: 'other' },
      { type: ARTIFACT_FETCH_MESSAGE_TYPE, id: '1', url: 'https://x', method: 'GET', headers: [] },
      { type: ARTIFACT_FETCH_MESSAGE_TYPE, id: 1, url: 7, method: 'GET', headers: [] },
      { type: ARTIFACT_FETCH_MESSAGE_TYPE, id: 1, url: 'https://x', method: 'GET', headers: 'a' },
      { type: ARTIFACT_FETCH_MESSAGE_TYPE, id: 1, url: 'x'.repeat(9000), method: 'GET', headers: [] },
    ]) {
      expect(parseArtifactFetchMessage(data)).toBeNull();
    }
  });

  it('parses abort messages', () => {
    expect(parseArtifactFetchAbortMessage({ type: ARTIFACT_FETCH_ABORT_MESSAGE_TYPE, id: 4 })).toBe(4);
    expect(parseArtifactFetchAbortMessage({ type: ARTIFACT_FETCH_MESSAGE_TYPE, id: 4 })).toBeNull();
  });
});

describe('requestOrigin', () => {
  it('keys grants on the https origin, as Rust does', () => {
    expect(requestOrigin('https://API.Example.com/v1?q=1')).toBe('https://api.example.com');
    expect(requestOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(requestOrigin('https://example.com:8443/')).toBe('https://example.com:8443');
  });

  it('is null for anything that is not plain https', () => {
    expect(requestOrigin('http://example.com/')).toBeNull();
    expect(requestOrigin('https://user:pw@example.com/')).toBeNull();
    expect(requestOrigin('not a url')).toBeNull();
  });
});

describe('isLocalNetworkOrigin', () => {
  it('flags hosts that are never public', () => {
    for (const origin of [
      'https://localhost',
      'https://printer.local',
      'https://127.0.0.1:8443',
      'https://10.0.0.5',
      'https://172.20.1.1',
      'https://192.168.1.1',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://[::1]',
      'https://[fd00::1]',
    ]) {
      expect(isLocalNetworkOrigin(origin), origin).toBe(true);
    }
  });

  it('leaves public hosts to the reader and Rust', () => {
    for (const origin of ['https://api.open-meteo.com', 'https://8.8.8.8', 'https://172.32.0.1', 'https://[2606:4700::1111]']) {
      expect(isLocalNetworkOrigin(origin), origin).toBe(false);
    }
  });
});
