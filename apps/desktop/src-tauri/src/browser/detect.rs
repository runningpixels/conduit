// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Which Chromium browsers are installed, from the places each puts itself.
//! No registry lookups: the known install folders are enough. Everything that
//! reads the machine goes through [`Env`] and an `exists` function, so tests
//! run against made-up roots.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// A browser agents may drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Browser {
    Edge,
    Chrome,
    Brave,
    Chromium,
}

impl Browser {
    /// The value stored in settings.
    pub fn id(self) -> &'static str {
        match self {
            Browser::Edge => "edge",
            Browser::Chrome => "chrome",
            Browser::Brave => "brave",
            Browser::Chromium => "chromium",
        }
    }

    /// What the user sees.
    pub fn name(self) -> &'static str {
        match self {
            Browser::Edge => "Microsoft Edge",
            Browser::Chrome => "Google Chrome",
            Browser::Brave => "Brave",
            Browser::Chromium => "Chromium",
        }
    }

    /// What tool results say (`browser: "Edge"`).
    pub fn short_name(self) -> &'static str {
        match self {
            Browser::Edge => "Edge",
            Browser::Chrome => "Chrome",
            Browser::Brave => "Brave",
            Browser::Chromium => "Chromium",
        }
    }

    pub fn from_id(id: &str) -> Option<Browser> {
        [
            Browser::Edge,
            Browser::Chrome,
            Browser::Brave,
            Browser::Chromium,
        ]
        .into_iter()
        .find(|b| b.id() == id)
    }

    pub fn from_name(name: &str) -> Option<Browser> {
        [
            Browser::Edge,
            Browser::Chrome,
            Browser::Brave,
            Browser::Chromium,
        ]
        .into_iter()
        .find(|b| b.name().eq_ignore_ascii_case(name.trim()))
    }
}

/// An installed browser, as the renderer lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub id: String,
    pub name: String,
}

