import type {
  ConnectorPromptInfo,
  ConnectorResourceInfo,
  ConnectorRuntimeSnapshot,
  ResourceRef,
} from '../ipc/contracts';
import { isConnectorCallable } from './connectorTools';

/**
 * Selection helpers for the resource and prompt halves of a connector's
 * capabilities.
 *
 * This is a deliberate sibling of `connectorTools.ts` rather than an extension
 * of it: that module builds the model-facing tool catalog, and a regression
 * there breaks tool calling for every user. Nothing here feeds the model's tool
 * surface — these lists drive composer pickers the user drives by hand.
 */

/** Prompts on connectors that are actually callable right now. */
export function selectAvailablePrompts(
  prompts: ConnectorPromptInfo[],
  snapshots: ConnectorRuntimeSnapshot[],
): ConnectorPromptInfo[] {
  const callable = callableVersionIds(snapshots);
  return prompts
    .filter((p) => callable.has(p.connectorVersionId))
    .sort(byConnectorThenName);
}

/** Resources on connectors that are actually callable right now. */
export function selectAvailableResources(
  resources: ConnectorResourceInfo[],
  snapshots: ConnectorRuntimeSnapshot[],
): ConnectorResourceInfo[] {
  const callable = callableVersionIds(snapshots);
  return resources
    .filter((r) => callable.has(r.connectorVersionId))
    .sort(byConnectorThenName);
}

function callableVersionIds(snapshots: ConnectorRuntimeSnapshot[]): Set<string> {
  return new Set(
    snapshots.filter(isConnectorCallable).map((s) => s.connectorVersionId),
  );
}

function byConnectorThenName(
  a: { connectorName: string; name: string },
  b: { connectorName: string; name: string },
): number {
  return a.connectorName.localeCompare(b.connectorName) || a.name.localeCompare(b.name);
}

/** Group rows by connector, for a picker with one section per server. */
export function groupByConnector<T extends { connectorVersionId: string; connectorName: string }>(
  rows: T[],
): { connectorVersionId: string; connectorName: string; items: T[] }[] {
  const groups = new Map<string, { connectorVersionId: string; connectorName: string; items: T[] }>();
  for (const row of rows) {
    const existing = groups.get(row.connectorVersionId);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(row.connectorVersionId, {
        connectorVersionId: row.connectorVersionId,
        connectorName: row.connectorName,
        items: [row],
      });
    }
  }
  return [...groups.values()];
}

/**
 * A prompt is usable when every required argument has a non-empty value.
 * Optional arguments may be left blank — the server applies its own default.
 */
export function missingRequiredArguments(
  prompt: ConnectorPromptInfo,
  values: Record<string, string>,
): string[] {
  return prompt.arguments
    .filter((a) => a.required)
    .filter((a) => !(values[a.name] ?? '').trim())
    .map((a) => a.name);
}

/** A prompt with no arguments is inserted directly, with no dialog. */
export function needsArgumentDialog(prompt: ConnectorPromptInfo): boolean {
  return prompt.arguments.length > 0;
}

/** Drop blank optional arguments so the server sees an absent key, not `''`. */
export function buildPromptArguments(
  prompt: ConnectorPromptInfo,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of prompt.arguments) {
    const value = (values[arg.name] ?? '').trim();
    if (value) out[arg.name] = value;
  }
  return out;
}

export function toResourceRef(resource: ConnectorResourceInfo): ResourceRef {
  return {
    connectorVersionId: resource.connectorVersionId,
    name: resource.name,
    uri: resource.uri,
  };
}

export function sameResource(a: ResourceRef, b: ResourceRef): boolean {
  return a.connectorVersionId === b.connectorVersionId && a.uri === b.uri;
}

/**
 * Whether a row predates the capture of URIs and argument lists. Such a row
 * cannot be used — a resource has no URI to read, and a prompt would be called
 * without its required arguments — so the picker offers a refresh instead.
 */
export function isStale(row: { stale: boolean }): boolean {
  return row.stale;
}
