//! Repository modules over the Phase 3 SQLite schema.
//!
//! Populated across milestones:
//!   M2 — `conversations`, `messages`, `event_log`
//!   M4 — `attachments`, `artifacts`
//!   M5 — `connectors`, `licenses`, `tenant_cache`
//!   Phase 4 — `tool_calls` (MCP tool execution records; written directly, not
//!             via `event_log`, so the provider-stream `view == fold(events)`
//!             invariant stays scoped to provider streaming)

pub mod app_activity;
pub mod app_inputs;
pub mod app_settings;
pub mod apps;
pub mod artifact_network;
pub mod artifacts;
pub mod attachments;
pub mod compactions;
pub mod connectors;
pub mod conversations;
pub mod drafts;
pub mod event_log;
pub mod knowledge;
pub mod licenses;
pub mod memory;
pub mod messages;
pub mod page_llm;
pub mod page_storage;
pub mod prompts;
pub mod search;
pub mod skills;
pub mod slides;
pub mod tenant_cache;
pub mod tool_approval_memory;
pub mod tool_calls;
pub mod usage_summary;
pub mod workflows;
