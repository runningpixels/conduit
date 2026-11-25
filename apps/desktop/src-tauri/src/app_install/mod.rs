//! Install a saved app on this computer: its own Start menu (Windows),
//! Applications (macOS) or app-menu (Linux) entry, optionally a desktop
//! shortcut, each opening the app in its own window
//! (`conduit-desktop --open-app <id>`, see `app_windows`).
//!
//! The entries are launchers only: the app itself stays in the database, so
//! an edit reaches the installed app with nothing to rewrite. What was
//! written is kept per app in `<data>/installed-apps/<id>/install.json`, next
//! to its icon files, so uninstall removes exactly that and a moved Conduit
//! executable can be repaired (`verify_all`). No database table: an older
//! build opening this profile must not meet a migration it doesn't know.
//!
//! Windows also keeps every entry path in `app-shortcuts.txt` under
//! `%LOCALAPPDATA%\<identifier>`, which the NSIS uninstaller reads (it can't
//! read the database or JSON) to take the shortcuts away with Conduit.

pub mod icons;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::{
    fs,
    path::{Path, PathBuf},
};

use provider_core::schema::{AppIconImage, AppInstallPlace, AppInstallStatus};
use serde::{Deserialize, Serialize};

use crate::app_windows::is_valid_app_id;
use icons::IconPng;

const RECORD_FILE: &str = "install.json";
pub const ICON_PNG: &str = "icon.png";
pub const ICON_ICO: &str = "icon.ico";
pub const ICON_ICNS: &str = "icon.icns";
const MAX_NAME_CHARS: usize = 80;

/// Where installed apps show up on this OS.
pub fn place() -> AppInstallPlace {
    if cfg!(windows) {
        AppInstallPlace::StartMenu
    } else if cfg!(target_os = "macos") {
        AppInstallPlace::Applications
    } else if cfg!(target_os = "linux") {
        AppInstallPlace::AppMenu
    } else {
        AppInstallPlace::Unsupported
    }
}

/// What one install wrote, kept so uninstall and repair know.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub app_id: String,
    pub name: String,
    pub desktop_shortcut: bool,
    /// Files or bundles written, in the order written.
    pub entries: Vec<PathBuf>,
    /// The executable the entries launch (Windows/Linux); repaired if it moves.
    pub exe: PathBuf,
}

/// The folders entries go in. Real ones from [`Roots::system`]; tests point
/// them at a temporary directory.
#[derive(Debug, Clone)]
pub struct Roots {
    /// Windows: Start menu `Programs`. macOS: `~/Applications`. Linux:
    /// `~/.local/share/applications`.
    pub menu: PathBuf,
    /// The user's desktop, if there is one.
    pub desktop: Option<PathBuf>,
}

impl Roots {
    pub fn system() -> Option<Roots> {
        let desktop =
            directories::UserDirs::new().and_then(|d| d.desktop_dir().map(Path::to_path_buf));
        #[cfg(windows)]
        let menu = windows::programs_folder()?;
        #[cfg(target_os = "macos")]
        let menu = directories::BaseDirs::new()?
            .home_dir()
            .join("Applications");
        #[cfg(target_os = "linux")]
        let menu = directories::BaseDirs::new()?
            .data_dir()
            .join("applications");
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        let menu: PathBuf = return None;
        Some(Roots { menu, desktop })
    }
}

/// Everything one install needs, platform-neutral.
#[derive(Debug, Clone)]
pub struct Installer {
    /// `<data>/installed-apps`.
    pub data_dir: PathBuf,
    pub roots: Roots,
    /// The product name, white-label aware (`brand::app_name()`).
    pub brand: String,
    /// The bundle identifier (`tauri.conf.json`), for macOS launchers and
    /// Windows taskbar ids.
    pub identifier: String,
    /// The executable entries launch.
    pub exe: PathBuf,
    /// Windows: the NSIS uninstaller's list of entries.
    pub index_file: Option<PathBuf>,
}

