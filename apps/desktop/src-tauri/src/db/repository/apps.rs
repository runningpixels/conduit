//! Saved mini-apps: a snapshot of an HTML artifact that outlives its chat.
//!
//! Saving copies the artifact's page into `apps.payload`; `source_artifact_id`
//! only remembers where it came from, so deleting the chat leaves the app. The
//! manifest and payload are encrypted like artifact content.

use std::path::Path;

use provider_core::schema::{
    AppCapabilities, AppCategory, AppCreatedWith, AppDetail, AppManifest, AppNetwork, AppOrigin,
    AppStorage, AppSummary,
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    db::{
        repository::{
            artifact_network::{self as grants, Principal},
            artifacts, page_storage,
        },
        DbError,
    },
    encryption::Encryption,
    starter_apps::StarterApp,
    time::now_iso8601,
};

/// The fixed quota a `storage` capability declaration gets, per ADR-012.
pub const STORAGE_QUOTA_BYTES: u64 = 5 * 1024 * 1024;

/// The one capability name a page may declare today.
pub const KNOWN_CAPABILITIES: &[&str] = &["storage"];

/// Check every declared capability is known, rejecting the first that isn't.
/// Returns whether `storage` was among them.
pub fn validate_capabilities(capabilities: &[String]) -> Result<bool, String> {
    for cap in capabilities {
        if !KNOWN_CAPABILITIES.contains(&cap.as_str()) {
            return Err(format!("invalid: unknown capability {cap:?}"));
        }
    }
    Ok(capabilities.iter().any(|c| c == "storage"))
}

pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_DESCRIPTION_CHARS: usize = 280;
pub const MAX_ICON_BYTES: usize = 16;
pub const MAX_PAYLOAD_BYTES: usize = 5 * 1024 * 1024;

/// What the user filled in on the Save as app form.
#[derive(Debug, Clone)]
pub struct AppMeta {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub category: AppCategory,
}

impl AppMeta {
    /// Trim and check the fields; an empty description or icon becomes `None`.
    pub fn validated(self) -> Result<Self, String> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err("An app needs a name.".to_string());
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(format!("Keep the name under {MAX_NAME_CHARS} characters."));
        }
        let description = self
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        if description
            .as_ref()
            .is_some_and(|d| d.chars().count() > MAX_DESCRIPTION_CHARS)
        {
            return Err(format!(
                "Keep the description under {MAX_DESCRIPTION_CHARS} characters."
            ));
        }
        let icon = self
            .icon
            .map(|i| i.trim().to_string())
            .filter(|i| !i.is_empty());
        if icon.as_ref().is_some_and(|i| i.len() > MAX_ICON_BYTES) {
            return Err("Use a single emoji for the icon.".to_string());
        }
        Ok(Self {
            name,
            description,
            icon,
            category: self.category,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn invalid(msg: impl Into<String>) -> DbError {
    DbError::Query(msg.into())
}

/// The page of an HTML artifact, or why it can't be an app.
async fn artifact_html(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
) -> Result<String, DbError> {
    let artifact = artifacts::get(pool, enc, artifact_id)
        .await?
        .ok_or_else(|| invalid("That document no longer exists."))?;
    if artifact.kind != "html" {
        return Err(invalid("Only HTML pages can be saved as apps."));
    }
    let bytes = artifacts::read_content_bytes(pool, artifacts_dir, enc, artifact_id).await?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid(
            "This page is too large to save as an app (5 MB at most).",
        ));
    }
    String::from_utf8(bytes).map_err(|_| invalid("This page isn't valid text."))
}

/// Bump the minor part of a `major.minor.patch` version; anything unparsable
/// restarts at 1.1.0.
fn bump_minor(version: &str) -> String {
    let parts: Vec<u64> = version.split('.').filter_map(|p| p.parse().ok()).collect();
    match parts.as_slice() {
        [major, minor, _] => format!("{major}.{}.0", minor + 1),
        _ => "1.1.0".to_string(),
    }
}

