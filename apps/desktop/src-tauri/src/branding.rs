//! Filesystem storage for the Mode A (runtime) white-label brand.
//!
//! `docs/private/white-label-plan.md` §4 puts the source of truth at
//! `<branding>/brand.md`, with `logo.<ext>` alongside it — see
//! [`crate::paths::AppPaths::branding`]. This module owns everything that
//! touches that directory: reading it at startup, writing a new brand from
//! Settings, clearing it, and importing one from an arbitrary file the user
//! picked. The IPC commands in `commands::branding` are thin wrappers around
//! the functions here, mirroring the `local_data`/`commands::settings` split.
//!
//! Parsing and validation themselves are *not* this module's job — that is
//! `provider_core::brand`, which is deliberately IO-free so both this crate
//! (Mode A) and the future `apply_brand` build example (Mode B) share it.
//! What this module adds is the IO around it: turning "no file" into `None`
//! rather than an error, resolving `logo.file` against a real directory to
//! check it actually exists, and the filesystem side of the traversal guard
//! for imports (the validator only checks the *filename grammar*; joining it
//! to a source directory and copying bytes is done here).

use std::{
    fs,
    path::{Path, PathBuf},
};

use provider_core::{
    brand::{self, BrandError, BrandIssue, Severity},
    schema::BrandConfig,
};

/// The one filename this module ever reads or writes directly under
/// `AppPaths::branding`. The logo's filename is whatever `brand.md` names it
/// as (`BrandLogo::file`), so it has no fixed constant.
pub const BRAND_FILE_NAME: &str = "brand.md";

/// A brand successfully read off disk: the validated config plus every
/// warning worth surfacing (WCAG contrast shortfalls from
/// `provider_core::brand::validate`, plus a missing-logo-file check this
/// module adds since the validator has no filesystem to check against).
#[derive(Debug, Clone)]
pub struct LoadedBrand {
    pub config: BrandConfig,
    pub warnings: Vec<BrandIssue>,
}

/// Read and validate `<branding_dir>/brand.md`.
///
/// `Ok(None)` means "no brand.md exists" — the ordinary unbranded state, not
/// an error. Any other read failure, or a parse/validation failure, comes
/// back as `Err`: the file is there and the author (who wrote it, generally
/// themselves) needs to know why it did not take rather than have it
/// silently ignored.
pub fn load(branding_dir: &Path) -> Result<Option<LoadedBrand>, String> {
    let path = branding_dir.join(BRAND_FILE_NAME);
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };

    let (config, mut warnings) = brand::parse(&source).map_err(describe_error)?;
    if let Some(logo) = &config.logo {
        if !branding_dir.join(&logo.file).is_file() {
            warnings.push(BrandIssue {
                field: "logo.file".to_string(),
                message: format!(
                    "`{}` is named in brand.md but is not present in the branding directory — \
                     the logo will not display until it is added",
                    logo.file
                ),
                severity: Severity::Warning,
            });
        }
    }

    Ok(Some(LoadedBrand { config, warnings }))
}

/// Validate `source` and, only if it validates cleanly, persist it as the
/// active `brand.md`.
///
/// Validating before writing (rather than writing then validating) is the
/// point: a config that fails validation must never reach disk, or [`load`]
/// would immediately hand the failure straight back to the user on the very
/// next read, which is a worse experience than just refusing the write.
pub fn set(branding_dir: &Path, source: &str) -> Result<(BrandConfig, Vec<BrandIssue>), String> {
    let (config, warnings) = brand::parse(source).map_err(describe_error)?;
    fs::write(branding_dir.join(BRAND_FILE_NAME), source)
        .map_err(|err| format!("failed to write brand.md: {err}"))?;
    Ok((config, warnings))
}

