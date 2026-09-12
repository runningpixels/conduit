//! Consent *policy* — how a discovered tool maps to a consent requirement.
//!
//! Enforcement (awaiting a user decision, emitting prompts) lives in the
//! conduit-desktop supervisor; this module only decides *whether* consent is
//! required for a given tool. The rule is conservative: a tool is treated as
//! side-effectful only when the connector explicitly declares it. An absent
//! `permissionLevel` defaults to read-only (auto) — the runtime never
//! silently treats something as side-effectful, and never silently runs a
//! declared side-effectful tool.

use crate::protocol::{McpTool, PermissionLevel};

/// Whether a tool invocation needs an explicit user decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsentKind {
    /// No prompt — invoke immediately.
    Auto,
    /// Stop and ask the user before invoking.
    Prompt,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentDecision {
    pub level: PermissionLevel,
    pub required: ConsentKind,
}

/// Classify a discovered tool. `None` permission level → read-only → auto.
pub fn classify(tool: &McpTool) -> ConsentDecision {
    let level = tool.permission_level.unwrap_or(PermissionLevel::ReadOnly);
    let required = match level {
        PermissionLevel::ReadOnly => ConsentKind::Auto,
        PermissionLevel::SideEffectful | PermissionLevel::Sensitive => ConsentKind::Prompt,
    };
    ConsentDecision { level, required }
}
