# ADR 007: Artifact Rendering Security (interactive HTML/JS)

## Status
Accepted.

## Decision
Render model-generated artifacts through a layered containment model. Markdown,
text, code, and JSON render through a hand-rolled safe-subset parser that emits
React nodes (never HTML strings, never `dangerouslySetInnerHTML`). Interactive
HTML/JS artifacts render inside a **sandboxed iframe** with a strict injected
Content-Security-Policy, no Tauri bridge, and a user-managed remote allowlist
for passive resources only.

## Context
Phase 5 makes generated artifacts first-class and allows rich, interactive
HTML+JS documents. Model-generated content is **untrusted** — it must never
execute in the main app context, reach the filesystem, exfiltrate data, or
access the Tauri bridge. At the same time, artifacts should be able to produce
rich documents (styled text, diagrams, small interactive widgets) for the user.

## Containment layers (interactive HTML/JS artifacts)
1. **Sandboxed iframe, `sandbox="allow-scripts"` only.** No `allow-same-origin`
   (the frame gets a null origin → no parent/ambient-DOM access, no same-origin
   requests to the app), no `allow-top-navigation`, `allow-popups`,
   `allow-forms`, `allow-modals`. Content is delivered via `srcdoc` (in-memory,
   null origin).
2. **Strict CSP injected as the FIRST `<meta>` in `<head>`:**
   `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'…;
   img-src data: blob:…; font-src data: blob:…; connect-src 'none';
   frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action
   'none'; navigate-to 'none'`. `connect-src 'none'` is the exfiltration guard
   the sandbox alone does not provide. CSP is monotonic — additional CSP metas
   in model content can only further RESTRICT, never relax. `base-uri 'none'`
   blocks `<base>` URL rewriting.
3. **No Tauri bridge injected** into the iframe → no `__TAURI__`, no filesystem,
   shell, or IPC surface.
4. **`srcdoc` delivery** (null origin). A dedicated origin is the future
   defense-in-depth upgrade.
5. **`referrerpolicy="no-referrer"`.**
6. **Trusted link interceptor (Conduit-owned inline script).** Because the
   sandbox omits `allow-popups` / `allow-top-navigation` and CSP sets
   `navigate-to 'none'`, raw `<a href>` clicks do nothing useful. A small
   interceptor Conduit injects into `srcdoc` (not model content) captures
   absolute `http(s)` clicks and `postMessage`s them to the parent. The parent
   confirms once per artifact+content for the session, then opens via the
   validated `open_external_url` command. Sandbox flags stay unchanged;
   `connect-src` remains `'none'` (OS browser open is a user action, not
   artifact network). Hostile scripts can also `postMessage`; confirmation +
   Rust URL validation remain the gate.

## Network policy — user-managed allowlist
Default is **fully offline**: `connect-src 'none'`, `script-src 'unsafe-inline'`
(inline only — **never** remote scripts), and `img-src`/`font-src`/`style-src`
restricted to `data:`/`blob:`. The user may add trusted http(s) origins to
`AppSettings.artifactRemoteAllowlist`; those origins are appended to the
passive resource directives (`style-src`/`img-src`/`font-src`) at render time.
`script-src` is never widened beyond `'unsafe-inline'` and `connect-src` is
always `'none'`, regardless of the allowlist. The allowlist is empty by default,
so out-of-the-box artifacts cannot reach the network at all. Entries are
validated as absolute http(s) URLs (origin only) by both Rust (`state.rs`) and
the renderer (`buildArtifactCsp.validateAllowedOrigin`).

## Markdown / text / code / JSON renderers
A hand-rolled safe-subset Markdown parser (`artifacts/markdown/safeMarkdown.ts`)
returns React nodes — every text node is a React text child (React escapes by
construction), so raw HTML in the source renders as escaped **visible text**,
not parsed markup. No `dangerouslySetInnerHTML` anywhere in the markdown path.
Link URLs are allowlisted to `http:`, `https:`, `mailto:` (`javascript:`,
`data:`, `vbscript:`, and whitespace-prefixed URLs are rejected and render as
plain text). Code/JSON/Plain renderers are likewise React-node-only. Syntax
highlighting is deferred (monospace + language chip).

## Residual risk
A hostile artifact can still hang its own frame or burn CPU (DoS). Render-only
means there is no bridge for a liveness heartbeat; mitigation is the user
closing the artifact. A watchdog / CPU-budget enforcer is a future follow-up.

## Testing caveat
jsdom does not enforce the iframe `sandbox` or CSP. Renderer tests therefore
assert **structure** (the `sandbox` attribute value, the assembled CSP string,
CSP `<meta>` placement, no `__TAURI__` in `srcdoc`, escaped raw HTML) on pure
functions (`buildArtifactCsp`, `assembleArtifactDoc`) and structural DOM
assertions (`HtmlArtifactRenderer.test.tsx`). Behavioral enforcement — a script
inside the artifact actually being blocked from `parent.document`, `fetch`,
`window.open`, top navigation, and remote `img` loads — requires a real browser
(Playwright) and is tracked as a future gap (`artifacts/isolation.test.tsx`
holds the skipped placeholders).

## Consequences
- Rich, interactive documents are possible without executing model-generated
  code in the main app context.
- The exfiltration surface is closed by `connect-src 'none'` + null origin, not
  by trusting the model.
- The user explicitly opts in to any network access for artifacts, and only for
  passive resources; scripts and API calls stay blocked.
- A dedicated iframe origin + a CPU watchdog are the named future upgrades.

## Addendum (2026-08-30) — Mermaid + KaTeX in markdown/chat

Two renderers were added without relaxing artifact-iframe CSP (`connect-src`
stays `'none'`) and without loading either library from a CDN.

1. **Mermaid.** `mermaid.render` (dynamic import, `securityLevel: 'strict'`)
   produces an SVG string. That string is wrapped in a `blob:` URL and shown
   as `<img>`. Model-controlled HTML never enters the React tree. Main-window
   `img-src` already allows `blob:`.
2. **KaTeX.** There is no first-party React emitter. `KatexHtml` may use
   `dangerouslySetInnerHTML` **only** on the return value of
   `katex.renderToString(tex, { throwOnError: true, output: 'html', trust: false })`.
   The TeX source is never assigned to the DOM. Hostile commands (`\html`,
   `\href{javascript:...}`) must fail closed (source fallback, no `<script>`).

HTML artifacts remain the sandboxed-iframe path. This addendum does not apply
to model-authored HTML that happens to include its own KaTeX/Mermaid scripts.

## Related
- Supersedes the interactive-rendering deferral in ADR 002 (which modeled
  artifacts as static payload records). ADR 002's append-only **versioning** is
  separately superseded by Phase 5's single-payload model (no version history,
  no restore — user-directed). The storage/export decision is recorded in the
  Phase 5 artifact-storage decision record.