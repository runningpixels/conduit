//! Phase 6 white-label: print a validated `BrandConfig` as JSON on stdout.
//!
//! `scripts/apply-brand-identity.mjs` (Mode B, build time) needs the build
//! profile of `brand.md` -- `[bundle]`, `[updater]`, `[runtime]` -- to patch
//! `tauri.conf.json` and drive icon generation. It must not re-implement
//! `+++` TOML parsing or validation in JavaScript: a second parser drifts
//! from this one, and drift between "what Mode A's Settings -> Branding
//! accepted" and "what the packaged build accepted" is the one failure
//! `docs/private/white-label-plan.md` §5 calls out as destroying trust in
//! the whole feature. So the Node script shells out to this binary instead,
//! mirroring the pattern `packages/config-schema` already established:
//! `cargo run --example export_ts -p provider-core`.
//!
//! Usage:
//!   cargo run --quiet --example print_brand_json -p provider-core -- <brand-dir>
//!
//! Reads `<brand-dir>/brand.md`, parses + validates it with
//! `provider_core::brand::parse` -- the same function the desktop crate's
//! `get_brand_config`/`import_brand_file` IPC commands call for Mode A -- and
//! prints exactly one JSON object to stdout:
//!
//!   success: {"ok":true,"config":<BrandConfig>,"warnings":[<issue>...]}
//!   failure: {"ok":false,"errors":[<issue>...],"message":"<human summary>"}
//!
//! where `<issue>` is `{"field":string,"message":string,"severity":"error"|"warning"}`.
//!
//! The exit code is 0 whenever a JSON object was printed to stdout -- callers
//! branch on the `ok` field, not on the process exit code, so the Node side
//! decides what counts as fatal (e.g. a missing `[updater]` section is a
//! hard failure for Mode B but would only be a warning for Mode A). Exit is
//! non-zero only for a failure the JSON envelope cannot represent: the file
//! could not be read at all. Nothing but that one JSON object is ever
//! written to stdout -- everything else (usage, IO errors) goes to stderr --
//! so a caller can pipe stdout straight into `JSON.parse`.
use std::{env, fs, path::Path, process::ExitCode};

use provider_core::brand::{self, BrandError, BrandIssue, Severity};
use serde_json::{json, Value};

fn issue_json(issue: &BrandIssue) -> Value {
    json!({
        "field": issue.field,
        "message": issue.message,
        "severity": match issue.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        },
    })
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: print_brand_json <brand-dir>");
        return ExitCode::FAILURE;
    };

    let path = Path::new(&dir).join("brand.md");
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(err) => {
            eprintln!("print_brand_json: cannot read {}: {err}", path.display());
            return ExitCode::FAILURE;
        }
    };

    let out = match brand::parse(&source) {
        Ok((config, warnings)) => json!({
            "ok": true,
            "config": config,
            "warnings": warnings.iter().map(issue_json).collect::<Vec<_>>(),
        }),
        Err(err) => {
            // Only `BrandError::Invalid` carries structured issues; the other
            // variants (missing/unterminated frontmatter, bad TOML, an
            // unsupported schemaVersion) are single free-text problems with
            // the file as a whole, not a field-scoped list. `message` always
            // carries a human-readable summary either way via `Display`.
            let errors = match &err {
                BrandError::Invalid(issues) => issues.iter().map(issue_json).collect::<Vec<_>>(),
                _ => Vec::new(),
            };
            json!({
                "ok": false,
                "errors": errors,
                "message": err.to_string(),
            })
        }
    };

    // `println!` on a `Value` uses its `Display`, which is compact
    // single-line JSON -- exactly one line on stdout, easy for the Node
    // caller to read whole.
    println!("{out}");
    ExitCode::SUCCESS
}
