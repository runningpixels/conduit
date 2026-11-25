//! Linux: a freedesktop `.desktop` entry in `~/.local/share/applications`
//! (named by app id, so renames don't collide), and optionally a copy on the
//! desktop marked trusted. `Exec` is the Conduit executable — the AppImage
//! when running from one — with `--open-app <id>`.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use super::{free_path, EntrySpec};

/// Quote an `Exec` argument per the Desktop Entry spec.
fn exec_quote(arg: &str) -> String {
    let mut out = String::from("\"");
    for c in arg.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    // `%` is a field code everywhere in the line.
    out.replace('%', "%%")
}

/// A value for a string key: one line, `\` escaped.
fn value(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('\n', " ")
        .replace('\r', " ")
        .replace('\t', " ")
}

pub(super) fn desktop_entry(spec: &EntrySpec) -> String {
    let exe = spec.installer.exe.display().to_string();
    let icon = spec.icon_dir.join(super::ICON_PNG).display().to_string();
    format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName={name}\nComment={comment}\nExec={exe} {arg} {id}\nIcon={icon}\nTerminal=false\nCategories=Utility;\nX-App-Id={id}\n",
        name = value(spec.name),
        comment = value(&format!("{} app", spec.installer.brand)),
        exe = exec_quote(&exe),
        arg = crate::app_windows::OPEN_APP_ARG,
        id = spec.app_id,
        icon = value(&icon),
    )
}

pub(super) fn write_menu_entry(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    let ident = spec
        .installer
        .identifier
        .replace(|c: char| !c.is_ascii_alphanumeric() && c != '.', "-");
    let path = dir.join(format!("{ident}.app-{}.desktop", spec.app_id));
    write_entry(&path, spec, false)?;
    Ok(path)
}

pub(super) fn write_desktop_entry(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    let path = free_path(dir, &spec.file_name, ".desktop", &[]);
    write_entry(&path, spec, true)?;
    Ok(path)
}

fn write_entry(path: &Path, spec: &EntrySpec, trusted: bool) -> Result<(), String> {
    fs::write(path, desktop_entry(spec))
        .and_then(|_| fs::set_permissions(path, fs::Permissions::from_mode(0o755)))
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    if trusted {
        // GNOME shows untrusted desktop launchers as plain files.
        let _ = Command::new("gio")
            .args(["set"])
            .arg(path)
            .args(["metadata::trusted", "true"])
            .output();
    }
    Ok(())
}

pub(super) fn notify_changed(dir: &Path) {
    let _ = Command::new("update-desktop-database").arg(dir).output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_arguments_are_quoted_and_percent_escaped() {
        assert_eq!(
            exec_quote("/opt/My Apps/conduit"),
            "\"/opt/My Apps/conduit\""
        );
        assert_eq!(exec_quote("/x/$HOME/100%"), "\"/x/\\$HOME/100%%\"");
    }

    #[test]
    fn values_stay_on_one_line() {
        assert_eq!(value("a\nb\\c"), "a b\\\\c");
    }
}
