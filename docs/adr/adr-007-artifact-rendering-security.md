# ADR 007: Artifact Rendering Security (interactive HTML/JS)

## Status
Accepted. Amended by [ADR 010](adr-010-artifact-network-access.md): a page may
reach public https APIs through a Rust-mediated `fetch()` after the reader
allows each site; the frame's sandbox and CSP (`connect-src 'none'`) are
unchanged. Amended 2026-10-09: the reader may give one page (or, in Settings,
every page) **full web access**, a wider CSP and `allow-modals`; see the addendum.

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
4. **`srcdoc` delivery** (null origin); superseded 2026-09-28, see the addendum. A dedicated origin is the future
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
   `img-src` already allows `blob:`. `htmlLabels: false` keeps model text in
   SVG `<text>` rather than `<foreignObject>` HTML, so no HTML reaches the blob
   either; `suppressErrorRendering: true` stops mermaid drawing its error
   diagram into a temporary node it appends to `document.body` and then
   abandons. Only a *terminated* fence is rendered — a fence still arriving
   over the stream stays source, so mermaid is never handed a fragment.
2. **KaTeX.** There is no first-party React emitter. `KatexHtml` may use
   `dangerouslySetInnerHTML` **only** on the return value of
   `katex.renderToString(tex, { throwOnError: true, output: 'html', trust: false })`.
   The TeX source is never assigned to the DOM. Hostile commands (`\html`,
   `\href{javascript:...}`) must fail closed (source fallback, no `<script>`).

HTML artifacts remain the sandboxed-iframe path. This addendum does not apply
to model-authored HTML that happens to include its own KaTeX/Mermaid scripts.

## Addendum (2026-09-14) — shortcut forwarding and the live preview

1. **Shortcut forwarding.** A key pressed inside the sandboxed frame never
   reaches the app window, so app shortcuts (Ctrl+N, Ctrl+K, …) did nothing
   while a preview had focus. A second Conduit-owned inline script, next to the
   link interceptor, posts `conduit:artifact-shortcut` messages for an
   allowlist of Mod chords and Escape. The host accepts a message only when
   `event.source` is that frame's `contentWindow` and the chord is on the same
   allowlist, then replays it on its own window. Artifact scripts can post the
   same message, so the allowlist holds only shortcuts that open or rearrange
   views (new chat, palette, settings, shortcuts sheet, sidebar, document
   panel, expand). Switching provider, toggling web search, forking and
   copying the last message are not forwardable.
2. **Live preview while writing.** With the opt-in "Live preview" toggle, the
   pending panel renders the document from the streaming tool call about once
   a second. It uses `assembleArtifactDoc` and the same `sandbox="allow-scripts"`,
   CSP-first `<head>` and `referrerpolicy` as the finished preview, so partial
   content gains no capability the finished document lacks; model content is
   still placed only in `<body>`, which a truncated document cannot escape.
   Model `<script>` elements and inline handlers are stripped first — a
   convenience so half-written scripts do not run, **not** a security boundary
   (the sandbox and CSP are). One Conduit-owned line scrolls to the end so the
   view follows the writing. Previewing stops past 1,000,000 characters.
## Addendum (2026-09-28): artifacts load from their own scheme, not `srcdoc`

**The bug:** in release builds, no artifact script ever ran. Tauri serves the main page
with the app CSP (`script-src 'self'` plus hashes of its own scripts). A `srcdoc` frame
inherits the embedding page's policy, so every inline script in the artifact was
blocked: the model's code, and Conduit's injected link, form, shortcut, error and fetch
scripts. Interactive artifacts rendered as static markup. Dev builds never showed it,
because Vite serves the page and Tauri injects no CSP there. Every earlier live test ran
in dev.

**The fix:** layer 4 changes. The renderer still assembles the same document (CSP meta
first in `<head>`, then the injected scripts). It hands that document to Rust
(`put_artifact_frame`), which keeps it in memory under a random token and serves it from
the `conduit-artifact` scheme:

- the URL is `http://conduit-artifact.localhost/<token>` on Windows, and
  `conduit-artifact://localhost/<token>` elsewhere
- the handler is `artifact_frames.rs`, which serves GET only
- responses are `no-store` and `nosniff`
- the store is capped by count and bytes
- the renderer drops a token when its frame goes away

A real navigation gets a fresh policy container, so the document's own CSP meta is the
policy that applies, as the ADR always intended.

**What stays the same:**

- The frame keeps `sandbox="allow-scripts"`, so its origin is still opaque. It can't read
  the app, other frames or the scheme's other documents; tokens are unguessable.