fn sorted_hosts(hosts: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut hosts: Vec<String> = hosts.into_iter().collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

fn manifest(
    id: &str,
    meta: &AppMeta,
    version: &str,
    hosts: Vec<String>,
    has_storage: bool,
) -> AppManifest {
    manifest_from(id, meta, version, hosts, has_storage, true)
}

fn manifest_from(
    id: &str,
    meta: &AppMeta,
    version: &str,
    hosts: Vec<String>,
    has_storage: bool,
    from_artifact: bool,
) -> AppManifest {
    AppManifest {
        manifest_version: 1,
        id: id.to_string(),
        name: meta.name.clone(),
        description: meta.description.clone(),
        icon: meta.icon.clone(),
        category: meta.category,
        version: version.to_string(),
        capabilities: AppCapabilities {
            network: (!hosts.is_empty()).then_some(AppNetwork { hosts }),
            storage: has_storage.then_some(AppStorage {
                quota_bytes: STORAGE_QUOTA_BYTES,
            }),
        },
        created_with: AppCreatedWith {
            conduit: env!("CARGO_PKG_VERSION").to_string(),
            from_artifact,
        },
    }
}

fn encode_manifest(enc: &Encryption, manifest: &AppManifest) -> Result<String, DbError> {
    let json = serde_json::to_string(manifest)
        .map_err(|e| DbError::Query(format!("encode app manifest: {e}")))?;
    enc.encrypt(&json)
}

fn decode_manifest(enc: &Encryption, stored: &str) -> Result<AppManifest, DbError> {
    serde_json::from_str(&enc.decrypt(stored)?)
        .map_err(|e| DbError::Query(format!("decode app manifest: {e}")))
}

/// Save an HTML artifact as a new app.
///
/// `declared_hosts` are the origins the page declares (read by the renderer
/// from its `conduit-network` meta tags, already normalised by the caller).
/// `keep_hosts` are the artifact's remembered grants the user chose to carry
/// over; each must really be one of them, so a caller can't mint a grant here.
/// `has_storage` is whether the page declared the `storage` capability
/// (validated by the caller); when it did, the artifact's `page_storage` rows
/// are copied to the new app so a tracker keeps its entries.
pub async fn save_from_artifact(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    artifact_id: &str,
    meta: AppMeta,
    declared_hosts: Vec<String>,
    has_storage: bool,
    keep_hosts: &[String],
) -> Result<AppSummary, DbError> {
    let html = artifact_html(pool, artifacts_dir, enc, artifact_id).await?;
    let artifact_grants: Vec<String> = grants::list(pool, Some(&Principal::artifact(artifact_id)))
        .await?
        .into_iter()
        .map(|g| g.host)
        .collect();
    if let Some(stray) = keep_hosts.iter().find(|h| !artifact_grants.contains(h)) {
        return Err(invalid(format!(
            "This page was never allowed to contact {stray}."
        )));
    }

    let id = Uuid::new_v4().to_string();
    let version = "1.0.0";
    let hosts = sorted_hosts(declared_hosts.into_iter().chain(keep_hosts.iter().cloned()));
    let manifest = manifest(&id, &meta, version, hosts, has_storage);
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO apps (id, name, description, icon, category, version, source_artifact_id, \
                           origin, manifest_json, payload, content_hash, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&meta.name)
    .bind(&meta.description)
    .bind(&meta.icon)
    .bind(meta.category.as_str())
    .bind(version)
    .bind(artifact_id)
    .bind(AppOrigin::Saved.as_str())
    .bind(encode_manifest(enc, &manifest)?)
    .bind(enc.encrypt(&html)?)
    .bind(sha256_hex(html.as_bytes()))
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let app = Principal::app(&id);
    for host in keep_hosts {
        grants::grant(pool, &app, host).await?;
    }
    if has_storage {
        page_storage::copy(pool, &Principal::artifact(artifact_id), &app)
            .await
            .map_err(DbError::from)?;
    }
    get_summary(pool, enc, &id)
        .await?
        .ok_or_else(|| invalid("The app wasn't saved."))
}

/// Columns every read selects, plus the source artifact's current hash.
const SELECT: &str = "SELECT p.id, p.name, p.description, p.icon, p.category, p.version, \
        p.origin, p.manifest_json, p.source_artifact_id, p.content_hash, a.content_hash, \
        p.last_opened_at, p.created_at, p.updated_at, p.starter_id \
     FROM apps p LEFT JOIN artifacts a ON a.id = p.source_artifact_id";

type AppRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

fn summary_from_row(enc: &Encryption, row: AppRow) -> Result<AppSummary, DbError> {
    let (
        id,
        name,
        description,
        icon,
        category,
        version,
        origin,
        manifest_json,
        source_artifact_id,
        content_hash,
        source_hash,
        last_opened_at,
        created_at,
        updated_at,
        starter_id,
    ) = row;
    let manifest = decode_manifest(enc, &manifest_json)?;
    Ok(AppSummary {
        id,
        name,
        description,
        icon,
        category: AppCategory::parse(&category).unwrap_or(AppCategory::Other),
        version,
        origin: AppOrigin::parse(&origin).unwrap_or(AppOrigin::Saved),
        hosts: manifest
            .capabilities
            .network
            .map(|n| n.hosts)
            .unwrap_or_default(),
        storage: manifest.capabilities.storage.is_some(),
        source_changed: source_hash.is_some_and(|h| h != content_hash),
        source_artifact_id,
        starter_id,
        last_opened_at,
        created_at,
        updated_at,
    })
}

/// Every app, most recently opened first (never-opened apps by when they
/// were saved).
pub async fn list(pool: &SqlitePool, enc: &Encryption) -> Result<Vec<AppSummary>, DbError> {
    let rows: Vec<AppRow> = sqlx::query_as(&format!(
        "{SELECT} ORDER BY COALESCE(p.last_opened_at, p.created_at) DESC, p.created_at DESC"
    ))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| summary_from_row(enc, row))
        .collect()
}

