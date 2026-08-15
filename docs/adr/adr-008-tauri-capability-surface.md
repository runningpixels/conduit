# ADR 008: Tauri capability surface & custom-command authorization

## Status
Accepted.

## Decision
Keep the default capability (`apps/desktop/src-tauri/capabilities/default.json`)
**minimal** — `core:*` only, with **no** `updater:default`, `dialog:default`, or
`shell:allow-open`. The renderer reaches the OS only through Conduit's own
`#[tauri::command]`s in `invoke_handler`, never through a plugin's JS command
directly. Any command that opens an OS resource (the "Reveal in folder"
`reveal_path`) derives the target **server-side** from `AppPaths` — it never
accepts a renderer-supplied path.

## Context
Phase 6 (consumer release) added the updater, dialog, and shell plugins and a set
of custom commands layered on them (`check_for_update`,
`download_and_install_update`, `reveal_path`, the diagnostics-disclosure pair).
A security review flagged that the original capability granted `updater:default`,
`dialog:default`, and `shell:allow-open`, which let the renderer call the plugins'
own JS commands directly (`invoke('plugin:updater|…')`, `invoke('plugin:shell|open')`)
— a wider surface than the app actually needs, since every feature already routes
through a custom command that runs the real logic (migration precheck, open a
server-owned directory) in Rust.

Two questions had to be answered with certainty before trimming the capability:

1. **Do custom `invoke_handler` commands keep working** when the capability is
   stripped to `core:*`? (If custom commands were ACL-gated, the trim would
   disable the entire Phase 6 command set.)
2. **Does `reveal_path` still work** without `shell:allow-open`, given it calls
   `app.shell().open(…)` on the Rust side?

## Findings (verified against source)

### 1. Custom commands are auto-allowed — the trim is safe
In `tauri-2.11.3`, the `#[tauri::command]` attribute macro emits a call to
`RuntimeAuthority::__allow_command(command, context)`, which inserts the command
into `allowed_commands` with `windows: ["*"]` (`src/ipc/authority.rs:137`):

```rust
pub fn __allow_command(&mut self, command: String, context: ExecutionContext) {
    self.allowed_commands.insert(
        command,
        vec![ResolvedCommand { context, windows: vec!["*".parse().unwrap()], ..Default::default() }],
    );
}
```

The capability/ACL system gates **plugin commands** and **core commands**
(those ship with generated permission sets). User-defined commands registered
via `tauri::generate_handler![…]` are allowed by the macro itself, independent of
any capability file. Therefore stripping the capability to `core:*` does **not**
disable `check_for_update`, `download_and_install_update`, `reveal_path`,
`get_diagnostics_disclosure_acknowledged`, or `acknowledge_diagnostics_disclosure`.

The trim only removes the renderer's ability to invoke the plugins' own JS
commands directly — the bypass the review identified.

### 2. `Shell::open` from Rust bypasses the `shell:allow-open` scope
In `tauri-plugin-shell-2.3.5`, `ShellExt::shell().open(…)` calls
`open::open(None, path, with)` (`src/lib.rs:77`), passing `scope: None`. The
`open::open` body (`src/open.rs:122`) then takes the Rust-direct branch:

```rust
pub fn open(scope: Option<&OpenScope>, path, with) -> crate::Result<()> {
    if let Some(scope) = scope {
        scope.open(path.as_ref(), with).map_err(Into::into)   // JS calls → scope-checked
    } else {
        // when running directly from Rust code we don't need to validate the path
        … ::open::that_detached(path.as_ref()) …              // Rust calls → no scope check
    }
}
```

So `shell:allow-open` only gates the **JS-direct** `invoke('plugin:shell|open')`
path. The Rust `Shell::open` path opens with **no** scope validation. Two
consequences:

- **Good:** `reveal_path` works without `shell:allow-open` — confirmed.
- **The hazard:** because the Rust path skips validation, any custom command that
  passes a **renderer-supplied** string to `app.shell().open(…)` is an
  open-anything-the-renderer-asks-for vector. The original M6.5 `reveal_path(app,
  path: String)` had exactly this shape — the renderer could pass
  `https://attacker.com` (opens the browser there) or any local path.

### 3. Updater / dialog permissions are not needed for the Rust-API flow
`updater:default` gates the updater plugin's JS commands (`plugin:updater|check`,
etc.). Conduit's `check_for_update`/`download_and_install_update` use the Rust
`UpdaterExt::updater_builder()` API, which does not route through the JS ACL.
`dialog:default` is similarly unused — the diagnostics disclosure uses the
browser-native `window.confirm()`, not the dialog plugin. (The dialog plugin is
still registered but inert; see Consequences.)

## Decision detail
`reveal_path` is defined to take no renderer-controlled path:

```rust
#[tauri::command]
#[allow(deprecated)] // shell().open is superseded by tauri-plugin-opener; migrate later
pub fn reveal_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(state.paths.exports.to_string_lossy(), None).map_err(|e| e.to_string())
}
```

It opens `AppPaths::exports` — the shared, app-owned exports directory. The TS
client (`revealPath()`) and `SettingsPanel`'s `handleRevealExports` pass no
argument. The renderer cannot direct the shell at an arbitrary location.

## Consequences
- **Renderer→plugin direct invocation is closed.** The renderer can only call
  Conduit's curated custom commands; it cannot reach `plugin:updater|…` or
  `plugin:shell|open`.
- **`reveal_path` is safe by construction.** The one shell-opening command opens
  a fixed, server-owned directory. The rule going forward: **no custom command
  may pass a renderer-supplied value to `app.shell().open(…)`** (or any other
  plugin Rust API that bypasses the scope) **unless that value is validated
  first**. Derive the target server-side, validate it is within `AppPaths`, or
  (for URLs) pass it through `validate_external_open_url`.
- **Exception — `open_external_url`:** accepts a renderer-supplied URL string
  and opens it in the system browser **only after** `validate_external_open_url`
  (absolute `http`/`https`, non-empty host, no userinfo, length-capped). Raw
  strings must never reach `shell().open`. The capability still omits
  `shell:allow-open`.
- **Custom commands are NOT a permission surface.** Anyone adding a new
  `#[tauri::command]` gets it auto-exposed on every window. If a command should
  be restricted, it must enforce its own authorization in the function body —
  the capability file will not gate it. Treat every custom command as
  renderer-reachable and validate its inputs.
- **Plugin Rust APIs bypass JS scopes.** `ShellExt`, `UpdaterExt`, etc. do not
  consult the capability/permission system when called from backend code. This
  is fine for app-owned targets and dangerous for renderer-supplied ones.
- **Inert `dialog` plugin.** `tauri_plugin_dialog::init()` is still registered
  but nothing uses it (the disclosure uses `window.confirm()`). It can be dropped
  (registration + `tauri-plugin-dialog` dep) for a truly minimal surface;
  harmless to leave until then.
- **`shell().open` is deprecated** upstream in favor of `tauri-plugin-opener`.
  Migrating is a later cleanup; the security reasoning above applies identically
  to the opener plugin (its Rust API likewise must not receive renderer-controlled
  paths).

## Verification
- `cargo check --lib`, `cargo test --lib` (32 passed) green.
- `pnpm check` (tsc -b) clean; `pnpm test` (vitest) 105 passed — incl. the
  `revealPath()` no-arg assertion.
- Source cross-checked: `tauri-2.11.3/src/ipc/authority.rs`,
  `tauri-plugin-shell-2.3.5/src/lib.rs` + `src/open.rs`.