- No Tauri bridge is injected. Requests to the custom scheme are handled in-process, never
  on the network.

**Other changes:**

- The app CSP's `frame-src` goes from `'none'` to that scheme only.
- Outside Tauri (unit tests), or if the IPC call fails, the renderer falls back to
  `srcdoc`. That fails safe: scripts are blocked, never widened.
- The live preview while a document streams uses the scheme too, one token per buffered
  frame. It still strips model scripts. Only Conduit's own helpers there (scroll-to-end,
  shortcut forwarding) are affected, and they now run in release as well.

**Verified in a release build:** an existing interactive artifact loads from the scheme,
its scripts run (it fetched live rates through the ADR-010 bridge), the WebRTC removal
(ADR-010 addendum) applies, `origin` is `null`, and access to the parent is blocked.

## Addendum (2026-10-09): full web access, per page, at the reader's risk

**Why.** The offline frame made pages fail in ways readers could not fix: a chart page
that loads Chart.js from a CDN, a map with OpenStreetMap tiles, an image grid with plain
`<img>` tags from Wikimedia. Readers asked for the same freedom a website has, on their
own say-so. A page is still not quite a website, so the grant is explicit and narrow:

1. its code is model-written and may follow instructions hidden in text the model read;
2. it can carry the reader's data (chat or document content put into it) and send it on;
3. it can reach host bridges (page storage, model calls on the reader's key);
4. it runs on the reader's machine, next to their local network.

**What changes, for one page.** The reader can give a page *full web access*. It is stored
as a network grant of the page's principal (`artifact:<id>` or `app:<id>`) with the
special value `full`, next to the site grants and the any-site grant (`*`); no schema
change. It survives later edits of the page (keyed on the principal, not the content), and
the Activity log still marks requests made after a change. It is listed and removable in
Settings → Artifact security and from the globe chip; removing it makes the page ask again.
A Settings switch, "Give every page full web access", off by default, gives it to every
page. Neither applies while pages can't connect at all (local-only mode, or the network
switch off).

With full web access the page loads with:

- CSP: `default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline'
  https: data: blob:; img-src https: data: blob:; font-src https: data: blob:; media-src
  https: data: blob:; connect-src https: wss:; frame-src https:; worker-src blob:;
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'`
  (allowlisted origins stay on the passive directives). No `http:` anywhere: no mixed
  content, and not the plain-http devices on a home network.
- Sandbox: `allow-scripts allow-modals`. Still **never** `allow-same-origin` (every page
  shares the `conduit-artifact` origin, so that would mean shared storage between pages and
  a path towards the app), `allow-popups`, `allow-top-navigation` or `allow-forms`.
- No Referer, by construction: a sandboxed document without `allow-same-origin` has an
  opaque origin, and Chromium sends no `Referer` from it whatever the referrer policy
  (verified 2026-10-09, `unsafe-url` included). Services that require one refuse the page:
  OpenStreetMap's tile servers answer with a "blocked" image. Giving pages a real origin
  would need `allow-same-origin`, which stays off. The model is told so it picks services
  that work without one.
  *(Superseded 2026-10-10: a full-access page now gets a real origin of its own and
  `allow-same-origin`, and the prompt no longer mentions the Referer; see the addendum
  below.)*
- Everything else unchanged: no Tauri bridge (and the `chrome.webview` cut), link clicks
  confirmed, the WebRTC removal, the ADR-010 fetch bridge (so `fetch()` keeps the proxy's
  checks and has no CORS trouble; full access implies the any-site grant, so it no longer
  asks per site), the ADR-014 model-access consent.

The CSP is fixed when the document loads, so granting or removing it reloads the page.
The view waits for the page's access state before the first load, so a page that already
has full access loads once, with the right policy.

**How the reader is asked.** Without full access, a Conduit-owned script in the frame
(`blockedLoads.ts`) listens for `securitypolicyviolation` and posts each blocked https/wss
origin with its directive to the host (deduped per directive and origin, at most 20 per
load; `inline`, `eval`, `data:` and `http:` are not reported, since full access would not
open them). The host shows a banner, "This page wants full web access: scripts from
cdnjs.cloudflare.com; images from upload.wikimedia.org", with Review and Not now (put off
for that page for this session). The dialog says plainly that the code was written by an AI
model that can be misled by what it read, that the page can then send anything it shows
or the reader types into it to any site, and that it may reach devices on the network.
The page can forge reports; a report only ever leads to that question.

