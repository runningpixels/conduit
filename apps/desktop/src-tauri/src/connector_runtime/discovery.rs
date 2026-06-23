//! Capability discovery + caching: run `tools|resources|prompts/list` on a
//! running connector, map the results to `ConnectorCapability` rows, filter
//! through the version's tenant-approved `capability_allowlist`, and persist
//! them as a replace-batch keyed by `connector_version_id`.
//!
//! Re-running this is also the cache-invalidation hook Phase 8 calls when a
//! connector version or grant changes.

use tracing::warn;

use super::ActiveConnector;
use crate::db::repository::connectors::{self, ConnectorCapability, ConnectorVersion};
use crate::db::DbPool;

/// Discover capabilities for a running connector, filter through the version's
/// allowlist, persist (replace-batch), and return the filtered set. Discovery
/// failure is non-fatal: the connector stays `healthy` but yields an empty
/// cache and the error is returned to the caller to log.
pub async fn discover(
    active: &std::sync::Arc<ActiveConnector>,
    pool: &DbPool,
    version: &ConnectorVersion,
) -> Result<Vec<ConnectorCapability>, String> {
    let cancel = active.cancel.clone();
    let (tools, resources, prompts) = {
        let mut t = active.transport.lock().await;
        // Apply the runtime call timeout to discovery as well to prevent hung connectors.
        let lists = async {
            let tools = t.list_tools(&cancel).await.map_err(|e| e.message)?;
            let resources = t.list_resources(&cancel).await.map_err(|e| e.message)?;
            let prompts = t.list_prompts(&cancel).await.map_err(|e| e.message)?;
            Ok::<_, String>((tools, resources, prompts))
        };
        // Note: using a longer effective window; in practice the manager timeout applies at higher level.
        tokio::time::timeout(std::time::Duration::from_secs(30), lists).await.map_err(|_| "discovery timeout".to_string())??
    };

    let version_id = &version.id;
    let mut caps: Vec<ConnectorCapability> = Vec::new();
    for tool in tools {
        caps.push(connectors::new_capability(
            version_id,
            "tool",
            &tool.name,
            Some(tool.input_schema.clone()),
        ));
    }
    for res in resources {
        caps.push(connectors::new_capability(version_id, "resource", &res.name, None));
    }
    for prompt in prompts {
        caps.push(connectors::new_capability(version_id, "prompt", &prompt.name, None));
    }

    caps = apply_allowlist(caps, &version.capability_allowlist);

    connectors::upsert_capabilities(pool, version_id, &caps)
        .await
        .map_err(|e| e.to_string())?;
    Ok(caps)
}

/// Drop any capability whose name is not in the version's allowlist. An absent
/// or non-array allowlist means "no filter" (the tenant hasn't restricted the
/// connector's surface).
fn apply_allowlist(
    caps: Vec<ConnectorCapability>,
    allowlist: &Option<serde_json::Value>,
) -> Vec<ConnectorCapability> {
    let Some(value) = allowlist else {
        return caps;
    };
    let Some(arr) = value.as_array() else {
        warn!(target: "mcp_connector", "capability_allowlist is not an array; ignoring");
        return caps;
    };
    let allowed: std::collections::HashSet<&str> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    if allowed.is_empty() {
        return caps;
    }
    caps.into_iter()
        .filter(|c| allowed.contains(c.name.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cap(name: &str) -> ConnectorCapability {
        ConnectorCapability {
            id: name.into(),
            connector_version_id: "v".into(),
            kind: "tool".into(),
            name: name.into(),
            schema_json: None,
            discovered_at: "2026-06-22T00:00:00Z".into(),
        }
    }

    #[test]
    fn absent_allowlist_keeps_all() {
        let caps = vec![cap("a"), cap("b")];
        let out = apply_allowlist(caps, &None);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn allowlist_filters_to_named() {
        let caps = vec![cap("a"), cap("b"), cap("c")];
        let out = apply_allowlist(caps, &Some(json!(["a", "c"])));
        let names: Vec<&str> = out.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a", "c"]);
    }

    #[test]
    fn non_array_allowlist_is_ignored() {
        let caps = vec![cap("a"), cap("b")];
        let out = apply_allowlist(caps, &Some(json!("oops")));
        assert_eq!(out.len(), 2);
    }
}