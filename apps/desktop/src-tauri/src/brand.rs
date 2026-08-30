//! Product identity, in one place (Rust half).
//!
//! The renderer has its own copy of this seam in `apps/desktop/src/brand/`.
//! Both exist because user-visible product-name strings are produced on both
//! sides of the IPC boundary: the shell renders most of them, but startup
//! failures (keychain unavailable, migration rolled back, update refused)
//! are formatted in Rust before the renderer is in a position to show
//! anything.
//!
//! This is the seam both white-label modes need:
//!
//!   - runtime branding calls [`set`] once at startup, after reading the
//!     brand config off disk;
//!   - a packaged rebrand rewrites [`DEFAULT_APP_NAME`] at build time.
//!
//! Phase 0 ships the seam only — nothing calls [`set`] yet, so every string is
//! byte-identical to the literal it replaces.
//!
//! Reads before [`set`] fall back to the default rather than panicking or
//! blocking. That matters: `db::migrations` formats user-facing failure text
//! during startup, potentially before a brand config has been read, and a
//! migration failure must not be made worse by a branding lookup.

use std::sync::OnceLock;

/// The built-in product name. Build-time rebranding rewrites this.
pub const DEFAULT_APP_NAME: &str = "Conduit";

/// Product identity as resolved at runtime.
#[derive(Debug, Clone)]
pub struct Brand {
    pub app_name: String,
    pub display_name: String,
}

impl Default for Brand {
    fn default() -> Self {
        Self {
            app_name: DEFAULT_APP_NAME.to_string(),
            display_name: DEFAULT_APP_NAME.to_string(),
        }
    }
}

static ACTIVE: OnceLock<Brand> = OnceLock::new();

/// Install the runtime brand. First call wins; later calls return `Err` with
/// the rejected value rather than replacing a brand the UI has already
/// rendered against.
pub fn set(brand: Brand) -> Result<(), Brand> {
    ACTIVE.set(brand)
}

/// The active brand, or the built-in default if [`set`] has not run.
pub fn active() -> &'static Brand {
    static FALLBACK: OnceLock<Brand> = OnceLock::new();
    ACTIVE
        .get()
        .unwrap_or_else(|| FALLBACK.get_or_init(Brand::default))
}

/// Short product name — the common case, so it gets its own accessor.
pub fn app_name() -> &'static str {
    &active().app_name
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set` is process-global and single-shot, so this asserts the default
    /// path only; the `set` path is covered where branding is wired up.
    #[test]
    fn defaults_to_the_built_in_name() {
        assert_eq!(Brand::default().app_name, DEFAULT_APP_NAME);
        assert_eq!(Brand::default().display_name, DEFAULT_APP_NAME);
    }

    #[test]
    fn active_falls_back_before_set() {
        // Whether another test in this binary has called `set` first is not
        // knowable here, so assert the invariant that actually matters: a read
        // never panics and never yields an empty name.
        assert!(!app_name().is_empty());
    }
}
