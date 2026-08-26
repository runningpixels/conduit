use std::{fs, path::Path};

fn main() {
    tauri_build::build();

    // Phase 6 white-label Mode B: bake `BrandRuntime.allow_user_branding`
    // (`crates/provider-core/src/schema.rs`) into the compiled binary as
    // `CONDUIT_ALLOW_USER_BRANDING`, read back via `option_env!` in
    // `commands::branding` -- the exact same compile-time-constant shape
    // `updater.rs`'s `UPDATE_BASE`/`CONDUIT_UPDATE_BASE` already uses (see
    // that constant's doc comment for why: a value baked in at `cargo build`
    // time cannot be flipped by editing a file on an already-installed copy
    // of the app, which is the entire point of Mode B's lock).
    //
    // `apps/desktop/branding.build.json` is the one on-disk artifact
    // `scripts/apply-brand-identity.mjs` already writes for this exact
    // decision -- `apps/desktop/vite.config.ts` reads it synchronously to
    // set the renderer's own `__ALLOW_USER_BRANDING__` define
    // (`src/brand/buildFlags.ts`). Reading that same file here, instead of
    // inventing a second signal, means the Rust and renderer halves of one
    // build agree by construction: whatever `apply-brand-identity.mjs`
    // decided is what both sides bake in, not two independently-plumbed
    // values that could drift apart.
    //
    // Absent entirely -- every ordinary `cargo build`/`cargo test` in a
    // checkout that never ran `apply-brand-identity.mjs` -- this fails open
    // to `true` (branding permitted), matching `BrandRuntime`'s own default
    // and `vite.config.ts`'s renderer-side fallback, so a stock build's
    // behavior is unchanged by this constant existing at all. A malformed
    // file fails open the same way, for the same reason `vite.config.ts`
    // does: a build script's job is to bake in what brand.md said, not to
    // become a second place branding validation can fail.
    let flags_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../branding.build.json");
    println!("cargo:rerun-if-changed={}", flags_path.display());
    let allow = match fs::read_to_string(&flags_path) {
        Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
            Ok(value) => value
                .get("allowUserBranding")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            Err(_) => true,
        },
        Err(_) => true,
    };
    println!("cargo:rustc-env=CONDUIT_ALLOW_USER_BRANDING={allow}");
}