/// One entry to write, as the platform modules get it.
pub(crate) struct EntrySpec<'a> {
    pub app_id: &'a str,
    pub name: &'a str,
    pub file_name: String,
    pub icon_dir: &'a Path,
    pub installer: &'a Installer,
}

impl Installer {
    /// The folder of the installed apps' menu entries.
    pub fn apps_folder(&self) -> PathBuf {
        if cfg!(target_os = "linux") {
            // The XDG applications dir is flat; files are named by id.
            self.roots.menu.clone()
        } else {
            self.roots
                .menu
                .join(format!("{} Apps", sanitize_name(&self.brand)))
        }
    }

    fn app_dir(&self, app_id: &str) -> PathBuf {
        self.data_dir.join(app_id)
    }

    /// The installed app's 256 px icon, for its window.
    pub fn window_icon_png(&self, app_id: &str) -> Option<Vec<u8>> {
        if !is_valid_app_id(app_id) || self.record(app_id).is_none() {
            return None;
        }
        fs::read(self.app_dir(app_id).join(ICON_PNG)).ok()
    }

    /// The installed app's `.ico` (Windows taskbar relaunch icon).
    pub fn ico_path(&self, app_id: &str) -> Option<PathBuf> {
        let path = self.app_dir(app_id).join(ICON_ICO);
        (is_valid_app_id(app_id) && path.is_file()).then_some(path)
    }

    pub fn record(&self, app_id: &str) -> Option<InstallRecord> {
        if !is_valid_app_id(app_id) {
            return None;
        }
        let raw = fs::read_to_string(self.app_dir(app_id).join(RECORD_FILE)).ok()?;
        serde_json::from_str::<InstallRecord>(&raw)
            .ok()
            .filter(|r| r.app_id == app_id)
    }

    fn records(&self) -> Vec<InstallRecord> {
        let Ok(dir) = fs::read_dir(&self.data_dir) else {
            return Vec::new();
        };
        let mut out: Vec<InstallRecord> = dir
            .flatten()
            .filter_map(|e| e.file_name().to_str().and_then(|id| self.record(id)))
            .collect();
        out.sort_by(|a, b| a.app_id.cmp(&b.app_id));
        out
    }

    pub fn status(&self, app_id: &str) -> AppInstallStatus {
        let record = self.record(app_id);
        AppInstallStatus {
            app_id: app_id.to_string(),
            installed: record.is_some(),
            desktop_shortcut: record.is_some_and(|r| r.desktop_shortcut),
            place: place(),
        }
    }

    pub fn list(&self) -> Vec<AppInstallStatus> {
        self.records()
            .into_iter()
            .map(|r| AppInstallStatus {
                app_id: r.app_id,
                installed: true,
                desktop_shortcut: r.desktop_shortcut,
                place: place(),
            })
            .collect()
    }

