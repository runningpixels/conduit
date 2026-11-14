// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Downloads in the agent's browser (design B3 §2).
//!
//! The browser saves every download into a holding folder in its own profile
//! ([`PENDING_DIR`]), named by the browser's id for it, never into the
//! person's Downloads. Nothing there is kept unless the person allows it:
//! a download a page starts is asked about on the browser card (Do it ·
//! Always on *site* · Don't). Programs and scripts are cancelled at once
//! and never asked about. An allowed file is checked again by its first
//! bytes, then saved as an attachment of the conversation, and the model
//! gets it as an attachment right after the tool results, like a file the
//! person attached. Conduit never opens or runs a downloaded file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use provider_core::schema::{
    BrowserAskReason, BrowserRequest, Message, MessagePart, MessagePartKind, MessageRole, SavedFile,
};
use serde_json::{json, Value};
use tokio::time::Instant;

use super::act::{ActContext, ActState, Approval};
use super::cdp::Cdp;
use super::rules;

/// The holding folder in the browser's profile. Emptied when the browser
/// starts.
pub const PENDING_DIR: &str = "downloads-pending";

/// Largest file kept.
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;

/// Most files kept in one run (or one chat's browser session).
pub const MAX_PER_RUN: usize = 5;

/// How long an allowed download may take to finish.
const FINISH_WAIT: Duration = Duration::from_secs(180);

/// File types never kept: programs, installers and scripts.
const BLOCKED_EXTENSIONS: [&str; 21] = [
    "exe",
    "msi",
    "msix",
    "msixbundle",
    "appx",
    "bat",
    "cmd",
    "ps1",
    "vbs",
    "js",
    "jar",
    "scr",
    "com",
    "dmg",
    "pkg",
    "app",
    "sh",
    "deb",
    "rpm",
    "appimage",
    "lnk",
];

/// The hidden key a tool result carries an allowed download under, until
/// [`store_download`] saves it.
const PENDING_KEY: &str = "_download";
/// The key the saved file's attachment id goes under, until the
/// continuation builder takes it.
const SAVED_KEY: &str = "_download_saved";

/// A download a page of the tab started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub guid: String,
    pub url: String,
    pub file: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    InProgress,
    Completed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub received: u64,
    /// 0 when the site didn't say.
    pub total: u64,
    pub state: State,
}

/// A tab's downloads: the ones started since a tool call last looked, and
/// how each is going.
#[derive(Debug, Default)]
pub struct TabDownloads {
    pub started: Vec<Seen>,
    pub progress: HashMap<String, Progress>,
}

impl TabDownloads {
    /// Note one more download of this tab.
    pub fn begin(&mut self, seen: Seen) {
        // Reported twice (browser level and the page's session): once is enough.
        if self.progress.contains_key(&seen.guid) {
            return;
        }
        self.progress.insert(
            seen.guid.clone(),
            Progress {
                received: 0,
                total: 0,
                state: State::InProgress,
            },
        );
        self.started.push(seen);
    }

    /// Apply a `downloadProgress` event, when it is one of this tab's.
    pub fn update(&mut self, params: &Value) {
        let Some(guid) = params["guid"].as_str() else {
            return;
        };
        let Some(progress) = self.progress.get_mut(guid) else {
            return;
        };
        progress.received = params["receivedBytes"].as_f64().unwrap_or(0.0) as u64;
        progress.total = params["totalBytes"].as_f64().unwrap_or(0.0) as u64;
        progress.state = match params["state"].as_str() {
            Some("completed") => State::Completed,
            Some("canceled") => State::Canceled,
            _ => State::InProgress,
        };
    }
}

/// The file name's extension, lowercased.
fn extension(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    Some(ext.trim().to_ascii_lowercase())
}

/// Whether a file name says program, installer or script.
pub fn blocked_name(name: &str) -> bool {
    extension(name).is_some_and(|ext| BLOCKED_EXTENSIONS.contains(&ext.as_str()))
}

