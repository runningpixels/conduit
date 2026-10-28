import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@conduit/config-schema';
import {
  applyToolSearch,
  buildConnectorToolCatalog,
  makeInvokeConnectorToolRequest,
  shouldDeferConnectorTools,
  splitToolDisplayName,
  TOOL_SEARCH_MAX_CHARS,
  TOOL_SEARCH_MAX_TOOLS,
} from './connectorTools';
import { SEARCH_TOOLS_TOOL_NAME } from './agentTools';

describe('connectorTools', () => {
  it('builds provider tool definitions from cached capabilities', () => {
    const catalog = buildConnectorToolCatalog(
      [
        {
          connectorVersionId: 'echo:1.0.0',
          connectorId: 'echo',
          connectorName: 'Echo',
          version: '1.0.0',
          transport: 'stdio',
          running: true,
          restartCount: 0,
          grantStatus: 'active',
          supportState: 'available',
        },
      ],
      {
        'echo:1.0.0': [
          {
            id: 'cap-1',
            connectorVersionId: 'echo:1.0.0',
            kind: 'tool',
            name: 'post_message',
            schemaJson: { type: 'object', properties: { channel: { type: 'string' } } },
            discoveredAt: '2026-06-22T00:00:00Z',
          },
        ],
      },
    );

    expect(catalog.toolDefinitions).toHaveLength(1);
    expect(catalog.toolDefinitions[0].name).toBe('Echo__post_message');
    expect(catalog.bindings['Echo__post_message']).toMatchObject({
      connectorVersionId: 'echo:1.0.0',
      connectorName: 'Echo',
      toolName: 'post_message',
    });
  });

  it('deduplicates provider tool names across connectors', () => {
    const catalog = buildConnectorToolCatalog(
      [
        {
          connectorVersionId: 'one:1.0.0',
          connectorId: 'one',
          connectorName: 'Slack',
          version: '1.0.0',
          transport: 'stdio',
          running: true,
          restartCount: 0,
          grantStatus: 'active',
          supportState: 'available',
        },
        {
          connectorVersionId: 'two:1.0.0',
          connectorId: 'two',
          connectorName: 'Slack',
          version: '1.0.0',
          transport: 'stdio',
          running: true,
          restartCount: 0,
          grantStatus: 'active',
          supportState: 'available',
        },
      ],
      {
        'one:1.0.0': [
          {
            id: 'cap-1',
            connectorVersionId: 'one:1.0.0',
            kind: 'tool',
            name: 'post_message',
            schemaJson: { type: 'object', properties: {} },
            discoveredAt: '2026-06-22T00:00:00Z',
          },
        ],
        'two:1.0.0': [
          {
            id: 'cap-2',
            connectorVersionId: 'two:1.0.0',
            kind: 'tool',
            name: 'post_message',
            schemaJson: { type: 'object', properties: {} },
            discoveredAt: '2026-06-22T00:00:00Z',
          },
        ],
      },
    );

    expect(catalog.toolDefinitions.map((tool) => tool.name)).toEqual([
      'Slack__post_message',
      'Slack__post_message_2',
    ]);
  });

  it('builds invoke requests from connector bindings', () => {
    const request = makeInvokeConnectorToolRequest(
      {
        providerToolName: 'Echo__post_message',
        connectorVersionId: 'echo:1.0.0',
        connectorName: 'Echo',
        toolName: 'post_message',
        description: 'Echo: post_message',
      },
      'req-1',
      'call-1',
      { channel: 'general' },
    );

    expect(request).toEqual({
      connectorVersionId: 'echo:1.0.0',
      requestId: 'req-1',
      toolCallId: 'call-1',
      toolName: 'post_message',
      arguments: { channel: 'general' },
    });
  });

  it('splits double-underscore tool names for display', () => {
    expect(splitToolDisplayName('Slack__post_message')).toEqual({
      connector: 'Slack',
      tool: 'post_message',
    });
  });
});

describe('applyToolSearch', () => {
  const builtin: ToolDefinition[] = [
    { toolId: 'current_time', name: 'current_time', description: 'Now', inputSchema: { type: 'object', properties: {} } },
  ];
  function connectorTool(n: number, descriptionChars = 10): ToolDefinition {
    return {
      toolId: `Tracker__tool_${n}`,
      name: `Tracker__tool_${n}`,
      description: `Tracker: tool_${n}`,
      inputSchema: { type: 'object', description: 'x'.repeat(descriptionChars), properties: {} },
      displayGroup: 'Tracker',
      tenantScope: 'tracker',
    };
  }
  const tools = (count: number, descriptionChars?: number) =>
    Array.from({ length: count }, (_, n) => connectorTool(n, descriptionChars));
  const names = (defs: ToolDefinition[]) => defs.map((d) => d.name);

  it('offers every connector tool at the tool-count threshold', () => {
    const split = applyToolSearch(builtin, tools(TOOL_SEARCH_MAX_TOOLS));
    expect(split.deferred).toEqual([]);
    expect(split.offered).toHaveLength(1 + TOOL_SEARCH_MAX_TOOLS);
    expect(names(split.offered)).not.toContain(SEARCH_TOOLS_TOOL_NAME);
  });

  it('offers search_tools instead of the connector tools past the tool-count threshold', () => {
    const connectors = tools(TOOL_SEARCH_MAX_TOOLS + 1);
    const split = applyToolSearch(builtin, connectors);
    expect(names(split.offered)).toEqual(['current_time', SEARCH_TOOLS_TOOL_NAME]);
    expect(split.deferred).toEqual(connectors);
  });

  it('defers a few connector tools whose definitions are too long', () => {
    const connectors = tools(3, Math.ceil(TOOL_SEARCH_MAX_CHARS / 3) + 1);
    expect(JSON.stringify(connectors).length).toBeGreaterThan(TOOL_SEARCH_MAX_CHARS);
    const split = applyToolSearch(builtin, connectors);
    expect(names(split.offered)).toEqual(['current_time', SEARCH_TOOLS_TOOL_NAME]);
    expect(split.deferred).toHaveLength(3);
  });

  it('keeps short definitions below the size threshold', () => {
    const connectors = tools(3, 100);
    expect(shouldDeferConnectorTools(connectors)).toBe(false);
    expect(applyToolSearch(builtin, connectors).offered).toHaveLength(4);
  });

  it('never offers search_tools without connector tools', () => {
    const split = applyToolSearch(builtin, []);
    expect(names(split.offered)).toEqual(['current_time']);
    expect(split.deferred).toEqual([]);
  });

  it('search_tools is the read-only built-in the backend dispatches', () => {
    const split = applyToolSearch(builtin, tools(TOOL_SEARCH_MAX_TOOLS + 5));
    const search = split.offered.find((d) => d.name === SEARCH_TOOLS_TOOL_NAME);
    expect(search?.permissionLevel).toBe('readOnly');
    expect(search?.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    });
  });
});
