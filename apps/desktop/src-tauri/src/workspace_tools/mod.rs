//! Workspace-scoped built-in file tools (read/write/edit/glob/grep).
//!
//! All paths resolve under a user-chosen root from `AppSettings`. Path policy
//! and secret redaction are enforced here before results return to the agent
//! loop. No shell execution.

pub mod path_policy;
pub mod secret_redact;
pub mod tools;

pub use path_policy::{resolve_existing, resolve_for_write, PolicyError, WorkspaceRoot};
pub use tools::{
    execute_workspace_edit, execute_workspace_glob, execute_workspace_grep, execute_workspace_read,
    execute_workspace_write, WorkspaceToolConfig,
};
