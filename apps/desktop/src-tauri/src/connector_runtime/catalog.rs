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

/// The connector tool catalog as the stored connectors, grants and discovered
/// capabilities describe it now.
pub async fn load_connector_tool_catalog(
    pool: &sqlx::SqlitePool,
) -> Result<ConnectorToolCatalog, String> {
    use std::collections::HashMap;

    let defs = conn_repo::list_definitions(pool)
        .await
        .map_err(|e| e.to_string())?;
    let grants = conn_repo::list_grants(pool, None)
        .await
        .map_err(|e| e.to_string())?;
    let mut grant_by_version: HashMap<String, String> = HashMap::new();
    for grant in grants {
        match grant_by_version.get(&grant.connector_version_id) {
            Some(existing) if existing == "active" => {}
            _ => {
                grant_by_version.insert(grant.connector_version_id.clone(), grant.status.clone());
            }
        }
    }

    let mut snapshots = Vec::new();
    let mut capabilities_by_version = HashMap::new();
    for def in defs {
        let versions = conn_repo::list_versions(pool, &def.id)
            .await
            .map_err(|e| e.to_string())?;
        for version in versions {
            let caps = conn_repo::list_capabilities(pool, &version.id)
                .await
                .map_err(|e| e.to_string())?;
            capabilities_by_version.insert(version.id.clone(), caps);
            snapshots.push(ConnectorToolSnapshot {
                connector_version_id: version.id.clone(),
                connector_id: def.id.clone(),
                connector_name: def.name.clone(),
                grant_status: grant_by_version.get(&version.id).cloned(),
                support_state: version.support_state.clone(),
            });
        }
    }

    Ok(build_connector_tool_catalog(
        &snapshots,
        &capabilities_by_version,
    ))
}

// --- tool search -------------------------------------------------------------

/// Matches `search_tools` returns when the model gives no `limit`.
pub const SEARCH_TOOLS_DEFAULT_LIMIT: usize = 8;
/// The most matches one `search_tools` call returns.
pub const SEARCH_TOOLS_MAX_LIMIT: usize = 20;
/// Characters of a tool's own description kept in a match's summary.
const SUMMARY_MAX_CHARS: usize = 160;

/// One connector tool `search_tools` found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolMatch {
    /// The name the model calls it by (`<connector>__<tool>`).
    pub name: String,
    /// The connector's display name.
    pub connector: String,
    /// What the tool does: its own description when discovery stored one,
    /// else `"<connector>: <tool>"`.
    pub summary: String,
}

/// Words too common to tell tools apart.
const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "the", "to", "of", "for", "in", "on", "my", "me", "i", "with", "from", "by",
    "or", "is", "it", "this", "that", "tool", "tools",
];

