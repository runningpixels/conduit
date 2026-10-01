// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PAGE_BRIDGE_MESSAGE_TYPE, buildPageBridgeScript, parsePageBridgeRequest, scriptSafeJson } from './pageBridge';

/// Runs the in-frame script against a fake window and parent, the way the
/// sandboxed frame would (mirrors networkBridge.test.ts's harness). `window`
/// needs `dispatchEvent`/`CustomEvent` too once inputs are involved, since the
/// script dispatches `conduit:inputs-changed` on it directly.
function frame(capabilities: string[], inputs?: Record<string, unknown> | null) {
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const windowEvents: CustomEvent[] = [];
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
    dispatchEvent: (event: CustomEvent) => {
      windowEvents.push(event);
      return true;
    },
  };
  new Function('window', 'parent', buildPageBridgeScript(capabilities, inputs))(win, parent);
  const answer = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners) fn({ source, data });
  };
  return { win, posted, answer, parent, windowEvents };
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

describe('buildPageBridgeScript — launch inputs (ADR-013)', () => {
  it('defines a frozen window.conduit.inputs from the given values, independent of capabilities', () => {
    const f = frame([], { city: 'Paris', units: 'metric' });
    const conduit = f.win.conduit as { capabilities: string[]; inputs: Record<string, unknown> };
    expect(conduit.capabilities).toEqual([]);
    expect(conduit.inputs).toEqual({ city: 'Paris', units: 'metric' });
    expect(Object.isFrozen(conduit.inputs)).toBe(true);
    expect(Object.isFrozen(conduit)).toBe(true);
  });

  it('has no inputs property when inputs is not given', () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { inputs?: unknown };
    expect(conduit.inputs).toBeUndefined();
    expect('inputs' in conduit).toBe(false);
  });

  it('an inputs-changed message from the parent swaps the values and dispatches conduit:inputs-changed', () => {
    const f = frame([], { city: 'Paris' });
    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, event: 'inputs-changed', inputs: { city: 'Berlin' } });
    const conduit = f.win.conduit as { inputs: Record<string, unknown> };
    expect(conduit.inputs).toEqual({ city: 'Berlin' });
    expect(f.windowEvents).toHaveLength(1);
    expect(f.windowEvents[0].type).toBe('conduit:inputs-changed');
    expect(f.windowEvents[0].detail).toEqual({ city: 'Berlin' });
  });

  it('ignores an inputs-changed message that does not come from the parent', () => {
    const f = frame([], { city: 'Paris' });
    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, event: 'inputs-changed', inputs: { city: 'Berlin' } }, {});
    const conduit = f.win.conduit as { inputs: Record<string, unknown> };
    expect(conduit.inputs).toEqual({ city: 'Paris' });
    expect(f.windowEvents).toHaveLength(0);
  });

  it('each read of window.conduit.inputs is its own frozen copy of the current values', () => {
    const f = frame([], { count: 1 });
    const conduit = f.win.conduit as { inputs: Record<string, unknown> };
    const first = conduit.inputs;
    const second = conduit.inputs;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('input values embedded in the script', () => {
  const nasty = { city: '</script><script>alert(1)</script>', note: 'line' + String.fromCharCode(0x2028) + 'sep' };

  it('can never close the <script> element they sit in', () => {
    const script = buildPageBridgeScript([], nasty);
    expect(script).not.toContain('</script>');
    expect(scriptSafeJson(nasty)).not.toContain('<');
  });

  it('still reach the page exactly as stored', () => {
    const { win } = frame([], nasty);
    const conduit = win.conduit as { inputs: Record<string, unknown> };
    expect(conduit.inputs).toEqual(nasty);
  });
});

describe('buildPageBridgeScript — model access (ADR-014)', () => {
  it('has no llm namespace without the capability', () => {
    const f = frame(['storage']);
    const conduit = f.win.conduit as { llm?: unknown };
    expect(conduit.llm).toBeUndefined();
  });

  it('defines a frozen window.conduit.llm with the capability', () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { capabilities: string[]; llm: unknown };
    expect(conduit.capabilities).toEqual(['llm']);
    expect(conduit.llm).toBeDefined();
    expect(Object.isFrozen(conduit)).toBe(true);
    expect(Object.isFrozen(conduit.llm)).toBe(true);
  });

  it('complete() round-trips through a message and a matching reply', async () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { llm: { complete: (req: unknown) => Promise<unknown> } };
    const pending = conduit.llm.complete({ prompt: 'Summarize this.' });
    expect(f.posted).toHaveLength(1);
    const req = f.posted[0];
    expect(req.method).toBe('llm.complete');
    expect(req.params).toEqual({ prompt: 'Summarize this.' });

    f.answer({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: req.id, ok: true, result: { text: 'A summary.' } });
    await expect(pending).resolves.toEqual({ text: 'A summary.' });
  });

  it('complete() forwards system, maxTokens and json only when given', () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { llm: { complete: (req: unknown) => Promise<unknown> } };
    void conduit.llm.complete({ prompt: 'Classify this.', system: 'Be terse.', maxTokens: 64, json: true });
    expect(f.posted[0].params).toEqual({ prompt: 'Classify this.', system: 'Be terse.', maxTokens: 64, json: true });
  });

  it('complete() forwards a valid slot and rejects any other with "invalid" before posting', async () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { llm: { complete: (req: unknown) => Promise<unknown> } };
    void conduit.llm.complete({ prompt: 'Hi', slot: 'quick' });
    expect(f.posted[0].params).toEqual({ prompt: 'Hi', slot: 'quick' });
    await expect(conduit.llm.complete({ prompt: 'Hi', slot: 'fast' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(conduit.llm.complete({ prompt: 'Hi', slot: 3 })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.posted).toHaveLength(1);
  });

  it('complete() rejects an empty or missing prompt with "invalid" before posting anything', async () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { llm: { complete: (req: unknown) => Promise<unknown> } };
    await expect(conduit.llm.complete({ prompt: '' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(conduit.llm.complete({})).rejects.toMatchObject({ code: 'invalid' });
    await expect(conduit.llm.complete({ prompt: 42 })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.posted).toHaveLength(0);
  });

  it('an error reply rejects with the code attached, including llm-only codes', async () => {
    const f = frame(['llm']);
    const conduit = f.win.conduit as { llm: { complete: (req: unknown) => Promise<unknown> } };
    const pending = conduit.llm.complete({ prompt: 'Hi' });
    const req = f.posted[0];
    f.answer({
      type: PAGE_BRIDGE_MESSAGE_TYPE,
      id: req.id,
      ok: false,
      error: { code: 'not_granted', message: "You didn't allow this page to use your model." },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'not_granted',
      message: "You didn't allow this page to use your model.",
    });
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
    expect(
      parsePageBridgeRequest({
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'f',
        method: 'llm.complete',
        params: { prompt: 'Summarize this.' },
      }),
    ).toEqual({ id: 'f', method: 'llm.complete', params: { prompt: 'Summarize this.' } });
    expect(
      parsePageBridgeRequest({
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'g',
        method: 'llm.complete',
        params: { prompt: 'Classify this.', system: 'Be terse.', maxTokens: 64, json: true },
      }),
    ).toEqual({
      id: 'g',
      method: 'llm.complete',
      params: { prompt: 'Classify this.', system: 'Be terse.', maxTokens: 64, json: true },
    });
  });

  it('keeps a valid llm slot', () => {
    expect(
      parsePageBridgeRequest({
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'h',
        method: 'llm.complete',
        params: { prompt: 'hi', slot: 'quick' },
      }),
    ).toEqual({ id: 'h', method: 'llm.complete', params: { prompt: 'hi', slot: 'quick' } });
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
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: '' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: {} },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: 5 } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: 'hi', system: 5 } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: 'hi', maxTokens: '64' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: 'hi', json: 'true' } },
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'a', method: 'llm.complete', params: { prompt: 'hi', slot: 'fast' } },
    ]) {
      expect(parsePageBridgeRequest(data)).toBeNull();
    }
  });
});
