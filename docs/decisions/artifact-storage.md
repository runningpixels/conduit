# Decision: Artifact Storage and Export (single-payload model)

## Status
Accepted. Overrides the append-only versioning provision of
[ADR 002](../adr/adr-002-artifact-schema.md) (approved, user-directed).

## Decision
An artifact holds **one current payload**. Saving overwrites the payload in
place — there is no `artifact_versions` table, no version picker, no restore,
and no history view. Payloads are stored hybrid inline/blob, encrypted at rest,
and exported with a curated metadata sidecar.

## Single-payload model
The `artifacts` row carries the payload columns directly:
`mime_type`, `content_text`, `content_json`, `content_path`, `content_hash`,
`size_bytes`, `enc_key_version`, `updated_at`. The old `current_version_id`
pointer and `artifact_versions` table were dropped by migration
`0005_artifacts_single_payload.sql`. `set_content` overwrites the row; if the
previous payload was a different on-disk blob, that blob is removed after the
row is updated. This is a destructive schema change applied once on upgrade;
pre-consumer-MVP dev stores that lost a version chain are an accepted cost.

## Hybrid inline/blob storage
- **Inline text** → encrypted `content_text` (AES-256-GCM when encryption is on;
  plaintext passthrough when off). `get` decrypts; `list` omits it.
- **Inline JSON** → serialized and encrypted into `content_json`; `get`
  decrypts and re-parses.
- **File payloads** → written as encrypted blobs at
  `artifacts/<artifact_id>/<filename>` (no version segment in the path) via an
  atomic temp+rename. `content_hash` is the sha256 over the **plaintext** (so
  `check_file_state` can detect tampering by decrypting the on-disk blob and
  re-hashing), with `size_bytes` (plaintext length) and `enc_key_version`
  stamped on the row.

The file-state machine (`check_artifact_file_state`) is:
`noFileContent` (inline payload) · `ok` (on-disk blob decrypts and hashes to
`content_hash`) · `modified` (blob exists but hash differs) · `missing` (blob
absent or row absent).

## Export (`export_artifact`)
Writes the current payload to the app-local `exports` directory
(`<app_data>/exports`), returning `{ exportedTo, bytesWritten }`. The filename
is the artifact title with a kind-appropriate extension, or the **original
filename** for File-content artifacts; collisions are de-duplicated with
`-2`, `-3`, …. Inline JSON is serialized; File-content is read from disk and
decrypted so the exported file is plaintext.

Extension matrix:
- markdown → `.md` (mimeType `text/markdown` overrides kind)
- text → `.txt`
- json → `.json` (mimeType `application/json` overrides kind)
- html → `.html` (mimeType `text/html` overrides kind)
- code → `text/x-<lang>` mapped to a language extension (`.rs`, `.py`, `.ts`,
  …), falling back to `.txt` for inline code with no original filename.

### Metadata sidecar
When `includeMetadata` is set, a `<payload>.conduit.json` sidecar is written
next to the payload. It includes:
`artifactId, title, kind, mimeType, contentHash, sizeBytes, createdAt,
updatedAt, sourceMessageId`.

It **excludes** `cloudShareId` (cloud is a non-goal), `encKeyVersion` (internal
encryption metadata), and freeform `metadata` (may carry sensitive/unkind
fields) — a future flag could opt the latter in.

## Chat → artifact linkage
The lighter path (no event-log/fold change): `source_message_id` on the artifact
row links it back to the assistant message. The in-chat chip is derived by
filtering the conversation's artifacts where `sourceMessageId === message.id`.
No `ArtifactReference` part is written to the DB.

## Non-goals honored
- No cloud sync/share (exports are local files; `cloudShareId` is never
  populated this phase).
- No version history or restore (single payload; ADR-002 versioning superseded).
- No executing model-generated code in the main app context — interactive HTML
  runs only in the sandboxed iframe (see
  [ADR 007](../adr/adr-007-artifact-rendering-security.md)).
- Export destination is app-local; a future Tauri dialog plugin can let the user
  pick a folder (tracked, not wired this phase).

## Related
- [ADR 002](../adr/adr-002-artifact-schema.md) — artifact schema (versioning
  provision superseded by this decision).
- [ADR 007](../adr/adr-007-artifact-rendering-security.md) — interactive
  artifact rendering security.