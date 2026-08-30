use std::path::{Path, PathBuf};

use provider_core::{
    brand::{render_brand_md, validate as validate_brand, Severity as BrandSeverity},
    schema::{
        BrandConfig, BrandIdentity, BrandPalette, BrandThemes, PermissionLevel, ToolCallRecord,
        ToolCallStatus, ToolDefinition, BRAND_SCHEMA_VERSION,
    },
};
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

// Branding tools (SideEffectful — proposes a theme artifact, never writes
// brand.md directly; see `write_brand_theme`'s doc comment).
pub const WRITE_BRAND_THEME_TOOL: &str = "write_brand_theme";

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

// Workspace file tools (gated by settings.workspace_tools_*)
pub const WORKSPACE_READ_TOOL: &str = "workspace_read";
pub const WORKSPACE_WRITE_TOOL: &str = "workspace_write";
pub const WORKSPACE_EDIT_TOOL: &str = "workspace_edit";
pub const WORKSPACE_GLOB_TOOL: &str = "workspace_glob";
pub const WORKSPACE_GREP_TOOL: &str = "workspace_grep";

pub struct AgentToolContext<'a> {
    pub db: &'a sqlx::SqlitePool,
    pub artifacts_dir: &'a Path,
    pub exports_dir: &'a Path,
    pub encryption: &'a Encryption,
    pub conversation_id: &'a str,
    pub source_message_id: Option<String>,
    /// Present when workspace tools are enabled with a valid root.
    pub workspace: Option<&'a crate::workspace_tools::WorkspaceToolConfig>,
}

#[derive(Debug, Clone)]
pub struct AgentToolExecution {
    pub record: ToolCallRecord,
    pub output: Value,
    pub is_error: bool,
}

