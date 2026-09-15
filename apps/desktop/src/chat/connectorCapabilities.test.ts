import { describe, expect, it } from 'vitest';
import type {
  ConnectorPromptInfo,
  ConnectorResourceInfo,
  ConnectorRuntimeSnapshot,
} from '../ipc/contracts';
import { buildConnectorToolCatalog } from './connectorTools';
import {
  buildPromptArguments,
  groupByConnector,
  missingRequiredArguments,
  needsArgumentDialog,
  sameResource,
  selectAvailablePrompts,
  selectAvailableResources,
  toResourceRef,
} from './connectorCapabilities';

function snapshot(over: Partial<ConnectorRuntimeSnapshot> = {}): ConnectorRuntimeSnapshot {
  return {
    connectorVersionId: 'echo:1.0.0',
    connectorId: 'echo',
    connectorName: 'Echo',
    version: '1.0.0',
    transport: 'stdio',
    running: true,
    restartCount: 0,
    grantStatus: 'active',
    supportState: 'available',
    ...over,
  } as ConnectorRuntimeSnapshot;
}

function prompt(over: Partial<ConnectorPromptInfo> = {}): ConnectorPromptInfo {
  return {
    connectorVersionId: 'echo:1.0.0',
    connectorName: 'Echo',
    name: 'summarize',
    description: 'Summarize a document',
    arguments: [],
    stale: false,
    discoveredAt: '2026-09-15T00:00:00Z',
    ...over,
  } as ConnectorPromptInfo;
}

function resource(over: Partial<ConnectorResourceInfo> = {}): ConnectorResourceInfo {
  return {
    connectorVersionId: 'echo:1.0.0',
    connectorName: 'Echo',
    name: 'spec.md',
    uri: 'echo://notes/spec.md',
    description: undefined,
    stale: false,
    discoveredAt: '2026-09-15T00:00:00Z',
    ...over,
  } as ConnectorResourceInfo;
}

describe('connectorCapabilities — availability', () => {
  it('keeps prompts on callable connectors', () => {
    const got = selectAvailablePrompts([prompt()], [snapshot()]);
    expect(got).toHaveLength(1);
  });

  it('drops prompts whose connector is revoked', () => {
    const got = selectAvailablePrompts(
      [prompt()],
      [snapshot({ supportState: 'revoked' })],
    );
    expect(got).toEqual([]);
  });

  it('drops resources whose grant is not active', () => {
    const got = selectAvailableResources(
      [resource()],
      [snapshot({ grantStatus: 'revoked' })],
    );
    expect(got).toEqual([]);
  });

  it('drops rows whose connector is not in the snapshot at all', () => {
    const got = selectAvailableResources([resource()], []);
    expect(got).toEqual([]);
  });

  it('sorts by connector then name so the picker does not reshuffle', () => {
    const got = selectAvailablePrompts(
      [
        prompt({ connectorVersionId: 'z:1', connectorName: 'Zeta', name: 'b' }),
        prompt({ connectorVersionId: 'a:1', connectorName: 'Alpha', name: 'b' }),
        prompt({ connectorVersionId: 'a:1', connectorName: 'Alpha', name: 'a' }),
      ],
      [
        snapshot({ connectorVersionId: 'z:1', connectorName: 'Zeta' }),
        snapshot({ connectorVersionId: 'a:1', connectorName: 'Alpha' }),
      ],
    );
    expect(got.map((p) => `${p.connectorName}/${p.name}`)).toEqual([
      'Alpha/a',
      'Alpha/b',
      'Zeta/b',
    ]);
  });

  it('groups rows by connector', () => {
    const groups = groupByConnector([
      resource({ name: 'a' }),
      resource({ name: 'b' }),
      resource({ connectorVersionId: 'other:1', connectorName: 'Other', name: 'c' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe('connectorCapabilities — prompt arguments', () => {
  it('needs no dialog when the prompt takes no arguments', () => {
    expect(needsArgumentDialog(prompt())).toBe(false);
  });

  it('needs a dialog as soon as there is any argument', () => {
    const p = prompt({
      arguments: [{ name: 'length', description: undefined, required: false }],
    });
    expect(needsArgumentDialog(p)).toBe(true);
  });

  it('reports a blank required argument as missing', () => {
    const p = prompt({
      arguments: [{ name: 'topic', description: undefined, required: true }],
    });
    expect(missingRequiredArguments(p, { topic: '   ' })).toEqual(['topic']);
    expect(missingRequiredArguments(p, { topic: 'widgets' })).toEqual([]);
  });

  it('does not require optional arguments', () => {
    const p = prompt({
      arguments: [{ name: 'length', description: undefined, required: false }],
    });
    expect(missingRequiredArguments(p, {})).toEqual([]);
  });

  it('omits blank optional arguments so the server applies its own default', () => {
    const p = prompt({
      arguments: [
        { name: 'topic', description: undefined, required: true },
        { name: 'length', description: undefined, required: false },
      ],
    });
    expect(buildPromptArguments(p, { topic: 'widgets', length: '  ' })).toEqual({
      topic: 'widgets',
    });
  });

  it('ignores values for arguments the prompt never declared', () => {
    const p = prompt({
      arguments: [{ name: 'topic', description: undefined, required: true }],
    });
    expect(buildPromptArguments(p, { topic: 'a', smuggled: 'b' })).toEqual({ topic: 'a' });
  });
});

describe('connectorCapabilities — resource refs', () => {
  it('identifies the same resource by connector and uri', () => {
    const a = toResourceRef(resource());
    expect(sameResource(a, toResourceRef(resource()))).toBe(true);
    expect(sameResource(a, toResourceRef(resource({ uri: 'echo://other' })))).toBe(false);
    expect(
      sameResource(a, toResourceRef(resource({ connectorVersionId: 'other:1' }))),
    ).toBe(false);
  });
});

describe('the tool catalog is untouched by this feature', () => {
  // Acceptance criterion 7: a connector advertising only tools must look and
  // behave exactly as it did before resources and prompts were surfaced.
  it('ignores resource and prompt capabilities when building tool definitions', () => {
    const snapshots = [snapshot()];
    const toolsOnly = {
      'echo:1.0.0': [
        {
          id: 'cap-1',
          connectorVersionId: 'echo:1.0.0',
          kind: 'tool' as const,
          name: 'post_message',
          schemaJson: { type: 'object', properties: {} },
          discoveredAt: '2026-06-22T00:00:00Z',
        },
      ],
    };
    const withExtras = {
      'echo:1.0.0': [
        ...toolsOnly['echo:1.0.0'],
        {
          id: 'cap-2',
          connectorVersionId: 'echo:1.0.0',
          kind: 'resource' as const,
          name: 'spec.md',
          schemaJson: { uri: 'echo://notes/spec.md' },
          discoveredAt: '2026-09-15T00:00:00Z',
        },
        {
          id: 'cap-3',
          connectorVersionId: 'echo:1.0.0',
          kind: 'prompt' as const,
          name: 'summarize',
          schemaJson: { arguments: [] },
          discoveredAt: '2026-09-15T00:00:00Z',
        },
      ],
    };

    const before = buildConnectorToolCatalog(snapshots, toolsOnly);
    const after = buildConnectorToolCatalog(snapshots, withExtras);
    expect(after).toEqual(before);
  });
});
