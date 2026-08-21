# Conduit — Project Overview

How this project is structured and how it works. Read alongside
[`architecture/foundation-contracts.md`](./architecture/foundation-contracts.md)
(the trust boundary) and the ADRs in [`adr/`](./adr/).

## What it is

**Conduit** is a desktop AI chat application — a local-first, multi-provider
chat shell built as a Tauri 2 app. The Rust backend owns secrets, persistence,
and the trusted provider abstraction; a React/TypeScript renderer presents state
only and never touches credentials or the network directly.

Everything described below is implemented and covered by tests. There is no
cloud component in this repository.

## Repo topology

A polyglot monorepo: a Rust workspace (`Cargo.toml`) plus a pnpm workspace
(`pnpm-workspace.yaml`) at the same root.

```text
apps/
  desktop/                 # the Tauri app (React + Vite renderer, Rust src-tauri)
    src/                   # TS/React frontend
    src-tauri/src/         # Rust desktop backend (commands, state, streaming, db)
crates/
  provider-core/           # provider-agnostic LLM abstraction + adapters
  mcp-runtime/             # MCP transport + protocol core
packages/
  config-schema/           # generated TS mirror of the Rust schema
  ui/                      # design tokens, primitives, bundled fonts
docs/                      # this folder
```

- Root `package.json` (`name: conduit`) delegates to `apps/desktop`
  (`dev`, `build`, `check`).
- TS path aliases: `@conduit/config-schema`, `@conduit/ui`.

## The two halves

### 1. `provider-core` — the trust boundary (Rust)

The provider-agnostic core. Everything LLM-shaped flows through here.

- **`schema.rs`** — the canonical message/content/event types (`Message`,
  `MessagePart`, `ProviderRequest`, `ProviderEvent`, `ProviderUsage`,
  `ProviderError`, `ToolDefinition`, …). This is the single source of truth for
  the on-wire shape; `packages/config-schema` is generated from it via ts-rs and
  CI fails if the two drift.
- **`adapter.rs`** — the `ProviderAdapter` trait (`validate_credentials`,
  `list_models`, `stream_chat`), the `StreamParser` trait for per-provider SSE
  parsing, and `registry()` / `get_adapter(id)`.
- **`adapters/`** — eleven registered adapters: `anthropic`, `openai`, `gemini`,
  `openrouter`, `opencode_zen`, `groq`, `deepseek`, `mistral`, `lmstudio`,
  `openai_compat` (any OpenAI-compatible base URL), and `ollama` (local, no
  key). Several are built on a shared `openai_preset` factory.
  `adapters/mod.rs` holds `wrap_sse_stream`, which parses raw SSE `data:` lines
  through a `StreamParser`, emits a leading `MessageStart` and trailing
  `MessageComplete`, and surfaces errors as `ProviderEvent::Error`.
- **`transport.rs`** — HTTP helpers on `reqwest`/rustls, cancellable via
  `CancellationToken`.
- **`normalize.rs`** — `validate(ProviderRequest) -> NormalizedRequest`, the
  guard at the trust boundary.
- **`catalog.rs`**, **`error.rs`**, **`fixtures/`** — model catalog, error
  construction, and recorded SSE fixtures for replay tests.

### 2. `apps/desktop` — the Tauri shell

**Renderer (`src/`)** — React + Vite, presents state only:

- `App.tsx` — the workspace shell: titlebar, collapsible icon rail, chat thread,
  composer, and the document panel.
- `chat/` — `ChatView` drives a conversation; `streamState.ts` is a pure reducer
  folding `ProviderEvent`s into `AssistantStreamState`. `AssistantMessage`,
  `ContentBlock`, `ReasoningBlock`, `ToolCallBlock`, `UsageSummary` render it.
- `artifacts/` — the safe renderers (text/code/JSON/Markdown, React-escaped) and
  `HtmlArtifactRenderer` (sandboxed iframe + strict CSP).
- `ipc/contracts.ts` + `ipc/client.ts` — typed wrappers over Tauri `invoke` and
  `Channel`. A per-request `Channel<ProviderEvent>` is the streaming primitive —
  deliberately not a global bus.

**Backend (`src-tauri/src/`)** — the privileged Rust side:

- `main.rs` / `lib.rs` — a lib+bin split so integration tests can reach the
  internals. Builds the Tauri app, registers `AppState`, wires the commands.
- `state.rs` — `AppState`: settings (persisted to `settings.json`), the SQLite
  pool, the encryption handle, and the connector runtime manager.
- `paths.rs` — resolves the per-user data dir via `directories::ProjectDirs` and
  creates `settings.json`, `conduit.sqlite`, and the `attachments/ artifacts/
  logs/ diagnostics/ updates/ streams/ connectors/ exports/` folders.
