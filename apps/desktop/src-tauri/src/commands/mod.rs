//! Tauri command surface — split into domain modules.
//!
//! Each module owns a slice of the IPC surface. The `mod.rs` re-exports every
//! `#[tauri::command]` function so `main.rs`'s `use conduit_desktop::commands::*`
//! and `tauri::generate_handler![...]` continue to resolve.

pub mod app_inputs;
pub mod app_settings;
pub mod apps;
pub mod artifact_frames;
pub mod artifact_network;
pub mod artifacts;
pub mod branding;
pub mod chat;
pub mod connectors;
pub mod knowledge;
pub mod memory;
pub mod page_llm;
pub mod page_storage;
pub mod prompts;
pub mod research;
pub mod settings;
pub mod skills;
pub mod slides;
pub mod tray;
pub mod workflows;

pub use app_inputs::*;
pub use app_settings::*;
pub use apps::*;
pub use artifact_frames::*;
pub use artifact_network::*;
pub use artifacts::*;
pub use branding::*;
pub use chat::*;
pub use connectors::*;
pub use knowledge::*;
pub use memory::*;
pub use page_llm::*;
pub use page_storage::*;
pub use prompts::*;
pub use research::*;
pub use settings::*;
pub use skills::*;
pub use slides::*;
pub use tray::*;
pub use workflows::*;