    /// Install, or refresh an installed app (new name, icon, shortcut
    /// choice): the old entries go first, so a rename leaves no stale one.
    pub fn install(
        &self,
        app_id: &str,
        name: &str,
        images: &[AppIconImage],
        desktop_shortcut: bool,
    ) -> Result<InstallRecord, String> {
        if !is_valid_app_id(app_id) {
            return Err("invalid app id".into());
        }
        if place() == AppInstallPlace::Unsupported {
            return Err("Installing apps isn't supported on this system.".into());
        }
        let icons = icons::validate(images)?;
        let app_dir = self.app_dir(app_id);
        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("could not create {}: {e}", app_dir.display()))?;
        write_icons(&app_dir, &icons)?;
        self.write_entries(app_id, name, desktop_shortcut)
    }

    /// Write (or rewrite) the entries for an app whose icons are in place.
    fn write_entries(
        &self,
        app_id: &str,
        name: &str,
        desktop_shortcut: bool,
    ) -> Result<InstallRecord, String> {
        let app_dir = self.app_dir(app_id);
        if let Some(old) = self.record(app_id) {
            remove_entries(&old.entries);
        }
        let display_name = sanitize_name(name);
        let mut entries = Vec::new();
        let spec = EntrySpec {
            app_id,
            name: &display_name,
            file_name: display_name.clone(),
            icon_dir: &app_dir,
            installer: self,
        };
        if let Err(error) = self.create_entries(&spec, desktop_shortcut, &mut entries) {
            remove_entries(&entries);
            return Err(error);
        }
        let record = InstallRecord {
            app_id: app_id.to_string(),
            name: display_name,
            desktop_shortcut,
            entries,
            exe: self.exe.clone(),
        };
        let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
        fs::write(app_dir.join(RECORD_FILE), json)
            .map_err(|e| format!("could not save the install record: {e}"))?;
        self.write_index();
        notify_menu_changed(&self.apps_folder());
        Ok(record)
    }

    /// Write the menu entry and, if asked, the desktop one. `entries` holds
    /// what was written so far, for the caller to undo on failure.
    fn create_entries(
        &self,
        spec: &EntrySpec,
        desktop_shortcut: bool,
        entries: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        let menu_dir = self.apps_folder();
        fs::create_dir_all(&menu_dir)
            .map_err(|e| format!("could not create {}: {e}", menu_dir.display()))?;
        entries.push(platform_menu_entry(&menu_dir, spec)?);
        if desktop_shortcut && place() != AppInstallPlace::Applications {
            if let Some(desktop) = &self.roots.desktop {
                entries.push(platform_desktop_entry(desktop, spec)?);
            }
        }
        Ok(())
    }

    /// Remove an app's entries and icon files. Not installed is not an error.
    pub fn uninstall(&self, app_id: &str) -> Result<(), String> {
        if !is_valid_app_id(app_id) {
            return Err("invalid app id".into());
        }
        if let Some(record) = self.record(app_id) {
            remove_entries(&record.entries);
        }
        let app_dir = self.app_dir(app_id);
        if app_dir.exists() {
            fs::remove_dir_all(&app_dir)
                .map_err(|e| format!("could not remove {}: {e}", app_dir.display()))?;
        }
        // An empty "<brand> Apps" folder goes too (not the shared Linux one).
        if !cfg!(target_os = "linux") {
            let _ = fs::remove_dir(self.apps_folder());
        }
        self.write_index();
        notify_menu_changed(&self.apps_folder());
        Ok(())
    }

    /// At start: rewrite entries whose executable moved (a reinstall to
    /// another folder, a moved AppImage), and forget installs whose entries
    /// the user deleted by hand. Returns the ids repaired or forgotten.
    pub fn verify_all(&self, exists: impl Fn(&str) -> bool) -> Vec<String> {
        let mut touched = Vec::new();
        for record in self.records() {
            if !exists(&record.app_id) {
                let _ = self.uninstall(&record.app_id);
                touched.push(record.app_id);
                continue;
            }
            let any_left = record.entries.iter().any(|p| p.exists());
            if !any_left {
                let _ = fs::remove_dir_all(self.app_dir(&record.app_id));
                touched.push(record.app_id);
                continue;
            }
            // macOS launchers name the bundle id, not a path.
            if record.exe != self.exe
                && !cfg!(target_os = "macos")
                && self
                    .write_entries(&record.app_id, &record.name, record.desktop_shortcut)
                    .is_ok()
            {
                touched.push(record.app_id);
            }
        }
        if !touched.is_empty() {
            self.write_index();
        }
        touched
    }

    /// Windows only: every entry path, one per line, UTF-16LE with a BOM
    /// (NSIS `FileReadUTF16LE`).
    fn write_index(&self) {
        let Some(index) = &self.index_file else {
            return;
        };
        let lines: Vec<String> = self
            .records()
            .iter()
            .flat_map(|r| r.entries.iter().map(|p| p.display().to_string()))
            .collect();
        if lines.is_empty() {
            let _ = fs::remove_file(index);
            return;
        }
        let text = lines.join("\r\n") + "\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        if let Some(parent) = index.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(error) = fs::write(index, bytes) {
            tracing::warn!(%error, "could not write the app shortcut index");
        }
    }
}

