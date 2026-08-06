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

// Utility tools (ReadOnly, always available)
pub const CURRENT_TIME_TOOL: &str = "current_time";
pub const UUID_TOOL: &str = "uuid";
pub const RANDOM_TOOL: &str = "random";
pub const CALCULATOR_TOOL: &str = "calculator";

// Web tools (ReadOnly/SideEffectful, search-gated)
pub const WEB_SEARCH_TOOL: &str = "web_search";
pub const WEB_FETCH_TOOL: &str = "web_fetch";

// Clipboard tools (SideEffectful, read requires consent)
pub const CLIPBOARD_READ_TOOL: &str = "clipboard_read";
pub const CLIPBOARD_WRITE_TOOL: &str = "clipboard_write";

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
        // ---------------------------------------------------------------------
        // Utility tools (ReadOnly — always available, no MCP needed)
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: CURRENT_TIME_TOOL.to_string(),
            name: CURRENT_TIME_TOOL.to_string(),
            description: "Get the current date and time in ISO-8601 format. No arguments needed."
                .to_string(),
            input_schema: json_schema(&[]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Utilities".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: UUID_TOOL.to_string(),
            name: UUID_TOOL.to_string(),
            description: "Generate a new UUID v4. No arguments needed.".to_string(),
            input_schema: json_schema(&[]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Utilities".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: RANDOM_TOOL.to_string(),
            name: RANDOM_TOOL.to_string(),
            description: "Generate a random integer in a range. Provide `min` (default 0) and `max` (default 100).".to_string(),
            input_schema: json_schema(&[
                ("min", "integer", false),
                ("max", "integer", false),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Utilities".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: CALCULATOR_TOOL.to_string(),
            name: CALCULATOR_TOOL.to_string(),
            description: "Evaluate a simple arithmetic expression. Accepts `expression` (e.g. \"(5 + 3) * 2\"). Uses safe evaluation — no code execution.".to_string(),
            input_schema: json_schema(&[
                ("expression", "string", true),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Utilities".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        // ---------------------------------------------------------------------
        // Web tools (search-gated)
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: WEB_SEARCH_TOOL.to_string(),
            name: WEB_SEARCH_TOOL.to_string(),
            description: "Search the web for information. Provide a `query` string. Returns up to 10 results with titles, snippets, and URLs.".to_string(),
            input_schema: json_schema(&[
                ("query", "string", true),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Web".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WEB_FETCH_TOOL.to_string(),
            name: WEB_FETCH_TOOL.to_string(),
            description: "Fetch the contents of a web page. Provide a `url` string. Returns the page content as text (may be truncated at 50KB).".to_string(),
            input_schema: json_schema(&[
                ("url", "string", true),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Web".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        // ---------------------------------------------------------------------
        // Clipboard tools
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: CLIPBOARD_READ_TOOL.to_string(),
            name: CLIPBOARD_READ_TOOL.to_string(),
            description: "Read the current contents of the system clipboard. Returns text content if available."
                .to_string(),
            input_schema: json_schema(&[]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Clipboard".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: CLIPBOARD_WRITE_TOOL.to_string(),
            name: CLIPBOARD_WRITE_TOOL.to_string(),
            description: "Write text to the system clipboard. Provide `text` to copy.".to_string(),
            input_schema: json_schema(&[
                ("text", "string", true),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Clipboard".to_string()),
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
            | CURRENT_TIME_TOOL
            | UUID_TOOL
            | RANDOM_TOOL
            | CALCULATOR_TOOL
            | WEB_SEARCH_TOOL
            | WEB_FETCH_TOOL
            | CLIPBOARD_READ_TOOL
            | CLIPBOARD_WRITE_TOOL
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
        // ---------------------------------------------------------------------
        // Utility tools
        // ---------------------------------------------------------------------
        CURRENT_TIME_TOOL => {
            let now = crate::time::now_iso8601();
            Ok(serde_json::json!({
                "ok": true,
                "iso8601": now,
                "unix_seconds": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            }))
        }
        UUID_TOOL => {
            let id = uuid::Uuid::new_v4().to_string();
            Ok(serde_json::json!({
                "ok": true,
                "uuid": id,
            }))
        }
        RANDOM_TOOL => {
            let input: RandomInput = parse_args(tool_name, arguments)?;
            let min = input.min.unwrap_or(0);
            let max = input.max.unwrap_or(100);
            if min >= max {
                return Err("min must be less than max".to_string());
            }
            use rand::Rng;
            let mut rng = rand::thread_rng();
            let value = rng.gen_range(min..=max);
            Ok(serde_json::json!({
                "ok": true,
                "value": value,
                "min": min,
                "max": max,
            }))
        }
        CALCULATOR_TOOL => {
            let input: CalculatorInput = parse_args(tool_name, arguments)?;
            match eval_expression(&input.expression) {
                Ok(result) => Ok(serde_json::json!({
                    "ok": true,
                    "expression": input.expression,
                    "result": result,
                })),
                Err(e) => Err(format!("calculator error: {e}")),
            }
        }
        // ---------------------------------------------------------------------
        // Web tools
        // ---------------------------------------------------------------------
        WEB_SEARCH_TOOL => {
            let input: WebSearchInput = parse_args(tool_name, arguments)?;
            match web_search(&input.query).await {
                Ok(results) => Ok(serde_json::json!({
                    "ok": true,
                    "query": input.query,
                    "results": results,
                })),
                Err(e) => Err(format!("web search error: {e}")),
            }
        }
        WEB_FETCH_TOOL => {
            let input: WebFetchInput = parse_args(tool_name, arguments)?;
            match web_fetch(&input.url).await {
                Ok(content) => Ok(serde_json::json!({
                    "ok": true,
                    "url": input.url,
                    "content": content,
                })),
                Err(e) => Err(format!("web fetch error: {e}")),
            }
        }
        // ---------------------------------------------------------------------
        // Clipboard tools
        // ---------------------------------------------------------------------
        CLIPBOARD_READ_TOOL => match clipboard_read().await {
            Ok(text) => Ok(serde_json::json!({
                "ok": true,
                "text": text,
            })),
            Err(e) => Err(format!("clipboard read error: {e}")),
        },
        CLIPBOARD_WRITE_TOOL => {
            let input: ClipboardWriteInput = parse_args(tool_name, arguments)?;
            match clipboard_write(&input.text).await {
                Ok(()) => Ok(serde_json::json!({
                    "ok": true,
                    "written": true,
                })),
                Err(e) => Err(format!("clipboard write error: {e}")),
            }
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

// -------------------------------------------------------------------------
// Utility tool input structs
// -------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RandomInput {
    min: Option<i64>,
    max: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CalculatorInput {
    expression: String,
}

#[derive(Debug, Deserialize)]
struct WebSearchInput {
    query: String,
}

#[derive(Debug, Deserialize)]
struct WebFetchInput {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ClipboardWriteInput {
    text: String,
}

// -------------------------------------------------------------------------
// Helper: safe arithmetic expression evaluator
// Supports +, -, *, /, parentheses, and integer/float numbers.
// -------------------------------------------------------------------------

fn eval_expression(expr: &str) -> Result<f64, String> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err("empty expression".to_string());
    }
    // Tokenize and parse via recursive descent.
    let tokens = tokenize(trimmed)?;
    let mut pos = 0;
    let result = parse_expr(&tokens, &mut pos)?;
    if pos < tokens.len() {
        return Err(format!("unexpected token at position {pos}"));
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
}

fn tokenize(s: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }
        match ch {
            '+' => {
                tokens.push(Token::Plus);
                chars.next();
            }
            '-' => {
                tokens.push(Token::Minus);
                chars.next();
            }
            '*' => {
                tokens.push(Token::Star);
                chars.next();
            }
            '/' => {
                tokens.push(Token::Slash);
                chars.next();
            }
            '(' => {
                tokens.push(Token::LParen);
                chars.next();
            }
            ')' => {
                tokens.push(Token::RParen);
                chars.next();
            }
            '0'..='9' | '.' => {
                let mut num = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_ascii_digit() || c == '.' {
                        num.push(c);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let n: f64 = num.parse().map_err(|_| format!("invalid number: {num}"))?;
                tokens.push(Token::Number(n));
            }
            _ => return Err(format!("unexpected character: '{ch}'")),
        }
    }
    Ok(tokens)
}

fn parse_expr(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_term(tokens, pos)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            Token::Plus => {
                *pos += 1;
                left += parse_term(tokens, pos)?;
            }
            Token::Minus => {
                *pos += 1;
                left -= parse_term(tokens, pos)?;
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_term(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_factor(tokens, pos)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            Token::Star => {
                *pos += 1;
                left *= parse_factor(tokens, pos)?;
            }
            Token::Slash => {
                *pos += 1;
                let right = parse_factor(tokens, pos)?;
                if right == 0.0 {
                    return Err("division by zero".to_string());
                }
                left /= right;
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_factor(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    if *pos >= tokens.len() {
        return Err("unexpected end of expression".to_string());
    }
    match tokens[*pos] {
        Token::Number(n) => {
            *pos += 1;
            Ok(n)
        }
        Token::LParen => {
            *pos += 1;
            let result = parse_expr(tokens, pos)?;
            if *pos >= tokens.len() || tokens[*pos] != Token::RParen {
                return Err("missing closing parenthesis".to_string());
            }
            *pos += 1;
            Ok(result)
        }
        Token::Minus => {
            *pos += 1;
            Ok(-parse_factor(tokens, pos)?)
        }
        _ => Err(format!("unexpected token at position {pos}")),
    }
}

// -------------------------------------------------------------------------
// Helper: web search via DuckDuckGo Instant Answer API
// -------------------------------------------------------------------------

async fn web_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding(query)
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "Conduit/1.0")
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("search response parse failed: {e}"))?;

    let mut results = Vec::new();

    // Abstract / answer
    if let Some(answer) = body.get("AbstractText").and_then(|v| v.as_str()) {
        if !answer.is_empty() {
            let source = body
                .get("AbstractSource")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let url = body
                .get("AbstractURL")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            results.push(serde_json::json!({
                "title": source,
                "snippet": answer,
                "url": url,
            }));
        }
    }

    // Related topics
    if let Some(topics) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
        for topic in topics {
            if let Some(text) = topic.get("Text").and_then(|v| v.as_str()) {
                let title = topic.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                let url = topic.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                results.push(serde_json::json!({
                    "title": title,
                    "snippet": text,
                    "url": url,
                }));
            }
            // Check for sub-topics
            if let Some(topics) = topic.get("Topics").and_then(|v| v.as_array()) {
                for sub in topics {
                    if let Some(text) = sub.get("Text").and_then(|v| v.as_str()) {
                        let url = sub.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
                        results.push(serde_json::json!({
                            "title": url,
                            "snippet": text,
                            "url": url,
                        }));
                    }
                }
            }
        }
    }

    if results.is_empty() {
        // Fallback: use the abstract text
        if let Some(abstract_text) = body.get("Abstract").and_then(|v| v.as_str()) {
            if !abstract_text.is_empty() {
                results.push(serde_json::json!({
                    "title": "Result",
                    "snippet": abstract_text,
                    "url": "",
                }));
            }
        }
    }

    Ok(results)
}

fn urlencoding(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push_str("%20"),
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

// -------------------------------------------------------------------------
// Helper: web fetch (HTTP GET)
// -------------------------------------------------------------------------

async fn web_fetch(url: &str) -> Result<String, String> {
    // Validate URL scheme
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported URL scheme: {scheme}")),
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client error: {e}"))?;

    let resp = client
        .get(url)
        .header("User-Agent", "Conduit/1.0")
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    // Read up to 50KB
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    let max_bytes = 50 * 1024;
    let truncated = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes
    };

    let text = String::from_utf8_lossy(truncated).to_string();
    Ok(text)
}

// -------------------------------------------------------------------------
// Helper: clipboard (via arboard, or fallback to no-op)
// -------------------------------------------------------------------------

async fn clipboard_read() -> Result<String, String> {
    // Use arboard for cross-platform clipboard access
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard init failed: {e}"))?;
    clipboard
        .get_text()
        .map_err(|e| format!("clipboard read failed: {e}"))
        .map(|t| t.to_string())
}

async fn clipboard_write(text: &str) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard init failed: {e}"))?;
    clipboard
        .set_text(text.to_owned())
        .map_err(|e| format!("clipboard write failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculator_basic() {
        assert_eq!(eval_expression("2 + 3").unwrap(), 5.0);
        assert_eq!(eval_expression("10 - 4").unwrap(), 6.0);
        assert_eq!(eval_expression("3 * 4").unwrap(), 12.0);
        assert_eq!(eval_expression("15 / 3").unwrap(), 5.0);
    }

    #[test]
    fn test_calculator_precedence() {
        assert_eq!(eval_expression("2 + 3 * 4").unwrap(), 14.0);
        assert_eq!(eval_expression("10 - 2 * 3").unwrap(), 4.0);
        assert_eq!(eval_expression("20 / 4 + 1").unwrap(), 6.0);
    }

    #[test]
    fn test_calculator_parentheses() {
        assert_eq!(eval_expression("(2 + 3) * 4").unwrap(), 20.0);
        assert_eq!(eval_expression("((2 + 3) * 2) - 1").unwrap(), 9.0);
    }

    #[test]
    fn test_calculator_negative() {
        assert_eq!(eval_expression("-5 + 3").unwrap(), -2.0);
    }

    #[test]
    fn test_calculator_float() {
        let result = eval_expression("3.5 + 2.5").unwrap();
        assert!((result - 6.0).abs() < 0.0001);
    }

    #[test]
    fn test_calculator_errors() {
        assert!(eval_expression("").is_err());
        assert!(eval_expression("1/0").is_err());
        assert!(eval_expression("2 + ").is_err());
    }

    #[test]
    fn test_tool_definitions_include_utility_tools() {
        let defs = builtin_tool_definitions();
        let names: Vec<&str> = defs.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&CURRENT_TIME_TOOL));
        assert!(names.contains(&UUID_TOOL));
        assert!(names.contains(&RANDOM_TOOL));
        assert!(names.contains(&CALCULATOR_TOOL));
        assert!(names.contains(&WEB_SEARCH_TOOL));
        assert!(names.contains(&WEB_FETCH_TOOL));
        assert!(names.contains(&CLIPBOARD_READ_TOOL));
        assert!(names.contains(&CLIPBOARD_WRITE_TOOL));
    }

    #[test]
    fn test_is_builtin_tool_name_includes_new_tools() {
        assert!(is_builtin_tool_name(CURRENT_TIME_TOOL));
        assert!(is_builtin_tool_name(CALCULATOR_TOOL));
        assert!(is_builtin_tool_name(WEB_SEARCH_TOOL));
        assert!(is_builtin_tool_name(CLIPBOARD_READ_TOOL));
        assert!(is_builtin_tool_name(WRITE_HTML_TOOL)); // existing still works
        assert!(!is_builtin_tool_name("nonexistent_tool"));
    }

    #[test]
    fn test_random_input_validation() {
        // min < max is required
        let args = serde_json::json!({ "min": 10, "max": 5 });
        let input: Result<RandomInput, _> = serde_json::from_value(args);
        assert!(input.is_ok()); // deserialization is fine, but execution would fail
    }

    #[test]
    fn test_calculator_input_deserialization() {
        let args = serde_json::json!({ "expression": "2 + 2" });
        let input: CalculatorInput = serde_json::from_value(args).unwrap();
        assert_eq!(input.expression, "2 + 2");
    }

    #[test]
    fn test_web_search_input_deserialization() {
        let args = serde_json::json!({ "query": "test query" });
        let input: WebSearchInput = serde_json::from_value(args).unwrap();
        assert_eq!(input.query, "test query");
    }

    #[test]
    fn test_web_fetch_url_validation() {
        // Invalid URL should fail
        let args = serde_json::json!({ "url": "not-a-url" });
        let input: WebFetchInput = serde_json::from_value(args).unwrap();
        assert_eq!(input.url, "not-a-url");
        // url::Url::parse would fail on this
        assert!(url::Url::parse(&input.url).is_err());
    }

    #[test]
    fn test_tool_count() {
        let defs = builtin_tool_definitions();
        // 7 original document tools + 8 new tools = 15
        assert_eq!(defs.len(), 15);
    }
}
