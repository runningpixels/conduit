# ADR 010: Artifact Network Access (mediated fetch)

## Status
Accepted — 2026-09-26. Amends [ADR 007](adr-007-artifact-rendering-security.md).
Plan and research: [`docs/plans/artifact-network-access.md`](../plans/artifact-network-access.md).

## Decision
An HTML artifact may reach public https APIs through `fetch()`, **only** after
the reader allows each site for that page. The frame itself gains no network:
its sandbox and CSP are byte-for-byte what ADR 007 specifies, `connect-src
'none'` included. Every request is made by Rust on the page's behalf, after
the grant, the address and the caps are checked there.

## Context
ADR 007 made artifacts fully offline. Live testing kept hitting that ceiling:
a "weather dashboard" shipped a made-up sample forecast; dashboards, trackers
and converters were "almost real". Competitors either open the frame's CSP to
the network (Claude artifacts behind a consent step; ChatGPT canvas; v0/Bolt
previews) or broker requests through the host (Figma plugins'
`allowedDomains`, browser-extension host permissions). Opening the CSP would
let any script in the page reach any allowed host with any header, and would
make the grant unrevocable mid-session. Brokering keeps one enforcement point
we own.

## How it works
1. **Shim.** For a saved page (not the streaming live preview), a third
   Conduit-owned inline script next to the link interceptor replaces
   `window.fetch`. It posts `conduit:artifact-fetch` `{id, url, method,
   headers, body}` to the parent and turns the answer
   (`conduit:artifact-fetch-result`) into a real `Response`; a refusal
   rejects with `TypeError`, as a network error would. `AbortSignal` posts
   `conduit:artifact-fetch-abort`. `XMLHttpRequest`, `WebSocket`,
   `EventSource` and remote scripts stay blocked by the CSP. WebRTC is **not**
   governed by CSP; see the 2026-09-28 addendum.
