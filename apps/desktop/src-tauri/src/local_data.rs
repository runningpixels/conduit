//! Local-data housekeeping for the migration-recovery flow.
//!
//! When a startup migration fails, [`crate::db::migrations`] copies the old
//! store to `conduit.sqlite.corrupt-<unix>.bak`, writes a `.migration-failed`
//! marker, and starts fresh. This module owns the other half of that contract:
//! finding those leftovers, discarding them on request, and wiping the local
//! store outright when the user would rather start clean than keep a backup
//! they cannot open.
//!
//! **Deletes are deferred to the next startup.** The SQLite pool holds an open
//! handle on the live database for the whole session and Windows refuses to
//! unlink an open file, so an in-place wipe is a coin flip. Instead
//! [`request_wipe`] writes a `.pending-wipe` marker, the app restarts, and
//! [`apply_pending_wipe`] runs before the pool is opened — where the files are
//! guaranteed to be closed.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::paths::AppPaths;

/// Marker written next to the database when a migration fails. Human-readable;
/// support reads it out of a diagnostics bundle.
const FAILURE_MARKER_SUFFIX: &str = ".migration-failed";

/// Marker requesting a wipe on next launch. Lives in the app root (not next to
/// the database) because an `Everything` wipe removes the database entirely.
const PENDING_WIPE_MARKER: &str = ".pending-wipe";

/// How much to delete when the user asks to start over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WipeScope {
    /// Conversations, attachments, artifacts, stream journals, and every
    /// recovery backup. Settings and keychain credentials survive, so the user
    /// lands in an empty workspace rather than back in onboarding.
    Conversations,
    /// The above plus `settings.json`, logs, diagnostics, and exports — a
    /// first-run state. Keychain secrets are *not* touched: they are stored
    /// outside the app directory and deleting them is a separate, explicit ask.
    Everything,
}

impl WipeScope {
    fn as_str(self) -> &'static str {
        match self {
            WipeScope::Conversations => "conversations",
            WipeScope::Everything => "everything",
        }
    }

    /// Parse the renderer-supplied scope. Unknown values are rejected rather
    /// than defaulting — defaulting either under-deletes (user thinks their
    /// data is gone when it isn't) or over-deletes.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "conversations" => Ok(WipeScope::Conversations),
            "everything" => Ok(WipeScope::Everything),
            other => Err(format!(
                "unknown wipe scope '{other}' (expected 'conversations' or 'everything')"
            )),
        }
    }
}

/// What a discard or wipe actually removed. Returned to the renderer so the
/// confirmation can name real paths and a real byte count instead of claiming
/// success generically.
#[derive(Debug, Clone, Default)]
pub struct RemovalReport {
    pub removed_paths: Vec<String>,
    pub freed_bytes: u64,
}

impl RemovalReport {
    fn record(&mut self, path: &Path) {
        let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        match fs::remove_file(path) {
            Ok(()) => {
                self.removed_paths.push(path.display().to_string());
                self.freed_bytes += bytes;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                eprintln!("conduit: could not remove {}: {err}", path.display());
            }
        }
    }

    fn absorb(&mut self, other: RemovalReport) {
        self.removed_paths.extend(other.removed_paths);
        self.freed_bytes += other.freed_bytes;
    }
}

/// Path of the failure marker for `db_path`.
pub fn failure_marker_path(db_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}{FAILURE_MARKER_SUFFIX}", db_path.display()))
}

fn pending_wipe_path(paths: &AppPaths) -> PathBuf {
    paths.root.join(PENDING_WIPE_MARKER)
}

/// Every recovery backup sitting next to `db_path`, oldest first.
///
/// Matches both `.corrupt-<unix>.bak` (written by the migration recovery) and
/// `.reset-<unix>.bak` (written by the Settings → Privacy reset), because from
/// the user's side both are "the copy of my old data".
pub fn backup_paths(db_path: &Path) -> Vec<PathBuf> {
    let Some(dir) = db_path.parent() else {
        return Vec::new();
    };
    let Some(stem) = db_path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let corrupt_prefix = format!("{stem}.corrupt-");
    let reset_prefix = format!("{stem}.reset-");

    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                name.ends_with(".bak")
                    && (name.starts_with(&corrupt_prefix) || name.starts_with(&reset_prefix))
            })
        })
        .collect();
    found.sort();
    found
}

