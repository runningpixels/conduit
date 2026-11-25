//! macOS: a tiny launcher bundle in `~/Applications/<brand> Apps/<Name>.app`.
//!
//! Its executable is a shell script that runs
//! `open -n -b <identifier> --args --open-app <id>`. `-n` starts a new
//! Conduit process even when one is running, so the arguments always arrive:
//! the single-instance plugin hands them to the running Conduit and the new
//! process exits; with none running, it becomes Conduit. The launcher is
//! `LSUIElement`, so it never shows in the Dock itself. It is written
//! locally, so it carries no quarantine flag; it is ad-hoc signed so Apple
//! silicon runs it without complaint.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use super::{free_path, EntrySpec};

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn identifier_is_safe(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

pub(super) fn info_plist(identifier: &str, app_id: &str, name: &str) -> String {
    let name = xml_escape(name);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>{identifier}.app.{app_id}</string>
  <key>CFBundleName</key><string>{name}</string>
  <key>CFBundleDisplayName</key><string>{name}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
"#
    )
}

pub(super) fn launch_script(identifier: &str, app_id: &str) -> String {
    format!(
        "#!/bin/sh\nexec /usr/bin/open -n -b '{identifier}' --args {} '{app_id}'\n",
        crate::app_windows::OPEN_APP_ARG
    )
}

pub(super) fn write_bundle(dir: &Path, spec: &EntrySpec) -> Result<PathBuf, String> {
    let identifier = &spec.installer.identifier;
    if !identifier_is_safe(identifier) {
        return Err(format!("unexpected bundle identifier {identifier}"));
    }
    let bundle = free_path(dir, &spec.file_name, ".app", &[]);
    let write = || -> std::io::Result<()> {
        let contents = bundle.join("Contents");
        let macos = contents.join("MacOS");
        let resources = contents.join("Resources");
        fs::create_dir_all(&macos)?;
        fs::create_dir_all(&resources)?;
        fs::write(
            contents.join("Info.plist"),
            info_plist(identifier, spec.app_id, spec.name),
        )?;
        let script = macos.join("launch");
        fs::write(&script, launch_script(identifier, spec.app_id))?;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
        let icns = spec.icon_dir.join(super::ICON_ICNS);
        if icns.is_file() {
            fs::copy(&icns, resources.join("AppIcon.icns"))?;
        }
        Ok(())
    };
    if let Err(error) = write() {
        let _ = fs::remove_dir_all(&bundle);
        return Err(format!("could not create {}: {error}", bundle.display()));
    }
    // Best effort: unsigned still opens (it was made here), signed is cleaner.
    let _ = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&bundle)
        .output();
    // Tell Launch Services (Spotlight, Launchpad) about it.
    let _ = Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .arg("-f")
    .arg(&bundle)
    .output();
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_escapes_the_name_and_names_the_bundle_by_app() {
        let plist = info_plist("io.example.conduit", "abc-123", "Tom & Jerry <3>");
        assert!(plist.contains("<string>Tom &amp; Jerry &lt;3&gt;</string>"));
        assert!(plist.contains("<string>io.example.conduit.app.abc-123</string>"));
    }

    #[test]
    fn launcher_opens_conduit_with_the_app() {
        assert_eq!(
            launch_script("io.example.conduit", "abc-123"),
            "#!/bin/sh\nexec /usr/bin/open -n -b 'io.example.conduit' --args --open-app 'abc-123'\n"
        );
        assert!(!identifier_is_safe("x'; rm -rf ~"));
    }
}
