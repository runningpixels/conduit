/// What a page tried to load from the web and its CSP stopped (ADR-007,
/// "Full web access").
///
/// A page without full web access may not load scripts, images, fonts or
/// media from other sites. A model writing a chart page reaches for a CDN
/// script anyway, and the page then shows nothing. This Conduit-owned script,
/// injected in the head before the page's own, listens for the browser's
/// `securitypolicyviolation` events and posts each blocked https origin to the
/// host, once per kind and origin and at most `MAX_REPORTS` per load. The host
/// offers the reader full web access for the page, listing what was stopped.
///
/// The page can post the same message itself, so a report is only ever a
/// reason to *ask*: the reader decides, and the dialog states the risk
/// whatever the list says.

export const ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE = 'conduit:artifact-blocked-load';

/// Reports one frame load sends at most.
const MAX_REPORTS = 20;
/// Longest origin accepted.
const MAX_ORIGIN = 300;

/// What was stopped, as the reader reads it.
export type BlockedLoadKind = 'scripts' | 'styles' | 'images' | 'fonts' | 'media' | 'connections' | 'frames';

export const BLOCKED_LOAD_KINDS: readonly BlockedLoadKind[] = [
  'scripts',
  'styles',
  'images',
  'fonts',
  'media',
  'connections',
  'frames',
];

export interface BlockedLoad {
  kind: BlockedLoadKind;
  /** `https://host[:port]` or `wss://host[:port]`. */
  origin: string;
}

/// The kind a CSP directive guards, or null for one full web access would not
/// open (`object-src`, `form-action`, …).
export function blockedLoadKind(directive: string): BlockedLoadKind | null {
  const name = directive.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (name.startsWith('script-src') || name === 'worker-src') return 'scripts';
  if (name.startsWith('style-src')) return 'styles';
  if (name === 'img-src') return 'images';
  if (name === 'font-src') return 'fonts';
  if (name === 'media-src') return 'media';
  if (name === 'connect-src') return 'connections';
  if (name === 'frame-src' || name === 'child-src') return 'frames';
  return null;
}

/// Trusted reporter (not model content). Only https and wss origins are
/// reported: those are what full web access opens. `inline`, `eval`, `data:`
/// and plain `http:` loads are not.
export const ARTIFACT_BLOCKED_LOAD_SCRIPT =
  `(function(){var seen={},sent=0;` +
  `document.addEventListener('securitypolicyviolation',function(e){` +
  `if(sent>=${MAX_REPORTS})return;` +
  `var d=String(e.effectiveDirective||e.violatedDirective||'').split(' ')[0];` +
  `var o;try{o=new URL(String(e.blockedURI||'')).origin;}catch(_){return;}` +
  `if(!/^(https|wss):\\/\\//.test(o))return;` +
  `var k=d+' '+o;if(seen[k])return;seen[k]=1;sent++;` +
  `parent.postMessage({type:'${ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE}',directive:d,origin:o},'*');` +
  `},true);})();`;

/// Parse a report from the frame; `null` unless well formed. Untrusted: the
/// page can post anything.
export function parseArtifactBlockedLoadMessage(data: unknown): BlockedLoad | null {
  if (data == null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE) return null;
  if (typeof d.directive !== 'string' || typeof d.origin !== 'string') return null;
  if (d.origin.length > MAX_ORIGIN) return null;
  const kind = blockedLoadKind(d.directive);
  if (!kind) return null;
  let url: URL;
  try {
    url = new URL(d.origin);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'wss:') || url.username || url.password || !url.hostname) {
    return null;
  }
  return { kind, origin: `${url.protocol}//${url.host}` };
}

/// Add `load` to `list` unless it is already there or the list is full.
/// Returns the same array when nothing changed.
export function addBlockedLoad(list: readonly BlockedLoad[], load: BlockedLoad, max = MAX_REPORTS): readonly BlockedLoad[] {
  if (list.length >= max) return list;
  if (list.some((l) => l.kind === load.kind && l.origin === load.origin)) return list;
  return [...list, load];
}

/// The hosts stopped for each kind, in a stable kind order, for the banner.
export function groupBlockedLoads(list: readonly BlockedLoad[]): Array<{ kind: BlockedLoadKind; hosts: string[] }> {
  const groups: Array<{ kind: BlockedLoadKind; hosts: string[] }> = [];
  for (const kind of BLOCKED_LOAD_KINDS) {
    const hosts = [...new Set(list.filter((l) => l.kind === kind).map((l) => new URL(l.origin).host))];
    if (hosts.length > 0) groups.push({ kind, hosts });
  }
  return groups;
}