/// Lowercase words of `text`, split on anything that is not a letter or digit
/// and at camelCase boundaries (`listIssues` → `list`, `issues`).
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            if c.is_uppercase() && prev_lower && !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            prev_lower = c.is_lowercase() || c.is_numeric();
            current.extend(c.to_lowercase());
        } else {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            prev_lower = false;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// The tool's own description (stored by discovery as the schema's top-level
/// `description`), if it has one.
fn schema_description(def: &ToolDefinition) -> Option<&str> {
    def.input_schema
        .get("description")
        .and_then(|d| d.as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty())
}

/// Property names and their descriptions from the tool's input schema.
fn schema_property_text(def: &ToolDefinition) -> String {
    let mut text = String::new();
    if let Some(props) = def
        .input_schema
        .get("properties")
        .and_then(|p| p.as_object())
    {
        for (name, prop) in props {
            text.push(' ');
            text.push_str(name);
            if let Some(about) = prop.get("description").and_then(|d| d.as_str()) {
                text.push(' ');
                text.push_str(about);
            }
        }
    }
    text
}

fn summary_of(def: &ToolDefinition) -> String {
    match schema_description(def) {
        Some(about) => {
            let first_line = about.lines().next().unwrap_or(about).trim();
            if first_line.chars().count() > SUMMARY_MAX_CHARS {
                let cut: String = first_line.chars().take(SUMMARY_MAX_CHARS - 1).collect();
                format!("{}…", cut.trim_end())
            } else {
                first_line.to_string()
            }
        }
        None => def.description.clone(),
    }
}

/// How well `term` matches one of `field`'s words: 2 for the same word, 1
/// when one starts with the other (`issue` / `issues`), 0 otherwise.
fn term_match(term: &str, field: &[String]) -> u32 {
    let mut best = 0;
    for word in field {
        if word == term {
            return 2;
        }
        let shorter = word.len().min(term.len());
        if shorter >= 3 && (word.starts_with(term) || term.starts_with(word.as_str())) {
            best = 1;
        }
    }
    best
}

/// Connector tools in `catalog` matching `query`, best first, at most
/// `limit`. Each query word is matched case-insensitively against the tool's
/// name (weighted most), its connector's name, and its description and input
/// fields. A tool must match at least one word.
pub fn search_connector_tools(
    catalog: &ConnectorToolCatalog,
    query: &str,
    limit: usize,
) -> Vec<ToolMatch> {
    let mut terms: Vec<String> = words(query)
        .into_iter()
        .filter(|w| !STOP_WORDS.contains(&w.as_str()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    terms.retain(|t| seen.insert(t.clone()));
    if terms.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(usize, u32, ToolMatch)> = Vec::new();
    for def in &catalog.tool_definitions {
        let binding = catalog.bindings.get(&def.name);
        let connector = binding
            .map(|b| b.connector_name.clone())
            .or_else(|| def.display_group.clone())
            .unwrap_or_default();
        let tool_name = binding.map(|b| b.tool_name.as_str()).unwrap_or(&def.name);
        let name_words = words(&format!("{} {}", def.name, tool_name));
        let connector_words = words(&connector);
        let about_words = words(&format!(
            "{} {}",
            schema_description(def).unwrap_or(""),
            schema_property_text(def)
        ));

        let mut matched = 0usize;
        let mut score = 0u32;
        for term in &terms {
            let best = (term_match(term, &name_words) * 3)
                .max(term_match(term, &connector_words) * 2)
                .max(term_match(term, &about_words));
            if best > 0 {
                matched += 1;
                score += best;
            }
        }
        if matched > 0 {
            scored.push((
                matched,
                score,
                ToolMatch {
                    name: def.name.clone(),
                    connector,
                    summary: summary_of(def),
                },
            ));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then_with(|| a.2.name.cmp(&b.2.name))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, found)| found)
        .collect()
}

/// The display names of the connectors with tools in `catalog`, sorted.
pub fn connector_names(catalog: &ConnectorToolCatalog) -> Vec<String> {
    let mut names: Vec<String> = catalog
        .bindings
        .values()
        .map(|b| b.connector_name.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// `search_tools`' `limit` argument: a number or a numeric string, clamped to
/// 1..=[`SEARCH_TOOLS_MAX_LIMIT`]; [`SEARCH_TOOLS_DEFAULT_LIMIT`] otherwise.
pub fn search_tools_limit(value: Option<&serde_json::Value>) -> usize {
    let asked = match value {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match asked {
        Some(n) if n.is_finite() && n >= 1.0 => (n as usize).min(SEARCH_TOOLS_MAX_LIMIT),
        Some(_) => 1,
        None => SEARCH_TOOLS_DEFAULT_LIMIT,
    }
}

/// What `search_tools` returns to the model. With matches, the tools (which
/// the agent loop then loads for the rest of the turn); with none, the
/// connector names, so the model can search again.
pub fn search_tools_output(
    catalog: &ConnectorToolCatalog,
    query: &str,
    limit: usize,
) -> serde_json::Value {
    let found = search_connector_tools(catalog, query, limit);
    if found.is_empty() {
        let connectors = connector_names(catalog);
        let note = if connectors.is_empty() {
            "No connector tools are available.".to_string()
        } else {
            "No connector tool matched. Search again with other words, or with one of these connector names."
                .to_string()
        };
        return serde_json::json!({
            "ok": true,
            "query": query,
            "tools": [],
            "connectors": connectors,
            "note": note,
        });
    }
    serde_json::json!({
        "ok": true,
        "query": query,
        "tools": found,
        "note": "These tools are now loaded. Call them by name.",
    })
}

/// The definitions of the tools a `search_tools` result lists, from `catalog`.
pub fn found_tool_definitions(
    catalog: &ConnectorToolCatalog,
    output: &serde_json::Value,
) -> Vec<ToolDefinition> {
    let Some(tools) = output.get("tools").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .filter_map(|name| catalog.tool_definitions.iter().find(|d| d.name == name))
        .cloned()
        .collect()
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

    fn cap(version: &str, name: &str, schema: serde_json::Value) -> conn_repo::ConnectorCapability {
        conn_repo::ConnectorCapability {
            id: format!("{version}/{name}"),
            connector_version_id: version.into(),
            kind: "tool".into(),
            name: name.into(),
            schema_json: Some(schema),
            discovered_at: "2026-10-27T00:00:00Z".into(),
        }
    }

    fn snapshot(version: &str, id: &str, name: &str) -> ConnectorToolSnapshot {
        ConnectorToolSnapshot {
            connector_version_id: version.into(),
            connector_id: id.into(),
            connector_name: name.into(),
            grant_status: Some("active".into()),
            support_state: None,
        }
    }

    fn sample_catalog() -> ConnectorToolCatalog {
        let mut caps = std::collections::HashMap::new();
        caps.insert(
            "tracker:1".to_string(),
            vec![
                cap(
                    "tracker:1",
                    "createIssue",
                    serde_json::json!({
                        "type": "object",
                        "description": "Open a new issue in a project.",
                        "properties": { "title": { "type": "string" } }
                    }),
                ),
                cap(
                    "tracker:1",
                    "list_projects",
                    serde_json::json!({ "type": "object", "properties": {} }),
                ),
            ],
        );
        caps.insert(
            "calendar:1".to_string(),
            vec![cap(
                "calendar:1",
                "list_events",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "day": { "type": "string", "description": "The meeting day" }
                    }
                }),
            )],
        );
        build_connector_tool_catalog(
            &[
                snapshot("tracker:1", "tracker", "Issue Tracker"),
                snapshot("calendar:1", "calendar", "Team Calendar"),
            ],
            &caps,
        )
    }

    #[test]
    fn words_split_case_and_punctuation() {
        assert_eq!(words("listIssues"), vec!["list", "issues"]);
        assert_eq!(
            words("Issue_Tracker__create-issue"),
            vec!["issue", "tracker", "create", "issue"]
        );
        assert_eq!(words("HTTP API"), vec!["http", "api"]);
    }

    #[test]
    fn search_matches_tool_names_case_insensitively_and_by_prefix() {
        let found = search_connector_tools(&sample_catalog(), "Create ISSUES", 8);
        assert_eq!(found[0].name, "Issue_Tracker__createIssue");
        assert_eq!(found[0].connector, "Issue Tracker");
        assert_eq!(found[0].summary, "Open a new issue in a project.");
    }

    #[test]
    fn search_matches_connector_names_and_schema_text() {
        let by_connector = search_connector_tools(&sample_catalog(), "calendar", 8);
        assert_eq!(
            by_connector
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Team_Calendar__list_events"]
        );
        let by_property = search_connector_tools(&sample_catalog(), "meeting", 8);
        assert_eq!(by_property[0].name, "Team_Calendar__list_events");
        // No stored description: the summary falls back to "connector: tool".
        assert_eq!(by_property[0].summary, "Team Calendar: list_events");
    }

    #[test]
    fn search_ranks_more_matched_words_first_and_honours_the_limit() {
        let found = search_connector_tools(&sample_catalog(), "list projects", 8);
        assert_eq!(found[0].name, "Issue_Tracker__list_projects");
        assert!(
            found.iter().any(|m| m.name == "Team_Calendar__list_events"),
            "list_events matches `list` too"
        );
        assert_eq!(
            search_connector_tools(&sample_catalog(), "list", 1).len(),
            1
        );
    }

    #[test]
    fn stop_words_alone_match_nothing() {
        assert!(search_connector_tools(&sample_catalog(), "the tools for me", 8).is_empty());
    }

    #[test]
    fn no_match_returns_the_connector_names() {
        let output = search_tools_output(&sample_catalog(), "weather forecast", 8);
        assert_eq!(output["tools"], serde_json::json!([]));
        assert_eq!(
            output["connectors"],
            serde_json::json!(["Issue Tracker", "Team Calendar"])
        );
        assert!(found_tool_definitions(&sample_catalog(), &output).is_empty());
    }

    #[test]
    fn found_definitions_come_from_the_catalog() {
        let catalog = sample_catalog();
        let output = search_tools_output(&catalog, "create issue", 8);
        let defs = found_tool_definitions(&catalog, &output);
        // `issue` also matches the connector's name, so its other tool comes
        // second; the calendar tool matches nothing.
        assert_eq!(
            defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            vec!["Issue_Tracker__createIssue", "Issue_Tracker__list_projects"]
        );
        assert_eq!(defs[0].tenant_scope.as_deref(), Some("tracker"));
    }

    #[test]
    fn limit_defaults_and_clamps() {
        assert_eq!(search_tools_limit(None), SEARCH_TOOLS_DEFAULT_LIMIT);
        assert_eq!(search_tools_limit(Some(&serde_json::json!(3))), 3);
        assert_eq!(search_tools_limit(Some(&serde_json::json!("5"))), 5);
        assert_eq!(
            search_tools_limit(Some(&serde_json::json!(500))),
            SEARCH_TOOLS_MAX_LIMIT
        );
        assert_eq!(search_tools_limit(Some(&serde_json::json!(0))), 1);
        assert_eq!(
            search_tools_limit(Some(&serde_json::json!(null))),
            SEARCH_TOOLS_DEFAULT_LIMIT
        );
    }
}