/// Apply a [`BrandConfig`] coming from the Settings UI, e.g. one colour
/// tweak on a form. The obvious implementation -- regenerate `brand.md` from
/// the struct on every edit -- is exactly what this function exists to
/// avoid: it would silently destroy a hand-authored file's comments, key
/// order, and prose the first time anyone nudged a swatch. So instead:
///
/// - If `brand.md` already exists, [`brand::merge_brand_edits`] it in --
///   a surgical text edit that changes only the bytes `cfg` actually
///   changed, per that function's own contract.
/// - If it does not exist yet (first save for this install),
///   [`brand::render_brand_md`] builds one from scratch -- there is no
///   author formatting to preserve because there is no file yet.
///
/// `cfg` is validated *before* either path runs, for the same reason
/// [`set`] validates before writing: a config that fails validation must
/// never reach disk, since [`load`] would just hand the failure straight
/// back on the very next read.
///
/// Returns the *re-parsed* config, not `cfg` itself, so the caller always
/// reflects what actually landed on disk -- e.g. if `brand.md` had a
/// `logo.file` this rewrite left untouched, the caller sees that logo too,
/// not just whatever fields the renderer happened to send.
pub fn apply(
    branding_dir: &Path,
    cfg: &BrandConfig,
) -> Result<(BrandConfig, Vec<BrandIssue>), String> {
    let errors: Vec<BrandIssue> = brand::validate(cfg)
        .into_iter()
        .filter(|issue| issue.severity == Severity::Error)
        .collect();
    if !errors.is_empty() {
        return Err(describe_error(BrandError::Invalid(errors)));
    }

    let path = branding_dir.join(BRAND_FILE_NAME);
    let rendered = match fs::read_to_string(&path) {
        Ok(existing) => brand::merge_brand_edits(&existing, cfg).map_err(describe_error)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => brand::render_brand_md(cfg),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };

    // Parse BEFORE writing, not after. The doc comment above promises a config
    // that fails validation never reaches disk, and writing first broke that
    // promise: `merge_brand_edits` builds TOML by hand, so any defect there
    // (an unescaped value, a malformed splice) produced a `brand.md` that was
    // already on disk by the time `parse` rejected it — and a corrupt
    // `brand.md` makes every later `load()` fail, which the renderer's boot
    // `Promise.all` surfaces as a failed startup rather than a bad save.
    //
    // Reordering costs one parse of a string already in memory and makes the
    // write unreachable unless the exact bytes about to be written round-trip.
    let reparsed = brand::parse(&rendered).map_err(describe_error)?;
    write_atomic(&path, rendered.as_bytes())?;
    Ok(reparsed)
}

/// Write `bytes` to `target` via a temp-file-then-rename, the same pattern
/// [`save_logo`] uses for its own writes: a rename is atomic on the same
/// filesystem, so a crash or a concurrent read of `target` can never observe
/// a half-written `brand.md`.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = target.with_extension("tmp.part");
    fs::write(&temp, bytes).map_err(|err| format!("failed to write {}: {err}", temp.display()))?;
    fs::rename(&temp, target)
        .map_err(|err| format!("failed to finalize {}: {err}", target.display()))?;
    Ok(())
}

/// Remove `brand.md` and its logo, if any. Idempotent: clearing an already-
/// unbranded install is success, not an error — the caller (Settings'
/// "Reset branding") should never have to special-case "there was nothing to
/// clear."
///
/// The logo filename is recovered on a best-effort basis by re-parsing the
/// existing `brand.md` before removing it. If that file has been hand-edited
/// into an unparseable state since it was last written by [`set`]/[`import`]
/// (both of which only ever write already-validated content), the logo
/// filename cannot be recovered and its file is left behind rather than
/// guessed at — `brand.md` itself is still removed either way.
pub fn clear(branding_dir: &Path) -> Result<(), String> {
    let logo_file = fs::read_to_string(branding_dir.join(BRAND_FILE_NAME))
        .ok()
        .and_then(|source| brand::parse(&source).ok())
        .and_then(|(config, _warnings)| config.logo)
        .map(|logo| logo.file);

    remove_if_exists(&branding_dir.join(BRAND_FILE_NAME))?;
    if let Some(file) = logo_file {
        remove_if_exists(&branding_dir.join(file))?;
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to remove {}: {err}", path.display())),
    }
}