**Windows: the guard proxy.** The main WebView2 is built with a proxy so WebRTC can't
leave over TCP (ADR-010 addendum). That proxy used to accept nothing, which also meant no
direct load could leave the webview. The app now starts a loopback **guard proxy**
(`guard_proxy.rs`) and points `--proxy-server` at it:

- `CONNECT` only, port 443 only; the name is resolved there and the tunnel pinned to the
  checked address, which must be public (the same check as the fetch bridge, DNS
  rebinding included);
- it refuses everything unless a document rendered with full web access is stored in the
  frame store (`put_artifact_frame` marks it; the renderer drops the token when the frame
  goes away), so with no such page on screen it behaves exactly like the dead proxy;
- a cap on open tunnels. If it can't listen, the dead proxy stays and full-access pages
  load nothing remote (fails safe).

**Residual risks.**

- A page with full web access can send anything in it to any https site, directly (an
  image URL, a script URL, a WebSocket), without the bridge's log or caps. The grant is
  explicit, per page, revocable, and the dialog says so.
- Nested frames (`frame-src https:`) inherit the sandbox, so they too run without
  same-origin, popups or navigation. On Windows, WebView2 runs Tauri's init scripts in
  every frame; the IPC refuses remote origins (no capability grants them), but the
  in-frame `chrome.webview` cut is not injected into a nested frame.
- While a full-access page is open on Windows, WebRTC can use the guard proxy too (TURN
  over TLS to a public host on 443). Other pages still have the constructors removed in
  their own frame.
- `https://localhost` and other loopback https services are reachable from a full-access
  page: Chromium never sends loopback through a proxy.
- macOS (WKWebView) and Linux (WebKitGTK) take no proxy argument, so there direct loads
  from a full-access page go out unchecked: they can reach https services on the local
  network. The macOS WebRTC gap (ADR-010 addendum) is still open.
- Embeds that need their own origin's storage (some video players) may still fail inside
  the sandbox. *(Addressed 2026-10-10, below.)*

## Addendum (2026-10-10): full-access pages get a real origin of their own

**Why.** The addendum above left a page with full web access on an opaque origin, which
sends no `Referer` and has no storage or cookies of its own. Services that require a
Referer refused such pages (OpenStreetMap tiles; checked with curl, OSM accepts any
Referer, `http://<id>.page.localhost:<port>/` included), and embeds that keep state in
their own storage (video players) failed. Pages **without** full web access are
unchanged: `conduit-artifact` scheme, `allow-scripts`, opaque origin.

**What changes, for a full-access page only.** Its document is served from a loopback
HTTP server in the app (`page_server.rs`) at `http://<page id>.page.localhost:<port>/<token>`,
and its frame's sandbox becomes `allow-scripts allow-modals allow-same-origin`. The page
then behaves like a website on its own origin: it sends a Referer
(`Referrer-Policy: strict-origin`, so a site sees only the origin, never the token), and
it keeps its own localStorage, IndexedDB, caches and cookies across reloads.

- **One origin per page.** `<page id>` is the first 32 hex characters of
  SHA-256(install secret ‖ principal). The install secret is 32 random bytes, created
  once and kept in `page-origins.json` in the app data directory (with the list of pages
  that were given an origin, for clearing). Stable across reloads and edits; different for
  every page, so pages never share storage; not derivable on another install. Page ids
  are hex, so they can never equal a scheme name or `tauri`.
- **A stable port.** The port is part of every page's origin, so storage only survives
  a restart if the port does. The first launch binds a random port in 49152–65000 and
  saves it in `page-origins.json`; later launches bind that port again (before the guard
  proxy takes its own ephemeral port). Only if it is taken is a new random port bound
  and saved; the old one goes into a bounded list (last 8) of previous ports, and a
  warning is logged.
- **Guards on the server.** Bound to `127.0.0.1` only. The `Host` header must
  be exactly `<page id>.page.localhost:<port>`, and the path's token must have been
  stored for that page id (`ArtifactFrames::put_page`); such a document is never served
  by the scheme, and the renderer drops the token when its frame goes away, as before.
  `GET`/`HEAD` only (else 405); a request whose `Sec-Fetch-Dest` says it is not for a
  frame is refused; everything else is 404. Every response is `no-store`, `nosniff`,
  `Origin-Agent-Cluster: ?1`, and carries a CSP header: the page's own `full` policy
  (the same one its first `<meta>` carries, built from the same allowlist) with
  `frame-ancestors` limited to the app's origin, so another local site or browser can't
  frame a page. Both policies apply, so the effective one is never wider than the meta.
