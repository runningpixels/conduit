# Plan: artifacts that can reach the internet, with the user's say-so

## Status

**Implemented — 2026-09-26** (branch `feat/artifact-network-access`), all of
Phases 0–3 in one change. Decision record:
[ADR-010](../adr/adr-010-artifact-network-access.md), amending
[ADR-007](../adr/adr-007-artifact-rendering-security.md). The open questions
were decided as recommended — see [Decisions](#decisions).

## Why

HTML artifacts cannot reach the network at all: the iframe's CSP pins
`connect-src 'none'` and the system prompt tells the model so
(`chat/artifactPrompt.ts`). That was the right default, and it stays the
default. But the live test batteries (September 2026) keep hitting its
ceiling:

- "Make a weather dashboard for Paris" produced a page with an *embedded
  sample forecast* and a disclaimer, because live data was impossible.
- "Make a D3.js bar chart" spent 8½ minutes reasoning its way around the
  missing CDN and network.
- Dashboards, trackers and tools people ask for are routinely "almost real":
  they would work if they could call a public API.

Users want pages that do something live — a weather widget, a currency
converter, a status board for their own service. The request is to allow it
**explicitly**, per artifact, with a modal that shows **where the artifact
will connect**.

---

## What others do (research, September 2026)

Full notes and sources are in the research summary below; the short version:

| Product | Network from generated code | Scope | Consent | Mediated? |
|---|---|---|---|---|
| Claude.ai Artifacts | No raw fetch | — | Per-artifact prompt + settings toggle, for **AI calls only** | Yes — `window.claude.complete()` bridge; no key reaches the artifact |
| ChatGPT Canvas | Conditional (admin toggle, off in Enterprise) | Workspace | Prompt when a preview needs resources *(secondary sources only)* | Unverified |
| Gemini Canvas | Unverified | — | None found | — |
| v0 (Vercel) | Yes — real VM per chat | Team network policy, default allow-all | None | No |
| Bolt.new | Yes — full browser fetch | Browser CORS | None | No |
| Lovable | Yes — client code | Secrets split: server-only vs `VITE_` public | None | No |
| Jan | **No** — CSP blocks it | Binary "render HTML artifacts" toggle | Settings toggle | No |
| Open WebUI | Admin-configured `IFRAME_CSP` | Instance | None | No |
| Figma plugins | Yes — declared | `networkAccess.allowedDomains` + `reasoning` | Static disclosure on the listing | No |
| Chrome extensions | Yes — declared / optional | Per-site; runtime `permissions.request()` tied to a user gesture | Native Allow/Deny | No |
| Deno | Yes — flag-gated | `--allow-net=host` | Per-host prompt: once / always | No |
| Little Snitch | (firewall) | Per process + host | Alert with a remember **duration** | — |

**Nobody offers per-host, user-granted network access for AI-generated
artifacts.** The AI products either forbid it (Claude, Jan), leave it to an
admin (Open WebUI, ChatGPT Enterprise), or allow everything with no consent
(v0, Bolt, Lovable). The good consent patterns live outside AI: Chrome's
gesture-tied runtime request, Deno's per-host prompt, Little Snitch's "for how
long", Figma's declared domains with a stated reason. This is room to do
something better than the field, not catch-up.

Lessons we design around:

1. **Mediate rather than open the socket.** Claude's `window.claude.complete()`
   gives artifacts a network-shaped capability without a network primitive.
   A host-side proxy lets us enforce, log and explain every request.
2. **An allowed host is not a safe host.** A disclosed Claude.ai exploit
   (Oasis Security, 2026-03-18) exfiltrated chat data to `api.anthropic.com` —
   an *allowed* domain — using an attacker's account there. Showing *what is
   sent*, not just *where*, matters.
3. **`connect-src` is one channel of many.** Images, fonts, forms, navigation
   and WebRTC each leak on their own; WebRTC bypasses `connect-src` entirely
   and was used against Claude artifacts. Opening only `connect-src` and
   calling it "controlled" would be false.
4. **Sandboxed frames send `Origin: null`.** Most third-party APIs reject it.
   Even a correct CSP allowlist would leave many real APIs unreachable; a
   host-side request does not have this problem.
5. **Never add `allow-same-origin`** to the frame; the artifact could lift its
   own sandbox. (Unchanged from ADR-007.)
6. **Re-consent after the code changes is unsolved in the field.** Model-written
   code changes under the user — a bait-and-switch nobody guards against.

*Could not verify:* Gemini Canvas's network model; ChatGPT Canvas's exact CSP
and prompt copy; Replit Agent's sandboxing. None change the design.

---

## Where Conduit is today

- **Frame:** `sandbox="allow-scripts"` only, `srcdoc` (null origin),
  `referrerpolicy="no-referrer"`, no Tauri bridge
  (`artifacts/HtmlArtifactRenderer.tsx`).
- **CSP** (`artifacts/buildArtifactCsp.ts`): `default-src 'none'`,
  `script-src 'unsafe-inline'`, `connect-src 'none'`, `frame-src 'none'`,
  `form-action 'none'`, `navigate-to 'none'`; `img-src`/`font-src`/`style-src`
  allow `data: blob:` plus the global **passive** allowlist.
- **`artifactRemoteAllowlist`** (`AppSettings`): global, origins only, passive
  resources only; edited in `ArtifactSecuritySection.tsx`, validated in Rust
  (`state.rs`, `validation::validate_artifact_origin`) and the renderer.
- **Conduit-owned frame scripts** talk to the host by `postMessage`, accepted
  only from the frame's own `contentWindow`: the link interceptor
  (`conduit:artifact-external-link`), the shortcut forwarder
  (`conduit:artifact-shortcut`), the runtime-error reporter
  (`conduit:artifact-runtime-error`). A fetch bridge is the fourth of these.
- **Per-artifact grant precedent:** external-link opening is confirmed once per
  `artifactId + contentFingerprint` (`artifacts/externalUrl.ts`), so an edit
  resets it.
- **Consent dialogs to reuse:** `WebSearchConsentDialog`,
  `ImageGenerationConsentDialog` (one-time, global flags in `AppSettings`).
- **Rust HTTP:** `web_fetch` (`agent_tools.rs`) is a model tool — GET-only, 15 s
  timeout, 50 kB cap — not reachable from the frame.
- **Model guidance:** `artifactPrompt.ts` says "no network access (no
  fetch/XHR) … embed any needed information directly in the artifact".
