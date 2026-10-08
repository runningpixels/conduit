import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCapability, ConnectorRuntimeSnapshot } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ getConnectorRuntimeStates: vi.fn(), listWorkflowConnectorTools: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import {
  argFields,
  argsFromJson,
  argsToJson,
  connectorChoices,
  isUsable,
  loadConnectorTools,
  missingRequired,
  parseNumber,
  readOnlyOf,
  toolFromCapability,
  withArg,
} from './connectorTools';

const snap = (over: Partial<ConnectorRuntimeSnapshot>): ConnectorRuntimeSnapshot =>
  ({
    connectorVersionId: 'v1',
    connectorId: 'gh',
    connectorName: 'Issues',
    version: '1',
    transport: 'stdio',
    restartCount: 0,
    grantStatus: 'active',
    running: true,
    health: 'healthy',
    ...over,
  }) as ConnectorRuntimeSnapshot;

const cap = (name: string, extra: Record<string, unknown> = {}, schemaJson?: Record<string, unknown>) =>
  ({ id: name, connectorVersionId: 'v1', kind: 'tool', name, schemaJson, discoveredAt: '', ...extra }) as ConnectorCapability &
    Record<string, unknown>;

describe('connectorChoices', () => {
  it('lists each connector once, preferring the active and running version', () => {
    const choices = connectorChoices([
      snap({ connectorVersionId: 'old', running: false, grantStatus: 'revoked' }),
      snap({ connectorVersionId: 'new' }),
      snap({ connectorId: 'fs', connectorName: 'Files', connectorVersionId: 'f1', running: false, health: undefined }),
    ]);
    expect(choices.map((c) => [c.connectorId, c.versionId, c.name])).toEqual([
      ['gh', 'new', 'Issues'],
      ['fs', 'f1', 'Files'],
    ]);
    expect(choices[0].statusKey).toBe('settings.connectors.status.live');
  });
});

describe('read-only gating', () => {
  it('reads a flag, a permission level or the MCP hint', () => {
    expect(readOnlyOf({ readOnly: true })).toBe(true);
    expect(readOnlyOf({ permissionLevel: 'readOnly' })).toBe(true);
    expect(readOnlyOf({ permissionLevel: 'write' })).toBe(false);
    expect(readOnlyOf({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(readOnlyOf({ annotations: { readOnlyHint: false } })).toBe(false);
  });

  it('is unknown without any of them, and unknown tools are not usable', () => {
    expect(readOnlyOf({})).toBeNull();
    expect(readOnlyOf(null)).toBeNull();
    const tool = toolFromCapability(cap('list', {}, { type: 'object' }));
    expect(tool.readOnly).toBeNull();
    expect(isUsable(tool)).toBe(false);
    expect(isUsable(toolFromCapability(cap('list', { annotations: { readOnlyHint: true } })))).toBe(true);
    expect(isUsable(toolFromCapability(cap('del', { permissionLevel: 'destructive' })))).toBe(false);
  });

  it('reads tools and their read-only flag from the workflow tool list', async () => {
    const schema = { type: 'object', properties: { repo: { type: 'string' } } };
    ipc.listWorkflowConnectorTools.mockResolvedValue([
      { name: 'list', description: null, inputSchema: schema, readOnly: true, permissionLevel: 'readOnly' },
      { name: 'post', description: 'Posts', inputSchema: {}, readOnly: false, permissionLevel: 'sideEffectful' },
    ]);
    const tools = await loadConnectorTools('github');
    expect(ipc.listWorkflowConnectorTools).toHaveBeenCalledWith('github');
    expect(tools).toEqual([
      { name: 'list', description: undefined, inputSchema: schema, readOnly: true },
      { name: 'post', description: 'Posts', inputSchema: {}, readOnly: false },
    ]);
    expect(tools.map(isUsable)).toEqual([true, false]);
  });
});

describe('argFields', () => {
  const schema = {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'owner/name' },
      state: { type: 'string', enum: ['open', 'closed'] },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      draft: { type: 'boolean' },
      labels: { type: 'array', items: { type: 'string' } },
      since: { type: ['string', 'null'], title: 'Since' },
      mixed: { enum: [1, 2] },
    },
  };

  it('maps each property to a field kind', () => {
    const fields = argFields(schema)!;
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ['repo', 'string', true],
      ['state', 'enum', false],
      ['limit', 'integer', false],
      ['ratio', 'number', false],
      ['draft', 'boolean', false],
      ['labels', 'json', false],
      ['since', 'string', false],
      ['mixed', 'json', false],
    ]);
    expect(fields[1].options).toEqual(['open', 'closed']);
    expect(fields[0].description).toBe('owner/name');
    expect(fields[6].label).toBe('Since');
  });

  it('has no form for a schema without named properties', () => {
    expect(argFields({})).toBeNull();
    expect(argFields({ type: 'object', properties: {} })).toBeNull();
  });

  it('sets, clears and checks values', () => {
    let args = withArg({}, 'repo', 'a/b');
    args = withArg(args, 'limit', 5);
    expect(args).toEqual({ repo: 'a/b', limit: 5 });
    expect(withArg(args, 'repo', '')).toEqual({ limit: 5 });
    expect(withArg(args, 'draft', false)).toEqual({ repo: 'a/b', limit: 5, draft: false });
    expect(missingRequired(argFields(schema), { limit: 5 })).toEqual(['repo']);
    expect(missingRequired(argFields(schema), { repo: 'x' })).toEqual([]);
    expect(parseNumber('', false)).toBeUndefined();
    expect(parseNumber('2.7', true)).toBe(2);
    expect(parseNumber('2.5', false)).toBe(2.5);
    expect(parseNumber('abc', false)).toBeUndefined();
  });
});

describe('JSON fallback', () => {
  it('round-trips the whole arguments object, templates included', () => {
    const args = { repo: '{{inputs.repo}}', limit: 20, filter: { labels: ['bug'], q: '{{steps.a.text}}' } };
    expect(argsFromJson(argsToJson(args))).toEqual(args);
  });

  it('treats blank as empty and rejects anything but an object', () => {
    expect(argsFromJson('')).toEqual({});
    expect(argsFromJson('[1]')).toBeNull();
    expect(argsFromJson('{"a":')).toBeNull();
    expect(argsFromJson('"x"')).toBeNull();
  });
});
