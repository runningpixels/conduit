import { describe, expect, it } from 'vitest';
import { buildConnectorToolCatalog, makeInvokeConnectorToolRequest, splitToolDisplayName } from './connectorTools';

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