2. **Host.** The renderer accepts request messages only when `event.source` is
   that frame's `contentWindow`, validates their shape, and hands them to the
   document panel's broker. A request to a site already allowed goes to Rust;
   one to an undecided site is **held** while the panel shows a banner ("This
   page wants to connect to api.example.com"). *Review* opens a dialog naming
   each site, whether the page declared it and why, the first request's method
   and path, and a preview of any body it sends. Choices: **Don't allow**
   (session), **Allow this time** (session, in Rust memory), **Always allow
   for this page** (database). A header chip lists every site the page
   declares, has in its code, or contacted, with its status and a request log
   ("since the last change" marks requests made after an edit).
3. **Declaring sites.** The model is told to declare each site as
   `<meta name="conduit-network" content="host — why">`. Declarations and
   https URLs found in `<script>` are shown before anything is contacted;
   neither grants anything.
4. **Rust (`artifact_fetch`).** Refuses when local-only mode is on or the
   Settings switch ("Pages can connect to the internet", on by default) is
   off. Checks the grant (database or session) for the request's origin.
   Then: https only, no userinfo, no `localhost`/`.local`; DNS is resolved and
   **every** address must be public (IPv4/IPv6 private, loopback, link-local,
   CGNAT, multicast, documentation, IPv4-mapped/NAT64 forms refused), and the
   connection is pinned to the checked addresses (no DNS rebinding); no
   proxy; redirects followed manually, at most 5, every hop checked again
   (see 7). Methods
   GET, HEAD, POST, PUT, PATCH, DELETE. Request headers `authorization`,
   `cookie`, `origin`, `referer`, `user-agent`, `host`, `sec-*`, `proxy-*`
   and hop-by-hop headers are dropped; `set-cookie` and `www-authenticate`
   never reach the page. No cookie jar. User agent `Conduit-Artifact/<ver>`.
   Caps: 20 s, 5 MB response, 1 MB body, 120 requests a minute per page; at
   most 4 run at once, and more wait their turn rather than fail (a page that
   loads five stories with `Promise.all` must get all five).
5. **Grants.** Keyed on (artifact id, origin). Remembered grants live in
   `artifact_network_grants` (deleted with the artifact); an edited page keeps
   them, and a new site in the edit asks again. Settings → Artifact security
   lists them with *Remove* and *Remove all*.

6. **Forms.** Without `allow-forms` a browser drops a form submission before
   its `submit` event fires, so pages that handle forms in script (search
   boxes, "add item") did nothing. A Conduit-owned script dispatches a
   synthetic, cancelable `submit` event for submit-button clicks, Enter and
   `requestSubmit()`. Nothing is submitted or navigated; the sandbox flags are
   unchanged. This applies to every page, with or without network access.

7. **Redirects and "any public site"** (amended 2026-09-27). APIs move
   (api.frankfurter.app now redirects to api.frankfurter.dev), and refusing a
   cross-site redirect left the page with no data and no way to recover.
   Rust follows a redirect to the same site (same host ignoring a leading
   `www.`, or a subdomain of the allowed host; labels are never stripped, so
   `a.co.uk` → `b.co.uk` is another site) or to a site the page may already
   reach. Any other redirect fails with `redirect:<origin> <message>`; the
   panel holds the request and asks about the target ("The page asked for X,
   which sent it on to Y"), and allowing it re-sends the original request.
   The dialog also offers **Let this page reach any public site**, which
   grants the origin `*` for this session or always. Everything in 4 still
   applies to every request — https, public addresses only, no credentials,
   the caps, the log, local-only and the Settings switch — so `*` widens
   which public sites, never what a request can carry or reach. It is per
   page, shown as "Any public site" in the chip and in Settings, and removed
   like any other grant.

## Consequences
- Live pages work, and the reader sees and decides every site first.
- The exfiltration guard moves from "no network" to "only sites the reader
  allowed, for this page, without credentials". A page allowed to reach a site
  can send that site whatever it can read — its own content and what the
  reader types into it. The dialog says so when a request carries a body.
- The site sees the reader's IP address; the dialog says so.
- The exported HTML file keeps calling `fetch()` directly and works (or not)
  under the browser's normal rules — the shim is not exported.
- Marketing claims that artifacts "can't phone home" must say "without your
  permission" instead.

## Testing
`networkBridge.test.ts` runs the shim against a fake frame; the renderer tests
assert the shim is injected only with a handler and the CSP is unchanged;
`useArtifactNetwork.test.ts` covers hold/allow/deny/blocked, a refused
redirect held and re-sent, and the any-site grant;
`src-tauri/tests/artifact_network.rs` runs `perform` against a scripted local
server (redirects, caps, header stripping, the address policy) and the grant
repository. The live check (Playwright over CDP) drives a weather page against
Open-Meteo.

## Addendum (2026-09-28): WebRTC was never blocked by the CSP

The statement in "How it works" §1 that WebRTC stays blocked by the CSP was
wrong. Chromium doesn't apply CSP to WebRTC. A live test on Windows (WebView2)
showed the problem: an artifact rendered with the offline CSP
(`connect-src 'none'`) and no grants opened an `RTCPeerConnection`, reached a
LAN STUN/TURN listener over UDP and TCP, and put a string it chose into the
TURN `USERNAME`. That's an exfiltration channel from any HTML artifact whose
scripts run.

Scope: this was reproduced in dev builds. Release builds weren't exposed only
because of a separate bug. There, Tauri serves the main page with the app CSP
(`script-src 'self'` plus hashes), and the artifact's `srcdoc` frame inherits
it, so no artifact script runs at all. Fixing that bug would have made this
hole live in release, so it had to be closed first.

Fixed in two layers:

1. **WebView level (the boundary).** The main window is now built in Rust
   (`main.rs` setup, `webview_args.rs`) with
   `--webrtc-ip-handling-policy=disable_non_proxied_udp` and a proxy that
   accepts nothing (`--proxy-server=http://127.0.0.1:9`).
   - The policy switch on its own still allowed TURN over TCP. The dead proxy
     closes that. (`--force-webrtc-ip-handling-policy` was ignored by WebView2.)
   - Loopback and Tauri's own schemes are unaffected.
   - Origins on the artifact remote allowlist go on `--proxy-bypass-list`, so
     their images, fonts and styles still load. That makes WebRTC to those
     hosts possible, but adds no new risk: an image URL to the same host can
     already carry data out.
   - The list is read at startup, so allowlist edits apply after a restart.
2. **Artifact document (defence in depth).** The first injected head script
   removes the WebRTC constructors (`webrtcBlock.ts`) before any model script
   runs. A removal inside the page's own realm is not a boundary by itself.

Verified live against the same listener: zero packets on UDP and TCP, with the
network layer alone and with both layers. An allowlisted origin's image still
loads, and the same image is refused when its origin isn't exempted.

**Not yet covered:** macOS (WKWebView) and Linux (WebKitGTK) don't take these
arguments, so there only the head-script layer applies. They need their own
live check and a platform-level fix.


## Addendum (2026-10-09): full web access

A page the reader gave full web access ([ADR 007](adr-007-artifact-rendering-security.md),
addendum of the same date) no longer has a frame without a network: its CSP allows
scripts, styles, images, fonts, media, frames and connections to any https/wss site. What
this ADR built still applies to its `fetch()`, which keeps going through the bridge:

- The grant is stored here, as a network grant of the page's principal with the value
  `full` (Rust `FULL_WEB_ACCESS`), next to the site grants and `*`. It implies the any-site
  grant, so `fetch()` no longer asks per site; every other check in `perform` (https,
  public addresses, pinned connections, no credentials, caps) is unchanged. A page can't
  declare `full` (or `*`) for itself: declared hosts are origins only.
- `get_artifact_network_state` reports `fullAccess`: the page's own grant (remembered or
  for this session) or the Settings switch, and never while `blockedReason` is set.
- Direct loads (a `<script src>`, an `<img>`, a WebSocket) don't pass through the bridge:
  they are not in the Activity log, have no rate cap, and are not checked by the fetch
  proxy. On Windows they pass through the guard proxy, which refuses non-public addresses
  and anything but port 443. Elsewhere they are not checked at all (see ADR 007's residual
  risks).