/// Import a `brand.md` (and its logo, if named) from an arbitrary path the
/// user picked via the file dialog, into the branding directory.
///
/// The source path is trusted no more than any other user input: the text
/// parses and validates exactly like [`set`], and the logo filename is
/// re-checked against the bare-filename grammar immediately before use here.
/// `provider_core::brand::validate` (run inside `brand::parse` above) already
/// rejects a `logo.file` containing a path separator, `..`, a leading `~`, or
/// a drive-qualified prefix — but that check happens once, in a shared crate
/// this module does not control. This function is the one place a traversal
/// in that filename would ever actually touch the filesystem (joining it
/// against the *source* directory to find the bytes to copy), so it is
/// re-verified here rather than trusting that the earlier check ran, or will
/// keep running unchanged, forever.
pub fn import(
    branding_dir: &Path,
    source_path: &Path,
) -> Result<(BrandConfig, Vec<BrandIssue>), String> {
    let source = fs::read_to_string(source_path)
        .map_err(|err| format!("failed to read {}: {err}", source_path.display()))?;
    let (config, warnings) = brand::parse(&source).map_err(describe_error)?;

    let source_dir = source_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| format!("{} has no parent directory", source_path.display()))?;
    // Canonicalizing the *directory* (not yet the logo file) up front gives a
    // stable boundary to check the logo's resolved location against below,
    // and fails fast if the source directory itself is somehow unreadable.
    let canonical_source_dir = source_dir
        .canonicalize()
        .map_err(|err| format!("failed to resolve {}: {err}", source_dir.display()))?;

    if let Some(logo) = &config.logo {
        if !is_bare_filename(&logo.file) {
            return Err(format!(
                "logo file `{}` named in brand.md is not a bare filename and was not imported",
                logo.file
            ));
        }

        let logo_source = source_dir.join(&logo.file);
        // `canonicalize` resolves symlinks to their real target as part of
        // resolving the path at all, so the `starts_with` check below rejects
        // a symlink pointing outside `source_dir` exactly as it would reject
        // a literal `../` — both simply produce a canonical path that is not
        // under `canonical_source_dir`. This is what keeps the import from
        // following a symlink out of the directory the user picked.
        let canonical_logo = logo_source.canonicalize().map_err(|err| {
            format!(
                "logo file `{}` named in brand.md was not found next to it: {err}",
                logo.file
            )
        })?;
        if !canonical_logo.starts_with(&canonical_source_dir) {
            return Err(format!(
                "logo file `{}` resolves outside its own directory (possibly via a symlink) \
                 and was not imported",
                logo.file
            ));
        }

        fs::copy(&canonical_logo, branding_dir.join(&logo.file))
            .map_err(|err| format!("failed to copy logo file: {err}"))?;
    }

    fs::write(branding_dir.join(BRAND_FILE_NAME), &source)
        .map_err(|err| format!("failed to write brand.md: {err}"))?;

    Ok((config, warnings))
}

/// Export the active `brand.md` -- and its logo, if any -- to a destination
/// the user picked. `dest_path` names the file `brand.md` itself is written
/// to; the logo (if named in the config) is copied *alongside* it, into
/// `dest_path`'s parent directory, under its own existing filename.
///
/// A brand exports as this file-plus-logo pair, not a single opaque blob,
/// because that is what keeps it hand-editable on the other end -- the same
/// reason `brand.md` is the storage format at all (see the module doc
/// comment and `docs/private/white-label-plan.md` §4).
///
/// `dest_path`'s parent must already exist; this never creates a directory
/// tree, only the two files inside a location the user (or the save dialog
/// that produced `dest_path`) already chose.
pub fn export(branding_dir: &Path, dest_path: &Path) -> Result<(), String> {
    let brand_md = branding_dir.join(BRAND_FILE_NAME);
    if !brand_md.is_file() {
        return Err("no brand is configured to export".to_string());
    }

    let parent = dest_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| format!("{} has no parent directory", dest_path.display()))?;
    if !parent.is_dir() {
        return Err(format!(
            "{} does not exist -- export writes files into an existing directory, it does not \
             create one",
            parent.display()
        ));
    }

    fs::copy(&brand_md, dest_path)
        .map_err(|err| format!("failed to write {}: {err}", dest_path.display()))?;

    // Best-effort: a brand.md that names a logo the app failed to load (see
    // `load`'s missing-logo warning) simply has nothing to copy here. The
    // exported brand.md itself is unaffected either way.
    if let Some(loaded) = load(branding_dir)? {
        if let Some(logo) = loaded.config.logo {
            let logo_src = branding_dir.join(&logo.file);
            if logo_src.is_file() {
                fs::copy(&logo_src, parent.join(&logo.file))
                    .map_err(|err| format!("failed to copy logo file: {err}"))?;
            }
        }
    }

    Ok(())
}

