# Chat stream completes with a blank assistant bubble

**Date:** 2026-06-25
**Scope:** `apps/desktop/src/chat/ChatView.tsx` (frontend streaming flow)
**Related backend:** `apps/desktop/src-tauri/src/stream_manager.rs`,
`crates/provider-core/src/adapters/{mod.rs,openai.rs}`
**Symptom owner:** consumer chat (any real provider with network latency)

---

## TL;DR

Sending a prompt returned a **"stream complete" status with a blank thread** —
no assistant bubble, no error. The backend was fine: it received the provider's
full reply and persisted every `ProviderEvent` to the SQLite event log. The bug
was entirely in `ChatView.handleSend`, which awaited `startChatStream(...)` as
if that promise marked stream completion. It does not — the Rust command spawns
the stream task and returns a handle **immediately**, so the `finally` block
tore down the active request *before any `contentDelta` arrived over the
network*, and every subsequent event was dropped by the callback guard.

## Symptom

- User types a prompt and sends.
- Status line reads **"Stream complete"**.
- The assistant thread shows **nothing** — no bubble, no error text.
- The turn is not committed (the conversation rail does not gain an assistant
  entry), but the user's message is.

## Root cause

`StreamManager::start_chat_stream` (`stream_manager.rs:170`→`214`) does:

```rust
tauri::async_runtime::spawn(async move {
    // …forward each ProviderEvent to the Tauri Channel + persist to event_log…
});
Ok(StreamHandle { request_id })   // returned immediately
```

The command returns a handle as soon as the stream task is spawned. It does
**not** await the stream. The Tauri `Channel<ProviderEvent>` continues to
deliver events asynchronously after `invoke` resolves.

`ChatView.handleSend` treated the invoke resolution as completion:

```ts
try {
  await startChatStream(request, cb);      // resolves IMMEDIATELY
  await waitForPendingRuntimeCalls(…);     // no pending → returns at once
  onStatus('Stream complete');
} catch (e) { … }
finally {
  const finalState = activeStreamRef.current;   // empty — no events yet
  if (content.trim() !== '' || finalState.error) { /* append turn */ }  // skipped
  activeRequestRef.current = null;               // ← kills the guard
  setActiveStream(null);
}
```

Timeline with a real provider (network RTT + time-to-first-token >> 0):

1. `await startChatStream` resolves instantly (spawn + return).
2. `finally` runs at once: `activeStreamRef.current` is still the *initial*
   empty stream state (no `contentDelta` has crossed the network), so
   `content === ""` and no error → the turn is **not appended**.
3. `finally` then nulls `activeRequestRef.current` and clears the live bubble.
4. The provider's `contentDelta` events arrive **after** step 3. The callback
   guard `if (!active || active.requestId !== request.requestId) return;`
   sees `activeRequestRef.current === null` and **drops every event**.

Net effect: "stream complete", blank thread. The mock stream appeared to work
because it fired events fast enough to mostly sneak through before the
teardown — the bug only became visible against a real, latent provider.

A secondary (related) issue compounded the diagnostic confusion: the empty
final state was read from `activeStreamRef`, which was synced from React state
via `useEffect` — i.e. only *after paint*. Even if teardown had waited, the
ref could lag the last delta. This is addressed in the same fix.

## Evidence

The `provider_event_log` table is the ground truth: `stream_manager` appends
**every** `ProviderEvent` to it inside `append_and_apply`, regardless of what
the frontend does. Copied the live DB aside and queried it with Node's
`node:sqlite`:

DB location: `%LOCALAPPDATA%\Conduit\Conduit\data\conduit.sqlite`
(resolved via `directories::ProjectDirs` → `data_local_dir()`)

For the last request (`34b4a9ed-bb54-4838-9ac0-c35d6e576726`, a "Test" prompt),
the log showed 23 rows including:

```
[0]  messageStart
[1]  contentBlockStart  block-0 text
[2]  contentDelta       ""             ← empty first delta
[4]  contentDelta       "Test"
[6]  contentDelta       " received"
[8]  contentDelta       "."
…
[18] contentDelta       "?"
[21] usage              inputTokens=24 outputTokens=11
[22] messageComplete    finishReason="stop"
```

So the backend received a complete, well-formed reply and emitted it over the
channel. The content ("Test received. How can I help?") never reached the UI.
This single query splits "backend sent nothing" from "frontend dropped it" in
under a minute — see **Recurrence diagnosis** below.

## Fix

`apps/desktop/src/chat/ChatView.tsx`:

1. **Await the terminal event, not the invoke.** `handleSend` wraps
   `startChatStream` in a `streamDone` promise that resolves only when the
   callback receives `messageComplete` or `error` (or on a pre-stream invoke
   rejection via `.catch`). The `finally`/teardown no longer runs before
   events arrive.
2. **Synchronous source of truth.** Replaced the `useEffect`-synced
   `activeStreamRef` with `streamStateRef`, updated synchronously inside the
   event callback. `activeStream` state mirrors it for rendering only. The
   `finally` block now reads the complete final state, not a render-lagged
   copy.
