//! Tauri command surface — split into domain modules.
//!
//! Each module owns a slice of the IPC surface. The `mod.rs` re-exports every
//! `#[tauri::command]` function so `main.rs`'s `use conduit_desktop::commands::*`
//! and `tauri::generate_handler![...]` continue to resolve.

pub mod artifacts;
pub mod branding;
pub mod chat;
pub mod connectors;
pub mod memory;
pub mod prompts;
pub mod settings;
pub mod skills;

pub use artifacts::*;
pub use branding::*;
pub use chat::*;
pub use connectors::*;
pub use memory::*;
pub use prompts::*;
pub use settings::*;
pub use skills::*;
