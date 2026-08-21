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

/// Minimal snapshot data needed to build a tool catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorToolSnapshot {
    pub connector_version_id: String,
    pub connector_id: String,
    pub connector_name: String,
    pub grant_status: Option<String>,
    pub support_state: Option<String>,
}

/// Sanitize a connector or tool name segment for use in a composite provider tool name.
/// Mirrors the TypeScript `sanitizeSegment` exactly.
pub fn sanitize_segment(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
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
pub fn is_connector_callable(grant_status: Option<&str>, support_state: Option<&str>) -> bool {
    if grant_status != Some("active") {
        return false;
    }
    !matches!(
        support_state.unwrap_or(""),
        "adminDisabled" | "revoked" | "unsupported" | "authRequired"
    )
}

/// Build a tool catalog and binding map from a set of callable snapshots and their capabilities.
/// This is the direct port of `buildConnectorToolCatalog` from TypeScript.
pub fn build_connector_tool_catalog(
    snapshots: &[ConnectorToolSnapshot],
    capabilities_by_version: &std::collections::HashMap<
        String,
        Vec<conn_repo::ConnectorCapability>,
    >,
) -> ConnectorToolCatalog {
    let mut tool_definitions = Vec::new();
    let mut bindings = std::collections::HashMap::new();
    let mut used_names = std::collections::HashSet::new();

    for snapshot in snapshots {
        if !is_connector_callable(
            snapshot.grant_status.as_deref(),
            snapshot.support_state.as_deref(),
        ) {
            continue;
        }
        let caps = capabilities_by_version
            .get(&snapshot.connector_version_id)
            .cloned()
            .unwrap_or_default();
        let tool_caps = caps.into_iter().filter(|cap| cap.kind == "tool");
        for cap in tool_caps {
            let connector_segment = sanitize_segment(&snapshot.connector_name);
            let tool_segment = sanitize_segment(&cap.name);
            let mut provider_tool_name = format!("{connector_segment}__{tool_segment}");
            let mut suffix = 2;
            while used_names.contains(&provider_tool_name) {
                provider_tool_name = format!("{connector_segment}__{tool_segment}_{suffix}");
                suffix += 1;
            }
            used_names.insert(provider_tool_name.clone());

            bindings.insert(
                provider_tool_name.clone(),
                ConnectorToolBinding {
                    provider_tool_name: provider_tool_name.clone(),
                    connector_version_id: snapshot.connector_version_id.clone(),
                    connector_name: snapshot.connector_name.clone(),
                    tool_name: cap.name.clone(),
                    description: format!("{}: {}", snapshot.connector_name, cap.name),
                },
            );
            tool_definitions.push(ToolDefinition {
                tool_id: provider_tool_name.clone(),
                name: provider_tool_name.clone(),
                description: format!("{}: {}", snapshot.connector_name, cap.name),
                input_schema: schema_object(cap.schema_json),
                permission_level: None,
                display_group: Some(snapshot.connector_name.clone()),
                tenant_scope: Some(snapshot.connector_id.clone()),
                kind: None,
                host_config: None,
            });
        }
    }

    ConnectorToolCatalog {
        tool_definitions,
        bindings,
    }
}

fn schema_object(value: Option<serde_json::Value>) -> serde_json::Value {
    match value {
        Some(v) if v.is_object() => v,
        _ => serde_json::json!({ "type": "object", "properties": {} }),
    }
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
