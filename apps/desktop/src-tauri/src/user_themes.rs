// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Filesystem loader for user theme files (theming Phase 5,
//! `docs/theming/user-themes.md`).
//!
//! Mirrors `crate::branding`'s split from `provider_core::brand`: parsing
//! and validation live in `provider_core::user_theme` (pure, no IO); this
//! module owns the directory scan -- deciding which files in
//! `AppPaths::themes` even look like a theme file, reading them under the
//! same size cap the parser enforces, and turning a read/parse failure into
//! a listing entry rather than losing the file or panicking.
//!
//! ## Why the directory scan cannot simply trust the parser's own size cap
//!
//! `provider_core::user_theme::parse_user_theme` takes a `&str` it has
//! already been handed in full -- by the time it runs, the bytes are
//! already in memory. [`list`] is what decides how many bytes to read in
//! the first place, and does so defensively: `fs::metadata` is checked
//! *before* opening the file (so an obviously oversized file is never read
//! at all), and the read itself is still bounded via `Read::take` one byte
//! past the cap (so a file that grows between the metadata check and the
//! read -- a TOCTOU window, however small -- is caught as oversized rather
//! than silently truncated or allowed through).

use std::{
    fs,
    io::Read as _,
    path::{Path, PathBuf},
};

use provider_core::{
    schema::UserThemeEntry,
    user_theme::{parse_user_theme, MAX_USER_THEME_BYTES},
};

/// Directory scans are non-recursive and bounded. Above this many matching
/// files, [`list`] stops reading further ones and appends one synthetic
/// [`UserThemeEntry`] (id `_overflow`) explaining that the rest were
/// ignored, rather than either reading an unbounded number of files on every
/// launch or silently dropping them with no explanation at all.
const MAX_THEME_ENTRIES: usize = 32;

/// The id [`list`] gives its synthetic "too many files" entry. Not a legal
/// stem under [`is_theme_file_name`] (it contains `_`), so it can never
/// collide with a real file's id.
const OVERFLOW_ENTRY_ID: &str = "_overflow";

/// List every user theme file directly inside `dir`.
///
/// Non-recursive. Only entries whose file name matches
/// [`is_theme_file_name`] are considered at all -- everything else (a
/// `README.md`, a stray `.DS_Store`, a subdirectory) is silently skipped,
/// not reported as an error, the same "ignore what doesn't look like ours"
/// stance a `themes` folder full of unrelated files should get. Entries are
/// sorted by file name for a stable, predictable picker order.
///
/// An IO error reading `dir` itself (missing, permissions, not a directory)
/// returns an empty list rather than an error or a panic -- `AppPaths`
/// creates this directory at startup, so its absence at scan time means
/// something unusual happened to it after the fact, and the theme picker
/// should degrade to "no user themes" rather than fail the caller.
pub fn list(dir: &Path) -> Vec<UserThemeEntry> {
    let read_dir = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            tracing::warn!("failed to read themes directory {}: {err}", dir.display());
            return Vec::new();
        }
    };

    let mut names: Vec<String> = Vec::new();
    for entry in read_dir {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                tracing::warn!("failed to read a themes directory entry: {err}");
                continue;
            }
        };

        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            // Non-UTF-8 file names cannot match the grammar (which is
            // ASCII-only) and cannot be round-tripped through the JSON IPC
            // boundary either -- skip rather than error.
            continue;
        };
        if !is_theme_file_name(&name) {
            continue;
        }

        // No symlinks, no directories -- `symlink_metadata` (unlike
        // `metadata`) reports the link itself rather than following it, so
        // a symlink's `file_type()` is never `is_file()` here regardless of
        // what it points at.
        let is_regular_file = entry
            .path()
            .symlink_metadata()
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        if !is_regular_file {
            continue;
        }

        names.push(name);
    }
    names.sort();

    let total = names.len();
    let overflow_count = total.saturating_sub(MAX_THEME_ENTRIES);
    names.truncate(MAX_THEME_ENTRIES);

    let mut entries: Vec<UserThemeEntry> = names
        .into_iter()
        .map(|name| load_entry(dir, &name))
        .collect();

    if overflow_count > 0 {
        entries.push(UserThemeEntry {
            id: OVERFLOW_ENTRY_ID.to_string(),
            file_name: String::new(),
            theme: None,
            error: Some(format!(
                "{overflow_count} more theme file(s) were found in the themes folder beyond \
                 the {MAX_THEME_ENTRIES}-file limit and were not loaded -- remove some files \
                 to see the rest"
            )),
        });
    }

    entries
}

