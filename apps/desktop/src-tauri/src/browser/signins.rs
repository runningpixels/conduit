// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Saved sign-ins (design B3 §3): a username and password for one site,
//! which the app types into that site's sign-in form itself. The model never
//! sees the password, and it's never typed anywhere but the saved site.
//!
//! The password lives in the credential store (the OS keychain, or the
//! encrypted file), as `browser-login:<site>`. The keychain can't list what it
//! holds, so the sites, usernames and switches are kept in
//! `browser-sign-ins.json` under the app's folder; that file holds no secret.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use provider_core::schema::AppError;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

const FILE_NAME: &str = "browser-sign-ins.json";

/// Serializes reads and writes of the list file.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// One saved sign-in, without its password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSignIn {
    /// A host such as `portal.example.com` (also used for `www.` of it).
    pub site: String,
    pub username: String,
    /// Also on every subdomain of `site`.
    #[serde(default)]
    pub include_subdomains: bool,
    /// Workflows may use it when nobody is watching the run.
    #[serde(default)]
    pub unattended: bool,
}

impl SavedSignIn {
    /// Whether this sign-in is for a page on `host`.
    pub fn covers(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_lowercase();
        host == self.site
            || host == format!("www.{}", self.site)
            || (self.include_subdomains && host.ends_with(&format!(".{}", self.site)))
    }
}

/// A saved sign-in with its password, read from the store when it's needed.
#[derive(Clone)]
pub struct SavedLogin {
    pub entry: SavedSignIn,
    pub password: String,
}

impl std::fmt::Debug for SavedLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedLogin")
            .field("entry", &self.entry)
            .field("password", &"(hidden)")
            .finish()
    }
}

/// The credential-store id of a site's password.
pub fn secret_id(site: &str) -> String {
    format!("browser-login:{site}")
}

fn list_path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

fn read_list(root: &Path) -> Vec<SavedSignIn> {
    std::fs::read(list_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_list(root: &Path, list: &[SavedSignIn]) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(list).map_err(|e| AppError::from(e.to_string()))?;
    let path = list_path(root);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            AppError::new(
                "error.browser.signInSaveFailed",
                format!("The saved sign-ins couldn't be written: {e}"),
            )
            .with("detail", e.to_string())
        })
}

/// The saved sign-ins, sorted by site.
pub fn list(root: &Path) -> Vec<SavedSignIn> {
    let _guard = FILE_LOCK.lock();
    let mut list = read_list(root);
    list.sort_by(|a, b| a.site.cmp(&b.site));
    list
}

/// A site as a sign-in is saved for: a plain host (no `*`, scheme or path).
pub fn clean_site(site: &str) -> Result<String, AppError> {
    let trimmed = site.trim();
    let bad = || {
        AppError::new(
            "error.browser.signInBadSite",
            format!("“{trimmed}” isn't a site. Write a host such as example.com."),
        )
        .with("site", trimmed)
    };
    if trimmed.starts_with('*') {
        return Err(bad());
    }
    let host = super::rules::normalize_site(trimmed).map_err(|_| bad())?;
    Ok(host
        .strip_prefix("www.")
        .map(str::to_string)
        .unwrap_or(host))
}

/// What Settings sends to save a sign-in. An empty `password` keeps the one
/// already saved for the site (to change only the switches or username).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInInput {
    pub site: String,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub include_subdomains: bool,
    #[serde(default)]
    pub unattended: bool,
}

/// Save or replace the sign-in for `input.site`. The password goes to the
/// store first, so the list never names a sign-in without one.
pub fn save(state: &AppState, input: SignInInput) -> Result<SavedSignIn, AppError> {
    let site = clean_site(&input.site)?;
    let username = input.username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::new(
            "error.browser.signInNoUsername",
            "Give the username or email you sign in with.",
        ));
    }
    let root = &state.paths.root;
    let _guard = FILE_LOCK.lock();
    let mut list = read_list(root);
    let exists = list.iter().any(|s| s.site == site);
    let store = state.credential_store();
    if input.password.is_empty() {
        if !exists || !store.has_provider_secret(&secret_id(&site)) {
            return Err(AppError::new(
                "error.browser.signInNoPassword",
                "Give the password for this sign-in.",
            ));
        }
    } else {
        store
            .save_provider_secret(&secret_id(&site), &input.password)
            .map_err(|e| {
                AppError::new(
                    "error.browser.signInSaveFailed",
                    format!("The password couldn't be saved: {e}"),
                )
                .with("detail", e)
            })?;
    }
    let entry = SavedSignIn {
        site: site.clone(),
        username,
        include_subdomains: input.include_subdomains,
        unattended: input.unattended,
    };
    list.retain(|s| s.site != site);
    list.push(entry.clone());
    write_list(root, &list)?;
    Ok(entry)
}

