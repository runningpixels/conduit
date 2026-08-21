/// Build the Content-Security-Policy string injected as the first `<meta>` in
/// every sandboxed HTML/JS artifact document. Pure function — the renderer
/// test suite asserts on the assembled string; jsdom does not enforce CSP, so
/// behavioral enforcement is verified structurally here and needs a real
/// browser (Playwright) for the residual gap (noted in
/// `docs/decisions/artifact-rendering-security.md`).
///
/// Security model:
/// - `connect-src 'none'` — always. No fetch/XHR/WebSocket. This is the
///   exfiltration guard the sandboxed-iframe alone does not provide.
/// - `script-src 'unsafe-inline'` — inline scripts only. **Never** widened
///   with a remote origin, regardless of the allowlist. Remote scripts are
///   blocked absolutely.
/// - `default-src 'none'` + `frame-src 'none'` + `frame-ancestors 'none'` +
///   `base-uri 'none'` + `form-action 'none'` + `navigate-to 'none'` — always.
///   `base-uri 'none'` blocks `<base>` URL rewriting; the navigation/form
///   guards plus the iframe `sandbox="allow-scripts"` (no
///   `allow-top-navigation`/`allow-popups`/`allow-forms`) close the outbound
///   surface.
/// - The user-managed `allowlist` widens ONLY passive resource loads:
///   `style-src`, `img-src`, `font-src`. Each entry must be an absolute
///   `http(s)` origin; anything else is rejected (returns `null`) so the
///   renderer falls back to the fully-offline policy rather than silently
///   dropping or accepting a bad entry.
///
/// Returns the CSP string, or `null` if any allowlist entry is invalid (caller
/// falls back to `buildArtifactCsp([])`).

/** Validate a single allowlist entry: an absolute URL with an http(s) scheme.
 *  Returns the normalized origin (`https://host`) or `null` if rejected. */
export function validateAllowedOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // Drop any path/query/fragment — an allowlist entry is an origin, not a URL.
  // `url.host` includes the port if present (e.g. `host:port`).
  return `${url.protocol}//${url.host}`;
}

const PASSIVE_DIRECTIVES = ['style-src', 'img-src', 'font-src'] as const;

/** Assemble the CSP. Invalid allowlist entries cause a `null` return so the
 *  caller can fall back to the offline policy. */
export function buildArtifactCsp(allowlist: string[]): string | null {
  const origins: string[] = [];
  for (const entry of allowlist) {
    const origin = validateAllowedOrigin(entry);
    if (origin == null) return null;
    if (!origins.includes(origin)) origins.push(origin);
  }

  const passive = (base: string): string => {
    if (origins.length === 0) return base;
    return `${base} ${origins.join(' ')}`;
  };

  const parts = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    passive("style-src 'unsafe-inline'"),
    passive('img-src data: blob:'),
    passive('font-src data: blob:'),
    "connect-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
  ];

  return parts.join('; ');
}

/// The offline (default, empty-allowlist) CSP. Convenience for callers that
/// don't have an allowlist handy.
export const OFFLINE_ARTIFACT_CSP = buildArtifactCsp([])!;