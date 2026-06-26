//! Connector tool catalog and binding resolution.
//!
//! Ports the logic from `apps/desktop/src/chat/connectorTools.ts` so the Rust
//! agent loop can resolve provider-declared tool names (e.g. `myconn__myttool`)
//! to concrete `(connectorVersionId, toolName)` pairs without trusting the UI.

use crate::db::repository::connectors as conn_repo;
use provider_core::schema::ToolDefinition;
use serde::{Deserialize, Serialize};

/// Binding from a provider-visible tool name back to the connector implementation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorToolBinding {
    pub provider_tool_name: String,
    pub connector_version_id: String,
    pub connector_name: String,
    pub tool_name: String,
    pub description: String,
}

/// Result of building a catalog for a given set of runtime snapshots.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorToolCatalog {
    pub tool_definitions: Vec<ToolDefinition>,
    pub bindings: std::collections::HashMap<String, ConnectorToolBinding>,
}

/// Sanitize a connector or tool name segment for use in a composite provider tool name.
/// Mirrors the TypeScript `sanitizeSegment` exactly.
pub fn sanitize_segment(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "tool".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Determine whether a connector snapshot is callable (active grant, healthy support state).
/// This is a pure predicate; the caller supplies the snapshot shape.
pub fn is_connector_callable(grant_status: &str, support_state: &str) -> bool {
    if grant_status != "active" {
        return false;
    }
    !matches!(
        support_state,
        "adminDisabled" | "revoked" | "unsupported" | "authRequired"
    )
}

/// Build a tool catalog and binding map from a set of callable snapshots and their capabilities.
/// This is the direct port of `buildConnectorToolCatalog` from TypeScript.
pub fn build_connector_tool_catalog(
    snapshots: &[(String, String, String, String)], // (version_id, connector_id, connector_name, grant_status, support_state) simplified tuple for now
    capabilities_by_version: &std::collections::HashMap<String, Vec<conn_repo::ConnectorCapability>>,
) -> ConnectorToolCatalog {
    // NOTE: Full implementation requires the actual snapshot shape from the runtime states command.
    // For Phase A scaffolding we provide a stub that compiles and can be filled when the loop
    // is ready to invoke tools.
    let _ = (snapshots, capabilities_by_version);
    ConnectorToolCatalog::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_segment_basic() {
        assert_eq!(sanitize_segment("My Connector"), "My_Connector");
        assert_eq!(sanitize_segment("tool--name"), "tool--name");
        assert_eq!(sanitize_segment("!!!"), "tool");
        assert_eq!(sanitize_segment(""), "tool");
    }
}