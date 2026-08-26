// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Mode B (white-label) build-time emitter -- white-label plan §5.
//!
//! Run: `cargo run --example apply_brand -p provider-core -- <brand-dir> [--repo-root <path>]`
//!
//! Reads `<brand-dir>/brand.md`, parses and validates it with the exact same
//! shared code Mode A's runtime loader uses (`provider_core::brand::parse`),
//! **hard-fails on any `Severity::Error`**, and writes:
//!
//!   - `packages/ui/src/brand.generated.css`      -- the palette, as real CSS
//!   - `apps/desktop/src/brand/generated.ts`       -- compiled-in identity defaults
//!   - `packages/ui/src/fonts/brand-{ui,mono,serif}.woff2` -- only the roles `[fonts]` names
//!
//! all relative to `--repo-root` (defaults to this crate's own `../..`, i.e.
//! the repository root, matching how the crate is normally checked out).
//!
//! This intentionally does **not** patch `tauri.conf.json`, regenerate
//! icons, or touch anything under `apps/desktop/src-tauri/` -- that is
//! Phase 6 (bundle identity), a separate piece of work. Per the plan: "No
//! config patching yet; verify a themed dev build looks identical to the
//! same brand.md applied at runtime. That equivalence is the acceptance test
//! for the whole design" -- see
//! `apps/desktop/src/brand/brandEquivalence.test.ts`, which runs this binary
//! for real against a fixture brand and diffs its output against Mode A's
//! `PALETTE_PROPERTY_MAP` + `deriveHueWeak`.

use provider_core::brand::{parse, BrandError};
use provider_core::brand_emit::{font_copy_plan, render_generated_css, render_generated_ts};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let invocation = format!(
        "cargo run --example apply_brand -p provider-core -- {}",
        args[1..].join(" ")
    );

    let mut brand_dir: Option<PathBuf> = None;
    let mut repo_root: Option<PathBuf> = None;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--repo-root" => {
                let Some(v) = iter.next() else {
                    eprintln!("error: --repo-root requires a path argument");
                    return ExitCode::FAILURE;
                };
                repo_root = Some(PathBuf::from(v));
            }
            "-h" | "--help" => {
                print_usage();
                return ExitCode::SUCCESS;
            }
            other if brand_dir.is_none() => brand_dir = Some(PathBuf::from(other)),
            other => {
                eprintln!("error: unexpected argument `{other}`");
                print_usage();
                return ExitCode::FAILURE;
            }
        }
    }

    let Some(brand_dir) = brand_dir else {
        print_usage();
        return ExitCode::FAILURE;
    };

    // Defaults to the repository root two levels up from this crate
    // (crates/provider-core/../..), the same relative-path convention
    // `export_ts.rs` uses for its own ts-rs `export_to` paths -- so a plain
    // `cargo run --example apply_brand -p provider-core -- <dir>` works from
    // any working directory, not just the repo root.
    let repo_root =
        repo_root.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));

    let brand_md_path = brand_dir.join("brand.md");
    let source = match fs::read_to_string(&brand_md_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: could not read {}: {e}", brand_md_path.display());
            return ExitCode::FAILURE;
        }
    };

    let (cfg, warnings) = match parse(&source) {
        Ok(ok) => ok,
        Err(BrandError::Invalid(errors)) => {
            eprintln!("error: {} failed validation:", brand_md_path.display());
            for issue in errors {
                eprintln!("  [error] {}: {}", issue.field, issue.message);
            }
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("error: {} failed to parse: {e}", brand_md_path.display());
            return ExitCode::FAILURE;
        }
    };

    // The "[section] only takes effect in a packaged build" notices are
    // meaningful to Mode A, reading the same file at runtime -- not here.
    // This *is* that packaged build, actually reading `[fonts]`/`[bundle]`/
    // `[updater]`/`[runtime]`, so echoing "this only applies in a packaged
    // build" back at the person running the packaged build would be
    // actively confusing. Distinguished from a genuine per-field warning by
    // field name: the notices use the bare section name (`"fonts"`), a real
    // issue always has a dotted field path (`"fonts.ui"`, `"bundle.identifier"`).
    for issue in &warnings {
        if matches!(
            issue.field.as_str(),
            "fonts" | "bundle" | "updater" | "runtime"
        ) {
            continue;
        }
        eprintln!("warning: {}: {}", issue.field, issue.message);
    }

    let css_path = repo_root.join("packages/ui/src/brand.generated.css");
    let ts_path = repo_root.join("apps/desktop/src/brand/generated.ts");

    if let Err(e) = ensure_parent_dir(&css_path) {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }
    if let Err(e) = ensure_parent_dir(&ts_path) {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    let css = render_generated_css(&cfg, &invocation);
    if let Err(e) = fs::write(&css_path, &css) {
        eprintln!("error: could not write {}: {e}", css_path.display());
        return ExitCode::FAILURE;
    }
    println!("wrote {}", css_path.display());

    let ts = render_generated_ts(&cfg, &invocation);
    if let Err(e) = fs::write(&ts_path, &ts) {
        eprintln!("error: could not write {}: {e}", ts_path.display());
        return ExitCode::FAILURE;
    }
    println!("wrote {}", ts_path.display());

    if let Some(fonts) = &cfg.fonts {
        let fonts_dir = repo_root.join("packages/ui/src/fonts");
        if let Err(e) = fs::create_dir_all(&fonts_dir) {
            eprintln!("error: could not create {}: {e}", fonts_dir.display());
            return ExitCode::FAILURE;
        }
        for (role, filename) in font_copy_plan(fonts) {
            let src = brand_dir.join(&filename);
            let dest = fonts_dir.join(role.dest_filename());
            if let Err(e) = fs::copy(&src, &dest) {
                eprintln!(
                    "error: could not copy font {} -> {}: {e}",
                    src.display(),
                    dest.display()
                );
                return ExitCode::FAILURE;
            }
            println!("wrote {}", dest.display());
        }
    }

    println!(
        "brand \"{}\" applied ({} warning(s))",
        cfg.identity.display_name,
        warnings.len()
    );
    ExitCode::SUCCESS
}

fn ensure_parent_dir(path: &std::path::Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))
}

fn print_usage() {
    eprintln!(
        "usage: cargo run --example apply_brand -p provider-core -- <brand-dir> [--repo-root <path>]"
    );
}
