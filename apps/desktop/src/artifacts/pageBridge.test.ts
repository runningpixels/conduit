// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PAGE_BRIDGE_MESSAGE_TYPE, buildPageBridgeScript, parsePageBridgeRequest } from './pageBridge';

/// Runs the in-frame script against a fake window and parent, the way the
/// sandboxed frame would (mirrors networkBridge.test.ts's harness).
function frame(capabilities: string[]) {
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage(data: Record<string, unknown>) {
      posted.push(data);
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  new Function('window', 'parent', buildPageBridgeScript(capabilities))(win, parent);
  const answer = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners) fn({ source, data });
  };
  return { win, posted, answer, parent };
}

describe('buildPageBridgeScript', () => {
  it('defines a frozen window.conduit with the given capabilities', () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { version: number; capabilities: string[]; storage: unknown };
    expect(conduit.version).toBe(2);
    expect(conduit.capabilities).toEqual(['storage']);
    expect(conduit.storage).toBeDefined();
    expect(Object.isFrozen(conduit)).toBe(true);
    expect(Object.isFrozen(conduit.storage)).toBe(true);
  });

  it('has no storage namespace without the capability', () => {
    const f = frame([]);
    const conduit = f.win.conduit as { version: number; capabilities: string[]; storage?: unknown };
    expect(conduit.capabilities).toEqual([]);
    expect(conduit.storage).toBeUndefined();
  });

  it('get() round-trips through a message and a matching reply', async () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { get: (key: string) => Promise<unknown> } };
    const pending = conduit.storage.get('theme');
    expect(f.posted).toHaveLength(1);
    const req = f.posted[0];
    expect(req.type).toBe(PAGE_BRIDGE_MESSAGE_TYPE);
    expect(req.method).toBe('storage.get');
    expect(req.params).toEqual({ key: 'theme' });
    expect(typeof req.id).toBe('string');

    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: req.id, ok: true, result: 'dark' });
    await expect(pending).resolves.toBe('dark');
  });

  it('an error reply rejects with the code attached', async () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { set: (key: string, value: unknown) => Promise<unknown> } };
    const pending = conduit.storage.set('big', 'x');
    const req = f.posted[0];
    f.answer({
      type: PAGE_BRIDGE_MESSAGE_TYPE,
      id: req.id,
      ok: false,
      error: { code: 'quota', message: 'Over the 5 MB limit.' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'quota', message: 'Over the 5 MB limit.' });
  });

  it('ignores replies that do not come from the parent window', async () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { get: (key: string) => Promise<unknown> } };
    let settled = false;
    const pending = conduit.storage.get('k').then(
      () => (settled = true),
      () => (settled = true),
    );
    const req = f.posted[0];
    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: req.id, ok: true, result: 'forged' }, {});
    await Promise.resolve();
    expect(settled).toBe(false);
    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: req.id, ok: true, result: 'real' });
    await pending;
    expect(settled).toBe(true);
  });

  it('set() rejects a non-JSON-serializable value with "invalid" before posting anything', async () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { set: (key: string, value: unknown) => Promise<unknown> } };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(conduit.storage.set('k', circular)).rejects.toMatchObject({ code: 'invalid' });
    await expect(conduit.storage.set('k', function bad() {})).rejects.toMatchObject({ code: 'invalid' });
    await expect(conduit.storage.set('k', undefined)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.posted).toHaveLength(0);
  });

  it('set() posts an ordinary JSON value', () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { set: (key: string, value: unknown) => Promise<unknown> } };
    void conduit.storage.set('prefs', { count: 3 });
    expect(f.posted[0].method).toBe('storage.set');
    expect(f.posted[0].params).toEqual({ key: 'prefs', value: { count: 3 } });
  });

  it('keys() posts an optional prefix', () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { storage: { keys: (prefix?: string) => Promise<unknown> } };
    void conduit.storage.keys('todo:');
    expect(f.posted[0].method).toBe('storage.keys');
    expect(f.posted[0].params).toEqual({ prefix: 'todo:' });
  });
});

describe('parsePageBridgeRequest', () => {
  it('accepts a well-formed request for each method', () => {
    expect(
      parsePageBridgeRequest({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.get', params: { key: 'k' } }),
    ).toEqual({ id: 'a', method: 'storage.get', params: { key: 'k' } });
    expect(
      parsePageBridgeRequest({
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'b',
        method: 'storage.set',
        params: { key: 'k', value: { x: 1 } },
      }),
    ).toEqual({ id: 'b', method: 'storage.set', params: { key: 'k', value: { x: 1 } } });
    expect(
      parsePageBridgeRequest({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'c', method: 'storage.delete', params: { key: 'k' } }),
    ).toEqual({ id: 'c', method: 'storage.delete', params: { key: 'k' } });
    expect(
      parsePageBridgeRequest({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'd', method: 'storage.keys', params: {} }),
    ).toEqual({ id: 'd', method: 'storage.keys', params: {} });
    expect(
      parsePageBridgeRequest({
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'e',
        method: 'storage.keys',
        params: { prefix: 'todo:' },
      }),
    ).toEqual({ id: 'e', method: 'storage.keys', params: { prefix: 'todo:' } });
  });

  it('rejects anything malformed', () => {
    for (const data of [
      null,
      'x',
      { type: 'other' },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 1, method: 'storage.get', params: { key: 'k' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a'.repeat(65), method: 'storage.get', params: { key: 'k' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: '', method: 'storage.get', params: { key: 'k' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.unknown', params: {} },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.get', params: { key: 5 } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.get', params: null },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.get', params: [] },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.set', params: { key: 'k' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'storage.keys', params: { prefix: 7 } },
    ]) {
      expect(parsePageBridgeRequest(data)).toBeNull();
    }
  });
});
