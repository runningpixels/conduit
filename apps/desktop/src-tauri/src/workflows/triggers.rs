//! What starts a workflow on its own besides a time: a new post in an RSS or
//! Atom feed, or a new file in the workflow's folder.
//!
//! A trigger workflow is "polled" by the scheduler (a `workflow_schedules`
//! row whose spec is `{"kind":"trigger"}`; its `next_run_at` is the next
//! look). A poll finds the items it hasn't seen, oldest first, at most
//! [`MAX_RUNS_PER_POLL`] of them; the scheduler runs the workflow once for
//! each, with the item as `{{trigger.<field>}}`.
//!
//! - The first poll after turning it on is a *baseline*: everything there is
//!   marked seen and nothing runs.
//! - What has been seen (ids of feed posts or relative file paths, at most
//!   [`SEEN_CAP`]), a feed's `ETag` / `Last-Modified`, and how many looks in a
//!   row failed live in a small file, `<data>/workflow-triggers/<id>.json`.
//!   It is deleted with the workflow, and ignored when the feed address or
//!   the folder changed.
//! - A feed is fetched through the same guarded network path as a page
//!   (public https addresses only). A folder's files count once they have
//!   stopped changing for [`SETTLE_SECS`] seconds; hidden and temporary files
//!   never count.
//! - A look that fails is simply tried again at the next poll. The third
//!   failure in a row pauses the workflow's trigger *in name*: the reason is
//!   kept for the page to show and the caller is told once; the polling goes
//!   on, and one good look clears it.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{DateTime, Utc};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::definition::Trigger;
use super::permissions::{self, Permission};
use crate::artifact_network::{self, AddressPolicy, ArtifactFetchRequest};

/// Most runs one poll starts; the rest wait for the next poll.
pub const MAX_RUNS_PER_POLL: usize = 5;
/// Most ids remembered as seen.
pub const SEEN_CAP: usize = 2000;
/// A file must have been left alone this long to count as finished.
pub const SETTLE_SECS: i64 = 10;
/// Failed looks in a row before the trigger is called paused.
pub const FAILURES_BEFORE_PAUSE: u32 = 3;
/// Subfolders deep a folder trigger looks.
const MAX_DEPTH: usize = 3;
/// Most entries a folder look reads, so a huge tree can't stall the poll.
const MAX_ENTRIES: usize = 20_000;
/// Largest feed read.
const MAX_FEED_BYTES: usize = 5 * 1024 * 1024;
/// Longest summary kept for a post.
const MAX_SUMMARY_CHARS: usize = 1000;
/// Folder under the data directory that holds the cursors.
const CURSOR_DIR: &str = "workflow-triggers";

/// One new thing: a post or a file.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// What "seen" is remembered by: a post's id, a file's relative path.
    pub id: String,
    /// What `{{trigger.<field>}}` reads.
    pub value: Value,
    /// Seconds since 1970 when known (a post's date, a file's modified time).
    when: Option<i64>,
}

/// What a poll came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Polled {
    /// The new items, oldest first (at most [`MAX_RUNS_PER_POLL`]). Empty
    /// when nothing is new, and for the baseline.
    Items(Vec<Item>),
    /// The look failed. `paused_now` is true exactly once, on the failure
    /// that reaches [`FAILURES_BEFORE_PAUSE`].
    Failed { error: String, paused_now: bool },
}

/// Where a trigger left off, kept in a small file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cursor {
    /// The feed address or folder this cursor belongs to.
    pub source: String,
    pub baselined: bool,
    pub seen: Vec<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// A folder's unseen files and their size at the last look.
    pub sizes: BTreeMap<String, u64>,
    pub failures: u32,
    pub last_error: Option<String>,
    pub paused_reason: Option<String>,
    pub last_checked_at: Option<String>,
}

/// What the workflow page shows about a trigger that is on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// `feed` or `folder`.
    pub kind: String,
    /// The feed's site (its host) or the folder's path.
    pub target: String,
    /// Minutes between looks.
    pub every_minutes: u32,
    /// Why it stopped being able to look, once three looks in a row failed.
    pub paused_reason: Option<String>,
    pub last_checked_at: Option<String>,
}