// =============================================================================
// Logo (Phase 2)
// =============================================================================

/// Write already-validated logo bytes to `<branding_dir>/logo.<ext>`
/// atomically (temp file + rename, the same pattern
/// `db::repository::attachments::write_atomic` uses for blob writes), and
/// remove every *other* `logo.*` file first so switching formats (PNG ->
/// SVG, say) can never leave two logo files coexisting with only `brand.md`
/// saying which one is current.
///
/// Does not touch `brand.md` -- pointing it at the new file is [`set_logo`]'s
/// job, called separately by the command layer once this succeeds, so a
/// failure partway through updating the reference never leaves an orphaned
/// write with no chance to retry the bytes themselves.
pub fn save_logo(branding_dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let file_name = format!("logo.{ext}");
    for path in existing_logo_files(branding_dir)? {
        if path.file_name().and_then(|n| n.to_str()) != Some(file_name.as_str()) {
            remove_if_exists(&path)?;
        }
    }

    let target = branding_dir.join(&file_name);
    let temp = target.with_extension("tmp.part");
    fs::write(&temp, bytes).map_err(|err| format!("failed to write {}: {err}", temp.display()))?;
    fs::rename(&temp, &target)
        .map_err(|err| format!("failed to finalize {}: {err}", target.display()))?;

    Ok(file_name)
}

/// Point `brand.md` at `filename` as its logo, via
/// [`provider_core::brand::set_logo_reference`] -- a surgical text edit that
/// leaves every other byte of the file (comments, key order, the Markdown
/// body) untouched, not a parse-mutate-reserialize round trip. The edited
/// text is re-parsed before it is written, the same "validate before
/// persist" discipline [`set`] follows above, so a malformed edit can never
/// reach disk.
pub fn set_logo(branding_dir: &Path, filename: &str) -> Result<BrandConfig, String> {
    let path = branding_dir.join(BRAND_FILE_NAME);
    let source = fs::read_to_string(&path).map_err(|err| {
        format!(
            "failed to read {}: {err} -- a brand must already exist before a logo can be added \
             to it",
            path.display()
        )
    })?;

    let updated = brand::set_logo_reference(&source, filename).map_err(describe_error)?;
    let (config, _warnings) = brand::parse(&updated).map_err(describe_error)?;
    fs::write(&path, &updated).map_err(|err| format!("failed to write brand.md: {err}"))?;

    Ok(config)
}

/// Remove the active logo: its bytes on disk (every `logo.*` file, though in
/// practice [`save_logo`]'s exclusivity invariant means there is ever only
/// one) and the `[logo]` reference in `brand.md`. Idempotent -- clearing
/// when there is no `brand.md`, no `[logo]` section, or no logo file all
/// succeed as a no-op, matching [`clear`]'s idempotency for the brand as a
/// whole.
pub fn clear_logo(branding_dir: &Path) -> Result<(), String> {
    let path = branding_dir.join(BRAND_FILE_NAME);
    if let Ok(source) = fs::read_to_string(&path) {
        let updated = brand::clear_logo_reference(&source).map_err(describe_error)?;
        if updated != source {
            fs::write(&path, &updated).map_err(|err| format!("failed to write brand.md: {err}"))?;
        }
    }

    for path in existing_logo_files(branding_dir)? {
        remove_if_exists(&path)?;
    }
    Ok(())
}