/// `^[a-z0-9][a-z0-9-]{0,39}\.theme\.md$`, hand-rolled -- the same "a fixed,
/// closed grammar does not need the `regex` crate" reasoning
/// `provider_core::brand::is_valid_hex_color` documents for its own grammar.
/// The stem (everything before `.theme.md`) is 1-40 characters: a lowercase
/// letter or digit, then up to 39 more lowercase letters, digits, or
/// hyphens.
fn is_theme_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".theme.md") else {
        return false;
    };
    let mut chars = stem.chars();
    let Some(first) = chars.next() else {
        return false; // empty stem
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    if stem.chars().count() > 40 {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Read and parse one theme file already known to match
/// [`is_theme_file_name`], turning any failure into `theme: None, error:
/// Some(..)` rather than propagating it -- a themes folder is scanned
/// unattended, so one bad file must not stop the rest of the picker from
/// working.
fn load_entry(dir: &Path, file_name: &str) -> UserThemeEntry {
    let id = file_name
        .strip_suffix(".theme.md")
        .unwrap_or(file_name)
        .to_string();
    let path: PathBuf = dir.join(file_name);

    let error = match read_bounded(&path) {
        Ok(source) => match parse_user_theme(&source) {
            Ok(theme) => {
                return UserThemeEntry {
                    id,
                    file_name: file_name.to_string(),
                    theme: Some(theme),
                    error: None,
                };
            }
            Err(err) => err.to_string(),
        },
        Err(message) => message,
    };

    UserThemeEntry {
        id,
        file_name: file_name.to_string(),
        theme: None,
        error: Some(error),
    }
}

/// Read `path` as UTF-8 text, refusing anything over
/// [`MAX_USER_THEME_BYTES`] -- checked once via `fs::metadata` before ever
/// opening the file (so an obviously oversized file is never read at all),
/// and enforced again on the bytes actually read via `Read::take` one byte
/// past the cap, so a file that grows between the two checks is still
/// caught rather than silently accepted up to whatever the OS handed back.
fn read_bounded(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    if metadata.len() > MAX_USER_THEME_BYTES as u64 {
        return Err(format!(
            "theme file is {} bytes, over the {MAX_USER_THEME_BYTES} byte limit for user theme \
             files",
            metadata.len()
        ));
    }

    let file =
        fs::File::open(path).map_err(|err| format!("failed to open {}: {err}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_USER_THEME_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    if bytes.len() as u64 > MAX_USER_THEME_BYTES as u64 {
        return Err(format!(
            "theme file is over the {MAX_USER_THEME_BYTES} byte limit for user theme files"
        ));
    }

    String::from_utf8(bytes).map_err(|_| format!("{} is not valid UTF-8", path.display()))
}

/// A fully-commented, self-contained example theme that
/// [`provider_core::user_theme::parse_user_theme`] parses successfully
/// (see the `template_parses` test below). Written verbatim to
/// `<themes>/example.theme.md` by the `create_example_user_theme` command
/// the first time it is asked for, and never overwritten afterwards.
pub const USER_THEME_TEMPLATE: &str = r##"+++
# example.theme.md -- user theme template
#
# Copy this file, or use "Add example theme" in Settings -> Appearance
# (which writes this exact template to <themes>/example.theme.md), then
# edit the values -- or hand the whole file to an LLM and ask it to build a
# theme around a colour or a vibe.
#
# THE ONE GOTCHA THAT MATTERS: this is TOML frontmatter (delimited by the
# `+++` lines), and in TOML `#` starts a comment. A hex colour MUST be
# quoted:
#
#   hue = "#268bd2"      -- correct, the value is the string "#268bd2"
#   hue = #268bd2        -- WRONG, everything after the `#` is a comment,
#                           so this line sets no value at all and the file
#                           fails to parse with a "missing field" error.
#
# Only the frontmatter (between the two `+++` lines) is read by the app.
# The Markdown body below the closing `+++` is never parsed -- see the
# bottom of this file for what it is for.

schemaVersion = 1

# Shown in the theme picker. 1-48 characters, no control characters.
name = "Example Theme"

# Optional. One line shown under the name in the picker. Up to 160
# characters.
description = "A Solarized-inspired variant of Graphite."

# Which built-in theme this one starts from. Anything this theme does not
# override below -- colours or structure -- keeps that base theme's value.
# Must be one of the built-in theme ids:
#   conduit-orange-charcoal, conduit-orange-dark, conduit-terra,
#   amber-terminal, green-phosphor, amber-paper, graphite, editorial,
#   high-contrast
extends = "graphite"

# ---- Structure: closed choices only, never a raw CSS value ----
#
# Every key below is optional -- omit any you don't want to override and
# extends's own choice applies instead. All seven are set here so you can
# see every option; delete the ones you don't need.
[structure]
# Corner radius family: square | subtle | rounded | soft
corners = "soft"
# Bundled UI face: sans | serif | mono
uiFont = "sans"
# Bundled face for assistant prose (the "Reading font" override): sans | serif | mono
readingFont = "serif"
# Section label styling: plain | uppercase | small-caps
labels = "plain"
# Elevation style: none | soft
shadows = "soft"
# Transitions: none | standard
motion = "standard"
# Icon stroke weight: thin | regular | bold
iconStroke = "regular"

# ---- Palette: colour overrides ----
#
# Optional -- omit [palette] entirely to keep extends's own colours. If you
# do specify it, at least one of [palette.dark] / [palette.light] is
# required, and each table you specify must set all eighteen keys below.
# The mode(s) you specify here become this theme's modes (both dark and
# light if you specify both tables; dark-only if you specify just
# [palette.dark]).
#
# Values are hex only: #rgb or #rrggbb. brand.md also accepts an 8-digit
# #rrggbbaa alpha form; a user theme does not -- a translucent surface
# colour breaks contrast math against a base theme's own structure, which a
# user theme (unlike a brand) does not otherwise control.
[palette.dark]
bg       = "#002b36"  # app ground -- Solarized base03
bgSide   = "#073642"  # sidebar / rail ground -- Solarized base02
card     = "#073642"  # raised surface -- message bubbles, panels
cardHi   = "#0a4552"  # hovered/active card
line     = "#0c4a58"  # default border
lineSoft = "#06404d"  # subdued divider
lineHi   = "#145c6e"  # emphasised border
ink      = "#eee8d5"  # primary text -- Solarized base2
ink2     = "#93a1a1"  # secondary text -- Solarized base1
ink3     = "#839496"  # tertiary text -- Solarized base0
hue      = "#268bd2"  # accent -- Solarized blue
hueText  = "#5bc0ff"  # accent tuned for text-on-background contrast
hueSolid = "#1b6fa8"  # accent as a solid fill (buttons)
onHue    = "#ffffff"  # text drawn on top of hueSolid
ok       = "#859900"  # success -- Solarized green
warn     = "#b58900"  # warning -- Solarized yellow
err      = "#dc322f"  # error -- Solarized red
link     = "#2aa198"  # hyperlink -- Solarized cyan
+++

# Example Theme -- notes

This section is never parsed -- it is prose for you, and for an LLM you ask
to revise this theme later. Describe what the palette is going for and why.

This template is Solarized Dark-inspired, applied on top of the Graphite
look. Delete the [palette.dark] table above (or the whole [palette]
section) to inherit Graphite's own colours instead and only change
structure.
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    const VALID_THEME: &str =
        "+++\nschemaVersion = 1\nname = \"Valid\"\nextends = \"graphite\"\n+++\n";

    #[test]
    fn template_parses() {
        parse_user_theme(USER_THEME_TEMPLATE).expect("the bundled template must parse cleanly");
    }

    #[test]
    fn valid_and_invalid_files_are_both_listed() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "good.theme.md", VALID_THEME);
        write(dir.path(), "bad.theme.md", "not a theme file at all");

        let entries = list(dir.path());
        assert_eq!(entries.len(), 2);

        let good = entries.iter().find(|e| e.id == "good").unwrap();
        assert!(good.theme.is_some());
        assert!(good.error.is_none());
        assert_eq!(good.file_name, "good.theme.md");

        let bad = entries.iter().find(|e| e.id == "bad").unwrap();
        assert!(bad.theme.is_none());
        assert!(bad.error.is_some());
    }

    #[test]
    fn non_matching_names_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Bad.theme.md", VALID_THEME); // uppercase
        write(dir.path(), "x.md", VALID_THEME); // wrong suffix
        write(dir.path(), "-leading.theme.md", VALID_THEME); // starts with '-'
        write(dir.path(), "..theme.md", VALID_THEME); // empty stem before dots
        fs::create_dir(dir.path().join("subdir.theme.md")).unwrap(); // a directory, not a file

        let entries = list(dir.path());
        assert!(entries.is_empty(), "expected no matches, got {entries:?}");
    }

    #[test]
    fn oversize_file_is_rejected_with_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let oversized = "a".repeat(MAX_USER_THEME_BYTES + 1);
        write(dir.path(), "big.theme.md", &oversized);

        let entries = list(dir.path());
        assert_eq!(entries.len(), 1);
        assert!(entries[0].theme.is_none());
        assert!(entries[0].error.as_ref().unwrap().contains("byte limit"));
    }

    #[test]
    fn missing_directory_yields_an_empty_list_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(list(&missing).is_empty());
    }

    #[test]
    fn sort_order_is_by_file_name() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "zeta.theme.md", VALID_THEME);
        write(dir.path(), "alpha.theme.md", VALID_THEME);
        write(dir.path(), "mid.theme.md", VALID_THEME);

        let entries = list(dir.path());
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["alpha", "mid", "zeta"]);
    }

    #[test]
    fn overflow_beyond_the_cap_is_reported_as_one_synthetic_entry() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_THEME_ENTRIES + 5) {
            write(dir.path(), &format!("theme{i:03}.theme.md"), VALID_THEME);
        }

        let entries = list(dir.path());
        assert_eq!(entries.len(), MAX_THEME_ENTRIES + 1);
        let overflow = entries.last().unwrap();
        assert_eq!(overflow.id, OVERFLOW_ENTRY_ID);
        assert!(overflow.error.as_ref().unwrap().contains('5'));
        // Every loaded (non-overflow) entry parsed successfully.
        assert!(entries[..MAX_THEME_ENTRIES]
            .iter()
            .all(|e| e.theme.is_some()));
    }

    #[test]
    fn is_theme_file_name_grammar() {
        assert!(is_theme_file_name("a.theme.md"));
        assert!(is_theme_file_name("my-theme-1.theme.md"));
        assert!(!is_theme_file_name("Bad.theme.md"));
        assert!(!is_theme_file_name("-a.theme.md"));
        assert!(!is_theme_file_name(".theme.md"));
        assert!(!is_theme_file_name("a.md"));
        assert!(!is_theme_file_name("a.theme.md.bak"));
        assert!(!is_theme_file_name(&format!("{}.theme.md", "a".repeat(41))));
    }

    // Symlinks are only exercised where the platform lets a test create one
    // without elevated privilege -- Windows requires Developer Mode or admin
    // for `std::os::windows::fs::symlink_file`, which most CI/dev machines do
    // not have, so this must skip rather than fail when creation itself is
    // refused.
    #[test]
    fn symlinks_are_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.theme.md");
        write(dir.path(), "real.theme.md", VALID_THEME);
        let link = dir.path().join("link.theme.md");

        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target, &link).is_ok();
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(not(any(unix, windows)))]
        let created = false;

        if !created {
            eprintln!("skipping symlinks_are_not_listed: could not create a symlink on this platform/privilege level");
            return;
        }

        let entries = list(dir.path());
        assert_eq!(
            entries.len(),
            1,
            "the symlink must not be listed, only the real file"
        );
        assert_eq!(entries[0].id, "real");
    }
}
