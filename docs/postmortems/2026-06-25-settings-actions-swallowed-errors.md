# Settings & onboarding actions silently swallowed errors

**Date:** 2026-06-25
**Scope:** `apps/desktop/src/workspace/SettingsPanel.tsx`,
`apps/desktop/src/workspace/settings/ProviderPicker.tsx`,
`apps/desktop/src/onboarding/Onboarding.tsx`, `apps/desktop/src/App.tsx`

---

## TL;DR

The onboarding/provider-setup actions ("Save provider key", "Load models",
"Test connection", "Persist settings") called `await invoke(...)` under `void`
with **no `try`/`catch`**. Tauri rejects failed invokes with the serialized Rust
error, and an unhandled rejection on a `void`-discarded promise is invisible —
no console surface the user watches, no status line update. The buttons
appeared to do nothing on failure. Worse, there was **no status region
rendered at all** in onboarding, so even the success messages the handlers
*did* emit (`onStatus('Settings persisted')`) never reached the screen. This
is why "settings didn't seem to persist" until the surrounding error handling
was added.

## Symptom

- Click "Test connection" with a bad key → button briefly flickers, nothing
  happens. No error message anywhere.
- Click "Persist settings" → no confirmation, no error. On failure the
  settings silently don't save.
- During onboarding, no status text is shown at all, so every action's
  outcome is invisible.

## Root cause

Two compounding problems:

1. **Unhandled rejections.** Handlers were shaped like:
   ```ts
   async function handleValidateProvider() {
     await validateProviderCredentials(settings.activeProvider);  // rejects → unhandled
     onStatus('Provider credentials validated');
   }
   ```
   Called via `void handleValidateProvider()` from `onClick`. A rejection
   propagates as an unhandled promise rejection; the success `onStatus` line
   is skipped (good) but nothing replaces it (bad). The same shape existed in
   `handlePersistSettings` (`SettingsPanel.tsx`).

2. **No status surface.** `App.tsx` maintained a `status` string but onboarding
   rendered no element for it, and the workspace status bar was only added
   conditionally. So `onStatus(...)` calls were writing to a string the user
   never saw. Onboarding also booted with a stale `setStatus('Rust trust
   boundary online')` that showed before the user had taken any action.

## Fix

- **Wrap every action handler in `try`/`catch`** and route the failure into
  `onStatus` with a readable message. `describeInvokeError`-style fallbacks
  (string / `.message` / `.error` / `String(...)`) handle Tauri's serialized
  rejections, which are not `Error` instances so `error instanceof Error` is
  false and a naive guard swallows the real reason.
- **Add a `busy` disable** on the three `ProviderPicker` action buttons while a
  request is in flight, so rapid clicks aren't lost and there is affordance
  that work is happening.
- **Render the status region.** `App.tsx` now renders a `role="status"` /
  `aria-live="polite"` bar in the workspace, and `Onboarding.tsx` accepts and
  renders `status` so success/error text from every onboarding action is
  visible. Boot starts with a clean `status` while the onboarding screen is up.

This unblocked diagnosing the streaming bug: once "Save provider key" /
"Test connection" reported real errors instead of going silent, the provider
could be configured correctly and the next symptom (blank "stream complete")
became reproducible and was traced via the event log — see
[2026-06-25 — chat stream completes blank](2026-06-25-chat-stream-completes-blank.md).

## Recurrence diagnosis

If a settings/onboarding button "does nothing":

1. Open DevTools console — an unhandled rejection here means a handler lost
   its `try`/`catch` (or a new one was added without one).
2. Check that the `onStatus(...)` text has somewhere to render in the current
   screen (workspace bar, onboarding status block). A handler that reports
   into a void is invisible even when it works.
3. If the action reports a Tauri error string, decode it the same way
   `describeInvokeError` does — do not assume `error instanceof Error`.

## Prevention

- **Every `invoke`-backed UI action belongs in a `try`/`catch`** that writes a
  human-readable failure to a status surface the user can actually see. Treat
   unhandled rejections in `void`-called async handlers as bugs.
- **Status text needs a home.** Any `onStatus(message)` call is dead unless
   some rendered element consumes `status` on that screen.
- **Decode Tauri rejections explicitly.** `Result<T, String>` rejections
   serialize to a string or object, not an `Error` — a single shared
   `describeInvokeError` helper covers the shapes. (The chat path has its own
   copy in `ChatView.tsx`; a shared util is a future cleanup.)

## Files touched

- `apps/desktop/src/workspace/SettingsPanel.tsx` — `handlePersistSettings`
  wrapped; failure reported.
- `apps/desktop/src/workspace/settings/ProviderPicker.tsx` — all three action
  handlers wrapped in `try`/`catch`/`finally`; `busy` disable added.
- `apps/desktop/src/onboarding/Onboarding.tsx` — accepts `status`, renders a
  status block.
- `apps/desktop/src/App.tsx` — renders a workspace status bar; boots with a
  clean status during onboarding.