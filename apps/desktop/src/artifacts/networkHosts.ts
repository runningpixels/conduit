/// Where an HTML artifact says, or looks like, it will connect (ADR-010).
///
/// 1. Declared: `<meta name="conduit-network" content="host — why">`, one or
///    more, several hosts separated by `;`. The model is asked to declare each
///    site with its reason, as Figma plugins do with `allowedDomains`.
/// 2. Found in the code: absolute https addresses inside `<script>` elements, so
///    a site the page did not declare is still listed before it is contacted.
///
/// Both are shown to the reader before any request is made; neither grants
/// anything.

import { requestOrigin } from './networkBridge';

export interface DeclaredHost {
  origin: string;
  /// The page's stated reason, when it gave one.
  reason?: string;
}

/// Namespace and schema hosts that appear in markup but are never fetched.
const NOT_NETWORK_HOSTS = new Set(['www.w3.org', 'w3.org', 'schema.org', 'www.schema.org', 'xmlns.com']);

function metaContents(html: string): string[] {
  const contents: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== 'conduit-network') continue;
    const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[2] ?? content?.[3];
    if (value) contents.push(value);
  }
  return contents;
}

/// Hosts the page declares, in order, first reason winning.
export function declaredHosts(html: string): DeclaredHost[] {
  const out = new Map<string, DeclaredHost>();
  for (const content of metaContents(html)) {
    for (const entry of content.split(/[;\n]/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [hostPart, ...rest] = trimmed.split(/\s+[—–-]\s+|\s*:\s+/);
      const reason = rest.join(' ').trim() || undefined;
      const origin = requestOrigin(/^https?:\/\//i.test(hostPart) ? hostPart : `https://${hostPart}`);
      if (origin && !out.has(origin)) out.set(origin, { origin, reason });
    }
  }
  return [...out.values()];
}

/// https origins written in the page's scripts, excluding declared ones is the
/// caller's job.
export function scriptedHosts(html: string): string[] {
  const out = new Set<string>();
  for (const script of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    for (const match of script.matchAll(/https:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
      // A link target the page builds (`href="https://…`, `.href = '…'`,
      // `window.open('…')`) is opened by the reader, not fetched.
      const before = script.slice(Math.max(0, match.index - 24), match.index);
      if (/(href\s*=\s*\\?["'`]?|\.href\s*=\s*["'`]|open\(\s*["'`])$/i.test(before)) continue;
      const origin = requestOrigin(match[0]);
      if (origin && !NOT_NETWORK_HOSTS.has(new URL(origin).hostname)) out.add(origin);
    }
  }
  return [...out];
}

/// Capability names a page may declare (ADR-012, ADR-014). Anything else is a
/// page asking for something Conduit doesn't grant, and is silently dropped
/// here the same way an unknown `conduit-network` host would not be — Rust
/// re-validates the declared list on save/update regardless.
const KNOWN_CAPABILITIES = new Set(['storage', 'llm']);

function capabilityContents(html: string): string[] {
  const contents: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== 'conduit-capability') continue;
    const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[2] ?? content?.[3];
    if (value) contents.push(value);
  }
  return contents;
}

/// Capabilities the page declares with `<meta name="conduit-capability"
/// content="storage — why">` (an optional `— reason`, several separated by
/// `;`, several tags). Lower-cased, de-duplicated, in order, and filtered to
/// names Conduit actually knows.
export function declaredCapabilities(html: string): string[] {
  const out: string[] = [];
  for (const content of capabilityContents(html)) {
    for (const entry of content.split(/[;\n]/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [namePart] = trimmed.split(/\s+[—–-]\s+|\s*:\s+/);
      const name = namePart.trim().toLowerCase();
      if (KNOWN_CAPABILITIES.has(name) && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/// "api.open-meteo.com" for display; the port is kept when it is not 443.
export function hostLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// =============================================================================
// Launch inputs (ADR-013)
// =============================================================================

import type { AppInput, AppInputKind } from '@conduit/config-schema';
export type { AppInput, AppInputKind };

const APP_INPUT_KINDS: ReadonlySet<string> = new Set<AppInputKind>(['string', 'number', 'boolean', 'enum', 'date']);
const APP_INPUT_ID_REGEX = /^[A-Za-z0-9_-]{1,40}$/;
const APP_INPUT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_APP_INPUTS = 20;
const MAX_ENUM_OPTIONS = 50;

/// A real calendar date, not just digits in the right shape — `2024-02-30`
/// fails this the way `Date` would round it into March otherwise.
function isRealCalendarDate(value: string): boolean {
  if (!APP_INPUT_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/// Whether `value` is a valid value for this input's type — the same rules
/// Rust re-validates: a string up to 500 characters, a finite number, a
/// boolean, one of an enum's options, or a real `YYYY-MM-DD` date.
function fitsAppInput(input: { type: AppInputKind; options?: string[] }, value: unknown): boolean {
  switch (input.type) {
    case 'string':
      return typeof value === 'string' && value.length <= 500;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (input.options ?? []).includes(value);
    case 'date':
      return typeof value === 'string' && isRealCalendarDate(value);
    default:
      return false;
  }
}

/// `null` unless `raw` is a well-formed `AppInput`: a 1–40 character id of
/// letters, digits, `-`/`_`; a 1–60 character label; a known type; `options`
/// present if and only if the type is `enum` (1–50 entries, each 1–60
/// characters); and, if given, a `default` that fits the type.
function parseAppInput(raw: unknown): AppInput | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !APP_INPUT_ID_REGEX.test(r.id)) return null;
  if (typeof r.label !== 'string' || r.label.trim().length === 0 || r.label.length > 60) return null;
  if (typeof r.type !== 'string' || !APP_INPUT_KINDS.has(r.type)) return null;
  const type = r.type as AppInputKind;
  if (r.required !== undefined && typeof r.required !== 'boolean') return null;

  let options: string[] | undefined;
  if (type === 'enum') {
    if (!Array.isArray(r.options) || r.options.length === 0 || r.options.length > MAX_ENUM_OPTIONS) return null;
    if (!r.options.every((o) => typeof o === 'string' && o.length >= 1 && o.length <= 60)) return null;
    options = r.options as string[];
  } else if (r.options !== undefined) {
    return null; // `options` is enum-only.
  }

  let defaultValue: unknown;
  if (r.default !== undefined) {
    if (!fitsAppInput({ type, options }, r.default)) return null;
    defaultValue = r.default;
  }

  const input: AppInput = { id: r.id, label: r.label, type, required: r.required === true };
  if (defaultValue !== undefined) input.default = defaultValue;
  if (options) input.options = options;
  return input;
}

/// The page's launch inputs (ADR-013): the JSON array inside the first
/// `<script type="application/conduit-inputs+json">` (a script of that type
/// never runs). Malformed JSON, a non-array, or the tag's absence all yield
/// `[]`; individual malformed entries and duplicate ids are dropped rather
/// than failing the whole block, capped at 20. Rust re-validates the
/// declaration again on save/update.
export function declaredInputs(html: string): AppInput[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const script = doc.querySelector('script[type="application/conduit-inputs+json"]');
  if (!script?.textContent) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(script.textContent);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: AppInput[] = [];
  for (const raw of parsed) {
    if (out.length >= MAX_APP_INPUTS) break;
    const input = parseAppInput(raw);
    if (!input || seen.has(input.id)) continue;
    seen.add(input.id);
    out.push(input);
  }
  return out;
}