3. **Error surfacing.** Terminal `error` events set `terminalError`; the
   status line and the committed turn's `streamState.error` reflect it, so
   in-stream errors render instead of a silent "stream complete".
4. **`handleCancel`** simplified to clear via `streamStateRef`. The
   interrupted banner comes from the reloaded DB rows (the backend cancel
   path already marks the turn interrupted). The in-flight `streamDone` is
   left pending on cancel — harmless, since `handleCancel` already cleaned
   the UI and the next send overwrites `streamStateRef`.

`tsc -b` clean; all 105 desktop vitest tests pass. The fix is TS-only — no
Rust rebuild required, just a frontend reload (Vite HMR picks it up under
`tauri dev`).

## Recurrence diagnosis

If "stream complete, blank thread" returns, the fastest split is the event
log. Copy the live DB aside (it is WAL-modeled and locked while the app runs)
and read it with any SQLite client — Node has one built in:

```sh
# Copy aside (the live DB is WAL-modeled and locked while the app runs).
mkdir -p "$LOCALAPPDATA/Temp/cdb"
cp "$LOCALAPPDATA/Conduit/Conduit/data/conduit.sqlite"* "$LOCALAPPDATA/Temp/cdb/"

# Node has a SQLite reader built in (Node 22+). Use a Windows-style path
# inside the script — Node on Windows does not resolve POSIX /tmp paths.
node --experimental-sqlite -e '
  const {DatabaseSync} = require("node:sqlite");
  const tmp = process.env.LOCALAPPDATA.replace(/\\/g,"/") + "/Temp/cdb/conduit.sqlite";
  const db = new DatabaseSync(tmp);
  const r = db.prepare("SELECT request_id, COUNT(*) n, MAX(created_at) b FROM provider_event_log GROUP BY request_id ORDER BY b DESC LIMIT 5").all();
  console.log("recent requests:", r.map(x => ({ n: x.n, b: x.b })));
  const top = r[0];
  if (top) for (const row of db.prepare("SELECT sequence, event_kind, payload FROM provider_event_log WHERE request_id=? ORDER BY sequence").all(top.request_id))
    console.log(`[${row.sequence}] ${row.event_kind}  ${row.payload ? row.payload.slice(0,200) : ""}`);
'
```

- If the newest request has `contentDelta` rows with real text → **backend is
  healthy; the bug is frontend event handling** (re-examine the callback guard
  and teardown ordering).
- If the newest request has events but no `contentDelta` (only
  `messageStart`/`usage`/`messageComplete`) → empty provider response; the
  `wrap_sse_stream` empty-response guard should have emitted an `Error`
  (see `adapters/mod.rs`). Check whether the binary includes that guard.
- If there is **no** newest request row at all → the send never reached the
  backend (frontend threw before `invoke`, or the invoke rejected
  pre-stream). Check the browser console and the `warn!` lines in
  `stream_manager.rs` ("provider stream_chat failed before any output").

The backend `warn!`/`info!` lines (added in the same session) also print to
stderr — visible in the `tauri dev` terminal, not in a built app.

## Prevention

- **Treat Tauri `Channel`-streaming commands as fire-and-forget on the
  client.** The contract is: `invoke` returns a handle immediately; events
  arrive on the channel later. Frontends must drive "done" off the terminal
  *event*, never off the invoke resolution. This is now encoded in
  `handleSend`; future channel consumers (connector tool invocation,
  mock stream) should follow the same pattern. Worth an explicit note in
  `docs/adr/adr-008-tauri-capability-surface.md` if channel use grows.
- **The event log is the streaming source of truth.** It persists every
  event even when the frontend misbehaves, which makes it the cheapest
  frontend/backend splitter. Documented here so the next debugger reaches
  for it first.
- **Tests should cover a *latent* stream.** The existing tests passed
  throughout because the mock stream delivered events synchronously,
  hiding the teardown race. A test that injects a delayed `messageComplete`
  (events arrive after `startChatStream` resolves) would have caught this.
  Left as a follow-up.

## Files touched

- `apps/desktop/src/chat/ChatView.tsx` — the fix (await terminal event,
  `streamStateRef`, error surfacing, `handleCancel` simplification).

Related working-tree changes from the same session (diagnostics that made
the cause findable; not the root cause but worth keeping):

- `apps/desktop/src-tauri/src/stream_manager.rs` — `warn!`/`info!` for
  pre-stream and in-stream errors; surfaces failures in the process log.
- `crates/provider-core/src/adapters/mod.rs` — `wrap_sse_stream` emits a
  synthetic `ProviderEvent::Error` when the parser produces no substantive
  event, so an empty provider response is diagnosed instead of rendered as
  a blank "complete".
- `crates/provider-core/src/adapters/openai.rs` — surfaces in-band
  `{"error":{…}}` chunks as `ProviderEvent::Error` instead of dropping them.