fn write_icons(app_dir: &Path, icons: &[IconPng]) -> Result<(), String> {
    let png = icons::of_size(icons, 256).ok_or("the 256 px icon is missing")?;
    let write = |name: &str, bytes: &[u8]| {
        fs::write(app_dir.join(name), bytes).map_err(|e| format!("could not write {name}: {e}"))
    };
    write(ICON_PNG, &png.bytes)?;
    if cfg!(windows) {
        write(ICON_ICO, &icons::ico(icons))?;
    }
    if cfg!(target_os = "macos") {
        write(ICON_ICNS, &icons::icns(icons))?;
    }
    Ok(())
}

fn remove_entries(entries: &[PathBuf]) {
    for path in entries {
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, path = %path.display(), "could not remove an app entry");
            }
        }
    }
}

#[allow(unused_variables)]
fn platform_menu_entry(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    #[cfg(windows)]
    return windows::write_shortcut(dir, spec);
    #[cfg(target_os = "macos")]
    return macos::write_bundle(dir, spec);
    #[cfg(target_os = "linux")]
    return linux::write_menu_entry(dir, spec);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err("unsupported".into())
}

#[allow(unused_variables)]
fn platform_desktop_entry(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    #[cfg(windows)]
    return windows::write_shortcut(dir, spec);
    #[cfg(target_os = "linux")]
    return linux::write_desktop_entry(dir, spec);
    #[cfg(not(any(windows, target_os = "linux")))]
    Err("unsupported".into())
}

#[allow(unused_variables)]
fn notify_menu_changed(dir: &Path) {
    #[cfg(windows)]
    windows::notify_changed(dir);
    #[cfg(target_os = "linux")]
    linux::notify_changed(dir);
}

/// A file name from an app name: no characters a file system refuses, no
/// trailing dots or spaces, no Windows device names, at most 80 characters.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.chars().take(MAX_NAME_CHARS).collect();
    out = out
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if out.is_empty() {
        return "App".into();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        out.push_str(" app");
    }
    out
}

