//! Tauri command surface — split into domain modules.
//!
//! Each module owns a slice of the IPC surface. The `mod.rs` re-exports every
//! `#[tauri::command]` function so `main.rs`'s `use conduit_desktop::commands::*`
//! and `tauri::generate_handler![...]` continue to resolve.

pub mod artifacts;
pub mod chat;
pub mod connectors;
pub mod prompts;
pub mod settings;

pub use artifacts::*;
pub use chat::*;
pub use connectors::*;
pub use prompts::*;
pub use settings::*;
