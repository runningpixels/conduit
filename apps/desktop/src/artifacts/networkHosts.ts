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

/// Capability names a page may declare (ADR-012). Only `storage` exists today;
/// anything else is a page asking for something Conduit doesn't grant, and is
/// silently dropped here the same way an unknown `conduit-network` host would
/// not be — Rust re-validates the declared list on save/update regardless.
const KNOWN_CAPABILITIES = new Set(['storage']);

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