pub fn builtin_tool_definitions() -> Vec<ToolDefinition> {
    let app_name = crate::brand::app_name();
    vec![
        ToolDefinition {
            tool_id: WRITE_HTML_TOOL.to_string(),
            name: WRITE_HTML_TOOL.to_string(),
            description: format!(
                "Create a new HTML document artifact. Omit artifact_id for new documents — {app_name} assigns IDs."
            ),
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
            description: format!(
                "Create a new Markdown document artifact. Omit artifact_id for new documents — {app_name} assigns IDs."
            ),
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
            description: format!(
                "Create a new plain-text document artifact. Omit artifact_id for new documents — {app_name} assigns IDs."
            ),
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
        // Branding tools
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: WRITE_BRAND_THEME_TOOL.to_string(),
            name: WRITE_BRAND_THEME_TOOL.to_string(),
            description: format!(
                "Propose a brand theme for {app_name} -- product naming plus a complete \
                 dark-mode and light-mode colour palette -- and save it as a Markdown artifact \
                 the user can preview and apply from Settings. This tool never changes the \
                 app's active appearance by itself: it only writes a proposal document, exactly \
                 like write_markdown_document. Use it when the user asks for a theme, rebrand, \
                 or colour scheme in chat (e.g. \"give this a warm editorial look with a \
                 burnt-orange accent\").\n\n\
                 Every colour value must be a hex string in #rrggbb form (#rgb and #rrggbbaa \
                 are also accepted, but prefer #rrggbb). No url(...), var(...), rgb(...), or \
                 named CSS colours -- the validator rejects anything that is not literal hex.\n\n\
                 Both `dark` and `light` are required, and each needs all 18 keys filled in. A \
                 theme that only specifies one mode, or leaves some keys out, is not a smaller \
                 version of a valid theme -- it is invalid, because whichever surfaces are left \
                 unset keep the previous theme's colours while everything else changes, which \
                 produces unreadable text rather than an obvious failure. Fill in every key for \
                 both modes even if a theme is conceptually \"mostly dark\": light must still be \
                 a complete, readable palette.\n\n\
                 `hue` is the one accent colour for the whole theme. The app derives several \
                 translucent tints from it automatically in CSS -- do not try to specify tints, \
                 shades, or variants of the accent yourselves beyond the hueText/hueSolid/onHue \
                 fields already in the schema, which serve distinct, specific roles (see their \
                 individual descriptions).\n\n\
                 `notes` should be a few sentences of prose explaining the design intent: the \
                 mood you were going for, why this accent, what to preserve if the theme is \
                 revised later. This is not cosmetic -- it is saved into the artifact and handed \
                 back to you verbatim if the user asks you to revise this theme, so a vague or \
                 missing `notes` makes a later revision request a guessing game instead of an \
                 edit.\n\n\
                 If the result names invalid fields, fix exactly those fields and call this tool \
                 again -- do not guess at a full rewrite."
            ),
            input_schema: write_brand_theme_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Branding".to_string()),
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
        // ---------------------------------------------------------------------
        // Workspace file tools (settings-gated; paths relative to workspace root)
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: WORKSPACE_READ_TOOL.to_string(),
            name: WORKSPACE_READ_TOOL.to_string(),
            description: "Read a text file under the workspace folder. Path must be relative to the workspace root. Optional offset/limit in bytes.".to_string(),
            input_schema: json_schema(&[
                ("path", "string", true),
                ("offset", "integer", false),
                ("limit", "integer", false),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Workspace".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WORKSPACE_WRITE_TOOL.to_string(),
            name: WORKSPACE_WRITE_TOOL.to_string(),
            description: "Create or overwrite a text file under the workspace folder. Path is relative to the workspace root. Set create_dirs=true to create parent directories.".to_string(),
            input_schema: json_schema(&[
                ("path", "string", true),
                ("content", "string", true),
                ("create_dirs", "boolean", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Workspace".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WORKSPACE_EDIT_TOOL.to_string(),
            name: WORKSPACE_EDIT_TOOL.to_string(),
            description: "Replace the full contents of an existing text file under the workspace folder. Path is relative to the workspace root.".to_string(),
            input_schema: json_schema(&[
                ("path", "string", true),
                ("content", "string", true),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Workspace".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WORKSPACE_GLOB_TOOL.to_string(),
            name: WORKSPACE_GLOB_TOOL.to_string(),
            description: "List files under the workspace folder matching a glob pattern (relative to the workspace root), e.g. \"**/*.rs\".".to_string(),
            input_schema: json_schema(&[
                ("pattern", "string", true),
                ("max_results", "integer", false),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Workspace".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WORKSPACE_GREP_TOOL.to_string(),
            name: WORKSPACE_GREP_TOOL.to_string(),
            description: "Search file contents under the workspace folder with a regex. Optional path (subdirectory) and glob filter (e.g. \"*.ts\").".to_string(),
            input_schema: json_schema(&[
                ("pattern", "string", true),
                ("path", "string", false),
                ("glob", "string", false),
                ("max_matches", "integer", false),
                ("case_insensitive", "boolean", false),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Workspace".to_string()),
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
            | WRITE_BRAND_THEME_TOOL
            | CURRENT_TIME_TOOL
            | UUID_TOOL
            | RANDOM_TOOL
            | CALCULATOR_TOOL
            | WEB_SEARCH_TOOL
            | WEB_FETCH_TOOL
            | CLIPBOARD_READ_TOOL
            | CLIPBOARD_WRITE_TOOL
            | WORKSPACE_READ_TOOL
            | WORKSPACE_WRITE_TOOL
            | WORKSPACE_EDIT_TOOL
            | WORKSPACE_GLOB_TOOL
            | WORKSPACE_GREP_TOOL
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
        // Branding tools
        // ---------------------------------------------------------------------
        WRITE_BRAND_THEME_TOOL => {
            let input: WriteBrandThemeInput = parse_args(tool_name, arguments)?;
            write_brand_theme(ctx, input).await
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
        // ---------------------------------------------------------------------
        // Workspace file tools
        // ---------------------------------------------------------------------
        WORKSPACE_READ_TOOL => {
            let input: crate::workspace_tools::tools::ReadInput = parse_args(tool_name, arguments)?;
            let ws = ctx
                .workspace
                .ok_or_else(|| "Workspace tools are disabled or no folder is set".to_string())?;
            Ok(crate::workspace_tools::execute_workspace_read(ws, input).unwrap_or_else(|e| e))
        }
        WORKSPACE_WRITE_TOOL => {
            let input: crate::workspace_tools::tools::WriteInput =
                parse_args(tool_name, arguments)?;
            let ws = ctx
                .workspace
                .ok_or_else(|| "Workspace tools are disabled or no folder is set".to_string())?;
            Ok(crate::workspace_tools::execute_workspace_write(ws, input).unwrap_or_else(|e| e))
        }
        WORKSPACE_EDIT_TOOL => {
            let input: crate::workspace_tools::tools::EditInput = parse_args(tool_name, arguments)?;
            let ws = ctx
                .workspace
                .ok_or_else(|| "Workspace tools are disabled or no folder is set".to_string())?;
            Ok(crate::workspace_tools::execute_workspace_edit(ws, input).unwrap_or_else(|e| e))
        }
        WORKSPACE_GLOB_TOOL => {
            let input: crate::workspace_tools::tools::GlobInput = parse_args(tool_name, arguments)?;
            let ws = ctx
                .workspace
                .ok_or_else(|| "Workspace tools are disabled or no folder is set".to_string())?;
            Ok(crate::workspace_tools::execute_workspace_glob(ws, input).unwrap_or_else(|e| e))
        }
        WORKSPACE_GREP_TOOL => {
            let input: crate::workspace_tools::tools::GrepInput = parse_args(tool_name, arguments)?;
            let ws = ctx
                .workspace
                .ok_or_else(|| "Workspace tools are disabled or no folder is set".to_string())?;
            Ok(crate::workspace_tools::execute_workspace_grep(ws, input).unwrap_or_else(|e| e))
        }
        _ => Err(format!("Unknown builtin tool: {tool_name}")),
    };

    match result {
        Ok(output) => {
            let is_error = output.get("ok") == Some(&Value::Bool(false));
            finalize_tool_call(
                ctx,
                tool_call_id,
                request_id,
                tool_name,
                arguments,
                output,
                is_error,
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

/// Persist a builtin tool call as failed without running it — used when the
/// agent loop clamps parallel / over-budget document creates so the model still
/// sees a tool result on the continuation.
pub async fn record_clamped_builtin_tool(
    ctx: &AgentToolContext<'_>,
    tool_call_id: &str,
    request_id: &str,
    tool_name: &str,
    arguments: &Value,
    error: &str,
) -> Result<AgentToolExecution, String> {
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

/// The `write_brand_theme` input schema. Built with `serde_json::json!`
/// directly rather than the flat [`json_schema`] helper above: `json_schema`
/// can only express a single level of `{name: type}` properties, and this
/// tool's `dark`/`light` fields are themselves nested 18-key objects — there
/// is no way to express that nesting through a `&[(&str, &str, bool)]` list
/// without either flattening the palette into 36 top-level keys (losing the
/// dark/light grouping a model needs to keep straight) or growing
/// `json_schema` into something that can express arbitrary nesting, which
/// none of the other builtin tools need.
fn write_brand_theme_schema() -> Value {
    let palette = brand_palette_schema();
    serde_json::json!({
        "type": "object",
        "properties": {
            "appName": {
                "type": "string",
                "description": "Short product name used inline in prose, e.g. \"Message \
                    Northwind\". Keep it brief — this is not a heading."
            },
            "displayName": {
                "type": "string",
                "description": "Full product name used in headings and the sidebar wordmark, \
                    e.g. \"Northwind AI\". Often identical to appName."
            },
            "tagline": {
                "type": "string",
                "description": "Optional composer placeholder text, e.g. \"Message \
                    Northwind...\". Omit to keep the app's default placeholder."
            },
            "notes": {
                "type": "string",
                "description": "A few sentences of prose explaining the design intent: the \
                    mood you were going for, why this accent colour, what matters if the theme \
                    is revised later. Saved verbatim into the artifact and handed back to you \
                    if the user asks for a revision, so write it as a briefing for your future \
                    self, not a caption."
            },
            "dark": palette.clone(),
            "light": palette,
        },
        "required": ["appName", "displayName", "dark", "light"],
    })
}

/// One theme's worth of the 18-key palette schema (shared by `dark` and
/// `light` in [`write_brand_theme_schema`]) so every field's description is
/// written once instead of twice, with no risk of the two copies drifting
/// apart. Key names and roles mirror [`provider_core::schema::BrandPalette`]
/// exactly, in the same camelCase spelling — see [`WriteBrandThemeInput`]'s
/// doc comment for why that spelling was chosen for this tool specifically.
fn brand_palette_schema() -> Value {
    let hex_hint = "Hex color only (#rrggbb preferred; #rgb and #rrggbbaa also accepted). No \
        url(...), var(...), rgb(...), or named CSS colours.";
    serde_json::json!({
        "type": "object",
        "description": "A complete 18-key colour palette for one theme (dark or light). All \
            18 keys are required — see the tool description for why a partial palette is \
            rejected rather than partially applied.",
        "properties": {
            "bg": { "type": "string", "description": format!("{hex_hint} The app's base background — the ground every other surface sits on.") },
            "bgSide": { "type": "string", "description": format!("{hex_hint} Sidebar/rail background.") },
            "card": { "type": "string", "description": format!("{hex_hint} Raised surface background — message bubbles, panels.") },
            "cardHi": { "type": "string", "description": format!("{hex_hint} Hovered/active state of card.") },
            "line": { "type": "string", "description": format!("{hex_hint} Default border/divider colour.") },
            "lineSoft": { "type": "string", "description": format!("{hex_hint} A subdued divider, lower contrast than line.") },
            "lineHi": { "type": "string", "description": format!("{hex_hint} An emphasised border, higher contrast than line.") },
            "ink": { "type": "string", "description": format!("{hex_hint} Primary text colour. Should read at WCAG AA (4.5:1) against bg, bgSide, card, and cardHi.") },
            "ink2": { "type": "string", "description": format!("{hex_hint} Secondary text colour, also checked against every surface.") },
            "ink3": { "type": "string", "description": format!("{hex_hint} Tertiary text colour (captions, hints), also checked against every surface.") },
            "hue": { "type": "string", "description": format!("{hex_hint} The single accent colour for this theme. The app derives translucent tints from it automatically in CSS — do not specify tints or variants of it yourself.") },
            "hueText": { "type": "string", "description": format!("{hex_hint} The accent tuned for use as text on the background — usually adjusted from hue for readability, not identical to it.") },
            "hueSolid": { "type": "string", "description": format!("{hex_hint} The accent as a solid fill, e.g. a primary button's background.") },
            "onHue": { "type": "string", "description": format!("{hex_hint} Text/icon colour drawn on top of hueSolid. Should read at WCAG AA (4.5:1) against hueSolid.") },
            "ok": { "type": "string", "description": format!("{hex_hint} Success state colour.") },
            "warn": { "type": "string", "description": format!("{hex_hint} Warning state colour.") },
            "err": { "type": "string", "description": format!("{hex_hint} Error state colour.") },
            "link": { "type": "string", "description": format!("{hex_hint} Hyperlink colour.") },
        },
        "required": [
            "bg", "bgSide", "card", "cardHi", "line", "lineSoft", "lineHi", "ink", "ink2",
            "ink3", "hue", "hueText", "hueSolid", "onHue", "ok", "warn", "err", "link"
        ],
    })
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

/// Turn a validated [`WriteBrandThemeInput`] into a `brand.md`-shaped
/// [`BrandConfig`], validate it, and — only on success — render it and save
/// it as a Markdown artifact via the exact same [`write_document`] path
/// [`WRITE_MARKDOWN_TOOL`] uses.
///
/// ## Why this never touches `<branding>/brand.md`
///
/// This tool is [`PermissionLevel::SideEffectful`] and is invoked by the
/// model, not the user. Silently rewriting the file that controls the whole
/// app's appearance with no confirmation step is the wrong default for that
/// combination — and it would make the Settings "Preview / Apply" step
/// pointless, since there would be nothing left to preview. Routing through
/// an artifact instead means the model *proposes* a theme and the user
/// *applies* it, which is exactly the Mode A boundary the rest of white-label
/// branding is built around (see `docs/private/white-label-plan.md` §4). The
/// artifact path also gets safe rendering and persistence for free — no new
/// storage code needed here.
///
/// ## Why validation errors come back as a tool error, not a partial artifact
///
/// A forced-tool-call model has no other structured feedback channel: if an
/// invalid theme were saved anyway, the model would have no way to know
/// which fields were wrong short of the user reporting a broken UI later.
/// Returning `Err` here — with every offending field named — is what lets
/// the model correct itself and call this tool again, which is the entire
/// reason this is a dedicated tool instead of asking the model to
/// free-form-generate a `brand.md` as prose.
async fn write_brand_theme(
    ctx: &AgentToolContext<'_>,
    input: WriteBrandThemeInput,
) -> Result<Value, String> {
    let display_name = input.display_name.clone();
    let config = BrandConfig {
        schema_version: BRAND_SCHEMA_VERSION,
        identity: BrandIdentity {
            app_name: input.app_name,
            display_name: input.display_name,
            tagline: input.tagline,
        },
        // A theme proposal never carries a logo — brand_theme is a colour
        // + naming tool only; the logo path (Phase 2) is a separate,
        // file-upload-shaped flow this tool has no bytes to feed anyway.
        logo: None,
        palette: Some(BrandThemes {
            dark: input.dark,
            light: input.light,
        }),
        notes: input.notes,
        // Build profile (Mode B): deliberately never model-authored. A packaged
        // rebrand changes the installer name, the bundle identifier and the
        // update endpoint its releases are verified against — decisions a
        // reseller makes once, in a file they own, not ones an LLM proposes
        // inside a chat turn.
        fonts: None,
        bundle: None,
        updater: None,
        runtime: None,
    };

    let (errors, warnings): (Vec<_>, Vec<_>) = validate_brand(&config)
        .into_iter()
        .partition(|issue| issue.severity == BrandSeverity::Error);

    if !errors.is_empty() {
        let detail = errors
            .iter()
            .map(|issue| format!("{} ({})", issue.field, issue.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!(
            "brand theme failed validation on {} field(s) — fix these and call \
             write_brand_theme again: {detail}",
            errors.len()
        ));
    }

    let markdown = render_brand_md(&config);
    let title = resolve_title(
        Some(format!("{display_name} — Brand Theme")),
        Some("brand.md".to_string()),
    );

    let mut output = write_document(
        ctx,
        &None,
        "markdown",
        "text/markdown",
        title.as_deref(),
        &markdown,
    )
    .await?;

    if let Some(obj) = output.as_object_mut() {
        obj.insert(
            "warnings".to_string(),
            serde_json::json!(warnings
                .into_iter()
                .map(|issue| serde_json::json!({
                    "field": issue.field,
                    "message": issue.message,
                }))
                .collect::<Vec<_>>()),
        );
    }

    Ok(output)
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

/// `write_brand_theme`'s input. Deliberately camelCase-keyed
/// (`#[serde(rename_all = "camelCase")]`) rather than the snake_case
/// `artifact_id`-style convention every other input struct in this file
/// uses, because this one has to match the wire shape
/// [`BrandConfig`]/[`BrandPalette`] already use in `schema.rs`
/// (`#[serde(rename_all = "camelCase")]` there too, since those types are
/// also ts-rs-exported to the renderer). Matching it means `dark`/`light`
/// deserialize straight into [`BrandPalette`] with no hand-written
/// field-by-field mapping layer between this struct and the type the model's
/// arguments actually populate — one less place for the two to drift apart
/// as palette keys are added or renamed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBrandThemeInput {
    app_name: String,
    display_name: String,
    tagline: Option<String>,
    notes: Option<String>,
    dark: BrandPalette,
    light: BrandPalette,
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
    // Same 15s bound `web_fetch` uses below. A bare `Client::new()` has no
    // timeout at all, so an endpoint that accepts the connection and then goes
    // quiet parks the agent turn on "Running 1 tool" indefinitely.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client error: {e}"))?;
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
        assert!(is_builtin_tool_name(WRITE_BRAND_THEME_TOOL));
        assert!(!is_builtin_tool_name("nonexistent_tool"));
    }

    #[test]
    fn test_write_brand_theme_definition_shape() {
        let defs = builtin_tool_definitions();
        let def = defs
            .iter()
            .find(|t| t.name == WRITE_BRAND_THEME_TOOL)
            .expect("write_brand_theme is registered");

        assert_eq!(
            def.permission_level,
            Some(PermissionLevel::SideEffectful),
            "a model-invoked tool that writes an artifact needs confirmation, not ReadOnly"
        );
        assert_eq!(def.display_group.as_deref(), Some("Branding"));

        // The schema must require appName/displayName/dark/light at the top
        // level, and each of dark/light must require all 18 palette keys —
        // this is the model's only spec for the format, so a slipped
        // required-key list here is a silent contract break.
        let schema = &def.input_schema;
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required, vec!["appName", "displayName", "dark", "light"]);

        for theme in ["dark", "light"] {
            let palette_required: Vec<&str> = schema["properties"][theme]["required"]
                .as_array()
                .unwrap_or_else(|| panic!("{theme} palette schema must declare `required`"))
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert_eq!(
                palette_required,
                vec![
                    "bg", "bgSide", "card", "cardHi", "line", "lineSoft", "lineHi", "ink", "ink2",
                    "ink3", "hue", "hueText", "hueSolid", "onHue", "ok", "warn", "err", "link"
                ],
                "{theme} palette must require exactly the 18 curated keys"
            );
        }
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
        // 7 original document tools + 8 utility/web/clipboard tools
        // + 1 write_brand_theme (Phase 4) = 16
        assert_eq!(defs.len(), 16);
    }
}
