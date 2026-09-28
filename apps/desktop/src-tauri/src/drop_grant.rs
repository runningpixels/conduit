//! Native drag-drop path grants (t1-8 P2 M1, D13).
//!
//! With the native drop handler on (the default), the renderer's own HTML5
//! `drop` event never fires on Windows, so message-box drops move onto
//! Tauri's native `WindowEvent::DragDrop` event too. That event carries
//! filesystem *paths* (`save_attachment` takes bytes), and a command that
//! reads any path the renderer names would be a read-any-file-on-disk
//! primitive — the renderer is untrusted for that (CONTRIBUTING invariant 1).
//!
//! So `main.rs`'s `on_window_event` records the paths of every native `Drop`
//! here as they land, and `commands::save_dropped_attachment` accepts a path
//! only if it was recorded within [`DROP_GRANT_TTL`] and has not already been
//! claimed. This module is the grant bookkeeping only — no I/O, no Tauri
//! types — so it is unit-testable without a window or an event loop.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a recorded drop remains claimable. Generous enough that the
/// renderer's read-then-call round trip never races it under normal
/// conditions, short enough that a stale path from a much earlier drop can't
/// be replayed later.
pub const DROP_GRANT_TTL: Duration = Duration::from_secs(60);

/// The paths of every native drop seen recently, each claimable exactly once.
#[derive(Debug, Default)]
pub struct DropGrants {
    drops: Vec<(Instant, PathBuf)>,
    ttl: Duration,
}

impl DropGrants {
    /// A grant table with the production TTL ([`DROP_GRANT_TTL`]).
    pub fn new() -> Self {
        Self::with_ttl(DROP_GRANT_TTL)
    }

    /// A grant table with an explicit TTL — used by tests that need to
    /// control expiry without waiting on the wall clock.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            drops: Vec::new(),
            ttl,
        }
    }

    /// Record every path from one native `Drop` event, timestamped `now`.
    /// Opportunistically drops anything already past its TTL, so this table
    /// never grows unbounded over a long-running session.
    pub fn record(&mut self, paths: Vec<PathBuf>, now: Instant) {
        self.prune(now);
        self.drops.extend(paths.into_iter().map(|p| (now, p)));
    }

    /// Claim `path` if it was recorded within the TTL of `now` and has not
    /// already been claimed. A successful claim removes the grant — it
    /// cannot be reused for a second `save_dropped_attachment` call.
    pub fn claim(&mut self, path: &Path, now: Instant) -> bool {
        self.prune(now);
        let Some(index) = self
            .drops
            .iter()
            .position(|(_, recorded_path)| recorded_path == path)
        else {
            return false;
        };
        self.drops.remove(index);
        true
    }

    fn prune(&mut self, now: Instant) {
        let ttl = self.ttl;
        self.drops
            .retain(|(recorded_at, _)| now.saturating_duration_since(*recorded_at) <= ttl);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrecorded_path_is_refused() {
        let mut grants = DropGrants::new();
        let now = Instant::now();
        assert!(!grants.claim(Path::new("/tmp/never-dropped.png"), now));
    }

    #[test]
    fn recorded_path_is_accepted_once() {
        let mut grants = DropGrants::new();
        let now = Instant::now();
        let path = PathBuf::from("/tmp/dropped.png");
        grants.record(vec![path.clone()], now);

        assert!(
            grants.claim(&path, now),
            "a freshly-recorded drop is claimable"
        );
        assert!(
            !grants.claim(&path, now),
            "a claimed grant cannot be claimed again"
        );
    }

    #[test]
    fn expired_grant_is_refused() {
        let mut grants = DropGrants::with_ttl(Duration::from_secs(60));
        let now = Instant::now();
        let recorded_at = now - Duration::from_secs(61);
        let path = PathBuf::from("/tmp/stale.png");
        grants.record(vec![path.clone()], recorded_at);

        assert!(
            !grants.claim(&path, now),
            "a grant older than the TTL must not be claimable"
        );
    }

    #[test]
    fn a_grant_still_within_ttl_is_claimable() {
        let mut grants = DropGrants::with_ttl(Duration::from_secs(60));
        let now = Instant::now();
        let recorded_at = now - Duration::from_secs(59);
        let path = PathBuf::from("/tmp/just-in-time.png");
        grants.record(vec![path.clone()], recorded_at);

        assert!(grants.claim(&path, now));
    }

    #[test]
    fn recording_multiple_paths_from_one_drop_makes_each_claimable() {
        let mut grants = DropGrants::new();
        let now = Instant::now();
        let a = PathBuf::from("/tmp/a.png");
        let b = PathBuf::from("/tmp/b.png");
        grants.record(vec![a.clone(), b.clone()], now);

        assert!(grants.claim(&a, now));
        assert!(grants.claim(&b, now));
    }

    #[test]
    fn a_different_path_is_not_confused_with_a_recorded_one() {
        let mut grants = DropGrants::new();
        let now = Instant::now();
        grants.record(vec![PathBuf::from("/tmp/a.png")], now);
        assert!(!grants.claim(Path::new("/tmp/b.png"), now));
    }
}