// ── The cursor file ──────────────────────────────────────────────────────────

fn cursor_path(root: &Path, workflow_id: &str) -> Option<PathBuf> {
    let safe = !workflow_id.is_empty()
        && workflow_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| root.join(CURSOR_DIR).join(format!("{workflow_id}.json")))
}

/// The saved cursor, or an empty one (no file, or one that can't be read).
pub fn load_cursor(root: &Path, workflow_id: &str) -> Cursor {
    cursor_path(root, workflow_id)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cursor(root: &Path, workflow_id: &str, cursor: &Cursor) -> Result<(), String> {
    let path = cursor_path(root, workflow_id).ok_or("That workflow can't be watched.")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(cursor).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Forget where a trigger left off (the workflow was deleted, or the trigger
/// was turned off or on again, which starts with a fresh baseline).
pub fn remove_cursor(root: &Path, workflow_id: &str) {
    if let Some(path) = cursor_path(root, workflow_id) {
        let _ = std::fs::remove_file(path);
    }
}

// ── What it watches, and what it needs ───────────────────────────────────────

/// What a trigger looks at: the feed's address or the folder.
fn source_of(trigger: &Trigger, folder: Option<&str>) -> String {
    match trigger {
        Trigger::Feed { url, .. } => url.trim().to_string(),
        Trigger::Folder => folder.unwrap_or_default().trim().to_string(),
    }
}

/// The permission a poll needs: reading the feed's site, or the folder.
pub fn permission(trigger: &Trigger, folder: Option<&str>) -> Option<Permission> {
    match trigger {
        Trigger::Feed { url, .. } => {
            permissions::host_of(url.trim()).map(|host| Permission::Host { host })
        }
        Trigger::Folder => folder
            .filter(|f| !f.trim().is_empty())
            .map(permissions::read_folder),
    }
}

/// What the page shows about `trigger` (the trigger of workflow
/// `workflow_id`, whose data is under `root`).
pub fn watch_status(
    root: &Path,
    workflow_id: &str,
    trigger: &Trigger,
    folder: Option<&str>,
) -> WatchStatus {
    let cursor = load_cursor(root, workflow_id);
    let source = source_of(trigger, folder);
    let mine = cursor.source == source;
    let target = match trigger {
        Trigger::Feed { url, .. } => {
            permissions::host_of(url.trim()).unwrap_or_else(|| url.trim().to_string())
        }
        Trigger::Folder => source,
    };
    WatchStatus {
        kind: trigger.kind().to_string(),
        target,
        every_minutes: trigger.poll_minutes(),
        paused_reason: cursor.paused_reason.clone().filter(|_| mine),
        last_checked_at: cursor.last_checked_at.clone().filter(|_| mine),
    }
}

// ── Polling ──────────────────────────────────────────────────────────────────

/// Look for new items. `allowed` is `Err(why)` when the user hasn't approved
/// this look; that counts as a failed one. `Err` only when the cursor can't
/// be saved; a look that fails is `Ok(Polled::Failed)`, counted in the cursor.
pub async fn poll(
    root: &Path,
    workflow_id: &str,
    trigger: &Trigger,
    folder: Option<&str>,
    policy: AddressPolicy,
    now: DateTime<Utc>,
    allowed: Result<(), String>,
) -> Result<Polled, String> {
    let source = source_of(trigger, folder);
    let mut cursor = load_cursor(root, workflow_id);
    if cursor.source != source {
        // A different feed or folder: start over, with a baseline.
        cursor = Cursor {
            source,
            ..Cursor::default()
        };
    }
    let mut working = cursor.clone();
    let looked = match (allowed, trigger) {
        (Err(why), _) => Err(why),
        (Ok(()), Trigger::Feed { url, .. }) => {
            look_at_feed(&mut working, url.trim(), policy, workflow_id).await
        }
        (Ok(()), Trigger::Folder) => look_in_folder(&mut working, folder.unwrap_or_default(), now),
    };
    let polled = match looked {
        Ok(items) => {
            cursor = working;
            cursor.failures = 0;
            cursor.last_error = None;
            cursor.paused_reason = None;
            Polled::Items(items)
        }
        Err(error) => {
            cursor.failures += 1;
            cursor.last_error = Some(error.clone());
            if cursor.failures >= FAILURES_BEFORE_PAUSE {
                cursor.paused_reason = Some(error.clone());
            }
            Polled::Failed {
                error,
                paused_now: cursor.failures == FAILURES_BEFORE_PAUSE,
            }
        }
    };
    cursor.last_checked_at = Some(now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    save_cursor(root, workflow_id, &cursor)?;
    Ok(polled)
}

/// The newest item right now (for "Run now" on a triggered workflow), without
/// touching what has been seen. Errors say why there is none.
pub async fn latest(
    trigger: &Trigger,
    folder: Option<&str>,
    policy: AddressPolicy,
    workflow_id: &str,
) -> Result<Item, String> {
    match trigger {
        Trigger::Feed { url, .. } => {
            let response = fetch_feed(url.trim(), policy, workflow_id, None, None).await?;
            let items = parse_feed(&response.body)?;
            newest(&items)
                .cloned()
                .ok_or_else(|| "The feed has no posts yet, so there is nothing to try.".to_string())
        }
        Trigger::Folder => {
            let folder = folder.unwrap_or_default();
            let files = scan(folder)?;
            files
                .into_iter()
                .max_by(|a, b| (a.when, &a.id).cmp(&(b.when, &b.id)))
                .ok_or_else(|| {
                    "The folder has no files yet, so there is nothing to try.".to_string()
                })
        }
    }
}

// ── Feeds ────────────────────────────────────────────────────────────────────

struct FeedResponse {
    /// `None` for "not modified".
    body: String,
    not_modified: bool,
    etag: Option<String>,
    last_modified: Option<String>,
}

async fn fetch_feed(
    url: &str,
    policy: AddressPolicy,
    workflow_id: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<FeedResponse, String> {
    let mut headers = vec![(
        "Accept".to_string(),
        "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5"
            .to_string(),
    )];
    if let Some(etag) = etag {
        headers.push(("If-None-Match".to_string(), etag.to_string()));
    }
    if let Some(modified) = last_modified {
        headers.push(("If-Modified-Since".to_string(), modified.to_string()));
    }
    let request = ArtifactFetchRequest {
        principal: format!("workflow-trigger:{workflow_id}"),
        url: url.to_string(),
        method: "GET".to_string(),
        headers,
        body: None,
    };
    let response = artifact_network::perform_capped(&request, policy, &|_| true, MAX_FEED_BYTES)
        .await
        .map_err(|e| format!("The feed couldn't be reached. {e}"))?;
    let header = |name: &str| {
        response
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    };
    if response.status == 304 {
        return Ok(FeedResponse {
            body: String::new(),
            not_modified: true,
            etag: etag.map(str::to_string),
            last_modified: last_modified.map(str::to_string),
        });
    }
    if response.status >= 400 {
        return Err(format!(
            "The feed answered {} {}.",
            response.status, response.status_text
        ));
    }
    let bytes = B64
        .decode(&response.body)
        .map_err(|_| "The feed couldn't be read.".to_string())?;
    Ok(FeedResponse {
        body: String::from_utf8_lossy(&bytes).into_owned(),
        not_modified: false,
        etag: header("etag"),
        last_modified: header("last-modified"),
    })
}

async fn look_at_feed(
    cursor: &mut Cursor,
    url: &str,
    policy: AddressPolicy,
    workflow_id: &str,
) -> Result<Vec<Item>, String> {
    let response = fetch_feed(
        url,
        policy,
        workflow_id,
        cursor.etag.as_deref().filter(|_| cursor.baselined),
        cursor.last_modified.as_deref().filter(|_| cursor.baselined),
    )
    .await?;
    if response.not_modified {
        return Ok(Vec::new());
    }
    let items = parse_feed(&response.body)?;
    let mut fresh: Vec<Item> = Vec::new();
    if cursor.baselined {
        let seen: HashSet<&str> = cursor.seen.iter().map(String::as_str).collect();
        let mut taken = HashSet::new();
        // The feed lists newest first; runs go oldest first.
        for item in items.iter().rev() {
            if !seen.contains(item.id.as_str()) && taken.insert(item.id.clone()) {
                fresh.push(item.clone());
            }
        }
        if fresh.iter().all(|i| i.when.is_some()) {
            fresh.sort_by_key(|i| i.when);
        }
    } else {
        cursor.baselined = true;
        let ids: Vec<String> = items.iter().rev().map(|i| i.id.clone()).collect();
        remember(cursor, ids);
    }
    fresh.truncate(MAX_RUNS_PER_POLL);
    // New posts are marked seen one by one as their runs happen
    // (`mark_seen`), so a batch cut short is picked up again next time. Until
    // then ask for the whole feed: a "not modified" answer would hide them.
    if fresh.is_empty() {
        cursor.etag = response.etag;
        cursor.last_modified = response.last_modified;
    } else {
        cursor.etag = None;
        cursor.last_modified = None;
    }
    Ok(fresh)
}

/// Record that the item `id` has had its run, so later looks skip it. Called
/// after each run (whatever its outcome), not when the item is found: a batch
/// that is cut short leaves the rest to the next look.
pub fn mark_seen(root: &Path, workflow_id: &str, id: &str) -> Result<(), String> {
    let mut cursor = load_cursor(root, workflow_id);
    remember(&mut cursor, vec![id.to_string()]);
    save_cursor(root, workflow_id, &cursor)
}

/// Add `ids` to what has been seen, keeping the newest [`SEEN_CAP`].
fn remember(cursor: &mut Cursor, ids: Vec<String>) {
    for id in ids {
        if !cursor.seen.contains(&id) {
            cursor.seen.push(id);
        }
    }
    if cursor.seen.len() > SEEN_CAP {
        let extra = cursor.seen.len() - SEEN_CAP;
        cursor.seen.drain(..extra);
    }
}

/// The most recent post: by date when every post has one, else the first
/// listed (feeds list newest first).
fn newest(items: &[Item]) -> Option<&Item> {
    if !items.is_empty() && items.iter().all(|i| i.when.is_some()) {
        // `max_by_key` keeps the last of equals; walk backwards so the
        // earlier-listed post wins a tie.
        return items.iter().rev().max_by_key(|i| i.when);
    }
    items.first()
}

#[derive(Default)]
struct Raw {
    title: String,
    link: String,
    link_rank: u8,
    summary: String,
    content: String,
    published: String,
    updated: String,
    id: String,
}

/// RSS 2.0 (and 1.0) or Atom to posts, in the order listed.
pub fn parse_feed(xml: &str) -> Result<Vec<Item>, String> {
    let not_a_feed = || "The address didn't return a feed (RSS or Atom).".to_string();
    let mut reader = Reader::from_str(xml);
    let config = reader.config_mut();
    config.expand_empty_elements = true;
    config.check_end_names = false;
    let mut stack: Vec<String> = Vec::new();
    let mut items = Vec::new();
    let mut current: Option<Raw> = None;
    let mut item_depth = 0;
    let mut text = String::new();
    let mut link_rank = 0u8;
    let mut link_href = String::new();
    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("The feed couldn't be read: {e}"))?;
        match event {
            Event::Eof => break,
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                if stack.is_empty() && !matches!(name.as_str(), "rss" | "feed" | "rdf:rdf") {
                    return Err(not_a_feed());
                }
                if current.is_none() && matches!(name.as_str(), "item" | "entry") {
                    current = Some(Raw::default());
                    item_depth = stack.len() + 1;
                } else if current.is_some() && stack.len() == item_depth {
                    text.clear();
                    link_href.clear();
                    link_rank = 0;
                    if name == "link" {
                        let (mut href, mut rel) = (String::new(), String::new());
                        for attribute in e.attributes().flatten() {
                            let value = attribute
                                .unescape_value()
                                .map(|v| v.into_owned())
                                .unwrap_or_default();
                            match attribute.key.as_ref() {
                                b"href" => href = value,
                                b"rel" => rel = value,
                                _ => {}
                            }
                        }
                        if !href.is_empty() {
                            link_rank = match rel.as_str() {
                                "" | "alternate" => 2,
                                _ => 1,
                            };
                            link_href = href;
                        }
                    }
                }
                stack.push(name);
            }
            Event::Text(t) => {
                if current.is_some() && stack.len() > item_depth {
                    text.push_str(&t.decode().map_err(|e| e.to_string())?);
                }
            }
            Event::CData(c) => {
                if current.is_some() && stack.len() > item_depth {
                    text.push_str(&c.decode().map_err(|e| e.to_string())?);
                }
            }
            Event::GeneralRef(r) => {
                if current.is_some() && stack.len() > item_depth {
                    if let Ok(Some(ch)) = r.resolve_char_ref() {
                        text.push(ch);
                    } else if let Ok(name) = r.decode() {
                        match quick_xml::escape::resolve_predefined_entity(&name) {
                            Some(resolved) => text.push_str(resolved),
                            None => {
                                text.push('&');
                                text.push_str(&name);
                                text.push(';');
                            }
                        }
                    }
                }
            }
            Event::End(_) => {
                let Some(name) = stack.pop() else { continue };
                let Some(raw) = current.as_mut() else {
                    continue;
                };
                if stack.len() == item_depth {
                    // A child of the item just closed.
                    let value = text.trim().to_string();
                    match name.as_str() {
                        "title" if raw.title.is_empty() => raw.title = value,
                        "link" => {
                            if link_rank > raw.link_rank && !link_href.is_empty() {
                                raw.link = link_href.clone();
                                raw.link_rank = link_rank;
                            } else if raw.link_rank == 0 && !value.is_empty() {
                                raw.link = value;
                                raw.link_rank = 2;
                            }
                        }
                        "description" | "summary" if raw.summary.is_empty() => raw.summary = value,
                        "content" | "content:encoded" if raw.content.is_empty() => {
                            raw.content = value
                        }
                        "pubdate" | "published" | "dc:date" if raw.published.is_empty() => {
                            raw.published = value
                        }
                        "updated" if raw.updated.is_empty() => raw.updated = value,
                        "guid" | "id" if raw.id.is_empty() => raw.id = value,
                        _ => {}
                    }
                    text.clear();
                } else if stack.len() + 1 == item_depth && matches!(name.as_str(), "item" | "entry")
                {
                    if let Some(raw) = current.take() {
                        items.push(finish(raw));
                    }
                }
            }
            _ => {}
        }
    }
    if stack.is_empty() && items.is_empty() && !xml.contains("<rss") && !xml.contains("<feed") {
        return Err(not_a_feed());
    }
    Ok(items)
}

fn finish(raw: Raw) -> Item {
    let title = one_line(&plain_text(&raw.title));
    let published_text = if raw.published.is_empty() {
        raw.updated.clone()
    } else {
        raw.published.clone()
    };
    let parsed = parse_date(&published_text);
    let published = parsed
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or(published_text);
    let summary_source = if raw.summary.is_empty() {
        &raw.content
    } else {
        &raw.summary
    };
    let summary = clip(&one_line(&plain_text(summary_source)), MAX_SUMMARY_CHARS);
    let id = [&raw.id, &raw.link, &title]
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("{published}|{summary}"));
    Item {
        value: json!({
            "title": title, "link": raw.link, "summary": summary,
            "published": published, "id": id,
        }),
        id,
        when: parsed.map(|d| d.timestamp()),
    }
}

fn parse_date(text: &str) -> Option<DateTime<Utc>> {
    let text = text.trim();
    DateTime::parse_from_rfc2822(text)
        .or_else(|_| DateTime::parse_from_rfc3339(text))
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// `html` as plain text: tags dropped, the common entities read.
fn plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

// ── Folders ──────────────────────────────────────────────────────────────────

/// Whether a file or folder name is one a trigger never counts: hidden,
/// temporary, or a download in progress.
pub fn ignored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.starts_with("~$")
        || lower.ends_with(".tmp")
        || lower.ends_with(".part")
        || lower.ends_with(".crdownload")
        || lower == "desktop.ini"
        || lower == "thumbs.db"
}

/// Every counted file under `folder`, top level and up to [`MAX_DEPTH`]
/// subfolders down, in a stable order.
fn scan(folder: &str) -> Result<Vec<Item>, String> {
    let root = Path::new(folder.trim());
    if folder.trim().is_empty() || !root.is_dir() {
        return Err(format!("The folder isn't there: {}", folder.trim()));
    }
    let mut items = Vec::new();
    let mut entries = 0;
    walk(root, "", 0, &mut items, &mut entries);
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<Item>, entries: &mut usize) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        *entries += 1;
        if *entries > MAX_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignored(&name) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                walk(&entry.path(), &relative, depth + 1, out, entries);
            }
        } else if kind.is_file() {
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta.modified().ok().map(DateTime::<Utc>::from);
            out.push(Item {
                value: json!({
                    "path": relative,
                    "name": name,
                    "modified": modified
                        .map(|m| m.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                        .unwrap_or_default(),
                    "bytes": meta.len(),
                }),
                id: relative,
                when: modified.map(|m| m.timestamp()),
            });
        }
    }
}