/// Whether the first bytes say program (Windows, Linux or Mac executables,
/// and other app binaries) or script (`#!`).
pub fn executable_bytes(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"MZ") || bytes.starts_with(b"\x7fELF") || bytes.starts_with(b"#!") {
        return true;
    }
    const MACH_O: [[u8; 4]; 5] = [
        [0xFE, 0xED, 0xFA, 0xCE],
        [0xFE, 0xED, 0xFA, 0xCF],
        [0xCE, 0xFA, 0xED, 0xFE],
        [0xCF, 0xFA, 0xED, 0xFE],
        [0xCA, 0xFE, 0xBA, 0xBE],
    ];
    if MACH_O.iter().any(|magic| bytes.starts_with(magic)) {
        return true;
    }
    infer::get(bytes).is_some_and(|kind| kind.matcher_type() == infer::MatcherType::App)
}

/// The type stored for a kept file: by its bytes, else by its name.
pub fn mime_of(bytes: &[u8], name: &str) -> String {
    if let Some(kind) = crate::attachment_documents::sniff_document(bytes, Some(name), None) {
        return kind.mime().to_string();
    }
    if let Some(kind) = infer::get(bytes) {
        return kind.mime_type().to_string();
    }
    match extension(name).as_deref() {
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A size as people read it ("2.3 MB").
pub fn size_text(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} bytes")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{:.1} MB", b / KB / KB)
    }
}

/// What the agent is told for a download that wasn't kept.
pub fn not_kept_note(file: &str, why: &str) -> String {
    format!("This started a download ({file}). {why} Nothing was saved.")
}

pub const NEEDS_ACT: &str = "Downloads need the agent to be allowed to click and type.";
pub const PROGRAM: &str = "Programs, installers and scripts are never downloaded.";
pub const DECLINED: &str = "The person said no to this download.";
pub const TOO_BIG: &str = "It is larger than 100 MB.";
pub const TOO_MANY: &str = "Five files were already downloaded; that's the most for one task.";
pub const DIDNT_FINISH: &str = "It didn't finish in time.";
pub const FAILED: &str = "The site stopped it.";
/// A host that isn't an http(s) site (a `blob:` or `data:` address): the
/// page's own host is used.
fn host_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => parsed.host_str().map(|h| h.to_ascii_lowercase()),
        _ => None,
    }
}

/// Where the browser put a download.
pub fn pending_path(profile: &Path, guid: &str) -> PathBuf {
    profile.join(PENDING_DIR).join(guid)
}

async fn cancel(cdp: &Cdp, profile: &Path, guid: &str) {
    let _ = cdp
        .call("Browser.cancelDownload", json!({ "guid": guid }), None)
        .await;
    let _ = std::fs::remove_file(pending_path(profile, guid));
}

/// What a page the tab is on looks like, for the card.
pub struct PageFacts {
    pub url: String,
    pub host: String,
    pub title: String,
}

