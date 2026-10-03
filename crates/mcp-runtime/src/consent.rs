//! Consent *policy* — how a discovered tool maps to a consent requirement.
//!
//! Enforcement (awaiting a user decision, emitting prompts) lives in the
//! conduit-desktop supervisor; this module only decides *whether* consent is
//! required for a given tool. A tool runs without asking only when it is
//! declared read-only — by a Conduit `permissionLevel` or the standard MCP
//! `readOnlyHint: true`. Anything undeclared asks first (see
//! [`McpTool::effective_permission_level`]).

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

/// Classify a discovered tool: read-only runs, everything else asks.
pub fn classify(tool: &McpTool) -> ConsentDecision {
    let level = tool.effective_permission_level();
    let required = match level {
        PermissionLevel::ReadOnly => ConsentKind::Auto,
        PermissionLevel::SideEffectful | PermissionLevel::Sensitive => ConsentKind::Prompt,
    };
    ConsentDecision { level, required }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ToolAnnotations;

    fn tool(level: Option<PermissionLevel>, annotations: Option<ToolAnnotations>) -> McpTool {
        McpTool {
            name: "t".into(),
            description: String::new(),
            input_schema: serde_json::json!({ "type": "object" }),
            permission_level: level,
            annotations,
        }
    }

    fn hints(read_only: Option<bool>, destructive: Option<bool>) -> Option<ToolAnnotations> {
        Some(ToolAnnotations {
            read_only_hint: read_only,
            destructive_hint: destructive,
        })
    }

    #[test]
    fn an_undeclared_tool_asks() {
        let d = classify(&tool(None, None));
        assert_eq!(d.level, PermissionLevel::SideEffectful);
        assert_eq!(d.required, ConsentKind::Prompt);
        // Annotations present but silent on read-only: still asks.
        assert_eq!(
            classify(&tool(None, hints(None, None))).required,
            ConsentKind::Prompt
        );
    }

    #[test]
    fn read_only_hint_runs_without_asking() {
        let d = classify(&tool(None, hints(Some(true), None)));
        assert_eq!(d.level, PermissionLevel::ReadOnly);
        assert_eq!(d.required, ConsentKind::Auto);
    }

    #[test]
    fn not_read_only_or_destructive_asks() {
        assert_eq!(
            classify(&tool(None, hints(Some(false), None))).required,
            ConsentKind::Prompt
        );
        assert_eq!(
            classify(&tool(None, hints(None, Some(true)))).required,
            ConsentKind::Prompt
        );
        assert_eq!(
            classify(&tool(None, hints(None, Some(false)))).required,
            ConsentKind::Prompt
        );
    }

    #[test]
    fn a_conduit_permission_level_wins_over_hints() {
        let read_only = tool(
            Some(PermissionLevel::ReadOnly),
            hints(Some(false), Some(true)),
        );
        assert_eq!(classify(&read_only).required, ConsentKind::Auto);
        let sensitive = tool(Some(PermissionLevel::Sensitive), hints(Some(true), None));
        assert_eq!(classify(&sensitive).level, PermissionLevel::Sensitive);
        assert_eq!(classify(&sensitive).required, ConsentKind::Prompt);
    }

    #[test]
    fn parses_standard_annotations_from_a_tool_listing() {
        let t: McpTool = serde_json::from_value(serde_json::json!({
            "name": "read_file",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Read file", "readOnlyHint": true, "openWorldHint": false }
        }))
        .unwrap();
        assert_eq!(classify(&t).required, ConsentKind::Auto);
        let t: McpTool = serde_json::from_value(serde_json::json!({
            "name": "write_file",
            "inputSchema": { "type": "object" },
            "annotations": { "destructiveHint": true }
        }))
        .unwrap();
        assert_eq!(classify(&t).required, ConsentKind::Prompt);
    }
}