fn look_in_folder(
    cursor: &mut Cursor,
    folder: &str,
    now: DateTime<Utc>,
) -> Result<Vec<Item>, String> {
    let files = scan(folder)?;
    if !cursor.baselined {
        cursor.baselined = true;
        cursor.sizes.clear();
        remember(cursor, files.into_iter().map(|f| f.id).collect());
        return Ok(Vec::new());
    }
    let seen: HashSet<&str> = cursor.seen.iter().map(String::as_str).collect();
    let mut sizes = BTreeMap::new();
    let mut ready: Vec<Item> = Vec::new();
    for file in files.into_iter().filter(|f| !seen.contains(f.id.as_str())) {
        let bytes = file.value["bytes"].as_u64().unwrap_or(0);
        // Still being written: touched a moment ago, or a different size
        // than at the last look.
        let touched_lately = file
            .when
            .is_none_or(|when| now.timestamp() - when < SETTLE_SECS);
        let growing = cursor
            .sizes
            .get(&file.id)
            .is_some_and(|before| *before != bytes);
        sizes.insert(file.id.clone(), bytes);
        if !touched_lately && !growing {
            ready.push(file);
        }
    }
    cursor.sizes = sizes;
    ready.sort_by(|a, b| (a.when, &a.id).cmp(&(b.when, &b.id)));
    ready.truncate(MAX_RUNS_PER_POLL);
    for file in &ready {
        cursor.sizes.remove(&file.id);
    }
    // Marked seen one by one as their runs happen (`mark_seen`).
    Ok(ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn items_found_but_not_run_come_back_at_the_next_look() {
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let dir = folder.path().to_string_lossy().to_string();
        let policy = AddressPolicy { public_only: true };
        // Looks happen a minute after the files were written, so they count as settled.
        let later = || Utc::now() + chrono::Duration::seconds(120);
        let look = || {
            poll(
                root.path(),
                "wf",
                &Trigger::Folder,
                Some(dir.as_str()),
                policy,
                later(),
                Ok(()),
            )
        };

        // Baseline on the empty folder, then two new files.
        assert!(matches!(look().await.unwrap(), Polled::Items(items) if items.is_empty()));
        std::fs::write(folder.path().join("a.md"), "a").unwrap();
        std::fs::write(folder.path().join("b.md"), "b").unwrap();
        let Polled::Items(found) = look().await.unwrap() else {
            panic!("look failed")
        };
        assert_eq!(found.len(), 2);

        // Only the first had its run before the batch was cut short.
        mark_seen(root.path(), "wf", &found[0].id).unwrap();
        let Polled::Items(again) = look().await.unwrap() else {
            panic!("look failed")
        };
        let ids: Vec<&str> = again.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec![found[1].id.as_str()]);

        mark_seen(root.path(), "wf", &found[1].id).unwrap();
        assert!(matches!(look().await.unwrap(), Polled::Items(items) if items.is_empty()));
    }

    const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Blog</title>
    <link>https://example.com/</link>
    <item>
      <title>Second &amp; better</title>
      <link>https://example.com/2</link>
      <guid>post-2</guid>
      <pubDate>Tue, 06 Oct 2026 10:00:00 +0000</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    </item>
    <item>
      <title>First</title>
      <link>https://example.com/1</link>
      <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
      <description>Plain &lt;i&gt;text&lt;/i&gt;</description>
    </item>
  </channel>
</rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Blog</title>
  <link href="https://example.com/feed" rel="self"/>
  <entry>
    <title type="html">Newer entry</title>
    <link rel="enclosure" href="https://example.com/a.mp3"/>
    <link rel="alternate" href="https://example.com/n"/>
    <id>tag:example.com,2026:n</id>
    <published>2026-10-06T10:00:00Z</published>
    <updated>2026-10-07T10:00:00Z</updated>
    <summary>Short</summary>
  </entry>
  <entry>
    <title>Older entry</title>
    <link href="https://example.com/o"/>
    <id>tag:example.com,2026:o</id>
    <updated>2026-10-01T10:00:00+02:00</updated>
    <content type="html">&lt;p&gt;Body text&lt;/p&gt;</content>
  </entry>
</feed>"#;

    #[test]
    fn rss_posts_are_read_with_their_fields() {
        let items = parse_feed(RSS).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "post-2");
        assert_eq!(items[0].value["title"], "Second & better");
        assert_eq!(items[0].value["link"], "https://example.com/2");
        assert_eq!(items[0].value["summary"], "Hello world");
        assert_eq!(items[0].value["published"], "2026-10-06T10:00:00Z");
        // No guid: the link stands in as the id.
        assert_eq!(items[1].id, "https://example.com/1");
        assert_eq!(items[1].value["summary"], "Plain text");
        assert_eq!(newest(&items).unwrap().id, "post-2");
    }

    #[test]
    fn atom_entries_pick_the_alternate_link_and_fall_back_to_updated_and_content() {
        let items = parse_feed(ATOM).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "tag:example.com,2026:n");
        assert_eq!(items[0].value["link"], "https://example.com/n");
        assert_eq!(items[0].value["published"], "2026-10-06T10:00:00Z");
        assert_eq!(items[1].value["link"], "https://example.com/o");
        assert_eq!(items[1].value["published"], "2026-10-01T08:00:00Z");
        assert_eq!(items[1].value["summary"], "Body text");
    }

    #[test]
    fn something_else_is_not_a_feed() {
        assert!(parse_feed("<html><body>hi</body></html>").is_err());
        assert!(parse_feed("just text").is_err());
        assert_eq!(
            parse_feed("<rss><channel></channel></rss>").unwrap().len(),
            0
        );
    }

    #[test]
    fn hidden_and_temporary_files_are_ignored() {
        for name in [
            ".hidden",
            ".DS_Store",
            "~$report.docx",
            "a.tmp",
            "B.PART",
            "x.crdownload",
            "Thumbs.db",
        ] {
            assert!(ignored(name), "{name}");
        }
        for name in ["report.pdf", "notes.txt", "a.tmpl"] {
            assert!(!ignored(name), "{name}");
        }
    }

    #[test]
    fn the_cursor_keeps_only_the_newest_ids() {
        let mut cursor = Cursor::default();
        remember(
            &mut cursor,
            (0..SEEN_CAP + 5).map(|n| n.to_string()).collect(),
        );
        assert_eq!(cursor.seen.len(), SEEN_CAP);
        assert_eq!(cursor.seen[0], "5");
    }
}