/// Total size of the recovery backups, for the "this frees N MB" copy.
pub fn backup_bytes(db_path: &Path) -> u64 {
    backup_paths(db_path)
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// Remove the failure marker. Best-effort: a marker we cannot delete is noise,
/// not a failure worth blocking the user on.
pub fn clear_failure_marker(db_path: &Path) {
    let _ = fs::remove_file(failure_marker_path(db_path));
}

/// Delete every recovery backup next to `db_path`, plus the failure marker.
///
/// Safe to run in-session: the backups are inert copies that nothing holds
/// open, unlike the live database.
pub fn discard_backups(db_path: &Path) -> RemovalReport {
    let mut report = RemovalReport::default();
    for backup in backup_paths(db_path) {
        report.record(&backup);
    }
    clear_failure_marker(db_path);
    report
}

/// Record that the user wants a wipe on next launch.
///
/// Nothing is deleted here — see the module docs on why this is deferred. The
/// caller is expected to restart the app immediately afterwards.
pub fn request_wipe(paths: &AppPaths, scope: WipeScope) -> Result<(), String> {
    fs::write(pending_wipe_path(paths), scope.as_str())
        .map_err(|e| format!("Could not schedule the reset: {e}"))
}

/// Drop a pending wipe request (used if the restart is cancelled).
pub fn cancel_pending_wipe(paths: &AppPaths) {
    let _ = fs::remove_file(pending_wipe_path(paths));
}

/// Whether a wipe is queued for the next launch.
pub fn pending_wipe(paths: &AppPaths) -> Option<WipeScope> {
    let raw = fs::read_to_string(pending_wipe_path(paths)).ok()?;
    WipeScope::parse(raw.trim()).ok()
}

/// Apply a queued wipe, if any. Call this **before** opening the database pool.
///
/// The marker is removed first: a wipe that panics halfway is bad, but a wipe
/// that re-runs on every launch and eats the user's new data is worse.
pub fn apply_pending_wipe(paths: &AppPaths) -> Option<RemovalReport> {
    let scope = pending_wipe(paths)?;
    let _ = fs::remove_file(pending_wipe_path(paths));

    let mut report = RemovalReport::default();

    // Live store + WAL sidecars. Removing the sidecars matters: a stale `-wal`
    // next to a missing database makes SQLite refuse to open the fresh one.
    let db = &paths.database;
    report.record(db);
    report.record(Path::new(&format!("{}-wal", db.display())));
    report.record(Path::new(&format!("{}-shm", db.display())));
    report.absorb(discard_backups(db));

    // Payload directories. Their contents are referenced by rows that no longer
    // exist, so leaving them would be orphaned bytes the user cannot reach.
    for dir in [&paths.attachments, &paths.artifacts, &paths.streams] {
        report.absorb(remove_dir_contents(dir));
    }

    if scope == WipeScope::Everything {
        report.record(&paths.settings_file);
        for dir in [
            &paths.logs,
            &paths.diagnostics,
            &paths.exports,
            &paths.connectors,
        ] {
            report.absorb(remove_dir_contents(dir));
        }
    }

    eprintln!(
        "conduit: applied pending wipe ({}) — {} item(s), {} byte(s) freed",
        scope.as_str(),
        report.removed_paths.len(),
        report.freed_bytes
    );
    Some(report)
}

/// Delete everything inside `dir`, keeping `dir` itself so `paths::resolve`'s
/// directory layout stays intact.
fn remove_dir_contents(dir: &Path) -> RemovalReport {
    let mut report = RemovalReport::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return report;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            let bytes = dir_size(&path);
            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    report.removed_paths.push(path.display().to_string());
                    report.freed_bytes += bytes;
                }
                Err(err) => eprintln!("conduit: could not remove {}: {err}", path.display()),
            }
        } else {
            report.record(&path);
        }
    }
    report
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                dir_size(&path)
            } else {
                fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> (tempfile::TempDir, AppPaths) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = crate::paths::resolve_in(dir.path()).expect("resolve");
        (dir, paths)
    }

    #[test]
    fn backup_paths_matches_both_backup_flavours() {
        let (_guard, paths) = temp_paths();
        let db = paths.database.display().to_string();
        fs::write(&paths.database, b"live").unwrap();
        fs::write(format!("{db}.corrupt-1787026415.bak"), b"a").unwrap();
        fs::write(format!("{db}.reset-1787026416.bak"), b"bb").unwrap();
        fs::write(format!("{db}-wal"), b"not a backup").unwrap();

        let found = backup_paths(&paths.database);
        assert_eq!(found.len(), 2, "found: {found:?}");
        assert_eq!(backup_bytes(&paths.database), 3);
    }

    #[test]
    fn discard_backups_leaves_the_live_database_alone() {
        let (_guard, paths) = temp_paths();
        let db = paths.database.display().to_string();
        fs::write(&paths.database, b"live").unwrap();
        fs::write(format!("{db}.corrupt-1.bak"), b"old").unwrap();
        fs::write(failure_marker_path(&paths.database), b"boom").unwrap();

        let report = discard_backups(&paths.database);

        assert_eq!(report.removed_paths.len(), 1);
        assert_eq!(report.freed_bytes, 3);
        assert!(paths.database.exists(), "live db must survive a discard");
        assert!(!failure_marker_path(&paths.database).exists());
    }

    #[test]
    fn pending_wipe_round_trips_and_applies_once() {
        let (_guard, paths) = temp_paths();
        fs::write(&paths.database, b"live").unwrap();
        fs::write(paths.attachments.join("a.bin"), b"payload").unwrap();
        fs::write(&paths.settings_file, b"{}").unwrap();

        request_wipe(&paths, WipeScope::Conversations).unwrap();
        assert_eq!(pending_wipe(&paths), Some(WipeScope::Conversations));

        let report = apply_pending_wipe(&paths).expect("wipe applied");
        assert!(report.freed_bytes >= 11);
        assert!(!paths.database.exists());
        assert!(!paths.attachments.join("a.bin").exists());
        assert!(paths.attachments.is_dir(), "directory layout must survive");
        assert!(
            paths.settings_file.exists(),
            "conversations scope must keep settings"
        );

        // Marker consumed — a second launch must not wipe again.
        assert_eq!(pending_wipe(&paths), None);
        assert!(apply_pending_wipe(&paths).is_none());
    }

    #[test]
    fn everything_scope_also_removes_settings() {
        let (_guard, paths) = temp_paths();
        fs::write(&paths.settings_file, b"{}").unwrap();

        request_wipe(&paths, WipeScope::Everything).unwrap();
        apply_pending_wipe(&paths).expect("wipe applied");

        assert!(!paths.settings_file.exists());
    }

    #[test]
    fn unknown_scope_is_rejected_not_defaulted() {
        assert!(WipeScope::parse("everythin").is_err());
        assert!(WipeScope::parse("").is_err());
    }
}
