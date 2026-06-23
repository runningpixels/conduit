# ADR 002: Artifact Payload Schema

## Status
Accepted (interactive-rendering + versioning provisions superseded — see below).

## Decision
Model artifacts as stable records with append-only versions, with MIME-aware payload handling.

## Context
Artifacts need to support markdown, plain text, code, and structured JSON in Phase 1, while leaving room for future bundles and interactive views.

## Options Considered
- Store artifact text directly in message rows.
- Store only opaque file paths.
- Store a stable artifact record plus version history and external payload references when needed.

## Consequences
- Version history stays inspectable and reversible.
- Large payloads can move to managed files without changing the core object model.
- UI rendering stays tied to content type instead of raw provider output.

## Superseded provisions
Two aspects of this ADR are overridden by Phase 5 (approved, user-directed):

1. **Append-only versioning is dropped.** Phase 5 collapses the version chain
   into a single current payload on the artifact row — saving overwrites in
   place; there is no `artifact_versions` table, no version picker, no restore,
   no history view. See the Phase 5 artifact-storage decision record.
2. **Interactive rendering (deferred here) is now defined.** Phase 5 adds an
   `html` artifact kind rendered inside a sandboxed iframe under a strict CSP,
   with no Tauri bridge and a user-managed passive-resource allowlist. See
   [ADR 007](./adr-007-artifact-rendering-security.md).

The stable-artifact-record, MIME-aware-payload, and external-file-reference
provisions stand.