/// Every `logo.*` file directly inside `branding_dir`, if the directory
/// exists at all -- a missing directory is treated as "no logo files"
/// rather than an error, the same "absence is not failure" stance [`load`]
/// takes for a missing `brand.md`.
fn existing_logo_files(branding_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(branding_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("failed to list {}: {err}", branding_dir.display())),
    };

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("logo."))
        {
            files.push(path);
        }
    }
    Ok(files)
}

/// Mirrors `provider_core::brand`'s private `validate_logo` grammar (a bare
/// filename: no separators, no `..`, no leading `~`, no null byte, no
/// Windows drive prefix). Duplicated deliberately rather than exposed from
/// that crate — see [`import`]'s doc comment for why this needs its own,
/// independent check rather than delegating back to the same validator.
fn is_bare_filename(name: &str) -> bool {
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.contains("..")
        || name.contains('\0')
        || name.starts_with('~')
    {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false; // e.g. "C:logo.png" — drive-relative, not a bare filename.
    }
    true
}

/// Turn a [`BrandError`] into a message a human editing `brand.md` by hand
/// can act on. Every variant already carries an author-facing `Display` via
/// `thiserror` *except* [`BrandError::Invalid`], whose default message is
/// just an issue count — this names every offending field instead, which is
/// the entire point of the validator producing structured issues at all.
///
/// `pub(crate)` rather than private: `commands::branding::parse_brand_source`
/// needs the exact same formatting for the exact same reason (a model or a
/// renderer reacting to *which* field is wrong, not just a count), and
/// re-deriving it there would risk the two messages drifting apart.
pub(crate) fn describe_error(err: BrandError) -> String {
    match err {
        BrandError::Invalid(issues) => {
            let details = issues
                .iter()
                .map(|issue| format!("- {}: {}", issue.field, issue.message))
                .collect::<Vec<_>>()
                .join("\n");
            format!("brand.md failed validation:\n{details}")
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kept in sync with the fixture in `provider_core::brand`'s own tests —
    /// this module does not re-test parsing/validation itself (that is
    /// `provider_core::brand`'s job), only the IO wrapped around it.
    const VALID_BRAND_MD: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"

[logo]
file = "logo.png"
+++

Design notes.
"##;

    const IDENTITY_ONLY_BRAND_MD: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"
+++
"##;

    #[test]
    fn missing_file_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let result = load(dir.path()).expect("a missing brand.md must not be an error");
        assert!(result.is_none());
    }

    #[test]
    fn valid_file_loads_the_config() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(BRAND_FILE_NAME), IDENTITY_ONLY_BRAND_MD).unwrap();
        let loaded = load(dir.path()).expect("valid file should load").unwrap();
        assert_eq!(loaded.config.identity.app_name, "Northwind");
        assert!(loaded.warnings.is_empty());
    }

    #[test]
    fn valid_file_with_missing_logo_warns_but_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(BRAND_FILE_NAME), VALID_BRAND_MD).unwrap();
        // Deliberately do not write logo.png.
        let loaded = load(dir.path())
            .expect("missing logo is a warning, not an error")
            .unwrap();
        assert!(loaded
            .warnings
            .iter()
            .any(|w| w.field == "logo.file" && w.severity == Severity::Warning));
    }

    #[test]
    fn invalid_file_is_an_error_naming_the_field() {
        let dir = tempfile::tempdir().unwrap();
        // appName empty -> validator error.
        let source =
            IDENTITY_ONLY_BRAND_MD.replace("appName     = \"Northwind\"", "appName = \"\"");
        fs::write(dir.path().join(BRAND_FILE_NAME), source).unwrap();
        let err = load(dir.path()).expect_err("a file that fails validation must be an error");
        assert!(
            err.contains("identity.appName"),
            "error should name the offending field: {err}"
        );
    }

    #[test]
    fn set_rejects_invalid_source_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let bad = "not a brand file at all";
        let err = set(dir.path(), bad).unwrap_err();
        assert!(err.contains("frontmatter"), "error: {err}");
        assert!(
            !dir.path().join(BRAND_FILE_NAME).exists(),
            "an invalid config must never be persisted"
        );
    }

    #[test]
    fn set_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (config, _warnings) = set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();
        assert_eq!(config.identity.app_name, "Northwind");
        let loaded = load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.config.identity.app_name, "Northwind");
    }

    #[test]
    fn clear_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        // Clearing an already-unbranded directory must succeed.
        clear(dir.path()).expect("clearing nothing should succeed");
        clear(dir.path()).expect("clearing nothing twice should still succeed");

        // Clearing a real brand removes it, and clearing again is still fine.
        set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();
        assert!(dir.path().join(BRAND_FILE_NAME).exists());
        clear(dir.path()).expect("clear should succeed");
        assert!(!dir.path().join(BRAND_FILE_NAME).exists());
        clear(dir.path()).expect("clearing an already-cleared brand should still succeed");
    }

    #[test]
    fn clear_removes_the_logo_too() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), VALID_BRAND_MD).unwrap();
        fs::write(dir.path().join("logo.png"), b"not a real png, just bytes").unwrap();
        assert!(dir.path().join("logo.png").exists());
        clear(dir.path()).unwrap();
        assert!(!dir.path().join("logo.png").exists());
    }

    #[test]
    fn import_copies_brand_and_logo() {
        let src_dir = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        fs::write(src_dir.path().join(BRAND_FILE_NAME), VALID_BRAND_MD).unwrap();
        fs::write(src_dir.path().join("logo.png"), b"logo bytes").unwrap();

        let (config, _warnings) =
            import(dest_dir.path(), &src_dir.path().join(BRAND_FILE_NAME)).unwrap();
        assert_eq!(config.identity.app_name, "Northwind");
        assert!(dest_dir.path().join(BRAND_FILE_NAME).exists());
        assert_eq!(
            fs::read(dest_dir.path().join("logo.png")).unwrap(),
            b"logo bytes"
        );
    }

    #[test]
    fn import_rejects_invalid_source_without_writing() {
        let src_dir = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        fs::write(src_dir.path().join(BRAND_FILE_NAME), "not a brand file").unwrap();

        let err = import(dest_dir.path(), &src_dir.path().join(BRAND_FILE_NAME)).unwrap_err();
        assert!(err.contains("frontmatter"), "error: {err}");
        assert!(!dest_dir.path().join(BRAND_FILE_NAME).exists());
    }

    /// The validator (`provider_core::brand::validate`) already rejects a
    /// traversal-shaped `logo.file` at parse time — `import` never even
    /// reaches the copy step. This asserts that outcome from the import
    /// caller's point of view: a crafted brand.md naming a traversal path
    /// must not import successfully, and must not leave anything on disk.
    #[test]
    fn import_rejects_traversal_named_logo() {
        let src_dir = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        // A real file elsewhere the traversal would otherwise reach.
        let secret_dir = tempfile::tempdir().unwrap();
        fs::write(secret_dir.path().join("secret.txt"), b"do not copy me").unwrap();

        let source = format!(
            r##"+++
schemaVersion = 1

[identity]
appName     = "X"
displayName = "X"

[logo]
file = "../{}/secret.txt"
+++
"##,
            secret_dir.path().file_name().unwrap().to_string_lossy()
        );
        fs::write(src_dir.path().join(BRAND_FILE_NAME), source).unwrap();

        let err = import(dest_dir.path(), &src_dir.path().join(BRAND_FILE_NAME)).unwrap_err();
        assert!(
            err.contains("logo.file") || err.contains("bare filename"),
            "error should point at the logo filename: {err}"
        );
        assert!(
            !dest_dir.path().join(BRAND_FILE_NAME).exists(),
            "nothing should be written when the logo filename fails validation"
        );
        assert!(
            !dest_dir.path().join("secret.txt").exists(),
            "the traversal target must not be copied in"
        );
    }

    #[test]
    fn is_bare_filename_accepts_plain_names_and_rejects_traversal_shapes() {
        assert!(is_bare_filename("logo.png"));
        assert!(!is_bare_filename("../logo.png"));
        assert!(!is_bare_filename("a/logo.png"));
        assert!(!is_bare_filename("a\\logo.png"));
        assert!(!is_bare_filename("~/logo.png"));
        assert!(!is_bare_filename("C:logo.png"));
        assert!(!is_bare_filename(""));
    }

    // -------------------------------------------------------------------
    // Logo storage
    // -------------------------------------------------------------------

    #[test]
    fn save_logo_writes_the_file_and_removes_other_extensions() {
        let dir = tempfile::tempdir().unwrap();
        save_logo(dir.path(), b"png bytes", "png").unwrap();
        assert_eq!(fs::read(dir.path().join("logo.png")).unwrap(), b"png bytes");

        // Re-saving under a different extension must not leave the old one.
        save_logo(dir.path(), b"svg bytes", "svg").unwrap();
        assert!(!dir.path().join("logo.png").exists());
        assert_eq!(fs::read(dir.path().join("logo.svg")).unwrap(), b"svg bytes");
    }

    #[test]
    fn save_logo_overwrites_the_same_extension() {
        let dir = tempfile::tempdir().unwrap();
        save_logo(dir.path(), b"first", "png").unwrap();
        save_logo(dir.path(), b"second", "png").unwrap();
        assert_eq!(fs::read(dir.path().join("logo.png")).unwrap(), b"second");
    }

    #[test]
    fn set_logo_points_brand_md_at_the_file_without_disturbing_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();

        let config = set_logo(dir.path(), "logo.png").unwrap();
        assert_eq!(config.logo.unwrap().file, "logo.png");
        assert_eq!(config.identity.app_name, "Northwind");

        let on_disk = fs::read_to_string(dir.path().join(BRAND_FILE_NAME)).unwrap();
        assert!(on_disk.contains("file = \"logo.png\""));
        assert!(on_disk.contains("appName     = \"Northwind\""));
    }

    #[test]
    fn set_logo_fails_without_an_existing_brand() {
        let dir = tempfile::tempdir().unwrap();
        let err = set_logo(dir.path(), "logo.png").unwrap_err();
        assert!(err.contains("must already exist"), "error: {err}");
    }

    #[test]
    fn clear_logo_removes_file_and_reference_but_keeps_the_rest_of_the_brand() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();
        save_logo(dir.path(), b"logo bytes", "png").unwrap();
        set_logo(dir.path(), "logo.png").unwrap();
        assert!(dir.path().join("logo.png").exists());

        clear_logo(dir.path()).unwrap();

        assert!(!dir.path().join("logo.png").exists());
        let loaded = load(dir.path()).unwrap().unwrap();
        assert!(loaded.config.logo.is_none());
        assert_eq!(loaded.config.identity.app_name, "Northwind");
    }

    #[test]
    fn clear_logo_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        // No brand.md at all.
        clear_logo(dir.path()).expect("clearing with no brand at all must succeed");

        // A brand with no logo.
        set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();
        clear_logo(dir.path()).expect("clearing a brand with no logo must succeed");

        // A brand with a logo, cleared twice.
        save_logo(dir.path(), b"logo bytes", "png").unwrap();
        set_logo(dir.path(), "logo.png").unwrap();
        clear_logo(dir.path()).unwrap();
        clear_logo(dir.path()).expect("clearing an already-cleared logo must still succeed");
        assert!(!dir.path().join("logo.png").exists());
    }

    // -------------------------------------------------------------------
    // apply
    // -------------------------------------------------------------------

    #[test]
    fn apply_renders_a_fresh_brand_md_when_none_exists() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg, _warnings) = brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();

        let (applied, warnings) = apply(dir.path(), &cfg).expect("apply should succeed");
        assert_eq!(applied.identity.app_name, "Northwind");
        assert!(warnings.is_empty());

        let on_disk = fs::read_to_string(dir.path().join(BRAND_FILE_NAME)).unwrap();
        assert!(on_disk.starts_with("+++\n"));
        assert!(on_disk.contains("appName = \"Northwind\""));
    }

    #[test]
    fn apply_merges_into_an_existing_brand_md_preserving_comments() {
        let dir = tempfile::tempdir().unwrap();
        let source = "+++\nschemaVersion = 1\n\n# do not remove this comment\n[identity]\n\
                       appName     = \"Northwind\"\ndisplayName = \"Northwind AI\"\n+++\n\nNotes.\n";
        fs::write(dir.path().join(BRAND_FILE_NAME), source).unwrap();

        let (mut cfg, _warnings) = brand::parse(source).unwrap();
        cfg.identity.display_name = "Northwind Labs".to_string();

        let (applied, _warnings) = apply(dir.path(), &cfg).expect("apply should succeed");
        assert_eq!(applied.identity.display_name, "Northwind Labs");

        let on_disk = fs::read_to_string(dir.path().join(BRAND_FILE_NAME)).unwrap();
        assert!(on_disk.contains("# do not remove this comment\n"));
        assert!(on_disk.contains("appName     = \"Northwind\"\n"));
        assert!(on_disk.contains("displayName = \"Northwind Labs\""));
        assert!(on_disk.contains("Notes.\n"));
    }

    #[test]
    fn apply_rejects_invalid_config_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut cfg, _warnings) = brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();
        cfg.identity.app_name = String::new();

        let err = apply(dir.path(), &cfg).unwrap_err();
        assert!(err.contains("identity.appName"), "error: {err}");
        assert!(!dir.path().join(BRAND_FILE_NAME).exists());
    }

    #[test]
    fn apply_rejects_invalid_config_leaving_existing_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();

        let (mut cfg, _warnings) = brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();
        cfg.identity.app_name = "x".repeat(65);

        let err = apply(dir.path(), &cfg).unwrap_err();
        assert!(err.contains("identity.appName"), "error: {err}");

        let on_disk = fs::read_to_string(dir.path().join(BRAND_FILE_NAME)).unwrap();
        assert_eq!(on_disk, IDENTITY_ONLY_BRAND_MD);
    }

    // -------------------------------------------------------------------
    // export
    // -------------------------------------------------------------------

    #[test]
    fn export_copies_brand_md_and_logo_alongside_it() {
        let branding_dir = tempfile::tempdir().unwrap();
        set(branding_dir.path(), VALID_BRAND_MD).unwrap();
        fs::write(branding_dir.path().join("logo.png"), b"logo bytes").unwrap();

        let dest_dir = tempfile::tempdir().unwrap();
        let dest_path = dest_dir.path().join("brand.md");
        export(branding_dir.path(), &dest_path).expect("export should succeed");

        assert_eq!(
            fs::read_to_string(&dest_path).unwrap(),
            VALID_BRAND_MD,
            "brand.md must be copied verbatim"
        );
        assert_eq!(
            fs::read(dest_dir.path().join("logo.png")).unwrap(),
            b"logo bytes",
            "the logo must land alongside brand.md, under its own filename"
        );
    }

    #[test]
    fn export_fails_and_creates_nothing_when_destination_parent_is_missing() {
        let branding_dir = tempfile::tempdir().unwrap();
        set(branding_dir.path(), IDENTITY_ONLY_BRAND_MD).unwrap();

        let dest_dir = tempfile::tempdir().unwrap();
        let missing_parent = dest_dir.path().join("does-not-exist");
        let dest_path = missing_parent.join("brand.md");

        let err = export(branding_dir.path(), &dest_path).unwrap_err();
        assert!(err.contains("does not exist"), "error: {err}");
        assert!(
            !missing_parent.exists(),
            "export must never create a directory tree"
        );
    }

    #[test]
    fn export_fails_when_there_is_no_brand_to_export() {
        let branding_dir = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        let dest_path = dest_dir.path().join("brand.md");

        let err = export(branding_dir.path(), &dest_path).unwrap_err();
        assert!(err.contains("no brand"), "error: {err}");
        assert!(!dest_path.exists());
    }
}
