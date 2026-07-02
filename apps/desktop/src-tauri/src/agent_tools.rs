use std::path::{Path, PathBuf};

use provider_core::schema::{PermissionLevel, ToolCallRecord, ToolCallStatus, ToolDefinition};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    db::repository::{
        artifacts::{self, Artifact, ArtifactContent},
        tool_calls,
    },
    encryption::Encryption,
    time::now_iso8601,
};

pub const WRITE_HTML_TOOL: &str = "write_html_document";
pub const EDIT_HTML_TOOL: &str = "edit_html_document";
pub const WRITE_MARKDOWN_TOOL: &str = "write_markdown_document";
pub const EDIT_MARKDOWN_TOOL: &str = "edit_markdown_document";
pub const WRITE_TEXT_TOOL: &str = "write_text_document";
pub const EDIT_TEXT_TOOL: &str = "edit_text_document";
pub const EXPORT_DOCUMENT_TOOL: &str = "export_document";

pub struct AgentToolContext<'a> {
    pub db: &'a sqlx::SqlitePool,
    pub artifacts_dir: &'a Path,
    pub exports_dir: &'a Path,
    pub encryption: &'a Encryption,
    pub conversation_id: &'a str,
    pub source_message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentToolExecution {
    pub record: ToolCallRecord,
    pub output: Value,
    pub is_error: bool,
}