/// Decide the downloads the tab started since the last tool call: cancel the
/// ones not kept, ask about the others, wait for an allowed one to finish.
/// The result gets a `download` note for the agent and, for a kept file, the
/// hidden [`PENDING_KEY`] that [`store_download`] saves. One file per call:
/// a second download started by the same action is cancelled.
#[allow(clippy::too_many_arguments)]
pub async fn settle_downloads(
    cdp: &Cdp,
    downloads: &std::sync::Mutex<TabDownloads>,
    profile: &Path,
    page: PageFacts,
    why: Option<String>,
    act: Option<&ActContext<'_>>,
    state: &std::sync::Mutex<ActState>,
    result: &mut serde_json::Map<String, Value>,
) {
    let started = match downloads.lock() {
        Ok(mut d) => std::mem::take(&mut d.started),
        Err(_) => return,
    };
    let mut notes = Vec::new();
    let mut kept = false;
    for seen in started {
        let not_kept = |why: &str| not_kept_note(&seen.file, why);
        if blocked_name(&seen.file) {
            cancel(cdp, profile, &seen.guid).await;
            notes.push(not_kept(PROGRAM));
            continue;
        }
        let Some(ctx) = act else {
            cancel(cdp, profile, &seen.guid).await;
            notes.push(not_kept(NEEDS_ACT));
            continue;
        };
        if kept {
            cancel(cdp, profile, &seen.guid).await;
            notes.push(not_kept(
                "Only one file is downloaded per step; ask for it again.",
            ));
            continue;
        }
        let count = state.lock().map(|s| s.downloads).unwrap_or(0);
        if count >= MAX_PER_RUN {
            cancel(cdp, profile, &seen.guid).await;
            notes.push(not_kept(TOO_MANY));
            continue;
        }
        let total = progress_of(downloads, &seen.guid)
            .map(|p| p.total)
            .unwrap_or(0);
        if total > MAX_BYTES {
            cancel(cdp, profile, &seen.guid).await;
            notes.push(not_kept(TOO_BIG));
            continue;
        }

        // Ask, unless the site is in the list (every site, `*`, doesn't
        // count for downloads) or was allowed in this run.
        let host = host_of(&seen.url).unwrap_or_else(|| page.host.clone());
        let offer = rules::site_to_offer(&host);
        let sites: Vec<String> = ctx
            .sites
            .iter()
            .filter(|s| s.as_str() != rules::ANY_SITE)
            .cloned()
            .collect();
        let allowed = rules::site_listed(&host, &sites)
            || state
                .lock()
                .map(|s| s.download_hosts.contains(&offer))
                .unwrap_or(false);
        if !allowed {
            let request = BrowserRequest {
                action: "download".to_string(),
                host: host.clone(),
                page_url: page.url.clone(),
                page_title: page.title.clone(),
                element_role: None,
                element_name: None,
                text: None,
                option: None,
                why: why.clone(),
                reason: BrowserAskReason::Download,
                risky_word: None,
                read_before: ctx.read_before.clone(),
                so_far: state.lock().map(|s| s.so_far.clone()).unwrap_or_default(),
                offer_site: Some(offer.clone()),
                file_name: Some(seen.file.clone()),
                file_size: (total > 0).then_some(total),
            };
            match (ctx.approve)(request).await {
                Approval::No(_) => {
                    cancel(cdp, profile, &seen.guid).await;
                    notes.push(not_kept(DECLINED));
                    continue;
                }
                Approval::Go { remember } => {
                    if remember {
                        if let Ok(mut s) = state.lock() {
                            s.download_hosts.insert(offer.clone());
                        }
                    }
                }
            }
        }

        match finish(cdp, downloads, profile, &seen).await {
            Ok((path, size)) => {
                let bytes = std::fs::read(&path).unwrap_or_default();
                if executable_bytes(&bytes) {
                    let _ = std::fs::remove_file(&path);
                    notes.push(not_kept(PROGRAM));
                    continue;
                }
                let mime = mime_of(&bytes, &seen.file);
                drop(bytes);
                if let Ok(mut s) = state.lock() {
                    s.downloads += 1;
                }
                kept = true;
                notes.push(format!(
                    "Downloaded {} ({}, {}). It is saved, and attached below.",
                    seen.file,
                    mime,
                    size_text(size)
                ));
                result.insert(
                    PENDING_KEY.into(),
                    json!({
                        "path": path.to_string_lossy(),
                        "name": seen.file,
                        "mime": mime,
                        "size": size,
                        "url": seen.url,
                    }),
                );
            }
            Err(why) => notes.push(not_kept(why)),
        }
    }
    if !notes.is_empty() {
        result.insert("download".into(), Value::String(notes.join(" ")));
    }
}

fn progress_of(downloads: &std::sync::Mutex<TabDownloads>, guid: &str) -> Option<Progress> {
    downloads.lock().ok()?.progress.get(guid).copied()
}

