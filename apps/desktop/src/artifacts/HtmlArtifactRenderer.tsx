/// Sandboxed HTML/JS artifact renderer (M6). Renders model-generated HTML in
/// a locked-down iframe so it CANNOT reach the app, the filesystem, the
/// network (beyond a user-managed passive-resource allowlist), or the parent
/// DOM. This is the one place model content is treated as HTML — by design,
/// contained by the layers below.
///
/// Layers (see docs/decisions/artifact-rendering-security.md):
/// 1. `sandbox="allow-scripts"` only — NO `allow-same-origin` (null origin →
///    no parent/ambient-DOM access, no same-origin requests to the app), NO
///    `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`.
/// 2. Strict CSP injected as the FIRST `<meta>` in `<head>`: `connect-src
///    'none'` (the exfiltration guard the sandbox alone doesn't provide),
///    `script-src 'unsafe-inline'` (inline only — never remote scripts),
///    `default-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
///    `navigate-to 'none'`, `frame-ancestors 'none'`. Additional CSP metas in
///    model content can only further RESTRICT, never relax (CSP is monotonic).
/// 3. No Tauri bridge is injected → no `__TAURI__` / filesystem / shell / IPC.
/// 4. `srcdoc` delivery (in-memory, null origin). A dedicated origin is the
///    future defense-in-depth upgrade.
/// 5. `referrerpolicy="no-referrer"`.
///
/// The `allowlist` widens ONLY passive resource loads (img/font/style) and
/// only with validated http(s) origins; `script-src` and `connect-src` are
/// never widened. Empty allowlist → fully offline.
///
/// Residual risk (documented): a hostile artifact can hang its own frame / burn
/// CPU (DoS). Render-only means no bridge for a liveness heartbeat; mitigated
/// by the user closing the artifact. A watchdog is a future follow-up.

import { useMemo } from 'react';
import { buildArtifactCsp, OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';

export interface HtmlArtifactRendererProps {
  /** The model-generated HTML document fragment (inserted into the iframe body). */
  html: string;
  /** User-managed remote allowlist (validated http(s) origins only). */
  allowlist: string[];
  /** Whether to inject richer app-like baseline styles (typography etc.). */
  styledPreview?: boolean;
}

/// Minimal reset so the artifact's own CSS starts from a clean baseline. Kept
/// tiny on purpose — the artifact may bring its own styles (inline only).
const RESET_STYLE = [
  'html,body{margin:0;padding:0;color:inherit;background:transparent;font:inherit}',
  'img{max-width:100%}',
].join('\n');

/// Richer baseline applied when `styledPreview` is true. Conservative set:
/// typography, spacing, code, tables, links — no heavy resets or JS.
const STYLED_STYLE = [
  'body{font:14px/1.65 var(--font-ui, system-ui, sans-serif); color:#111}',
  'h1,h2,h3{margin-top:1.4em;margin-bottom:.4em;font-weight:600}',
  'p{margin:.6em 0}',
  'pre,code{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); background:#f6f7f9; padding:2px 6px; border-radius:4px}',
  'pre{padding:12px 14px; overflow:auto}',
  'table{border-collapse:collapse}',
  'th,td{border:1px solid #ddd; padding:6px 10px; text-align:left}',
  'a{color:#0066cc}',
  'ul,ol{padding-left:1.4em}',
].join('\n');

/// Assemble the full srcdoc: doctype + our CSP meta (FIRST in head) + reset
/// style + (optional styled baseline) + body with the model HTML. Pure — exported for unit testing.
export function assembleArtifactDoc(html: string, allowlist: string[], styledPreview = true): string {
  const csp = buildArtifactCsp(allowlist) ?? OFFLINE_ARTIFACT_CSP;
  const extra = styledPreview ? `<style>${STYLED_STYLE}</style>` : '';
  return (
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${RESET_STYLE}</style>` +
    extra +
    `</head><body>${html}</body></html>`
  );
}

export function HtmlArtifactRenderer({ html, allowlist, styledPreview = true }: HtmlArtifactRendererProps) {
  const srcdoc = useMemo(() => assembleArtifactDoc(html, allowlist, styledPreview), [html, allowlist, styledPreview]);

  return (
    <iframe
      className="artifact-html-frame"
      title="Artifact preview"
      // `allow-scripts` only. NEVER add allow-same-origin / allow-top-navigation /
      // allow-popups / allow-forms / allow-modals — those would break containment.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
    />
  );
}