pub fn builtin_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_id: WRITE_HTML_TOOL.to_string(),
            name: WRITE_HTML_TOOL.to_string(),
            description: "Create a new HTML document artifact. Omit artifact_id for new documents — Conduit assigns IDs.".to_string(),
            input_schema: json_schema(&[
                ("title", "string", false),
                ("html", "string", true),
                ("artifact_id", "string", false),
                ("filename", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: EDIT_HTML_TOOL.to_string(),
            name: EDIT_HTML_TOOL.to_string(),
            description: "Replace the full contents of an existing HTML document artifact."
                .to_string(),
            input_schema: json_schema(&[
                ("artifact_id", "string", true),
                ("updated_html", "string", true),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WRITE_MARKDOWN_TOOL.to_string(),
            name: WRITE_MARKDOWN_TOOL.to_string(),
            description: "Create a new Markdown document artifact. Omit artifact_id for new documents — Conduit assigns IDs.".to_string(),
            input_schema: json_schema(&[
                ("title", "string", false),
                ("markdown", "string", true),
                ("artifact_id", "string", false),
                ("filename", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: EDIT_MARKDOWN_TOOL.to_string(),
            name: EDIT_MARKDOWN_TOOL.to_string(),
            description: "Replace the full contents of an existing Markdown document artifact."
                .to_string(),
            input_schema: json_schema(&[
                ("artifact_id", "string", true),
                ("updated_markdown", "string", true),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WRITE_TEXT_TOOL.to_string(),
            name: WRITE_TEXT_TOOL.to_string(),
            description: "Create a new plain-text document artifact. Omit artifact_id for new documents — Conduit assigns IDs.".to_string(),
            input_schema: json_schema(&[
                ("title", "string", false),
                ("text", "string", true),
                ("mime_type", "string", false),
                ("artifact_id", "string", false),
                ("filename", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: EDIT_TEXT_TOOL.to_string(),
            name: EDIT_TEXT_TOOL.to_string(),
            description: "Replace the full contents of an existing plain-text document artifact."
                .to_string(),
            input_schema: json_schema(&[
                ("artifact_id", "string", true),
                ("updated_text", "string", true),
                ("mime_type", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: EXPORT_DOCUMENT_TOOL.to_string(),
            name: EXPORT_DOCUMENT_TOOL.to_string(),
            description: "Export an existing document artifact to disk.".to_string(),
            input_schema: json_schema(&[
                ("artifact_id", "string", true),
                ("include_metadata_sidecar", "boolean", false),
            ]),
            permission_level: Some(PermissionLevel::Sensitive),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
    ]
}

pub fn is_builtin_tool_name(name: &str) -> bool {
    matches!(
        name,
        WRITE_HTML_TOOL
            | EDIT_HTML_TOOL
            | WRITE_MARKDOWN_TOOL
            | EDIT_MARKDOWN_TOOL
            | WRITE_TEXT_TOOL
            | EDIT_TEXT_TOOL
            | EXPORT_DOCUMENT_TOOL
    )
}

pub async fn execute_builtin_tool(
    ctx: &AgentToolContext<'_>,
    tool_call_id: &str,
    request_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<AgentToolExecution, String> {
    let record = ToolCallRecord {
        id: tool_call_id.to_string(),
        tool_id: tool_name.to_string(),
        request_id: request_id.to_string(),
        status: ToolCallStatus::Running,
        arguments: Some(arguments.clone()),
        result: None,
        error: None,
        approved_at: None,
        completed_at: None,
    };
    tool_calls::insert_tool_call(ctx.db, &record)
        .await
        .map_err(|e| e.to_string())?;

    let result = match tool_name {
        WRITE_HTML_TOOL => {
            let input: WriteHtmlInput = parse_args(tool_name, arguments)?;
            let title = resolve_title(input.title, input.filename);
            write_document(
                ctx,
                &input.artifact_id,
                "html",
                "text/html",
                title.as_deref(),
                &input.html,
            )
            .await
        }
        EDIT_HTML_TOOL => {
            let input: EditHtmlInput = parse_args(tool_name, arguments)?;
            edit_document(
                ctx,
                &input.artifact_id,
                "html",
                "text/html",
                &input.updated_html,
            )
            .await
        }
        WRITE_MARKDOWN_TOOL => {
            let input: WriteMarkdownInput = parse_args(tool_name, arguments)?;
            let title = resolve_title(input.title, input.filename);
            write_document(
                ctx,
                &input.artifact_id,
                "markdown",
                "text/markdown",
                title.as_deref(),
                &input.markdown,
            )
            .await
        }
        EDIT_MARKDOWN_TOOL => {
            let input: EditMarkdownInput = parse_args(tool_name, arguments)?;
            edit_document(
                ctx,
                &input.artifact_id,
                "markdown",
                "text/markdown",
                &input.updated_markdown,
            )
            .await
        }
        WRITE_TEXT_TOOL => {
            let input: WriteTextInput = parse_args(tool_name, arguments)?;
            let title = resolve_title(input.title, input.filename);
            let mime_type = input.mime_type.unwrap_or_else(|| "text/plain".to_string());
            write_document(
                ctx,
                &input.artifact_id,
                "text",
                &mime_type,
                title.as_deref(),
                &input.text,
            )
            .await
        }
        EDIT_TEXT_TOOL => {
            let input: EditTextInput = parse_args(tool_name, arguments)?;
            let mime_type = input.mime_type.unwrap_or_else(|| "text/plain".to_string());
            edit_document(
                ctx,
                &input.artifact_id,
                "text",
                &mime_type,
                &input.updated_text,
            )
            .await
        }
        EXPORT_DOCUMENT_TOOL => {
            let input: ExportInput = parse_args(tool_name, arguments)?;
            export_document(ctx, &input.artifact_id, input.include_metadata_sidecar).await
        }
        _ => Err(format!("Unknown builtin tool: {tool_name}")),
    };

    match result {
        Ok(output) => {
            finalize_tool_call(
                ctx,
                tool_call_id,
                request_id,
                tool_name,
                arguments,
                output,
                false,
            )
            .await
        }
        Err(error) => {
            finalize_tool_call(
                ctx,
                tool_call_id,
                request_id,
                tool_name,
                arguments,
                serde_json::json!({ "ok": false, "error": error }),
                true,
            )
            .await
        }
    }
}

fn json_schema(fields: &[(&str, &str, bool)]) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for (name, kind, is_required) in fields {
        properties.insert((*name).to_string(), serde_json::json!({ "type": kind }));
        if *is_required {
            required.push((*name).to_string());
        }
    }
    let mut schema = serde_json::json!({
        "type": "object",
        "properties": properties,
    });
    if !required.is_empty() {
        schema["required"] = serde_json::json!(required);
    }
    schema
}

fn resolve_title(title: Option<String>, filename: Option<String>) -> Option<String> {
    let trimmed = title.and_then(|t| {
        let t = t.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if trimmed.is_some() {
        return trimmed;
    }
    filename.and_then(|f| {
        let path = PathBuf::from(f);
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

async fn write_document(
    ctx: &AgentToolContext<'_>,
    artifact_id: &Option<String>,
    kind: &str,
    mime_type: &str,
    title: Option<&str>,
    text: &str,
) -> Result<Value, String> {
    let (artifact, created) = match artifact_id {
        Some(id) => {
            if let Some(existing) = artifacts::get(ctx.db, ctx.encryption, id)
                .await
                .map_err(|e| e.to_string())?
            {
                ensure_kind(&existing, kind)?;
                if let Some(new_title) = title {
                    artifacts::set_title(ctx.db, id, new_title)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                (existing, false)
            } else {
                // Model-supplied ids are often slug-like labels, not Conduit UUIDs.
                let art = artifacts::create(
                    ctx.db,
                    ctx.conversation_id,
                    kind,
                    title,
                    ctx.source_message_id.as_deref(),
                )
                .await
                .map_err(|e| e.to_string())?;
                (art, true)
            }
        }
        None => {
            let art = artifacts::create(
                ctx.db,
                ctx.conversation_id,
                kind,
                title,
                ctx.source_message_id.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?;
            (art, true)
        }
    };

    let updated = artifacts::set_content(
        ctx.db,
        ctx.artifacts_dir,
        ctx.encryption,
        &artifact.id,
        Some(mime_type),
        &ArtifactContent::Text {
            text: text.to_string(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "artifact_id": updated.id,
        "created": created,
        "updated": !created,
        "kind": kind,
        "title": updated.title,
    }))
}

async fn edit_document(
    ctx: &AgentToolContext<'_>,
    artifact_id: &str,
    kind: &str,
    mime_type: &str,
    text: &str,
) -> Result<Value, String> {
    let existing = artifacts::get(ctx.db, ctx.encryption, artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("artifact '{artifact_id}' not found"))?;
    ensure_kind(&existing, kind)?;

    let updated = artifacts::set_content(
        ctx.db,
        ctx.artifacts_dir,
        ctx.encryption,
        artifact_id,
        Some(mime_type),
        &ArtifactContent::Text {
            text: text.to_string(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "artifact_id": updated.id,
        "updated": true,
        "kind": kind,
    }))
}

async fn export_document(
    ctx: &AgentToolContext<'_>,
    artifact_id: &str,
    include_metadata_sidecar: Option<bool>,
) -> Result<Value, String> {
    let result = artifacts::export(
        ctx.db,
        ctx.artifacts_dir,
        ctx.encryption,
        artifact_id,
        ctx.exports_dir,
        include_metadata_sidecar.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "artifact_id": artifact_id,
        "exported_path": result.exported_to,
        "bytes_written": result.bytes_written,
    }))
}

fn ensure_kind(artifact: &Artifact, expected: &str) -> Result<(), String> {
    if artifact.kind == expected {
        Ok(())
    } else {
        Err(format!(
            "artifact '{}' is '{}' not '{}'",
            artifact.id, artifact.kind, expected
        ))
    }
}

fn parse_args<T: for<'de> Deserialize<'de>>(tool_name: &str, args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone())
        .map_err(|e| format!("invalid arguments for {tool_name}: {e}"))
}

async fn finalize_tool_call(
    ctx: &AgentToolContext<'_>,
    tool_call_id: &str,
    request_id: &str,
    tool_name: &str,
    arguments: &Value,
    output: Value,
    is_error: bool,
) -> Result<AgentToolExecution, String> {
    let status = if is_error {
        ToolCallStatus::Failed
    } else {
        ToolCallStatus::Completed
    };
    let record = ToolCallRecord {
        id: tool_call_id.to_string(),
        tool_id: tool_name.to_string(),
        request_id: request_id.to_string(),
        status,
        arguments: Some(arguments.clone()),
        result: if is_error { None } else { Some(output.clone()) },
        error: if is_error {
            output
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            None
        },
        approved_at: None,
        completed_at: Some(now_iso8601()),
    };
    tool_calls::insert_tool_call(ctx.db, &record)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tool_calls::insert_tool_result(ctx.db, ctx.encryption, tool_call_id, &output, is_error)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AgentToolExecution {
        record,
        output,
        is_error,
    })
}

#[derive(Debug, Deserialize)]
struct WriteHtmlInput {
    title: Option<String>,
    html: String,
    artifact_id: Option<String>,
    filename: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditHtmlInput {
    artifact_id: String,
    updated_html: String,
}

#[derive(Debug, Deserialize)]
struct WriteMarkdownInput {
    title: Option<String>,
    markdown: String,
    artifact_id: Option<String>,
    filename: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditMarkdownInput {
    artifact_id: String,
    updated_markdown: String,
}

#[derive(Debug, Deserialize)]
struct WriteTextInput {
    title: Option<String>,
    text: String,
    mime_type: Option<String>,
    artifact_id: Option<String>,
    filename: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EditTextInput {
    artifact_id: String,
    updated_text: String,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportInput {
    artifact_id: String,
    include_metadata_sidecar: Option<bool>,
}
