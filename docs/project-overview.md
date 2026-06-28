# Conduit — Project Overview

A rundown of how this project is structured and how it works. Read alongside
`docs/architecture/foundation-contracts.md` (the Phase 0 boundary) and
`docs/plans/` (the phased delivery plan).

## What it is

**Conduit** is a desktop AI chat application — a local-first, multi-provider chat
shell built as a Tauri 2 app. The Rust backend owns secrets, persistence, and the
trusted provider abstraction; a React/TypeScript renderer presents state only and
never touches credentials or network directly. The project is currently at the
"desktop shell with real provider adapters" stage (Phases 0–2 of the plan are the
parts actually implemented; later phases — local SQLite DB, MCP runtime, cloud,
white-label — exist mostly as docs and stubs).

## Repo topology

A polyglot monorepo: a Rust workspace (`Cargo.toml`) plus a pnpm workspace
(`pnpm-workspace.yaml`) at the same root.

```text
apps/
  desktop/                 # the Tauri app (React + Vite renderer, Rust src-tauri)
    src/                   # TS/React frontend
    src-tauri/src/         # Rust desktop backend (commands, state, streaming)
crates/
  provider-core/           # provider-agnostic LLM abstraction + adapters
  mcp-runtime/             # MCP runtime (stub today — crate_name() only)
packages/
  config-schema/           # shared TS types = mirror of the Rust schema
  ui/                      # shared theme tokens
docs/                      # this folder
```

- Root `Cargo.toml` members: `apps/desktop/src-tauri`, `crates/provider-core`,
  `crates/mcp-runtime`.
- Root `package.json` (`name: conduit`) just delegates to
  `apps/desktop` (`dev`, `build`, `check`).
- TS path aliases: `@conduit/config-schema`, `@conduit/ui`.

## The two halves

### 1. `provider-core` — the trust boundary (Rust)

The provider-agnostic core. Everything LLM-shaped flows through here.

- **`schema.rs`** — the canonical message/content/event types (`Message`,
  `MessagePart`, `ProviderRequest`, `ProviderEvent`, `ProviderUsage`,
  `ProviderError`, `ToolDefinition`, etc.). This is the single source of truth
  for the on-wire shape; the TS `config-schema` package mirrors it.
- **`adapter.rs`** — the `ProviderAdapter` trait:
  `validate_credentials`, `list_models`, `stream_chat` (returns a
  `Stream<Item = ProviderEvent>`). `registry()` / `get_adapter(id)` select an
  adapter by string id. Also defines `StreamParser` for per-provider SSE parsing.
- **`adapters/`** — concrete implementations:
  - `anthropic` (Claude, `x-api-key` + `anthropic-version`)
  - `openai` (official OpenAI, Bearer auth)
  - `openai_compat` (any OpenAI-compatible endpoint via configurable base URL)
  - `ollama` (local, no key)
  - `mod.rs` holds `wrap_sse_stream` — parses raw SSE `data:` lines through a
    `StreamParser`, emits a leading `MessageStart` and a trailing
    `MessageComplete`, surfacing errors as `ProviderEvent::Error`.
- **`transport.rs`** — HTTP helpers (`bearer_header`, `api_key_header`,
  `post_sse`) built on `reqwest` (rustls). Cancellable via `CancellationToken`.
- **`normalize.rs`** — `validate(ProviderRequest) -> NormalizedRequest`, the
  guard at the trust boundary (request_id/conversation_id/model_id required,
  non-empty messages, valid tools/controls).
- **`error.rs`**, **`fixtures/`** — error construction and test fixtures.

### 2. `apps/desktop` — the Tauri shell

**Renderer (`src/`)** — React + Vite, presents state only:

- `App.tsx` — top-level shell with hash-based routing (`conversations`,
  `artifacts`, `settings`, `connectors`, `cloud`) and the settings/provider UI.
- `chat/` — chat rendering: `ChatView` drives a conversation, `streamState.ts`
  is a pure reducer that folds `ProviderEvent`s into `AssistantStreamState`
  (content blocks, reasoning, tool calls, usage). `AssistantMessage`,
  `ContentBlock`, `ReasoningBlock`, `ToolCallBlock`, `UsageSummary`,
  `InterruptedBanner` render it.
- `ipc/contracts.ts` + `ipc/client.ts` — typed wrappers over Tauri `invoke` /
  `Channel`. The `Channel<ProviderEvent>` is the streaming primitive (per
  request, not a global bus — a deliberate constraint from the foundation
  contracts).

**Backend (`src-tauri/src/`)** — the privileged Rust side:

- `main.rs` — builds the Tauri app, registers `AppState` + `StreamManager`,
  wires the `invoke_handler` with all commands.
- `state.rs` — `AppState`: in-memory `AppSettings` (persisted to
  `settings.json`), per-stream cancel flags. `update_settings` validates
  patches (provider/model non-empty, theme enum, base URLs must be http(s)).