/// Delete the sign-in for `site`, its password included.
pub fn delete(state: &AppState, site: &str) -> Result<(), AppError> {
    let site = clean_site(site)?;
    let root = &state.paths.root;
    let _guard = FILE_LOCK.lock();
    let mut list = read_list(root);
    state.credential_store().delete_secret(&secret_id(&site))?;
    list.retain(|s| s.site != site);
    write_list(root, &list)
}

/// Every saved sign-in that has a password in the store, with it. Read each
/// time; never logged or sent.
pub fn logins(state: &AppState) -> Vec<SavedLogin> {
    let store = state.credential_store();
    list(&state.paths.root)
        .into_iter()
        .filter_map(|entry| {
            let password = store.get_secret(&secret_id(&entry.site)).ok()?;
            (!password.is_empty()).then_some(SavedLogin { entry, password })
        })
        .collect()
}

/// Shown instead of a saved password found in what a page returned.
pub const HIDDEN: &str = "(saved password hidden)";

/// Replace every saved password (6 characters or more; shorter ones would
/// match by chance) in the strings of `value` with [`HIDDEN`].
pub fn hide_passwords(value: &mut serde_json::Value, passwords: &[String]) {
    let passwords: Vec<&str> = passwords
        .iter()
        .map(|p| p.as_str())
        .filter(|p| p.chars().count() >= 6)
        .collect();
    if passwords.is_empty() {
        return;
    }
    fn walk(value: &mut serde_json::Value, passwords: &[&str]) {
        match value {
            serde_json::Value::String(text) => {
                for p in passwords {
                    if text.contains(p) {
                        *text = text.replace(p, HIDDEN);
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|v| walk(v, passwords)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|v| walk(v, passwords)),
            _ => {}
        }
    }
    walk(value, &passwords);
}

/// The saved sign-in for a page on `host`: the most specific site wins.
pub fn for_host(logins: Vec<SavedLogin>, host: &str) -> Option<SavedLogin> {
    logins
        .into_iter()
        .filter(|l| l.entry.covers(host))
        .max_by_key(|l| l.entry.site.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(site: &str, subdomains: bool) -> SavedSignIn {
        SavedSignIn {
            site: site.to_string(),
            username: "me".to_string(),
            include_subdomains: subdomains,
            unattended: false,
        }
    }

    #[test]
    fn a_sign_in_covers_its_site_and_www_only_unless_asked() {
        let plain = entry("example.com", false);
        assert!(plain.covers("example.com"));
        assert!(plain.covers("WWW.example.com."));
        assert!(!plain.covers("login.example.com"));
        assert!(!plain.covers("example.com.evil.net"));
        assert!(!plain.covers("notexample.com"));
        let wide = entry("example.com", true);
        assert!(wide.covers("login.example.com"));
        assert!(!wide.covers("badexample.com"));
    }

    #[test]
    fn the_most_specific_sign_in_wins() {
        let login = |site: &str, subdomains| SavedLogin {
            entry: entry(site, subdomains),
            password: format!("pw-{site}"),
        };
        let all = vec![login("example.com", true), login("shop.example.com", false)];
        assert_eq!(
            for_host(all.clone(), "shop.example.com")
                .unwrap()
                .entry
                .site,
            "shop.example.com"
        );
        assert_eq!(
            for_host(all.clone(), "mail.example.com")
                .unwrap()
                .entry
                .site,
            "example.com"
        );
        assert!(for_host(all, "example.org").is_none());
    }

    #[test]
    fn sites_are_plain_hosts() {
        assert_eq!(clean_site(" WWW.Example.com ").unwrap(), "example.com");
        assert_eq!(
            clean_site("portal.example.com").unwrap(),
            "portal.example.com"
        );
        for bad in [
            "*",
            "*.example.com",
            "https://example.com",
            "example.com/login",
            "localhost",
        ] {
            assert_eq!(
                clean_site(bad).unwrap_err().code,
                "error.browser.signInBadSite",
                "{bad}"
            );
        }
    }

    #[test]
    fn saved_passwords_are_hidden_from_page_text() {
        let mut page = serde_json::json!({
            "content": "Your password is hunter2-secret, keep it safe",
            "elements": [{ "name": "hunter2-secret" }],
            "short": "abc"
        });
        hide_passwords(&mut page, &["hunter2-secret".into(), "abc".into()]);
        assert_eq!(
            page["content"],
            format!("Your password is {HIDDEN}, keep it safe")
        );
        assert_eq!(page["elements"][0]["name"], HIDDEN);
        assert_eq!(page["short"], "abc");
    }

    #[test]
    fn a_login_never_prints_its_password() {
        let login = SavedLogin {
            entry: entry("example.com", false),
            password: "hunter2-secret".to_string(),
        };
        assert!(!format!("{login:?}").contains("hunter2"));
    }

    #[test]
    fn the_list_file_round_trips_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        write_list(
            dir.path(),
            &[entry("b.example", false), entry("a.example", true)],
        )
        .unwrap();
        let got = list(dir.path());
        assert_eq!(got[0].site, "a.example");
        assert!(got[0].include_subdomains);
        let raw = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(!raw.contains("password"));
    }
}