- **App origin.** Known at startup: `http://tauri.localhost` on Windows (`https` with
  `useHttpsScheme`), `tauri://localhost` on macOS and Linux, plus the dev server's origin
  in a dev build (`build.devUrl`). The app CSP's `frame-src` adds
  `http://*.page.localhost:*`.
- **Host and frame messages.** The host still accepts a message only from the frame's
  window (`event.source`); for a page on its own origin it also requires `event.origin`
  to be that origin (a page could navigate its frame elsewhere), and posts to that exact
  origin instead of `'*'`. A `srcdoc` or scheme frame never gets `allow-same-origin`: the
  renderer adds it only when the source is a page-server URL, and re-creates the frame
  when the origin changes so the flags and the `src` change together.
- **No IPC from page origins.** Tauri answers IPC only for its own origin and for remote
  URLs a capability lists; `capabilities/default.json` lists none, so a call from
  `*.page.localhost` is refused. The page's CSP blocks http connections
  (`connect-src https: wss:`), which also closes `http://ipc.localhost`; the in-frame
  `chrome.webview` cut stays. Chromium never proxies `*.localhost` (it resolves it to
  loopback itself), so the guard proxy is not involved.
- **Clearing: "delete cookies and site data".** Nothing in the app can reach another
  origin's storage, so it is cleared on the page's own origin: Rust mints a one-shot token
  (60 s) and `GET /<token>/__clear` answers with
  `Clear-Site-Data: "cache", "cookies", "storage"` and a nonce'd script that also empties
  localStorage, sessionStorage, IndexedDB (`indexedDB.databases()`), Cache Storage and the
  cookies it can see, then posts `conduit:page-data-cleared` to the app's origin. The host
  loads it in a hidden frame (`allow-scripts allow-same-origin`) and waits up to 5 s. Used
  by "Clear site data" in a saved app's ⋯ menu and a chat page's ⋯ menu (both only while
  the page has full access); by Settings → Artifact security → "Clear data for all pages"
  (every page that was given an origin, then every cookie in the webview's store except
  the app's own, through Tauri's `Webview::cookies`/`delete_cookie`, which covers cookies
  set by embedded sites); and by a sweep that clears pages that were deleted or lost full
  web access (on revoke, on "Remove all", when the every-page switch is turned off, after
  deleting an app or a chat, and at startup).

**Residual risks.**

- Any local process can connect to the server, but it needs a document's token, which is
  random, lives only while the frame is open, and is bound to one page id; the Host check
  stops a DNS-rebinding site from using it.
- All page origins are under `page.localhost`, so the browser may treat them as one
  *site* (cross-origin): a page could set a cookie for `Domain=page.localhost` that another
  full-access page reads, and `SameSite` doesn't separate them. Storage, IndexedDB and
  caches stay per origin, and `Origin-Agent-Cluster` keeps `document.domain` from joining
  them. Clearing one page with `Clear-Site-Data: "cookies"` may also clear such shared
  cookies of the others.
- Page frames are third-party to the app, so their storage is partitioned under the
  app's top-level site; it persists in the webview profile until cleared.
- Embeds set third-party cookies under their own sites; only the all-pages clear removes
  those (per-page clearing can't tell which page an embed's cookie came from).
- WebKit (macOS, Linux) is not yet verified: that it resolves `*.localhost` to loopback,
  treats it as a secure context, honours `frame-ancestors tauri://localhost`, and supports
  `Clear-Site-Data` (in part; the script does the same by hand). Until then a failure
  there means a page that doesn't load, not a wider one.
- Not yet checked live (Windows release build included): Leaflet with OSM tiles, a video
  embed, storage surviving a reload and separate between two pages, and a probe page that
  tries `__TAURI_INTERNALS__`, `ipc.localhost` and the custom schemes.
- If the saved port is taken at launch (another program got it first), the port changes
  and so does every page's origin: what pages stored under the old origins stays in the
  webview profile, unreachable from the app (neither shown nor cleared by "Clear data for
  all pages"; the cookie clear still removes cookies there). The previous ports are kept
  in the record for reference only; nothing tries to reach the old origins.
- Resetting the local database doesn't rotate the install secret; a new profile does.

## Related
- Supersedes the interactive-rendering deferral in ADR 002 (which modeled
  artifacts as static payload records). ADR 002's append-only **versioning** is
  separately superseded by Phase 5's single-payload model (no version history,
  no restore — user-directed). The storage/export decision is recorded in the
  Phase 5 artifact-storage decision record.