- `paths.rs` — resolves the per-user data dir via `directories::ProjectDirs`
  and creates `settings.json`, `conduit.sqlite`, `attachments/`, `artifacts/`,
  `logs/`, `diagnostics/`, `updates/`, `streams/`.
- `credentials.rs` — `CredentialStore` over OS keychain (`keyring`); secrets
  never hit disk — only a `keychain://conduit/<provider>` reference is stored
  in settings.
- `stream_manager.rs` — the orchestrator. `start_chat_stream` looks up the
  active provider's adapter, builds an `AdapterContext` (key from keychain,
  base URL from settings, ollama/openai_compat are key-optional), calls
  `adapter.stream_chat`, then spawns a task that drives the provider stream:
  each event is persisted via `StreamPersistence` and forwarded over the Tauri
  `Channel`. `CancellationToken` backs cancel; a dropped channel marks the
  stream interrupted. Also `validate_credentials` / `list_models`.
- `stream_persistence.rs` — file-based stream journal under `streams/<conv>/<request_id>.json`,
  accumulating events into a finalized `Message` (with `interrupted`/`finish_reason`).
  This is the *current* persistence layer (the SQLite DB is planned, not yet
  wired). `get_conversation_messages` reloads a conversation from these files.
- `diagnostics.rs` — exports a redacted diagnostics JSON (secrets/attachment
  paths nulled) to `diagnostics/`.
- `commands.rs` — the Tauri command surface: `get_app_paths`, `get_settings`,
  `update_settings`, `save_provider_credential`,
  `load_provider_credential_reference`, `validate_provider_credentials`,
  `list_provider_models`, `start_chat_stream`, `cancel_chat_stream`,
  `get_conversation_messages`, `export_diagnostics`, plus a `start_mock_stream`
  / `cancel_mock_stream` pair for UI development without a live provider.

### 3. Shared packages

- **`packages/config-schema`** — the TS mirror of `provider-core`'s schema,
  exported as `@conduit/config-schema`. `CANONICAL_SCHEMA_VERSION = 1`. Keeps
  the renderer and backend agreeing on shapes without a codegen step.
- **`packages/ui`** — `themeTokens`, CSS-variable-based theming shared by the app.

### 4. `mcp-runtime`

Currently a stub (`lib.rs` returns `crate_name()`). The plan (`docs/plans/archive/04-mcp-runtime.md`)
describes the intended MCP tool runtime; not yet implemented.

## How a chat turn flows

```text
React ChatView
  └─ ipc/client.startChatStream(ProviderRequest, onEvent)
       └─ Tauri invoke('start_chat_stream', { request, channel })   ← per-request Channel
            └─ StreamManager.start_chat_stream
                 ├─ provider_core::get_adapter(settings.active_provider)
                 ├─ build_adapter_context  (key from keychain, base_url from settings)
                 ├─ adapter.stream_chat(request, ctx, CancellationToken)
                 └─ spawn task: for each ProviderEvent:
                      ├─ StreamPersistence.apply_event  (journal to streams/<conv>/<id>.json)
                      └─ channel.send(event)            → renderer onMessage
            ↑ cancel_chat_stream cancels the token + marks interrupted
  Renderer: streamState.applyProviderEvent folds events into AssistantStreamState
  Renderer: AssistantMessage/ContentBlock/ToolCallBlock/… render it
```

Key invariant from the foundation contracts: **the renderer presents state and
intent only; Rust owns secrets, persistence, and privileged operations.** The
renderer never holds an API key or makes an HTTP call — it sends a
`ProviderRequest` and receives `ProviderEvent`s.

## Build / run

- `pnpm dev` (root) → `apps/desktop` `tauri dev` (boots Vite at :5173, then the shell).
- `pnpm build` → `tauri build`. `pnpm check` → `tsc -b` (typecheck).
- Rust side built through Tauri (`tauri build` / `tauri dev`); `cargo` workspace
  resolves `provider-core` + `mcp-runtime` as the desktop crate's deps.
- `check-setup.ps1` at root sanity-checks the toolchain.

## Configuration / data

Per-user under the OS data dir (`directories::ProjectDirs` →
`com.Conduit.Conduit`): `settings.json`, `conduit.sqlite` (planned), and the
`attachments/ artifacts/ logs/ diagnostics/ updates/ streams/` folders. Default
settings: provider `anthropic`, model `claude-sonnet-4`, `local_only: true`,
`diagnostics_enabled: true`, `theme: system`. Secrets live in the OS keychain,
referenced from settings as `keychain://conduit/<provider>`.

## Status / what's real vs planned

The living record of what is implemented vs. planned lives in
`docs/plans/status.md` — that is the single source of truth for implementation
status, kept current against the working tree. The `docs/schemas/internal-models.md`
and `docs/adr/*` records describe target shapes; treat the code, not those docs,
as the source of truth for what runs today.