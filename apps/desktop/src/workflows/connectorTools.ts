/// What a connector step's editor needs to know about connectors: which are
/// installed, what tools each offers, whether a tool only reads, and how to
/// turn a tool's input schema into a form.
///
/// The tool list comes through ONE function, `loadConnectorTools`. Today it
/// reads the capability cache the Connectors page uses; a command that returns
/// tools with a read-only flag would replace only that function's body.

import { getConnectorRuntimeStates, listWorkflowConnectorTools } from '../ipc/client';
import type { ConnectorCapability, ConnectorRuntimeSnapshot } from '../ipc/contracts';
import { connectorLabel, type ConnectorTone } from '../workspace/settings/connectors/useConnectors';

export type JsonObject = Record<string, unknown>;

/// An installed connector a step can name.
export interface ConnectorChoice {
  connectorId: string;
  name: string;
  /// The version the tool list is read from.
  versionId: string;
  tone: ConnectorTone;
  /// Catalog key of the connector's status ("Live", "Stopped", "Sign in needed").
  statusKey: string;
}

/// One tool a connector offers.
export interface ConnectorToolInfo {
  name: string;
  description?: string;
  /// The tool's JSON input schema (an empty object when it has none).
  inputSchema: JsonObject;
  /// `true` when it only reads, `false` when it can change things, `null`
  /// when nothing says which (treated as not allowed).
  readOnly: boolean | null;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/// Installed connectors, one per connector id (the active, then the running, version wins).
export function connectorChoices(rows: readonly ConnectorRuntimeSnapshot[]): ConnectorChoice[] {
  const rank = (r: ConnectorRuntimeSnapshot) => (r.grantStatus === 'active' ? 2 : 0) + (r.running ? 1 : 0);
  const best = new Map<string, ConnectorRuntimeSnapshot>();
  for (const row of rows) {
    const seen = best.get(row.connectorId);
    if (!seen || rank(row) > rank(seen)) best.set(row.connectorId, row);
  }
  return [...best.values()].map((row) => {
    const label = connectorLabel(row);
    return {
      connectorId: row.connectorId,
      name: row.connectorName,
      versionId: row.connectorVersionId,
      tone: label.tone,
      statusKey: label.labelId,
    };
  });
}

export async function loadConnectorChoices(): Promise<ConnectorChoice[]> {
  return connectorChoices(await getConnectorRuntimeStates());
}

/// Whether a raw tool record says it only reads: a `readOnly` flag, a
/// `permissionLevel` of `readOnly`, or the MCP `readOnlyHint` annotation.
/// `null` when none of them is present.
export function readOnlyOf(raw: unknown): boolean | null {
  if (!isObject(raw)) return null;
  if (typeof raw.readOnly === 'boolean') return raw.readOnly;
  if (typeof raw.permissionLevel === 'string') return raw.permissionLevel === 'readOnly';
  if (isObject(raw.annotations) && typeof raw.annotations.readOnlyHint === 'boolean') {
    return raw.annotations.readOnlyHint;
  }
  return null;
}

/// A cached capability as a tool. Its `schemaJson` is the input schema; any
/// read-only facts a newer cache adds beside it are read by `readOnlyOf`.
export function toolFromCapability(cap: ConnectorCapability & Record<string, unknown>): ConnectorToolInfo {
  const schema = isObject(cap.schemaJson) ? cap.schemaJson : {};
  const description = typeof cap.description === 'string' ? cap.description : undefined;
  return {
    name: cap.name,
    description,
    inputSchema: isObject(cap.inputSchema) ? cap.inputSchema : schema,
    readOnly: readOnlyOf(cap) ?? readOnlyOf(schema),
  };
}

/// THE tool source: a connector's live tools with the same read-only
/// classification the step uses when it runs.
export async function loadConnectorTools(connectorId: string): Promise<ConnectorToolInfo[]> {
  const tools = await listWorkflowConnectorTools(connectorId);
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? undefined,
    inputSchema: isObject(t.inputSchema) ? t.inputSchema : {},
    readOnly: t.readOnly,
  }));
}

/// A tool a workflow may use: it is known to only read.
export function isUsable(tool: ConnectorToolInfo): boolean {
  return tool.readOnly === true;
}

// ---- arguments form ------------------------------------------------------

export type ArgKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';

export interface ArgField {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  kind: ArgKind;
  options?: string[];
}

function schemaType(prop: JsonObject): string | null {
  const type = prop.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const real = type.filter((x): x is string => typeof x === 'string' && x !== 'null');
    return real.length === 1 ? real[0] : null;
  }
  return null;
}

function fieldKind(prop: JsonObject): { kind: ArgKind; options?: string[] } {
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((o) => typeof o === 'string')) {
    return { kind: 'enum', options: prop.enum as string[] };
  }
  switch (schemaType(prop)) {
    case 'string':
      return { kind: 'string' };
    case 'number':
      return { kind: 'number' };
    case 'integer':
      return { kind: 'integer' };
    case 'boolean':
      return { kind: 'boolean' };
    default:
      return { kind: 'json' };
  }
}

/// The form for a tool's input schema: one field per property. `null` when the
/// schema has no named properties, so the editor offers only the JSON box.
export function argFields(schema: JsonObject): ArgField[] | null {
  if (!isObject(schema.properties)) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  const fields: ArgField[] = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    const p = isObject(prop) ? prop : {};
    fields.push({
      key,
      label: typeof p.title === 'string' && p.title ? p.title : key,
      description: typeof p.description === 'string' ? p.description : undefined,
      required: required.has(key),
      ...fieldKind(p),
    });
  }
  return fields.length > 0 ? fields : null;
}

/// `args` with `key` set to `value`; an empty value (`undefined`, `''`) removes the key.
export function withArg(args: JsonObject, key: string, value: unknown): JsonObject {
  const { [key]: _drop, ...rest } = args;
  return value === undefined || value === '' ? rest : { ...rest, [key]: value };
}

/// A number box's text as a value: `undefined` when blank or not a number.
export function parseNumber(text: string, integer: boolean): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return integer ? Math.trunc(n) : n;
}

/// The whole arguments object as JSON text (`{}` when empty).
export function argsToJson(args: JsonObject): string {
  return JSON.stringify(args, null, 2);
}

/// JSON text as an arguments object; `null` when it isn't valid JSON or isn't an object.
export function argsFromJson(text: string): JsonObject | null {
  try {
    const v: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/// The required fields still empty in `args` (for a note beside the form).
export function missingRequired(fields: readonly ArgField[] | null, args: JsonObject): string[] {
  return (fields ?? []).filter((f) => f.required && (args[f.key] === undefined || args[f.key] === '')).map((f) => f.key);
}