/// Wait for an allowed download to finish; the file and its size.
async fn finish(
    cdp: &Cdp,
    downloads: &std::sync::Mutex<TabDownloads>,
    profile: &Path,
    seen: &Seen,
) -> Result<(PathBuf, u64), &'static str> {
    let deadline = Instant::now() + FINISH_WAIT;
    loop {
        let progress = progress_of(downloads, &seen.guid);
        match progress.map(|p| p.state) {
            Some(State::Completed) => break,
            Some(State::Canceled) => {
                let _ = std::fs::remove_file(pending_path(profile, &seen.guid));
                return Err(FAILED);
            }
            _ => {}
        }
        if progress.is_some_and(|p| p.received > MAX_BYTES || p.total > MAX_BYTES) {
            cancel(cdp, profile, &seen.guid).await;
            return Err(TOO_BIG);
        }
        if Instant::now() >= deadline {
            cancel(cdp, profile, &seen.guid).await;
            return Err(DIDNT_FINISH);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let path = pending_path(profile, &seen.guid);
    let size = std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|_| FAILED)?;
    if size > MAX_BYTES {
        let _ = std::fs::remove_file(&path);
        return Err(TOO_BIG);
    }
    Ok((path, size))
}

/// Save an allowed download as an attachment of the conversation: the hidden
/// file note leaves the result, the attachment id goes in its place, and the
/// file in the holding folder is deleted. The saved file, for its card.
pub async fn store_download(
    state: &crate::state::AppState,
    conversation_id: &str,
    result: &mut Value,
) -> Result<Option<SavedFile>, String> {
    let Some(pending) = result.as_object_mut().and_then(|o| o.remove(PENDING_KEY)) else {
        return Ok(None);
    };
    let path = PathBuf::from(pending["path"].as_str().unwrap_or_default());
    let name = pending["name"].as_str().unwrap_or("download").to_string();
    let mime = pending["mime"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = std::fs::read(&path);
    let _ = std::fs::remove_file(&path);
    let bytes = bytes.map_err(|_| "the downloaded file could not be read".to_string())?;
    let saved = crate::db::repository::attachments::save(
        &state.db,
        &state.paths.attachments,
        &state.encryption,
        conversation_id,
        &bytes,
        &mime,
        Some(&name),
    )
    .await
    .map_err(|e| format!("the downloaded file could not be saved ({e})"))?;
    result[SAVED_KEY] = json!({
        "id": saved.id,
        "name": name,
        "mime": mime,
        "url": pending["url"],
    });
    Ok(Some(SavedFile {
        attachment_id: saved.id,
        name,
        mime,
        size: bytes.len() as u64,
    }))
}

/// A saved download, for the message that hands it to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    pub attachment_id: String,
    pub name: String,
    pub mime: String,
    pub url: String,
}

/// Take a saved download out of a tool result, so the text the model reads
/// doesn't carry its id.
pub fn take_download(result: &mut Value) -> Option<Downloaded> {
    let saved = result.as_object_mut()?.remove(SAVED_KEY)?;
    Some(Downloaded {
        attachment_id: saved["id"].as_str()?.to_string(),
        name: saved["name"].as_str().unwrap_or_default().to_string(),
        mime: saved["mime"].as_str().unwrap_or_default().to_string(),
        url: saved["url"].as_str().unwrap_or_default().to_string(),
    })
}

/// The user message that hands downloaded files to the model, right after the
/// tool results, as attachments it reads like ones the person attached. Not
/// saved: a later turn sees only the tool's text.
pub fn download_message(
    id: &str,
    conversation_id: &str,
    files: &[Downloaded],
    now: &str,
) -> Message {
    let mut parts = Vec::new();
    for file in files {
        parts.push(MessagePart {
            id: format!("{id}/{}", parts.len()),
            message_id: id.to_string(),
            index: parts.len() as u32,
            kind: MessagePartKind::Text,
            content: Some(format!(
                "The file you downloaded ({}, from {}):",
                file.name, file.url
            )),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: now.to_string(),
        });
        parts.push(MessagePart {
            id: format!("{id}/{}", parts.len()),
            message_id: id.to_string(),
            index: parts.len() as u32,
            kind: MessagePartKind::AttachmentReference,
            content: None,
            mime_type: Some(file.mime.clone()),
            tool_call_id: None,
            artifact_id: None,
            attachment_id: Some(file.attachment_id.clone()),
            blob_ref: None,
            metadata: Some(json!({ "url": file.url, "name": file.name })),
            created_at: now.to_string(),
        });
    }
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: Some(json!({ "browser_download": true })),
        parts,
        created_at: now.to_string(),
    }
}