pub async fn get_summary(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<AppSummary>, DbError> {
    let row: Option<AppRow> = sqlx::query_as(&format!("{SELECT} WHERE p.id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?;
    row.map(|row| summary_from_row(enc, row)).transpose()
}

/// A starter app's copy follows the page this build ships: starters are
/// never edited by the user and are granted nothing when added, so when the
/// bundled page changes the copy is replaced and its minor version bumped.
/// A newly declared site still asks on first use.
async fn refresh_starter(pool: &SqlitePool, enc: &Encryption, id: &str) -> Result<(), DbError> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT starter_id, content_hash FROM apps WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let Some((Some(starter_id), hash)) = row else {
        return Ok(());
    };
    let Some(starter) = crate::starter_apps::find(&starter_id) else {
        return Ok(());
    };
    let bundled = sha256_hex(starter.html.as_bytes());
    if bundled == hash {
        return Ok(());
    }
    let old = stored_manifest(pool, enc, id).await?;
    let meta = AppMeta {
        name: old.name.clone(),
        description: old.description.clone(),
        icon: old.icon.clone(),
        category: old.category,
    };
    let version = bump_minor(&old.version);
    let hosts = sorted_hosts(starter.hosts.iter().map(|h| h.to_string()));
    let has_storage = starter.capabilities.contains(&"storage");
    let manifest = manifest_from(id, &meta, &version, hosts, has_storage, false);
    sqlx::query(
        "UPDATE apps SET version = ?, manifest_json = ?, payload = ?, content_hash = ?,                          updated_at = ? WHERE id = ?",
    )
    .bind(&version)
    .bind(encode_manifest(enc, &manifest)?)
    .bind(enc.encrypt(starter.html)?)
    .bind(bundled)
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// An app with its page, stamping when it was opened. A starter app is
/// first brought up to the page this build ships.
pub async fn open(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<AppDetail>, DbError> {
    refresh_starter(pool, enc, id).await?;
    sqlx::query("UPDATE apps SET last_opened_at = ? WHERE id = ?")
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    let Some(summary) = get_summary(pool, enc, id).await? else {
        return Ok(None);
    };
    let (payload,): (String,) = sqlx::query_as("SELECT payload FROM apps WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(Some(AppDetail {
        summary,
        html: enc.decrypt(&payload)?,
    }))
}

async fn stored_manifest(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<AppManifest, DbError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT manifest_json FROM apps WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let (stored,) = row.ok_or_else(|| invalid("That app no longer exists."))?;
    decode_manifest(enc, &stored)
}

/// Rename or re-describe an app. The page is untouched.
pub async fn update_meta(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    meta: AppMeta,
) -> Result<AppSummary, DbError> {
    let old = stored_manifest(pool, enc, id).await?;
    let hosts = old
        .capabilities
        .network
        .map(|n| n.hosts)
        .unwrap_or_default();
    let has_storage = old.capabilities.storage.is_some();
    let manifest = manifest(id, &meta, &old.version, hosts, has_storage);
    sqlx::query(
        "UPDATE apps SET name = ?, description = ?, icon = ?, category = ?, manifest_json = ?, \
                         updated_at = ? WHERE id = ?",
    )
    .bind(&meta.name)
    .bind(&meta.description)
    .bind(&meta.icon)
    .bind(meta.category.as_str())
    .bind(encode_manifest(enc, &manifest)?)
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    get_summary(pool, enc, id)
        .await?
        .ok_or_else(|| invalid("That app no longer exists."))
}

/// Take a fresh snapshot of the app's source artifact and bump its minor
/// version. Declared hosts are re-read from the new page; the app's own grants
/// stay (the user gave them to this app), and a newly declared host still asks
/// on first use. The app's `page_storage` rows are untouched either way — only
/// the manifest's `storage` capability is recomputed from `has_storage`, the
/// new page's own declaration.
pub async fn update_from_artifact(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    enc: &Encryption,
    id: &str,
    declared_hosts: Vec<String>,
    has_storage: bool,
) -> Result<AppSummary, DbError> {
    let summary = get_summary(pool, enc, id)
        .await?
        .ok_or_else(|| invalid("That app no longer exists."))?;
    let source = summary
        .source_artifact_id
        .clone()
        .ok_or_else(|| invalid("This app wasn't saved from a page in a chat."))?;
    let html = artifact_html(pool, artifacts_dir, enc, &source).await?;
    let old = stored_manifest(pool, enc, id).await?;
    let granted = grants::list(pool, Some(&Principal::app(id)))
        .await?
        .into_iter()
        .map(|g| g.host);
    let hosts = sorted_hosts(declared_hosts.into_iter().chain(granted));
    let meta = AppMeta {
        name: old.name.clone(),
        description: old.description.clone(),
        icon: old.icon.clone(),
        category: old.category,
    };
    let version = bump_minor(&old.version);
    let manifest = manifest(id, &meta, &version, hosts, has_storage);
    sqlx::query(
        "UPDATE apps SET version = ?, manifest_json = ?, payload = ?, content_hash = ?, \
                         updated_at = ? WHERE id = ?",
    )
    .bind(&version)
    .bind(encode_manifest(enc, &manifest)?)
    .bind(enc.encrypt(&html)?)
    .bind(sha256_hex(html.as_bytes()))
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    get_summary(pool, enc, id)
        .await?
        .ok_or_else(|| invalid("That app no longer exists."))
}

/// The user's copy of a starter app, if they added it.
pub async fn installed_starters(
    pool: &SqlitePool,
) -> Result<std::collections::HashMap<String, String>, DbError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT starter_id, id FROM apps WHERE starter_id IS NOT NULL")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

/// Add a starter app to the user's apps, or return the copy they already
/// have. Nothing is granted: its sites still ask on first use.
pub async fn install_starter(
    pool: &SqlitePool,
    enc: &Encryption,
    starter: &StarterApp,
    meta: AppMeta,
) -> Result<AppSummary, DbError> {
    if let Some(existing) = installed_starters(pool).await?.get(starter.id) {
        return get_summary(pool, enc, existing)
            .await?
            .ok_or_else(|| invalid("That app no longer exists."));
    }
    let id = Uuid::new_v4().to_string();
    let version = "1.0.0";
    let hosts = sorted_hosts(starter.hosts.iter().map(|h| h.to_string()));
    let has_storage = starter.capabilities.contains(&"storage");
    let manifest = manifest_from(&id, &meta, version, hosts, has_storage, false);
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO apps (id, name, description, icon, category, version, source_artifact_id, \
                           origin, manifest_json, payload, content_hash, created_at, updated_at, \
                           starter_id) \
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&meta.name)
    .bind(&meta.description)
    .bind(&meta.icon)
    .bind(meta.category.as_str())
    .bind(version)
    .bind(AppOrigin::Starter.as_str())
    .bind(encode_manifest(enc, &manifest)?)
    .bind(enc.encrypt(starter.html)?)
    .bind(sha256_hex(starter.html.as_bytes()))
    .bind(&now)
    .bind(&now)
    .bind(starter.id)
    .execute(pool)
    .await?;
    get_summary(pool, enc, &id)
        .await?
        .ok_or_else(|| invalid("The app wasn't added."))
}

/// Delete an app, its grants, and its storage.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    let app = Principal::app(id);
    grants::clear(pool, Some(&app)).await?;
    page_storage::clear(pool, &app)
        .await
        .map_err(DbError::from)?;
    sqlx::query("DELETE FROM apps WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minor_bumps_reset_patch() {
        assert_eq!(bump_minor("1.0.0"), "1.1.0");
        assert_eq!(bump_minor("2.9.4"), "2.10.0");
        assert_eq!(bump_minor("weird"), "1.1.0");
    }

    #[test]
    fn meta_is_trimmed_and_bounded() {
        let meta = |name: &str, icon: Option<&str>| AppMeta {
            name: name.to_string(),
            description: Some("  ".to_string()),
            icon: icon.map(str::to_string),
            category: AppCategory::Tools,
        };
        let ok = meta("  Timer ", Some("🍅")).validated().unwrap();
        assert_eq!(ok.name, "Timer");
        assert_eq!(ok.description, None);
        assert!(meta("   ", None).validated().is_err());
        assert!(meta(&"x".repeat(81), None).validated().is_err());
        assert!(meta("Timer", Some("this is not an emoji"))
            .validated()
            .is_err());
    }
}
