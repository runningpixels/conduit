//! Where `export_file` steps write: the app's exports folder, in a subfolder
//! named after the workflow, under a plain file name.

use std::path::{Path, PathBuf};

use super::definition::{EXPORT_EXTENSIONS, MAX_EXPORT_NAME_CHARS};

/// Most bytes one export may hold.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// Longest subfolder name made from a workflow's name.
const MAX_FOLDER_CHARS: usize = 60;

/// Names Windows reserves, which can't be files whatever their extension.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The subfolder for a workflow called `workflow_name`: its name with what a
/// folder name can't hold replaced.
pub fn folder_name(workflow_name: &str) -> String {
    let cleaned: String = workflow_name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned: String = cleaned
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take(MAX_FOLDER_CHARS)
        .collect();
    let cleaned = cleaned.trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() {
        "workflow".to_string()
    } else if RESERVED.contains(&cleaned.to_ascii_uppercase().as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// The file name to use for `name` (`.md` added when it has no extension), or
/// why it can't be used.
pub fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("The file name came out empty.".to_string());
    }
    if name.chars().count() > MAX_EXPORT_NAME_CHARS {
        return Err(format!(
            "The file name is too long (up to {MAX_EXPORT_NAME_CHARS} characters)."
        ));
    }
    if name.contains(['/', '\\']) || name.contains("..") || name.contains(':') {
        return Err(format!(
            "\"{name}\" isn't a plain file name. Use a name without folders, such as report.md."
        ));
    }
    if name
        .chars()
        .any(|c| c.is_control() || "<>\"|?*".contains(c))
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
    {
        return Err(format!("\"{name}\" can't be used as a file name."));
    }
    let name = match name.rsplit_once('.') {
        None => format!("{name}.md"),
        Some((stem, extension)) => {
            if !EXPORT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()) {
                return Err(format!(
                    "Files can be exported as {} (not .{extension}).",
                    EXPORT_EXTENSIONS
                        .iter()
                        .map(|e| format!(".{e}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if stem.is_empty() {
                return Err(format!("\"{name}\" can't be used as a file name."));
            }
            name.to_string()
        }
    };
    let stem = name
        .rsplit_once('.')
        .map_or(name.as_str(), |(stem, _)| stem);
    if RESERVED.contains(&stem.to_ascii_uppercase().as_str()) {
        return Err(format!("\"{name}\" can't be used as a file name."));
    }
    Ok(name)
}

/// Where `name` goes for the workflow `workflow_name`: the file's full path
/// and its final name.
pub fn target(
    exports: &Path,
    workflow_name: &str,
    name: &str,
) -> Result<(PathBuf, String), String> {
    let name = checked_name(name)?;
    Ok((exports.join(folder_name(workflow_name)).join(&name), name))
}

/// The folder to show for `path`, a file or folder inside `exports`; `Err`
/// for anything outside it (a path can't be used to open an arbitrary
/// folder).
pub fn reveal_target(exports: &Path, path: &str) -> Result<PathBuf, String> {
    let outside = || "That file isn't in the exports folder.".to_string();
    let root = exports.canonicalize().map_err(|_| outside())?;
    let wanted = Path::new(path.trim())
        .canonicalize()
        .map_err(|_| "That file isn't there any more.".to_string())?;
    if !wanted.starts_with(&root) {
        return Err(outside());
    }
    if wanted.is_file() {
        Ok(wanted.parent().map(Path::to_path_buf).unwrap_or(wanted))
    } else {
        Ok(wanted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_inbox_starter_name_reads_well_for_any_file() {
        // `{{trigger.name}} summary.md` for a `list2.txt` and for a name with no extension.
        assert_eq!(
            checked_name("list2.txt summary.md").unwrap(),
            "list2.txt summary.md"
        );
        assert_eq!(
            checked_name("notes summary.md").unwrap(),
            "notes summary.md"
        );
    }

    #[test]
    fn only_things_in_the_exports_folder_can_be_revealed() {
        let dir = tempfile::tempdir().unwrap();
        let exports = dir.path().join("exports");
        let sub = exports.join("Digest");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.md");
        std::fs::write(&file, "x").unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "x").unwrap();

        let shown = reveal_target(&exports, file.to_str().unwrap()).unwrap();
        assert_eq!(shown, sub.canonicalize().unwrap());
        let shown = reveal_target(&exports, sub.to_str().unwrap()).unwrap();
        assert_eq!(shown, sub.canonicalize().unwrap());
        assert!(reveal_target(&exports, outside.to_str().unwrap()).is_err());
        let sneaky = sub.join("..").join("..").join("secret.txt");
        assert!(reveal_target(&exports, sneaky.to_str().unwrap()).is_err());
        assert!(reveal_target(&exports, "").is_err());
    }

    #[test]
    fn plain_names_are_kept_and_a_missing_extension_becomes_md() {
        assert_eq!(checked_name("report.csv").unwrap(), "report.csv");
        assert_eq!(checked_name("  Notes 2026.TXT ").unwrap(), "Notes 2026.TXT");
        assert_eq!(checked_name("digest").unwrap(), "digest.md");
        assert_eq!(checked_name("a.b.json").unwrap(), "a.b.json");
    }

    #[test]
    fn paths_odd_names_and_other_types_are_refused() {
        for bad in [
            "",
            "   ",
            "../x.md",
            "a/b.md",
            "a\\b.md",
            "..",
            "C:x.md",
            "x..md",
            ".hidden.md",
            "run.exe",
            "run.",
            "con.txt",
            "a|b.md",
            ".md",
        ] {
            assert!(checked_name(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(checked_name(&format!("{}.md", "a".repeat(120))).is_err());
        assert!(checked_name(&format!("{}.md", "a".repeat(100))).is_ok());
    }

    #[test]
    fn the_subfolder_is_the_workflows_name_made_safe() {
        assert_eq!(folder_name("New posts digest"), "New posts digest");
        assert_eq!(folder_name("Q1/Q2: plan?"), "Q1_Q2_ plan_");
        assert_eq!(folder_name("..."), "workflow");
        assert_eq!(folder_name(" CON "), "_CON");
        assert_eq!(folder_name(&"x".repeat(100)).chars().count(), 60);
    }

    #[test]
    fn the_target_is_inside_the_exports_folder() {
        let (path, name) = target(Path::new("/data/exports"), "Digest", "today").unwrap();
        assert_eq!(name, "today.md");
        assert_eq!(
            path,
            Path::new("/data/exports").join("Digest").join("today.md")
        );
    }
}
