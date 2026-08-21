import type {
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
  InvokeConnectorToolRequest,
  PermissionLevel,
} from '../ipc/contracts';
import type { ToolDefinition } from '@conduit/config-schema';

export interface ConnectorToolBinding {
  providerToolName: string;
  connectorVersionId: string;
  connectorName: string;
  toolName: string;
  description: string;
  permissionLevel?: PermissionLevel;
}

export interface ConnectorToolCatalog {
  toolDefinitions: ToolDefinition[];
  bindings: Record<string, ConnectorToolBinding>;
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

function schemaObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {
    type: 'object',
    properties: {},
  };
}

export function isConnectorCallable(snapshot: ConnectorRuntimeSnapshot): boolean {
  if (snapshot.grantStatus !== 'active') return false;
  return !(
    snapshot.supportState === 'adminDisabled' ||
    snapshot.supportState === 'revoked' ||
    snapshot.supportState === 'unsupported' ||
    snapshot.supportState === 'authRequired'
  );
}

export function buildConnectorToolCatalog(
  snapshots: ConnectorRuntimeSnapshot[],
  capabilitiesByVersion: Record<string, ConnectorCapability[]>,
): ConnectorToolCatalog {
  const toolDefinitions: ToolDefinition[] = [];
  const bindings: Record<string, ConnectorToolBinding> = {};
  const usedNames = new Set<string>();

  for (const snapshot of snapshots) {
    if (!isConnectorCallable(snapshot)) continue;
    const caps = capabilitiesByVersion[snapshot.connectorVersionId] ?? [];
    const toolCaps = caps.filter((cap) => cap.kind === 'tool');
    for (const cap of toolCaps) {
      const connectorSegment = sanitizeSegment(snapshot.connectorName);
      const toolSegment = sanitizeSegment(cap.name);
      let providerToolName = `${connectorSegment}__${toolSegment}`;
      let suffix = 2;
      while (usedNames.has(providerToolName)) {
        providerToolName = `${connectorSegment}__${toolSegment}_${suffix}`;
        suffix += 1;
      }
      usedNames.add(providerToolName);

      bindings[providerToolName] = {
        providerToolName,
        connectorVersionId: snapshot.connectorVersionId,
        connectorName: snapshot.connectorName,
        toolName: cap.name,
        description: `${snapshot.connectorName}: ${cap.name}`,
      };
      toolDefinitions.push({
        toolId: providerToolName,
        name: providerToolName,
        description: `${snapshot.connectorName}: ${cap.name}`,
        inputSchema: schemaObject(cap.schemaJson),
        displayGroup: snapshot.connectorName,
        tenantScope: snapshot.connectorId,
      });
    }
  }

  return { toolDefinitions, bindings };
}

export function makeInvokeConnectorToolRequest(
  binding: ConnectorToolBinding,
  requestId: string,
  toolCallId: string,
  args: Record<string, unknown>,
): InvokeConnectorToolRequest {
  return {
    connectorVersionId: binding.connectorVersionId,
    requestId,
    toolCallId,
    toolName: binding.toolName,
    arguments: args,
  };
}

export function splitToolDisplayName(name: string): { connector: string; tool: string } {
  if (name.includes('__')) {
    const [connector, ...toolParts] = name.split('__');
    return { connector, tool: toolParts.join('__') || connector };
  }
  if (name.includes('.')) {
    const [connector, ...toolParts] = name.split('.');
    return { connector, tool: toolParts.join('.') || connector };
  }
  return { connector: name, tool: name };
}