- **Claims that would change:** README ("Artifacts that can't phone home …
  `connect-src 'none'`"), `conduit-website-internal/PLAN.md` rows on artifacts
  and the data-flow table.
- **Artifacts:** single payload, `content_hash` (sha256) changes on every edit;
  export writes the raw HTML, which then runs with none of this sandboxing.

---

## Design

### The one decision everything follows from: mediated fetch, `connect-src` stays `'none'`

The artifact never gets a socket. A Conduit-owned script in the frame replaces
`window.fetch`; each call becomes a `postMessage` to the host; the host checks
the grant and asks Rust to make the request; the response is posted back and
handed to the page as an ordinary `Response`.

```
 artifact code ──fetch(url)──▶ Conduit shim (in frame)
                                   │ postMessage {conduit:artifact-fetch}
                                   ▼
                        DocumentPanel (host window)
                          • source === this frame?
                          • grant for (artifact, host)?  ── no ──▶ queue + banner → consent modal
                                   │ yes
                                   ▼
                   invoke('artifact_fetch')  ── Rust ──▶ network
                          • https / public address only        (no cookies,
                          • method, size, time, rate caps        no credentials)
                          • redirect re-checked per hop
                                   │
                  log entry ◀──────┤
                                   ▼
                   postMessage response ─▶ shim ─▶ Response to artifact code
```

Why this and not "add granted hosts to `connect-src`":

| | Mediated fetch (proposed) | Widen `connect-src` |
|---|---|---|
| ADR-007's exfiltration guard | **Kept** — the frame still has no network | Weakened |
| APIs that reject `Origin: null` | Work — Rust sends a normal request | Fail |
| "Where does it connect?" | Every request seen, logged, attributable | Invisible to the app |
| Enforcement after grant | Per request (host, method, size, rate) | Browser-level host match only |
| WebRTC / images / forms | Stay blocked as today | Must each be reasoned about |
| Code the model writes | Plain `fetch()` — shim is transparent | Plain `fetch()` |
| Cost | Shim + one Rust command + message plumbing | One CSP line |

The CSP, sandbox flags and passive allowlist are **unchanged**. The only new
egress is a Rust command that enforces the user's grants.

### Declared hosts: "show where it will connect"

Before anything runs, the panel can already say where the page intends to go:

1. **Declaration (preferred).** The model is told to declare hosts in the page:
   `<meta name="conduit-network" content="api.open-meteo.com — live forecast">`.
   Like Figma's `allowedDomains` + `reasoning`, it carries the *why*.
2. **Static scan (fallback).** Absolute `http(s)` URLs found in the source are
   listed too, marked "found in the code", so an undeclared host is still
   visible.

The panel header gets a **network chip**: `🌐 2 sites` — click for the list,
each host with its declared reason, its grant state, and its requests so far.
A declared host the page never contacts costs nothing; an undeclared host it
does contact is flagged in the modal ("not declared by this page").

### Consent: banner first, modal on request

The page auto-opens as soon as the turn ends, so a modal that fires on the
page's first `fetch` would appear unasked. Following Chrome's gesture rule:

1. The first request to an ungranted host is **held**, and a banner appears
   across the preview:
   **This page wants to connect to api.open-meteo.com.** `[Review]` `[Not now]`
2. `[Review]` opens the modal. `[Not now]` fails held requests with a normal
   network error — the page's own error handling runs, as it would offline.

Modal (one per host; several hosts in one request burst are listed together):

```
┌───────────────────────────────────────────────────────────────┐
│  Let "Paris Weather" connect to the internet?                 │
│                                                               │
│  🌐 api.open-meteo.com                                        │
│     "live forecast" — declared by this page                   │
│                                                               │
│  First request                                                │
│     GET /v1/forecast?latitude=48.85&longitude=2.35&hourly=…   │
│     Sends no data beyond the address above.                   │
│                                                               │
│  Conduit makes these requests for the page. It sends no       │
│  cookies or saved passwords, and you can see every request    │
│  in the page's network list.                                  │
│                                                               │
│      [ Don't allow ]   [ Allow once ]   [ Allow for this page ] │
└───────────────────────────────────────────────────────────────┘
```

- **What is sent** is shown, not just where: method, path and query, and for a
  body its size and a short preview ("Sends 142 bytes: `{"city":"Paris"…`").
  This answers lesson 2 — the user sees data leaving, not a hostname.
- Undeclared host → an extra line: *Not declared by this page.*
- **Allow once** covers requests until the page reloads; **Allow for this
  page** persists (see grants). **Don't allow** remembers the refusal for the
  session so the page cannot re-prompt in a loop.
- Non-`GET` requests use "send data to" wording, and a body preview is always
  shown.

### Grants

New table `artifact_network_grants(artifact_id, host, scope, created_at,
content_hash, last_used_at)`; `scope` is `page` (persisted) — "once" grants live
in memory only.

- **Keyed by artifact and host** (host = scheme + hostname + port). Not global:
  allowing `api.github.com` for one page must not open it to every page a model
  writes later.
- **Edits** — see open question 1. Recommended: a grant survives edits for the
  *same* host; a host the new version reaches for the first time prompts as
  usual; the network list marks requests made "since the page last changed".
- **Managed in Settings → Artifact security:** every granted page and host,
  with last use and a Remove button; plus **Clear all**. Deleting the artifact
  or its conversation deletes its grants.

### Enforcement in Rust — `artifact_fetch`

A new command, not an extension of `web_fetch` (different caller, different
caps, different trust):

- **Grant check first**, against the DB or the session's once/deny sets.
- **Schemes:** `https` only by default; plain `http` refused with a clear error.
- **No private networks (SSRF).** Resolve the host and refuse loopback,
  private, link-local, CGNAT and unique-local addresses; connect to the
  resolved address so DNS rebinding cannot swap it. `localhost` and LAN
  targets are refused even if granted — an artifact is not a route into the
  user's network. (A later opt-in for `localhost` development is possible.)
- **Redirects** are followed manually; each hop must be to the same granted
  host, or the request fails.
- **Request:** methods `GET HEAD POST PUT PATCH DELETE`; no cookies, no
  credential store, no proxy-auth; headers filtered (no `Cookie`,
  `Authorization` unless a later secrets feature adds one, no hop-by-hop);
  `User-Agent: Conduit-Artifact/<version>`.
- **Caps:** 20 s timeout; 5 MB response; 1 MB request body; 60 requests a
  minute per artifact; 4 in flight. Every cap fails as a normal network error
  the page can handle, and shows in the network list with the reason.
- **Response to the frame:** status, filtered headers (no `Set-Cookie`), body
  as an `ArrayBuffer` so JSON, text, images (`blob:` URLs are already allowed)
  and binary all work.
- **Local-only mode** refuses all artifact requests with an explanation;
  local-only is a promise that nothing leaves the machine unasked.
- **Kill switch:** Settings → Artifact security → *Let pages ask to connect to
  the internet* (default **on**, asks per host). Off means requests fail
  without a banner.

### The shim (Conduit-owned, injected like the link interceptor)

- Defines `window.fetch` over `postMessage`; supports `Request`/`Headers`/
  string/`URLSearchParams`/`FormData`(as multipart)/`Blob`/`ArrayBuffer`
  bodies; `AbortSignal` cancels the host request.
- Leaves `XMLHttpRequest`, `WebSocket`, `EventSource` and WebRTC **blocked** (by
  the unchanged CSP). The model is told to use `fetch`. An XHR shim can follow
  if models keep reaching for it.
- Runs in the finished preview only. The live preview while a document is
  still being written gets no network (requests fail immediately, no banner).
- Messages are accepted only from the frame's own `contentWindow`, as today.
  A hostile page can post anything — the gate is the grant plus Rust's checks,
  never the message.

### Model guidance

`artifactPrompt.ts` changes from "no network access" to (only when the kill
switch is on):

> HTML artifacts can request data with `fetch()` to public HTTPS APIs. The
> user is asked before any site is contacted, so declare each host in
> `<meta name="conduit-network" content="host — why">`, and handle a refused or
> failed request by showing a message or sample data. Do not put API keys in
> the page. XMLHttpRequest, WebSocket and remote scripts are unavailable.

Prefer APIs that need no key (Open-Meteo, public GitHub endpoints, etc.).
API keys are out of scope for v1 (see Later).

### Exports

An exported HTML file runs in a normal browser, without the shim: `fetch` is
the browser's own and CORS applies. The shim installs only inside Conduit, so
exports behave like any web page. The export dialog notes that the page may
contact the declared hosts when opened.

---

## Phases

### Phase 0 — decision record (½ day)

- ADR-010 *Artifact network access through a host-mediated fetch*, amending
  ADR-007: `connect-src` stays `'none'`; the only new egress is
  `artifact_fetch`; its checks are listed as invariants.
- Resolve the open questions below.

### Phase 1 — mediated GET, consent, grants (core)

- Shim (`artifacts/networkBridge.ts`): `fetch` → `conduit:artifact-fetch`;
  response plumbing; abort.
- Host: held-request queue per frame, banner, consent modal (reusing the
  consent-dialog shape), session once/deny sets.
- Rust: `artifact_fetch` with grant check, https-only, SSRF refusal with
  pinned resolution, manual redirects, caps, filtered headers; grants table +
  migration; delete-with-artifact.
- **GET/HEAD only** in this phase.
- Tests: shim unit tests; Rust tests for every refusal (private IPs incl. IPv6
  and rebinding, redirect off-host, caps, http); structure tests that the CSP
  string is **byte-identical** to today's.
- Done when: a generated Open-Meteo weather page shows the banner, the user
  allows the host, and the page renders live data; refusing leaves the page's
  fallback working.

### Phase 2 — where it connects, and sending data

- `conduit-network` declaration + static scan; network chip and per-page
  request list (method, URL, status, size, time, "since last change").
- Non-GET methods with the body preview in the modal.
- Settings: grant management, kill switch, Clear all.
- Model guidance change; live battery prompts that need live data (weather,
  currency, GitHub stars, public status page).

### Phase 3 — hardening and claims

- Behavioral isolation tests in a real WebView (CDP harness): the frame still
  cannot `fetch` directly, open WebSockets, start WebRTC, submit forms or load
  remote images outside the passive allowlist — closes ADR-007's standing
  "Playwright isolation" gap.
- Red-team prompts: a document with injected instructions to send chat content
  to a host; confirm the modal shows the payload and nothing leaves unasked.
- Update README, `conduit-website-internal/PLAN.md` claims and the data-flow
  table; changelog.

### Later (not in this plan)

- **Secrets per host** (Lovable/Val Town pattern): the user stores a key in the
  credential store for `api.example.com`; Rust adds the header; the page never
  sees the key.
- **Trusted script CDNs** (cdnjs/jsDelivr) — a `script-src` change with its own
  risks; separate plan.
- XHR / EventSource shims; a `localhost` opt-in for developers.
- A dedicated artifact origin (ADR-007's named upgrade).

---

## Decisions

Taken 2026-09-26, as recommended when this plan was proposed:

1. **Grants survive edits** for sites already allowed; a new site asks; the
   request log marks requests made since the last change.
2. **On by default**, asking per page and site, with a Settings switch
   ("Pages can connect to the internet") that refuses everything.
3. **Non-GET is in**, with the body preview in the dialog (shipped together
   rather than as a later phase).
4. **Local-only mode refuses all artifact requests** — nothing leaves.
5. **https only**; no plain http, localhost or private networks.

## Risks

- **Consent fatigue.** Mitigated by banner-then-modal, per-page grants and the
  declaration list; measure prompts per session in the battery.
- **A granted multi-tenant host as a drop point** (lesson 2). Mitigated by
  showing what is sent and the request list; not eliminated — the ADR says so.
- **Model code that uses XHR/WebSocket** fails quietly. Mitigated by guidance
  and the runtime-error notice; an XHR shim is the fallback.
- **Claims drift.** README and site copy say artifacts cannot phone home;
  Phase 3 must land in the same release as Phase 1–2.
