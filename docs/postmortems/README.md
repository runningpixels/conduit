# Postmortems & Bug-Fix History

Dated, evidence-backed write-ups of non-obvious bugs — what the symptom
looked like, the root cause, the fix, and how to diagnose a recurrence fast.
The goal is institutional memory: when a similar symptom shows up again, this
is the first place to look before re-deriving the cause from scratch.

## Convention

One file per incident, named `YYYY-MM-DD-short-slug.md`. Structure:

- **Date / Scope / Affected files**
- **Symptom** — what the user observed
- **Root cause** — the actual mechanism, with `file:line` references
- **Evidence** — how the cause was confirmed (logs, queries, repro)
- **Fix** — what changed and why
- **Recurrence diagnosis** — the fastest path to split the cause next time
- **Prevention** — guard, test, or invariant that would have caught it

Add a one-line entry to the index below when you add a file. Keep entries
honest about uncertainty — mark anything inferred rather than confirmed.

## Index

- [2026-06-25 — Chat stream completes with a blank assistant bubble](2026-06-25-chat-stream-completes-blank.md) — frontend awaited the invoke resolution as stream completion, but the command returns immediately after spawning the stream task; all provider events were dropped after early teardown.
- [2026-06-25 — Settings/credential actions silently swallowed errors](2026-06-25-settings-actions-swallowed-errors.md) — onboarding + settings actions called `await invoke(...)` under `void` with no catch, so Tauri rejections vanished and the buttons appeared to do nothing.