/// Empty the holding folder (the browser is starting; nothing in it is
/// anyone's).
pub fn clear_pending(profile: &Path) {
    let dir = profile.join(PENDING_DIR);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_and_scripts_are_blocked_by_name() {
        for name in [
            "setup.EXE",
            "x.msi",
            "run.ps1",
            "a.sh",
            "b.AppImage",
            "c.js",
        ] {
            assert!(blocked_name(name), "{name}");
        }
        for name in [
            "report.pdf",
            "data.csv",
            "notes",
            "archive.zip",
            "page.html",
        ] {
            assert!(!blocked_name(name), "{name}");
        }
    }

    #[test]
    fn programs_are_blocked_by_their_first_bytes() {
        assert!(executable_bytes(b"MZ\x90\x00rest"));
        assert!(executable_bytes(b"\x7fELF\x02\x01"));
        assert!(executable_bytes(&[0xCF, 0xFA, 0xED, 0xFE, 0, 0]));
        assert!(executable_bytes(b"#!/bin/sh\necho hi"));
        assert!(!executable_bytes(b"%PDF-1.7"));
        assert!(!executable_bytes(b"name,amount\nMarch,12\n"));
    }

    #[test]
    fn progress_follows_only_this_tabs_downloads() {
        let mut d = TabDownloads::default();
        d.begin(Seen {
            guid: "g1".into(),
            url: "https://x.test/r.pdf".into(),
            file: "r.pdf".into(),
        });
        d.update(&json!({ "guid": "other", "state": "completed" }));
        d.update(&json!({ "guid": "g1", "receivedBytes": 10.0, "totalBytes": 20.0, "state": "inProgress" }));
        assert_eq!(
            d.progress["g1"],
            Progress {
                received: 10,
                total: 20,
                state: State::InProgress
            }
        );
        d.update(&json!({ "guid": "g1", "receivedBytes": 20.0, "totalBytes": 20.0, "state": "completed" }));
        assert_eq!(d.progress["g1"].state, State::Completed);
        assert!(!d.progress.contains_key("other"));
    }

    #[test]
    fn types_come_from_the_bytes_first() {
        assert_eq!(mime_of(b"%PDF-1.7 ...", "x.bin"), "application/pdf");
        assert_eq!(mime_of(b"a,b\n1,2\n", "data.csv"), "text/csv");
        assert_eq!(mime_of(b"{\"a\":1}", "x.json"), "application/json");
        assert_eq!(size_text(500), "500 bytes");
        assert_eq!(size_text(2_400_000), "2.3 MB");
    }

    #[test]
    fn a_saved_download_leaves_the_text_and_becomes_an_attachment() {
        let mut result = json!({ "url": "https://x.test", SAVED_KEY: { "id": "att-9", "name": "r.pdf", "mime": "application/pdf", "url": "https://x.test/r.pdf" } });
        let file = take_download(&mut result).unwrap();
        assert_eq!(file.attachment_id, "att-9");
        assert!(result.get(SAVED_KEY).is_none());
        let message = download_message("req/downloads", "c1", &[file], "now");
        assert_eq!(message.role, MessageRole::User);
        assert_eq!(message.parts.len(), 2);
        assert_eq!(message.parts[1].attachment_id.as_deref(), Some("att-9"));
        assert_eq!(
            message.parts[1].mime_type.as_deref(),
            Some("application/pdf")
        );
    }
}