/// `dir/<name><ext>`, or `dir/<name> (2)<ext>` … when a file of that name is
/// there already and isn't one of `ours`.
pub(crate) fn free_path(dir: &Path, name: &str, ext: &str, ours: &[PathBuf]) -> PathBuf {
    let candidate = dir.join(format!("{name}{ext}"));
    if !candidate.exists() || ours.contains(&candidate) {
        return candidate;
    }
    (2..100)
        .map(|n| dir.join(format!("{name} ({n}){ext}")))
        .find(|p| !p.exists() || ours.contains(p))
        .unwrap_or_else(|| dir.join(format!("{name} ({}){ext}", uuid::Uuid::new_v4())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(sanitize_name("Pomodoro: 25/5"), "Pomodoro 25 5");
        assert_eq!(sanitize_name("  ...  "), "App");
        assert_eq!(sanitize_name("con"), "con app");
        assert_eq!(sanitize_name("Notes."), "Notes");
        assert_eq!(sanitize_name("a\nb\tc"), "a b c");
        assert_eq!(
            sanitize_name(&"x".repeat(200)).chars().count(),
            MAX_NAME_CHARS
        );
        assert_eq!(sanitize_name("Wetter ☀"), "Wetter ☀");
    }

    #[test]
    fn free_path_skips_files_that_are_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        let taken = dir.path().join("Notes.lnk");
        fs::write(&taken, b"x").unwrap();
        assert_eq!(
            free_path(dir.path(), "Notes", ".lnk", &[]),
            dir.path().join("Notes (2).lnk")
        );
        assert_eq!(
            free_path(dir.path(), "Notes", ".lnk", std::slice::from_ref(&taken)),
            taken
        );
        assert_eq!(
            free_path(dir.path(), "Other", ".lnk", &[]),
            dir.path().join("Other.lnk")
        );
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    mod round_trip {
        use super::super::*;
        use crate::app_install::icons::{tests::image, ICON_SIZES};

        fn installer(root: &Path) -> Installer {
            Installer {
                data_dir: root.join("data").join("installed-apps"),
                roots: Roots {
                    menu: root.join("menu"),
                    desktop: Some(root.join("desktop")),
                },
                brand: "Acme".into(),
                identifier: "io.github.runningpixels.conduit".into(),
                exe: root.join("bin").join(if cfg!(windows) {
                    "conduit-desktop.exe"
                } else {
                    "conduit-desktop"
                }),
                index_file: cfg!(windows).then(|| root.join("index").join("app-shortcuts.txt")),
            }
        }

        const ID: &str = "0b7c6a8e-1d2f-4a3b-9c4d-5e6f7a8b9c0d";

        #[test]
        fn install_rename_and_uninstall_leave_nothing_behind() {
            let root = tempfile::tempdir().unwrap();
            fs::create_dir_all(root.path().join("desktop")).unwrap();
            let inst = installer(root.path());
            let images: Vec<_> = ICON_SIZES.iter().map(|s| image(*s)).collect();

            let record = inst.install(ID, "Focus timer", &images, true).unwrap();
            let expected = if cfg!(target_os = "macos") { 1 } else { 2 };
            assert_eq!(record.entries.len(), expected);
            for entry in &record.entries {
                assert!(entry.exists(), "{} written", entry.display());
            }
            assert!(inst.status(ID).installed);
            assert_eq!(inst.list().len(), 1);
            assert!(inst.window_icon_png(ID).is_some());
            if cfg!(windows) {
                assert!(inst.index_file.as_ref().unwrap().exists());
            }

            // A rename replaces the entries instead of adding to them.
            let renamed = inst.install(ID, "Deep work", &images, false).unwrap();
            assert_eq!(renamed.entries.len(), 1);
            for old in &record.entries {
                assert!(!old.exists(), "{} removed on refresh", old.display());
            }
            assert!(renamed.entries[0]
                .to_string_lossy()
                .contains(if cfg!(target_os = "linux") {
                    ID
                } else {
                    "Deep work"
                }));

            inst.uninstall(ID).unwrap();
            assert!(!renamed.entries[0].exists());
            assert!(!inst.status(ID).installed);
            assert!(!inst.data_dir.join(ID).exists());
            if cfg!(windows) {
                assert!(
                    !inst.index_file.as_ref().unwrap().exists(),
                    "empty index removed"
                );
                assert!(!inst.apps_folder().exists(), "empty Apps folder removed");
            }
        }

        #[test]
        fn verify_forgets_deleted_apps_and_hand_removed_entries() {
            let root = tempfile::tempdir().unwrap();
            let inst = installer(root.path());
            let images = vec![image(256)];
            let record = inst.install(ID, "Gone", &images, false).unwrap();
            assert_eq!(inst.verify_all(|_| false), vec![ID.to_string()]);
            assert!(!record.entries[0].exists());

            let record = inst.install(ID, "Removed by hand", &images, false).unwrap();
            remove_entries(&record.entries);
            assert_eq!(inst.verify_all(|_| true), vec![ID.to_string()]);
            assert!(!inst.status(ID).installed);
        }

        #[test]
        #[cfg(not(target_os = "macos"))]
        fn verify_repoints_entries_at_a_moved_executable() {
            let root = tempfile::tempdir().unwrap();
            let inst = installer(root.path());
            inst.install(ID, "Mover", &[image(256)], false).unwrap();
            let mut moved = inst.clone();
            moved.exe = root.path().join("elsewhere").join("conduit-desktop");
            assert_eq!(moved.verify_all(|_| true), vec![ID.to_string()]);
            assert_eq!(moved.record(ID).unwrap().exe, moved.exe);
            assert!(
                moved.verify_all(|_| true).is_empty(),
                "nothing left to repair"
            );
        }

        #[test]
        fn refuses_bad_ids() {
            let root = tempfile::tempdir().unwrap();
            let inst = installer(root.path());
            assert!(inst.install("../evil", "x", &[image(256)], false).is_err());
            assert!(inst.uninstall("a/b").is_err());
            assert!(!inst.status("..").installed);
        }
    }
}
