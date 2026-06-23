# Canonical Internal Schemas

These are the first stable internal models shared by the provider, persistence,
and desktop shell phases.

## Rust is the source of truth (C1)

The **executable source** for every type that crosses an IPC or persistence
boundary is Rust, in `crates/provider-core/src/schema.rs`. The TypeScript
bindings in `@conduit/config-schema` are **generated** from that source by
[ts-rs](https://github.com/Aleph-Alpha/ts-rs) — they are never hand-edited.

Regenerate the bindings from the workspace root:

```
cargo run --example export_ts -p provider-core
# or, from packages/config-schema:
npm run build
```

The generator writes one file per type into
`packages/config-schema/src/generated/`, re-exported by
`packages/config-schema/src/index.ts`.

### Staleness check

`npm run check` (in `packages/config-schema`) regenerates the bindings and fails
(`git diff --exit-code`) if the committed files differ from the Rust source.
CI (`.github/workflows/ci.yml`) runs this on every push and PR. **If you change
`schema.rs`, re-run the export and commit the generated files**, or CI will fail.

### Field-level accuracy

The generated TS reflects the *actual* wire format produced by serde — including
tagged-enum field casing. Tagged enums (`ProviderEvent` with `tag = "kind"`,
`ToolChoice` with `tag = "type"`) carry `#[serde(rename_all_fields =
"camelCase")]` so variant fields serialize as camelCase, matching the rest of
the schema. `Option<T>` fields are emitted as nullable/optional; `serde_json::Value`
fields are typed as `Record<string, unknown>` (or `unknown` for free-form results)
via `#[ts(type = "...")]` overrides.

## Type reference

The **authoritative field list** for each type is the Rust struct/enum in
`schema.rs` (and the generated TS that mirrors it). The notes below capture the
*design intent* per type — versioning, persistence, UI, and migration concerns —
which the type definitions alone do not convey.

### Message
- Versioning: append-only row identity; state changes are represented through parts and metadata.
- Persistence: SQLite row keyed by local ID.
- UI assumption: the shell renders normalized turns, not raw provider payloads.
- Migration concern: partial turns must survive crashes and upgrades.

### MessagePart
- Versioning: block order is stable per message.
- Persistence: separate row so streaming can append incrementally.
- UI assumption: text, tool, and artifact blocks render independently.
- Migration concern: block order must remain deterministic.

### ProviderRequest
- Versioning: request shape is semver'd in the shared schema package.
- Persistence: stored only as needed for recovery and debugging, with payload redaction.
- UI assumption: the request can be summarized without leaking secrets.
- Migration concern: request replays need a stable field mapping.

### ProviderEvent
- Required: `request_id`, `kind`, `index`.
- Versioning: event tags are additive; new events must not break older renderers.
- Persistence: append-only stream log for recovery (see Phase 3 persistence plan).
- UI assumption: events can arrive out of band but are rendered in index order.
- Migration concern: old fixtures must continue to replay.

### ToolDefinition
- Persistence: local cache keyed by connector or provider source.
- UI assumption: consent dialogs can describe the tool without parsing raw JSON.

### ToolCallRecord
- Persistence: immutable audit trail.
- UI assumption: tool calls can show pending/approved/completed states.

### Artifact
- Persistence: stable local record with version pointer.
- UI assumption: the artifact panel can preview the latest version.

### ArtifactVersion
- Persistence: append-only version table.
- UI assumption: older versions remain inspectable and restorable.

### Attachment
- Persistence: file-backed payload with SQLite metadata.
- UI assumption: attachments are referenced, not inlined.

### TenantConfig
- Persistence: cached locally for enrollment and refresh.
- UI assumption: configuration changes can re-theme the shell at runtime.

### ConnectorDefinition
- Persistence: tenant-authored or tenant-imported definition record.
- UI assumption: the settings shell can list connectors by support state.

### ConnectorVersion
- Persistence: immutable version record.
- UI assumption: version pins and rollout state can be displayed separately.

### ConnectorGrant
- Persistence: local cache of tenant authorization state.
- UI assumption: grant state can explain why a connector is unavailable.

### LicenseClaims
- Persistence: signed token material plus verification metadata.
- UI assumption: license state should explain next steps without exposing keys.

### AppSettings / SettingsPatch / Theme
- IPC schema for the desktop shell's persisted settings. Defaults and validation
  live in `apps/desktop/src-tauri/src/state.rs`; the data shape lives in
  `schema.rs` so the renderer's TS is generated from the same source.
- `Theme` is an enum (`system | dark | light`); serde rejects invalid values at
  deserialization, so `update_settings` applies it without re-validating.

### ModelInfo / CredentialRequest / CredentialSummary
- IPC schema for `list_models` and the keychain credential commands. The
  keychain is the sole source of truth for stored secrets (M2); `CredentialSummary`
  carries only a `keychain://` reference, never the secret itself.