- `credentials.rs` — `CredentialStore` over the OS keychain, with a file-backed
  fallback for environments without one (see
  [`adr/adr-009-file-backed-credential-store.md`](./adr/adr-009-file-backed-credential-store.md)).
  Settings hold only a `keychain://conduit/<provider>` reference.
- `encryption.rs` — AES-256-GCM at rest with an OS-keychain-wrapped master key,
  tier-gated Off/On, rotation, and a non-silent-downgrade policy: if encrypted
  data exists and the key is unavailable, the app refuses to start.
- `db/` — the SQLite layer: a `sqlx` pool (WAL, foreign keys, busy timeout), a
  forward-only migration runner, startup integrity checks with user-safe
  recovery, and repositories for conversations, messages, artifacts,
  attachments, connectors, tool calls, prompts, search, usage, licenses, and the
  tenant cache.
- `stream_manager.rs` — the orchestrator. Looks up the active adapter, builds an
  `AdapterContext` (key from the credential store, base URL from settings),
  calls `stream_chat`, then drives the stream: each event is persisted and
  forwarded over the Tauri `Channel`. Also runs the multi-round agent loop, so
  tool results feed back into follow-up provider rounds within one turn.
- `connector_runtime/` — the MCP supervisor: launch/shutdown, restart backoff,
  concurrency cap, per-call timeouts, discovery and capability caching, and
  consent enforcement.
- `agent_tools.rs` — built-in tools (web fetch, web search, clipboard).
- `updater.rs`, `diagnostics.rs`, `commands/` — update checks, redacted
  diagnostics export, and the Tauri command surface.

### 3. Shared packages

- **`packages/config-schema`** — the TS mirror of `provider-core`'s schema,
  generated by `cargo run --example export_ts -p provider-core`. Never
  hand-edited; CI enforces freshness.
- **`packages/ui`** — design tokens (`tokens.css`), React primitives, and
  locally bundled OFL fonts.

### 4. `mcp-runtime`

The transport-agnostic MCP core: the `McpTransport` trait, a live
`StdioTransport` (newline-delimited JSON-RPC 2.0 over a child process, no
shell, kill-on-drop), an `HttpSseTransport` scaffold that returns
`NotImplemented`, consent classification, redaction helpers, and the
`validate_reinjection` gate that prevents tool output from being fed back into a
prompt.

## How a chat turn flows

```text
React ChatView
  └─ ipc/client.startChatStream(ProviderRequest, onEvent)
       └─ Tauri invoke('start_chat_stream', { request, channel })   ← per-request Channel
            └─ StreamManager.start_chat_stream
                 ├─ provider_core::get_adapter(settings.active_provider)
                 ├─ build_adapter_context  (key from credential store, base_url from settings)
                 ├─ adapter.stream_chat(request, ctx, CancellationToken)
                 └─ spawn task: for each ProviderEvent:
                      ├─ event_log::append_and_apply   (log + view, one transaction)
                      └─ channel.send(event)           → renderer onMessage
            ↑ cancel_chat_stream cancels the token + marks the turn interrupted
  Renderer: streamState.applyProviderEvent folds events into AssistantStreamState
```

The key invariant: **the renderer presents state and intent only; Rust owns
secrets, persistence, and privileged operations.** The renderer never holds an
API key or makes an HTTP call — it sends a `ProviderRequest` and receives
`ProviderEvent`s.

## Persistence model

Writes go through an **append-only event log** plus a **materialized message
view**, updated in the same transaction. `db/fold.rs::fold` is the canonical
pure fold, and `view == fold(events)` is a checked invariant: startup
reconciliation compares the two and rebuilds the view from the log on drift.
Interrupted streams are recovered at boot.

`stream_persistence.rs` (the older file-based journal) is retained read-only for
backfilling stores written by earlier builds.

## Configuration and data

Per-user, under the OS data dir resolved from `ProjectDirs::from("com",
"Conduit", "Conduit")` — see the table in the
[README](../README.md#where-your-data-lives). Secrets are **not** stored there;
they live in the OS keychain, referenced from settings as
`keychain://conduit/<provider>`.

## Testing

- `cargo test --workspace` — unit tests plus integration suites in
  `apps/desktop/src-tauri/tests/` covering migrations, crash recovery, the
  persistence invariant, encryption, connector execution, artifacts, and
  diagnostics privacy.
- `pnpm -C apps/desktop test` — renderer tests (Vitest + Testing Library,
  jsdom), colocated with the components.
- `crates/provider-core/tests/fixture_replay.rs` replays recorded SSE fixtures
  so adapter changes are checked against real provider output.
