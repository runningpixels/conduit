/// Shared helpers for opening http(s) URLs from artifact previews in the
/// system browser. Client-side checks mirror (but do not replace) the Rust
/// `validate_external_open_url` gate — every open still goes through IPC.

export const ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE = 'conduit:artifact-external-link';

const MAX_EXTERNAL_URL_LEN = 2048;

/// True when `url` is an absolute http(s) URL suitable for system-browser open.
/// Rejects userinfo, empty host, whitespace, overlong strings, and every other
/// scheme (`javascript:`, `data:`, `file:`, `mailto:`, …).
export function isHttpOrHttpsUrl(url: string): boolean {
  if (!url || url.length > MAX_EXTERNAL_URL_LEN) return false;
  if (/\s/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

/// Parse a postMessage payload from the HTML artifact iframe. Returns the
/// validated href or `null` when the message is not ours / not safe.
export function parseArtifactExternalLinkMessage(data: unknown): string | null {
  if (data == null || typeof data !== 'object') return null;
  const payload = data as { type?: unknown; href?: unknown };
  if (payload.type !== ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE) return null;
  if (typeof payload.href !== 'string') return null;
  return isHttpOrHttpsUrl(payload.href) ? payload.href : null;
}

/// Cheap content fingerprint so a grant does not survive an in-session edit of
/// the same artifact id (hostile links could be added after approval).
export function contentFingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/// Session grant key: artifact id + content fingerprint.
export function artifactExternalLinkGrantKey(artifactId: string, content: string): string {
  return `${artifactId}:${contentFingerprint(content)}`;
}
