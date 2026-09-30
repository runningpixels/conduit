# ADR 012: Page bridge v2 and page storage

## Status
Accepted — 2026-09-29. Amends [ADR 007](adr-007-artifact-rendering-security.md)
and builds on [ADR 010](adr-010-artifact-network-access.md).

## Decision
A sandboxed HTML page (an artifact in a chat, or a saved app) may keep data
between launches through `window.conduit.storage`, a small key/value store that
Rust keeps in the database for that page. The frame gains no new power of its
own: the sandbox and CSP stay exactly as ADR 007 specifies, and every read and
write is a message that Rust validates and performs.

`window.conduit` is the one bridge object for page capabilities from here on.
Storage is its first namespace; later ones (model access, launch inputs) join it
without changing the envelope.

## Context
A page runs in `sandbox="allow-scripts"` with a null origin, so `localStorage`,
`indexedDB` and cookies throw. A budget tracker or a habit log loses everything
when it closes, which is the main thing that keeps a page from being a tool —
and, since Apps (saved pages) shipped, the main gap in them.

## How it works
1. **Declaring it.** A page asks for storage with
   `<meta name="conduit-capability" content="storage">` (an optional
   `— reason` after the name, like `conduit-network`). Without the tag the
   bridge is not injected and `window.conduit` is undefined. Saving a page as
   an app records `storage` in the app's manifest capabilities.
2. **The page side.** A Conduit-owned inline script, next to the existing
   fetch shim, defines `window.conduit = { version: 2, capabilities, storage }`
   before page scripts run. Each call posts
   `{ type: 'conduit:bridge/v2', id, method, params }` to the parent and awaits
   `{ type: 'conduit:bridge/v2', id, ok: true, result }` or
   `{ …, ok: false, error: { code, message } }`. Codes: `invalid`, `quota`,
   `unavailable`, `rate_limited`.
3. **The host side.** The renderer accepts only messages whose `event.source`
   is its own frame, routes them by method, and never trusts the page to name
   its principal: the principal (`artifact:<id>` or `app:<id>`) comes from the
   view that rendered the page.
4. **Rust.** One command per operation, keyed by principal:
   - `storage.get(key)` → the value or `undefined`;
   - `storage.set(key, value)` → stores JSON;
   - `storage.delete(key)`;
   - `storage.keys(prefix?)` → sorted keys.
5. **Limits**, enforced in Rust: key 1–256 characters; a value's JSON at most
   1 MB; at most 5 MB and 10,000 keys per principal; 600 writes per minute per
   principal. Writes past a limit fail with `quota` or `rate_limited`, and
   nothing is partly written.
6. **Where it lives.** Table `page_storage (principal, key, value_json,
   size_bytes, updated_at)`. Values are encrypted at rest like other content
   columns.
7. **Lifetime.** Storage belongs to its principal:
   - deleting an artifact (or its chat) deletes its storage;
   - saving a page as an app **copies** the page's storage to the app, so a
     tracker keeps its entries;
   - deleting an app deletes its storage;
   - updating an app from its source keeps the app's storage.

## Consequences
- **No consent prompt for storage.** It is local, per page, bounded by the
  quota, and reachable only by that page. A prompt would teach people to click
  through the prompts that matter (network, and later the model).
- **Visible, not silent.** An open app's status strip shows how much it stores,
  and clearing it is one action away.
- **The model is told.** The artifact instructions say how to declare and use
  storage, and that `localStorage` doesn't work in a page.
- **Not a boundary on its own.** `window.conduit` lives in the page's own realm,
  so the page can replace or wrap it; that only affects the page itself. The
  boundary is Rust: the principal comes from the host, and every limit is
  checked there.