impl From<Browser> for BrowserInfo {
    fn from(browser: Browser) -> Self {
        BrowserInfo {
            id: browser.id().to_string(),
            name: browser.name().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// The folders install paths hang off.
#[derive(Debug, Clone)]
pub struct Env {
    pub os: Os,
    pub program_files: Option<PathBuf>,
    pub program_files_x86: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub home: Option<PathBuf>,
    /// The folders on `PATH` (Linux looks browsers up by name).
    pub path_dirs: Vec<PathBuf>,
}

impl Env {
    pub fn current() -> Env {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Env {
            os: Os::current(),
            program_files: var("ProgramFiles"),
            program_files_x86: var("ProgramFiles(x86)"),
            local_app_data: var("LOCALAPPDATA"),
            home: var("HOME").or_else(|| var("USERPROFILE")),
            path_dirs: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
        }
    }
}

/// The browsers in the order agents prefer them.
pub fn preference(os: Os) -> [Browser; 4] {
    match os {
        Os::Windows => [
            Browser::Edge,
            Browser::Chrome,
            Browser::Brave,
            Browser::Chromium,
        ],
        _ => [
            Browser::Chrome,
            Browser::Brave,
            Browser::Edge,
            Browser::Chromium,
        ],
    }
}

/// Where `browser`'s program may be, most likely first.
pub fn candidates(browser: Browser, env: &Env) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match env.os {
        Os::Windows => {
            let (folder, exe) = match browser {
                Browser::Edge => ("Microsoft/Edge/Application", "msedge.exe"),
                Browser::Chrome => ("Google/Chrome/Application", "chrome.exe"),
                Browser::Brave => ("BraveSoftware/Brave-Browser/Application", "brave.exe"),
                Browser::Chromium => ("Chromium/Application", "chrome.exe"),
            };
            for root in [
                &env.program_files,
                &env.program_files_x86,
                &env.local_app_data,
            ]
            .into_iter()
            .flatten()
            {
                out.push(root.join(folder).join(exe));
            }
        }
        Os::Mac => {
            let app = match browser {
                Browser::Edge => "Microsoft Edge",
                Browser::Chrome => "Google Chrome",
                Browser::Brave => "Brave Browser",
                Browser::Chromium => "Chromium",
            };
            let inside = format!("{app}.app/Contents/MacOS/{app}");
            out.push(Path::new("/Applications").join(&inside));
            if let Some(home) = &env.home {
                out.push(home.join("Applications").join(&inside));
            }
        }
        Os::Linux => {
            let names: &[&str] = match browser {
                Browser::Edge => &["microsoft-edge-stable", "microsoft-edge"],
                Browser::Chrome => &["google-chrome-stable", "google-chrome"],
                Browser::Brave => &["brave-browser", "brave"],
                Browser::Chromium => &["chromium", "chromium-browser"],
            };
            for name in names {
                for dir in &env.path_dirs {
                    out.push(dir.join(name));
                }
            }
        }
    }
    out
}

/// Where `browser` is installed, if it is.
pub fn find(browser: Browser, env: &Env, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates(browser, env).into_iter().find(|p| exists(p))
}

/// The installed browsers with their programs, in preference order.
pub fn installed(env: &Env, exists: &dyn Fn(&Path) -> bool) -> Vec<(Browser, PathBuf)> {
    preference(env.os)
        .into_iter()
        .filter_map(|b| find(b, env, exists).map(|p| (b, p)))
        .collect()
}

/// [`installed`] on this machine.
pub fn installed_now() -> Vec<(Browser, PathBuf)> {
    installed(&Env::current(), &|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn windows() -> Env {
        Env {
            os: Os::Windows,
            program_files: Some(PathBuf::from("C:/PF")),
            program_files_x86: Some(PathBuf::from("C:/PF86")),
            local_app_data: Some(PathBuf::from("C:/Local")),
            home: None,
            path_dirs: Vec::new(),
        }
    }

    fn fake(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p| set.contains(p)
    }

    #[test]
    fn windows_looks_in_program_files_and_local_app_data() {
        let c = candidates(Browser::Edge, &windows());
        assert_eq!(
            c,
            vec![
                PathBuf::from("C:/PF/Microsoft/Edge/Application/msedge.exe"),
                PathBuf::from("C:/PF86/Microsoft/Edge/Application/msedge.exe"),
                PathBuf::from("C:/Local/Microsoft/Edge/Application/msedge.exe"),
            ]
        );
        assert!(candidates(Browser::Brave, &windows())[0]
            .ends_with("BraveSoftware/Brave-Browser/Application/brave.exe"));
    }

    #[test]
    fn windows_prefers_edge_then_chrome() {
        let exists = fake(&[
            "C:/Local/Google/Chrome/Application/chrome.exe",
            "C:/PF86/Microsoft/Edge/Application/msedge.exe",
            "C:/Local/Chromium/Application/chrome.exe",
        ]);
        let found: Vec<Browser> = installed(&windows(), &exists)
            .into_iter()
            .map(|(b, _)| b)
            .collect();
        assert_eq!(
            found,
            vec![Browser::Edge, Browser::Chrome, Browser::Chromium]
        );
    }

    #[test]
    fn mac_looks_in_both_applications_folders() {
        let env = Env {
            os: Os::Mac,
            program_files: None,
            program_files_x86: None,
            local_app_data: None,
            home: Some(PathBuf::from("/Users/me")),
            path_dirs: Vec::new(),
        };
        let c = candidates(Browser::Chrome, &env);
        assert_eq!(
            c,
            vec![
                PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                PathBuf::from(
                    "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                ),
            ]
        );
        let exists = fake(&[
            "/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]);
        let found: Vec<Browser> = installed(&env, &exists)
            .into_iter()
            .map(|(b, _)| b)
            .collect();
        assert_eq!(found, vec![Browser::Brave, Browser::Edge]);
    }

    #[test]
    fn linux_looks_names_up_on_path() {
        let env = Env {
            os: Os::Linux,
            program_files: None,
            program_files_x86: None,
            local_app_data: None,
            home: None,
            path_dirs: vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")],
        };
        let exists = fake(&["/usr/bin/chromium-browser", "/usr/local/bin/google-chrome"]);
        let found = installed(&env, &exists);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].0, Browser::Chrome);
        assert_eq!(found[0].1, PathBuf::from("/usr/local/bin/google-chrome"));
        assert_eq!(found[1].0, Browser::Chromium);
    }

    #[test]
    fn nothing_installed_is_empty() {
        assert!(installed(&windows(), &|_| false).is_empty());
    }

    #[test]
    fn ids_and_names_round_trip() {
        for b in preference(Os::Windows) {
            assert_eq!(Browser::from_id(b.id()), Some(b));
            assert_eq!(Browser::from_name(b.name()), Some(b));
        }
        assert_eq!(Browser::from_id("firefox"), None);
        assert_eq!(Browser::Brave.name(), "Brave");
        assert_eq!(Browser::Edge.name(), "Microsoft Edge");
    }

    #[test]
    fn preference_order_by_os() {
        assert_eq!(preference(Os::Windows)[0], Browser::Edge);
        assert_eq!(preference(Os::Mac)[0], Browser::Chrome);
        assert_eq!(preference(Os::Linux)[2], Browser::Edge);
    }
}
