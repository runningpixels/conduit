use std::path::{Path, PathBuf};

use provider_core::{
    brand::{render_brand_md, validate as validate_brand, Severity as BrandSeverity},
    schema::{
        BlockOwner, BrandConfig, BrandIdentity, BrandPalette, BrandThemes, DeckDetail, DeckSlide,
        DeckSnapshotCause, DeckStage, OutlineSection, PermissionLevel, StorylineItem,
        ToolCallRecord, ToolCallStatus, ToolDefinition, BRAND_SCHEMA_VERSION,
    },
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    db::repository::{
        artifacts::{self, Artifact, ArtifactContent},
        conversations, drafts, slides, tool_calls,
    },
    encryption::Encryption,
    slide_html,
    slide_layouts::{self, Layout, SlideFields},
    time::now_iso8601,
};

pub const WRITE_HTML_TOOL: &str = "write_html_document";
pub const EDIT_HTML_TOOL: &str = "edit_html_document";
pub const WRITE_MARKDOWN_TOOL: &str = "write_markdown_document";
pub const EDIT_MARKDOWN_TOOL: &str = "edit_markdown_document";
pub const WRITE_TEXT_TOOL: &str = "write_text_document";
pub const EDIT_TEXT_TOOL: &str = "edit_text_document";
pub const EXPORT_DOCUMENT_TOOL: &str = "export_document";
/// The kinds the write_*/edit_* tools produce; a rewrite may convert between them.
const DOCUMENT_KINDS: [&str; 3] = ["html", "markdown", "text"];
/// Exact-text replacements in an existing document of any kind.
pub const PATCH_DOCUMENT_TOOL: &str = "patch_document";
/// Current content of an existing document, so a patch can quote it exactly.
pub const READ_DOCUMENT_TOOL: &str = "read_document";

/// Longest `read_document` response, in characters. Larger documents come back
/// truncated with a note saying how to read further.
const READ_DOCUMENT_MAX_CHARS: usize = 60_000;

// Branding tools (SideEffectful — proposes a theme artifact, never writes
// brand.md directly; see `write_brand_theme`'s doc comment).
pub const WRITE_BRAND_THEME_TOOL: &str = "write_brand_theme";

/// t0-8 M3: generate one image from a prompt and save it as an `image`-kind
/// artifact. Only runs when `ctx.image` is configured (see
/// [`ImageToolConfig`]); not yet reachable from a real turn (M4).
pub const GENERATE_IMAGE_TOOL: &str = "generate_image";

// Utility tools (ReadOnly, always available)
pub const CURRENT_TIME_TOOL: &str = "current_time";
pub const UUID_TOOL: &str = "uuid";
pub const RANDOM_TOOL: &str = "random";
pub const CALCULATOR_TOOL: &str = "calculator";
/// Mid-answer structured elicitation (t1-2). Handled specially by the agent loop.
pub const ASK_USER_TOOL: &str = "ask_user";
/// t1-5: propose a memory fact. Writes `pending` until the user saves it.
pub const REMEMBER_TOOL: &str = "remember";

// Web tools (ReadOnly/SideEffectful, search-gated)
pub const WEB_SEARCH_TOOL: &str = "web_search";
pub const WEB_FETCH_TOOL: &str = "web_fetch";
/// Most readable text one `web_fetch` returns to the model.
const WEB_FETCH_MAX_CHARS: usize = 50_000;

// Clipboard tools (SideEffectful, read requires consent)
pub const CLIPBOARD_READ_TOOL: &str = "clipboard_read";
pub const CLIPBOARD_WRITE_TOOL: &str = "clipboard_write";

// Workspace file tools (gated by settings.workspace_tools_*)
pub const WORKSPACE_READ_TOOL: &str = "workspace_read";
pub const WORKSPACE_WRITE_TOOL: &str = "workspace_write";
pub const WORKSPACE_EDIT_TOOL: &str = "workspace_edit";
pub const WORKSPACE_GLOB_TOOL: &str = "workspace_glob";
pub const WORKSPACE_GREP_TOOL: &str = "workspace_grep";

// Deck tools (only offered in a chat bound to a deck)
pub const READ_DECK_TOOL: &str = "read_deck";
pub const SET_STORYLINE_TOOL: &str = "set_storyline";
pub const ADD_SLIDE_TOOL: &str = "add_slide";
pub const UPDATE_SLIDE_TOOL: &str = "update_slide";
pub const PATCH_SLIDE_TOOL: &str = "patch_slide";
pub const MOVE_SLIDE_TOOL: &str = "move_slide";
pub const DELETE_SLIDE_TOOL: &str = "delete_slide";
pub const SET_THEME_TOOL: &str = "set_theme";
pub const REPLACE_IN_DECK_TOOL: &str = "replace_in_deck";
pub const UPDATE_SLOTS_TOOL: &str = "update_slots";
// Offered only in a chat that is NOT bound to a deck, on a deck-request turn.
pub const START_DECK_TOOL: &str = "start_deck";

// Draft tools (Writing; only offered in a draft's chat)
pub const READ_DRAFT_TOOL: &str = "read_draft";
pub const SET_OUTLINE_TOOL: &str = "set_outline";
pub const WRITE_SECTION_TOOL: &str = "write_section";
pub const EDIT_BLOCKS_TOOL: &str = "edit_blocks";
pub const REPLACE_IN_DRAFT_TOOL: &str = "replace_in_draft";

/// Longest `read_draft` response, in characters of block text. A longer draft
/// comes back cut at a block boundary with a note saying where to continue.
const READ_DRAFT_MAX_CHARS: usize = 60_000;

/// True for the deck tools that change a deck's content (everything but
/// `read_deck` and `start_deck`). A deck build is a dozen or more `add_slide`
/// calls; each one that succeeds is progress for the turn's time limit.
pub fn is_deck_write_tool(name: &str) -> bool {
    matches!(
        name,
        SET_STORYLINE_TOOL
            | ADD_SLIDE_TOOL
            | UPDATE_SLIDE_TOOL
            | PATCH_SLIDE_TOOL
            | MOVE_SLIDE_TOOL
            | DELETE_SLIDE_TOOL
            | SET_THEME_TOOL
            | REPLACE_IN_DECK_TOOL
            | UPDATE_SLOTS_TOOL
    )
}

/// True for the draft tools that change a draft (everything but `read_draft`).
pub fn is_draft_write_tool(name: &str) -> bool {
    matches!(
        name,
        SET_OUTLINE_TOOL | WRITE_SECTION_TOOL | EDIT_BLOCKS_TOOL | REPLACE_IN_DRAFT_TOOL
    )
}

pub struct AgentToolContext<'a> {
    pub db: &'a sqlx::SqlitePool,
    pub artifacts_dir: &'a Path,
    pub exports_dir: &'a Path,
    pub encryption: &'a Encryption,
    pub conversation_id: &'a str,
    pub source_message_id: Option<String>,
    /// Present when workspace tools are enabled with a valid root.
    pub workspace: Option<&'a crate::workspace_tools::WorkspaceToolConfig>,
    /// Local web_search backend + optional API key. Default is Exa (keyless).
    pub search: crate::search::LocalSearchConfig,
    /// Present when the active provider has a configured default image model
    /// (t0-8 M3). `None` makes `generate_image` fail with a clear error
    /// instead of silently doing nothing — see [`ImageToolConfig`].
    pub image: Option<ImageToolConfig>,
}

/// Resolved image-generation support for the turn's active provider (t0-8
/// M3): which adapter to call, the `AdapterContext` it needs, and which
/// model id to send. Built once at the single `AgentToolContext`
/// construction site in `stream_manager.rs`, mirroring how `workspace` and
/// `search` above are resolved configs rather than raw `AppState`.
///
/// Gated on the *provider*, not the turn's active chat model:
/// `AppSettings.active_model` is always a chat model, and image models
/// (`gpt-image-2.5-*`, `imagen-4.0-*`) don't share an id namespace with
/// chat models, so `model_generates_images(provider, active_model)` would be
/// false for every real user. `stream_manager.rs` instead calls
/// `provider_core::default_image_model(active_provider)` and only builds a
/// config when that returns `Some`.
///
/// Carries the already-*resolved* adapter (via `StreamManager`'s existing
/// `AdapterResolver` seam — the same one `agent_turn.rs`'s `ScriptedAdapter`
/// substitutes for chat) rather than just a provider id string, so a test
/// can hand `generate_image` a fake `ProviderAdapter` directly with no
/// network call and no `AppState`.
pub struct ImageToolConfig {
    /// Kept alongside `adapter` for error messages; `adapter.id()` would
    /// also work but this reads clearer at call sites that don't otherwise
    /// touch the adapter.
    pub provider_id: String,
    /// The provider's default image model — see this struct's doc comment
    /// for why it is never the turn's active chat model.
    pub model_id: String,
    pub adapter: Box<dyn provider_core::ProviderAdapter>,
    pub adapter_ctx: provider_core::AdapterContext,
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
                ("more_to_write", "boolean", false),
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
                ("more_to_write", "boolean", false),
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
                ("more_to_write", "boolean", false),
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
                ("more_to_write", "boolean", false),
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
                ("more_to_write", "boolean", false),
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
                ("more_to_write", "boolean", false),
                ("mime_type", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: PATCH_DOCUMENT_TOOL.to_string(),
            name: PATCH_DOCUMENT_TOOL.to_string(),
            description: "Change part of an existing document by exact text replacement."
                .to_string(),
            input_schema: patch_document_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Documents".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: READ_DOCUMENT_TOOL.to_string(),
            name: READ_DOCUMENT_TOOL.to_string(),
            description: "Read the current content of an existing document.".to_string(),
            input_schema: json_schema(&[
                ("artifact_id", "string", true),
                ("start_line", "integer", false),
                ("end_line", "integer", false),
            ]),
            permission_level: Some(PermissionLevel::ReadOnly),
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
        // Image tools (t0-8 M3). Gated on `ctx.image`, which is only ever
        // `Some` for a provider with a configured default image model (see
        // `ImageToolConfig`) — not reachable from a real turn until M4 adds
        // it to `selectBuiltinTurnTools` on the TS side.
        // ---------------------------------------------------------------------
        ToolDefinition {
            tool_id: GENERATE_IMAGE_TOOL.to_string(),
            name: GENERATE_IMAGE_TOOL.to_string(),
            description: format!(
                "Generate a single image from a text prompt and save it as a new image \
                 artifact. Produces exactly one image per call -- call it again for \
                 additional images. Requires the active provider to support image \
                 generation; {app_name} returns a clear error if it doesn't."
            ),
            input_schema: json_schema(&[
                ("prompt", "string", true),
                ("size", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Images".to_string()),
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
        ToolDefinition {
            tool_id: ASK_USER_TOOL.to_string(),
            name: ASK_USER_TOOL.to_string(),
            description: "Ask the user a short structured question mid-turn (up to 4 fields). Provide `title` and `fields` (array of {id, prompt, type: text|choice, options?}). Wait for the user's answers before continuing.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "fields": {
                        "type": "array",
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "prompt": { "type": "string" },
                                "type": { "type": "string" },
                                "options": { "type": "array", "items": { "type": "string" } }
                            },
                            "required": ["id", "prompt", "type"]
                        }
                    }
                },
                "required": ["title", "fields"]
            }),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Utilities".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: REMEMBER_TOOL.to_string(),
            name: REMEMBER_TOOL.to_string(),
            description: "Propose a durable personal fact for the user to save. Provide `fact` (one short sentence) and optional `kind` (`core` or `note`). The fact is queued until the user saves it in Settings → Memory; it is not used until then.".to_string(),
            input_schema: json_schema(&[
                ("fact", "string", true),
                ("kind", "string", false),
            ]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Memory".to_string()),
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
            description: "Search the web via the configured local search backend. Provide a `query` string. Returns up to 10 results with titles, snippets, and URLs. Empty results mean no hit — do not retry similar queries.".to_string(),
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
            description: "Fetch a public web page. Provide a `url` string. Returns its title and readable text (truncated at 50,000 characters). Only public https sites can be fetched; local and private-network addresses are refused.".to_string(),
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
            description: "Read a text file under the workspace folder. PDF and DOCX files are read as text (extracted, so offset/limit count characters for them). Path must be relative to the workspace root. Optional offset/limit in bytes for text files.".to_string(),
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
        ToolDefinition {
            tool_id: READ_DECK_TOOL.to_string(),
            name: READ_DECK_TOOL.to_string(),
            description: READ_DECK_DESCRIPTION.to_string(),
            input_schema: read_deck_schema(),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: SET_STORYLINE_TOOL.to_string(),
            name: SET_STORYLINE_TOOL.to_string(),
            description: SET_STORYLINE_DESCRIPTION.to_string(),
            input_schema: set_storyline_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: ADD_SLIDE_TOOL.to_string(),
            name: ADD_SLIDE_TOOL.to_string(),
            description: ADD_SLIDE_DESCRIPTION.to_string(),
            input_schema: add_slide_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: UPDATE_SLIDE_TOOL.to_string(),
            name: UPDATE_SLIDE_TOOL.to_string(),
            description: UPDATE_SLIDE_DESCRIPTION.to_string(),
            input_schema: update_slide_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: PATCH_SLIDE_TOOL.to_string(),
            name: PATCH_SLIDE_TOOL.to_string(),
            description: PATCH_SLIDE_DESCRIPTION.to_string(),
            input_schema: patch_slide_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: MOVE_SLIDE_TOOL.to_string(),
            name: MOVE_SLIDE_TOOL.to_string(),
            description: MOVE_SLIDE_DESCRIPTION.to_string(),
            input_schema: json_schema(&[("slide_id", "string", true), ("position", "integer", true)]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: DELETE_SLIDE_TOOL.to_string(),
            name: DELETE_SLIDE_TOOL.to_string(),
            description: DELETE_SLIDE_DESCRIPTION.to_string(),
            input_schema: json_schema(&[("slide_id", "string", true)]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: SET_THEME_TOOL.to_string(),
            name: SET_THEME_TOOL.to_string(),
            description: SET_THEME_DESCRIPTION.to_string(),
            input_schema: json_schema(&[("css", "string", true), ("name", "string", false)]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: REPLACE_IN_DECK_TOOL.to_string(),
            name: REPLACE_IN_DECK_TOOL.to_string(),
            description: REPLACE_IN_DECK_DESCRIPTION.to_string(),
            input_schema: replace_in_deck_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: UPDATE_SLOTS_TOOL.to_string(),
            name: UPDATE_SLOTS_TOOL.to_string(),
            description: UPDATE_SLOTS_DESCRIPTION.to_string(),
            input_schema: update_slots_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: START_DECK_TOOL.to_string(),
            name: START_DECK_TOOL.to_string(),
            description: START_DECK_DESCRIPTION.to_string(),
            input_schema: json_schema(&[("title", "string", true)]),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Slides".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: READ_DRAFT_TOOL.to_string(),
            name: READ_DRAFT_TOOL.to_string(),
            description: READ_DRAFT_DESCRIPTION.to_string(),
            input_schema: read_draft_schema(),
            permission_level: Some(PermissionLevel::ReadOnly),
            display_group: Some("Writing".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: SET_OUTLINE_TOOL.to_string(),
            name: SET_OUTLINE_TOOL.to_string(),
            description: SET_OUTLINE_DESCRIPTION.to_string(),
            input_schema: set_outline_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Writing".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: WRITE_SECTION_TOOL.to_string(),
            name: WRITE_SECTION_TOOL.to_string(),
            description: WRITE_SECTION_DESCRIPTION.to_string(),
            input_schema: write_section_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Writing".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: EDIT_BLOCKS_TOOL.to_string(),
            name: EDIT_BLOCKS_TOOL.to_string(),
            description: EDIT_BLOCKS_DESCRIPTION.to_string(),
            input_schema: edit_blocks_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Writing".to_string()),
            tenant_scope: None,
            kind: None,
            host_config: None,
        },
        ToolDefinition {
            tool_id: REPLACE_IN_DRAFT_TOOL.to_string(),
            name: REPLACE_IN_DRAFT_TOOL.to_string(),
            description: REPLACE_IN_DRAFT_DESCRIPTION.to_string(),
            input_schema: replace_in_draft_schema(),
            permission_level: Some(PermissionLevel::SideEffectful),
            display_group: Some("Writing".to_string()),
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
            | PATCH_DOCUMENT_TOOL
            | READ_DOCUMENT_TOOL
            | WRITE_BRAND_THEME_TOOL
            | GENERATE_IMAGE_TOOL
            | CURRENT_TIME_TOOL
            | UUID_TOOL
            | RANDOM_TOOL
            | CALCULATOR_TOOL
            | ASK_USER_TOOL
            | REMEMBER_TOOL
            | WEB_SEARCH_TOOL
            | WEB_FETCH_TOOL
            | CLIPBOARD_READ_TOOL
            | CLIPBOARD_WRITE_TOOL
            | WORKSPACE_READ_TOOL
            | WORKSPACE_WRITE_TOOL
            | WORKSPACE_EDIT_TOOL
            | WORKSPACE_GLOB_TOOL
            | WORKSPACE_GREP_TOOL
            | READ_DECK_TOOL
            | SET_STORYLINE_TOOL
            | ADD_SLIDE_TOOL
            | UPDATE_SLIDE_TOOL
            | PATCH_SLIDE_TOOL
            | MOVE_SLIDE_TOOL
            | DELETE_SLIDE_TOOL
            | SET_THEME_TOOL
            | REPLACE_IN_DECK_TOOL
            | UPDATE_SLOTS_TOOL
            | START_DECK_TOOL
            | READ_DRAFT_TOOL
            | SET_OUTLINE_TOOL
            | WRITE_SECTION_TOOL
            | EDIT_BLOCKS_TOOL
            | REPLACE_IN_DRAFT_TOOL
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
        PATCH_DOCUMENT_TOOL => {
            let input: PatchDocumentInput = parse_args(tool_name, arguments)?;
            patch_document(ctx, input).await
        }
        READ_DOCUMENT_TOOL => {
            let input: ReadDocumentInput = parse_args(tool_name, arguments)?;
            read_document(ctx, input).await
        }
        // ---------------------------------------------------------------------
        // Image tools
        // ---------------------------------------------------------------------
        GENERATE_IMAGE_TOOL => {
            let input: GenerateImageInput = parse_args(tool_name, arguments)?;
            generate_image(ctx, input).await
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
            match crate::search::search(&ctx.search, &input.query).await {
                Ok(results) => Ok(web_search_tool_output_with_note(
                    &input.query,
                    results,
                    crate::search::empty_note(ctx.search.backend),
                )),
                Err(e) => Err(format!("web search error: {e}")),
            }
        }
        WEB_FETCH_TOOL => {
            let input: WebFetchInput = parse_args(tool_name, arguments)?;
            match web_fetch(&input.url).await {
                Ok(page) => Ok(serde_json::json!({
                    "ok": true,
                    "url": page.url,
                    "title": page.title,
                    "content": page.text,
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
            Ok(crate::workspace_tools::execute_workspace_read(ws, input)
                .await
                .unwrap_or_else(|e| e))
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
        // Handled by `StreamManager::execute_ask_user_tool` before this match runs;
        // arm exists so TS/Rust parity treats ask_user as a known builtin.
        ASK_USER_TOOL => Err(
            "ask_user must be handled by the agent loop (StreamManager), not execute_builtin_tool"
                .to_string(),
        ),
        REMEMBER_TOOL => {
            let input: RememberInput = parse_args(tool_name, arguments)?;
            remember_fact(ctx, input).await
        }
        // ---------------------------------------------------------------------
        // Deck tools
        // ---------------------------------------------------------------------
        READ_DECK_TOOL => {
            let input: ReadDeckInput = parse_args(tool_name, arguments)?;
            read_deck(ctx, input).await
        }
        SET_STORYLINE_TOOL => {
            let input: SetStorylineInput = parse_args(tool_name, arguments)?;
            set_storyline(ctx, input).await
        }
        ADD_SLIDE_TOOL => {
            let args = crate::slide_layouts::without_placeholder_fields(arguments);
            let input: AddSlideInput = parse_args(tool_name, &args)?;
            add_slide(ctx, input).await
        }
        UPDATE_SLIDE_TOOL => {
            let input: UpdateSlideInput = parse_args(tool_name, arguments)?;
            update_slide(ctx, input, arguments).await
        }
        PATCH_SLIDE_TOOL => {
            let input: PatchSlideInput = parse_args(tool_name, arguments)?;
            patch_slide(ctx, input).await
        }
        MOVE_SLIDE_TOOL => {
            let input: MoveSlideInput = parse_args(tool_name, arguments)?;
            move_slide(ctx, input).await
        }
        DELETE_SLIDE_TOOL => {
            let input: DeleteSlideInput = parse_args(tool_name, arguments)?;
            delete_slide(ctx, input).await
        }
        SET_THEME_TOOL => {
            let input: SetThemeInput = parse_args(tool_name, arguments)?;
            set_theme(ctx, input).await
        }
        REPLACE_IN_DECK_TOOL => {
            let input: ReplaceInDeckInput = parse_args(tool_name, arguments)?;
            replace_in_deck(ctx, input).await
        }
        UPDATE_SLOTS_TOOL => {
            let input: UpdateSlotsInput = parse_args(tool_name, arguments)?;
            update_slots(ctx, input).await
        }
        START_DECK_TOOL => {
            let input: StartDeckInput = parse_args(tool_name, arguments)?;
            start_deck(ctx, input).await
        }
        // ---------------------------------------------------------------------
        // Draft tools
        // ---------------------------------------------------------------------
        READ_DRAFT_TOOL => {
            let input: ReadDraftInput = parse_args(tool_name, arguments)?;
            read_draft(ctx, input).await
        }
        SET_OUTLINE_TOOL => {
            let input: SetOutlineInput = parse_args(tool_name, arguments)?;
            set_outline(ctx, input).await
        }
        WRITE_SECTION_TOOL => {
            let input: WriteSectionInput = parse_args(tool_name, arguments)?;
            write_section(ctx, input).await
        }
        EDIT_BLOCKS_TOOL => {
            let input: EditBlocksInput = parse_args(tool_name, arguments)?;
            edit_blocks(ctx, input).await
        }
        REPLACE_IN_DRAFT_TOOL => {
            let input: ReplaceInDraftInput = parse_args(tool_name, arguments)?;
            replace_in_draft(ctx, input).await
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

/// The `patch_document` input schema: `edits` is an array of objects, which the
/// flat [`json_schema`] helper cannot express.
fn patch_document_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "artifact_id": { "type": "string" },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "old_text": { "type": "string" },
                        "new_text": { "type": "string" },
                    },
                    "required": ["old_text", "new_text"],
                },
            },
            "more_to_write": { "type": "boolean" },
        },
        "required": ["artifact_id", "edits"],
    })
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
    // A full rewrite may change the document's kind: "turn it into an HTML
    // page" on a markdown resume. That used to be refused ("is 'markdown' not
    // 'html'") — the model retried, gave up, and pasted the page into the chat
    // while the panel kept the old markdown. Between document kinds it is a
    // conversion of the same artifact; anything else is still refused.
    let converting = existing.kind != kind
        && DOCUMENT_KINDS.contains(&existing.kind.as_str())
        && DOCUMENT_KINDS.contains(&kind);
    if converting {
        artifacts::set_kind(ctx.db, artifact_id, kind)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        ensure_kind(&existing, kind)?;
    }

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

/// Apply exact-text replacements to a document, in order, all or nothing.
///
/// Each `old_text` must occur exactly once in the document as it stands after
/// the edits before it. When one does not, nothing is saved and the error
/// names the edit and what was wrong, so the model can fix that one edit —
/// usually by quoting more surrounding text, or reading the document first.
pub fn apply_document_edits(content: &str, edits: &[DocumentEdit]) -> Result<String, String> {
    if edits.is_empty() {
        return Err("edits is empty — pass at least one {old_text, new_text} pair".to_string());
    }
    let mut next = content.to_string();
    for (i, edit) in edits.iter().enumerate() {
        let n = i + 1;
        if edit.old_text.is_empty() {
            return Err(format!(
                "edit {n}: old_text is empty — quote the exact text to replace"
            ));
        }
        let matches = next.matches(edit.old_text.as_str()).count();
        match matches {
            1 => next = next.replacen(edit.old_text.as_str(), &edit.new_text, 1),
            // Models often quote a block without its indentation — live, the
            // first patch of a build quoted `<!-- SECTION:mercury -->` where the
            // skeleton had it indented. Fall back to whole lines compared
            // without surrounding whitespace, still requiring one match.
            0 => match find_lines_ignoring_indentation(&next, &edit.old_text) {
                LineMatch::One(range) => {
                    next.replace_range(range, edit.new_text.trim());
                }
                LineMatch::Many(count) => {
                    return Err(format!(
                        "edit {n}: old_text matches {count} places when indentation is ignored — \
                         nothing was saved. Include more surrounding text so it matches exactly one"
                    ))
                }
                LineMatch::None => {
                    return Err(format!(
                        "edit {n}: old_text was not found in the document, even ignoring \
                         indentation — nothing was saved. Quote the text exactly as it appears \
                         (read_document shows the current content)"
                    ))
                }
            },
            count => {
                return Err(format!(
                    "edit {n}: old_text matches {count} places — nothing was saved. \
                     Include more surrounding text so it matches exactly one"
                ))
            }
        }
    }
    Ok(next)
}

enum LineMatch {
    None,
    /// Byte range to replace: from the first matched line's first
    /// non-whitespace character to the last matched line's last one, so the
    /// document keeps its own indentation and line endings.
    One(std::ops::Range<usize>),
    Many(usize),
}

/// Find `needle` as a run of whole lines in `haystack`, comparing each line
/// without leading or trailing whitespace. Blank lines at either end of the
/// needle are ignored.
fn find_lines_ignoring_indentation(haystack: &str, needle: &str) -> LineMatch {
    let wanted: Vec<&str> = needle.lines().map(str::trim).collect();
    let first = wanted.iter().position(|line| !line.is_empty());
    let last = wanted.iter().rposition(|line| !line.is_empty());
    let (Some(first), Some(last)) = (first, last) else {
        return LineMatch::None;
    };
    let wanted = &wanted[first..=last];

    // (start offset, line without its line ending) for every line.
    let mut lines = Vec::new();
    let mut offset = 0;
    for raw in haystack.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        lines.push((offset, line));
        offset += raw.len();
    }
    if lines.len() < wanted.len() {
        return LineMatch::None;
    }

    let mut found = Vec::new();
    for start in 0..=lines.len() - wanted.len() {
        let window = &lines[start..start + wanted.len()];
        if window
            .iter()
            .zip(wanted)
            .all(|((_, line), want)| line.trim() == *want)
        {
            let (first_offset, first_line) = window[0];
            let (last_offset, last_line) = window[wanted.len() - 1];
            let begin = first_offset + (first_line.len() - first_line.trim_start().len());
            let end = last_offset + last_line.trim_end().len();
            found.push(begin..end);
        }
    }
    match found.len() {
        0 => LineMatch::None,
        1 => LineMatch::One(found.remove(0)),
        count => LineMatch::Many(count),
    }
}

async fn patch_document(
    ctx: &AgentToolContext<'_>,
    input: PatchDocumentInput,
) -> Result<Value, String> {
    let existing = artifacts::get(ctx.db, ctx.encryption, &input.artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("artifact '{}' not found", input.artifact_id))?;
    let Some(content) = existing.content_text.as_deref() else {
        return Err(format!(
            "artifact '{}' has no text content to patch",
            input.artifact_id
        ));
    };
    let patched = apply_document_edits(content, &input.edits)?;
    let updated = artifacts::set_content(
        ctx.db,
        ctx.artifacts_dir,
        ctx.encryption,
        &existing.id,
        existing.mime_type.as_deref(),
        &ArtifactContent::Text {
            text: patched.clone(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "artifact_id": updated.id,
        "updated": true,
        "kind": existing.kind,
        "edits_applied": input.edits.len(),
        "lines": patched.lines().count(),
    }))
}

async fn read_document(
    ctx: &AgentToolContext<'_>,
    input: ReadDocumentInput,
) -> Result<Value, String> {
    let existing = artifacts::get(ctx.db, ctx.encryption, &input.artifact_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("artifact '{}' not found", input.artifact_id))?;
    let Some(content) = existing.content_text.as_deref() else {
        return Err(format!(
            "artifact '{}' has no text content to read",
            input.artifact_id
        ));
    };
    Ok(read_document_output(
        &existing,
        content,
        input.start_line,
        input.end_line,
    ))
}

/// The `read_document` result: the requested lines (all by default), capped at
/// [`READ_DOCUMENT_MAX_CHARS`] and cut at a line boundary.
pub fn read_document_output(
    artifact: &Artifact,
    content: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Value {
    let total_lines = content.lines().count();
    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(total_lines).min(total_lines);
    let mut text = String::new();
    let mut last_line = start.saturating_sub(1);
    let mut line_cut = false;
    for (i, line) in content.lines().enumerate().skip(start - 1) {
        let n = i + 1;
        if n > end {
            break;
        }
        if text.len() + line.len() + 1 > READ_DOCUMENT_MAX_CHARS {
            // A single line longer than the cap (minified HTML) still returns
            // its beginning rather than nothing.
            if text.is_empty() {
                let mut cut = READ_DOCUMENT_MAX_CHARS.min(line.len());
                while !line.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.push_str(&line[..cut]);
                last_line = n;
                line_cut = true;
            }
            break;
        }
        text.push_str(line);
        text.push('\n');
        last_line = n;
    }
    let mut output = serde_json::json!({
        "ok": true,
        "artifact_id": artifact.id,
        "kind": artifact.kind,
        "title": artifact.title,
        "total_lines": total_lines,
        "start_line": start,
        "end_line": last_line,
        "content": text,
    });
    if line_cut {
        output["note"] = serde_json::json!(format!(
            "Line {last_line} is longer than {READ_DOCUMENT_MAX_CHARS} characters and was cut. \
             Quote text from the part shown when patching."
        ));
    } else if last_line < end {
        output["note"] = serde_json::json!(format!(
            "Truncated at line {last_line} of {total_lines}. Call read_document with start_line {} to read on.",
            last_line + 1
        ));
    }
    output
}

/// Call the configured provider's `generate_image` and save the result as a
/// new `image`-kind artifact.
///
/// Mirrors [`write_document`]'s structure, but the order of operations is
/// different on purpose: `write_document` already has its text in hand (the
/// model produced it), so it creates the artifact row first. Here the
/// "content" comes from an async provider call that can fail (bad prompt,
/// provider outage, no credential) — generating first and only creating the
/// artifact on success avoids leaving behind an empty/orphaned image
/// artifact every time a generation fails.
async fn generate_image(
    ctx: &AgentToolContext<'_>,
    input: GenerateImageInput,
) -> Result<Value, String> {
    // Fail clearly rather than silently doing nothing — the whole point of
    // gating on the provider (see `ImageToolConfig`'s doc comment) instead of
    // the active chat model is that this arm is reachable in practice, so it
    // needs a real error message when the provider truly has no image support
    // configured.
    let cfg = ctx.image.as_ref().ok_or_else(|| {
        "Image generation is not available: the active provider has no configured image model"
            .to_string()
    })?;

    let request = provider_core::ImageGenerationRequest {
        prompt: input.prompt.clone(),
        size: input.size.clone(),
        model_id: cfg.model_id.clone(),
    };

    let result = cfg
        .adapter
        .generate_image(request, &cfg.adapter_ctx)
        .await
        .map_err(|e| format!("{} image generation failed: {}", cfg.provider_id, e.message))?;

    let extension = extension_for_image_mime(&result.mime_type);
    let title = resolve_title(Some(truncate_title(&input.prompt, 100)), None);

    let artifact = artifacts::create(
        ctx.db,
        ctx.conversation_id,
        "image",
        title.as_deref(),
        ctx.source_message_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let filename = format!("image-{}.{extension}", artifact.id);

    let updated = artifacts::set_content(
        ctx.db,
        ctx.artifacts_dir,
        ctx.encryption,
        &artifact.id,
        Some(&result.mime_type),
        &ArtifactContent::File {
            bytes: result.bytes,
            filename,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "artifact_id": updated.id,
        "created": true,
        "kind": "image",
        "title": updated.title,
        "mime_type": updated.mime_type,
    }))
}

/// Extension matching a generated image's sniffed MIME type
/// (`image_generation::decode_generated_image` sniffs it with `infer`,
/// falling back to the provider's claimed type). Unrecognized types still
/// get a valid filename rather than failing the whole tool call over a
/// cosmetic detail.
fn extension_for_image_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// Truncate a prompt down to a reasonable artifact title. Char-based (not
/// byte-based) so it never splits a multi-byte UTF-8 character.
fn truncate_title(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{truncated}…")
    }
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

// -----------------------------------------------------------------------------
// Deck tools
// -----------------------------------------------------------------------------

const READ_DECK_DESCRIPTION: &str = "Read the deck you are building. With no slide_id it returns the title, theme, stage, storyline and an outline of every slide (slide_id, position, layout, visible text, and its text slots with each slot's name, text and pinned flag). With a slide_id it returns that slide's notes, slots and fields (its layout's fields when it was built from fields, otherwise null), plus its full inner html for custom and older slides. A pinned slot holds text the user wrote. Read a slide before you change it.";
const SET_STORYLINE_DESCRIPTION: &str = "Write the deck's storyline: one short line per planned slide, in order. Replaces the whole storyline. The user reviews and edits it before any slides are built. Always pass title on the first storyline (a short name for the deck, 120 characters at most). Pass assumptions when the user did not say who the deck is for or what they should do: one or two sentences stating what you assumed about audience, goal and length (400 characters at most; an empty string clears it).";
const START_DECK_DESCRIPTION: &str = "Start a slide deck from this chat. Call it when the user asks for slides, a deck or a presentation, then stop and reply in one short sentence: the app opens the deck in Slides and asks you for the storyline there. title is a short name for the deck.";
const ADD_SLIDE_DESCRIPTION: &str = "Add ONE slide to the deck (call once per slide), at the end or after after_slide_id. Pick a layout and pass only that layout's fields; the app builds the slide in the theme. Fields and limits per layout (counts are visible words unless noted):\n- title: headline (≤10), sub (≤20), kicker.\n- statement: headline (≤14), sub (≤20).\n- bullets: headline (≤10), bullets (2-5 items, each ≤14), kicker.\n- stat-row: stats (2-4 items, each a value of ≤6 characters such as \"$28.6M\" and a label of ≤8 words that carries the unit or context), headline (≤10, optional), kicker.\n- two-col: headline (≤10), columns (exactly 2, each a kicker ≤4 plus body ≤30 or bullets of 2-4 items ≤10), kicker.\n- quote: quote (≤30), cite (≤8).\n- section: headline (≤8), kicker.\n- image-left: headline (≤10), body (≤30) or bullets (2-3 items, each ≤12), and chart or svg for the picture.\n- chart: headline (≤12), chart or svg, kicker.\n- custom: html only, when no other layout fits; its layout is checked after the turn.\nkicker is always ≤4. Every layout except title, section and custom also takes footnote (≤20). Text fields are plain text plus span, em, strong, b, i, u, br, sub, sup, small and mark tags. For numbers prefer chart: the app draws it from your data. Use svg only for a diagram. A call that breaks a limit is rejected with every problem listed: fix them all and call again. notes is optional speaker notes.";
const UPDATE_SLIDE_DESCRIPTION: &str = "Restructure one slide: pass slide_id and the fields to change. They merge onto the slide's current fields; null or an empty value removes an optional field. Layouts, fields and limits are as in add_slide. To switch layout pass layout and the new layout's fields; fields with the same name carry over. A custom slide, or an older slide not built from fields, needs every field for its layout, or html with layout custom. notes alone changes only the speaker notes. For a wording change use update_slots instead. Pinned slots (text the user wrote) keep their text and are listed in kept_pinned. Pass release_pinned with a pinned slot's name only when the user's message names that specific text (for example \"change my headline to ...\"). A request to rewrite, restyle, shorten or redo the slide or the deck does not name it: keep pinned text word for word and say in your reply that you kept it.";
const PATCH_SLIDE_DESCRIPTION: &str = "Change part of the inner html of a custom slide, or of an older slide not built from fields, by exact text replacement. On slides built from fields use update_slots for wording and update_slide for structure. Each old_text must occur exactly once in the slide; read the slide first and quote enough surrounding text. Edits apply in order, all or nothing. Pinned slots (text the user wrote, data-owner=\"user\") must keep their exact content: the call is rejected otherwise. Pass release_pinned with a pinned slot's name only when the user's message names that specific text (for example \"change my headline to ...\"). A request to rewrite, restyle, shorten or redo the slide or the deck does not name it: keep pinned text word for word and say in your reply that you kept it.";
const REPLACE_IN_DECK_DESCRIPTION: &str = "Swap an exact word or phrase everywhere in the deck's text and speaker notes in one step; markup is never touched. Use it only for an exact swap the user asked for across the deck. It also changes pinned slots, because the user named the word, and reports them in pinned_changed. match_case and whole_word default to false.";
const UPDATE_SLOTS_DESCRIPTION: &str = "Set the text of slots (elements with data-text) on one or more slides in one call. This is the way to change wording on slides built from fields, whose slots are kicker, headline, sub, body, bullet-N, stat-N-value, stat-N-label, col-N-kicker, col-N-body, col-N-bullet-M, quote, cite and footnote (numbered from 1). Use it also for judgment edits across slides, such as sentence-casing every headline or saying customers instead of users. Each edit gives slide_id, the slot name and the new inline html: text plus only span, em, strong, b, i, u, br, sub, sup, small and mark tags, with no attributes except class. index picks one of several slots with the same name (0-based, default the first). Pinned slots (text the user wrote) are skipped and listed in skipped_pinned. For an exact word swap use replace_in_deck.";
const MOVE_SLIDE_DESCRIPTION: &str =
    "Move a slide to a new 0-based position in the deck (clamped to the last slide).";
const DELETE_SLIDE_DESCRIPTION: &str = "Delete one slide from the deck.";
const SET_THEME_DESCRIPTION: &str = "Replace the deck's whole theme CSS (the classes and color tokens every slide uses). Rarely needed; name is the theme's label and defaults to \"Custom\".";

fn read_deck_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "slide_id": {
                "type": "string",
                "description": "Return this one slide in full instead of the deck outline."
            },
        },
    })
}

fn set_storyline_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": { "type": "string" },
                "description": "One short line per planned slide, in order."
            },
            "title": {
                "type": "string",
                "description": "A short name for the deck (120 characters at most). Pass it on the first storyline; it renames the deck and its chat."
            },
            "assumptions": {
                "type": "string",
                "description": "One or two sentences stating what you assumed about audience, goal or length that the user did not say (400 characters at most). Empty string clears it."
            },
        },
        "required": ["lines"],
    })
}

/// The typed slide fields shared by add_slide and update_slide, keyed by
/// name. Mirrored exactly in agentTools.ts (agentToolsParity checks it).
fn slide_field_properties() -> serde_json::Map<String, Value> {
    let props = serde_json::json!({
        "kicker": { "type": "string", "description": "Small label above the headline, at most 4 words (title, section, bullets, two-col, stat-row, chart)." },
        "headline": { "type": "string", "description": "The slide's main line (every layout except quote and custom)." },
        "sub": { "type": "string", "description": "One supporting line, at most 20 words (title, statement)." },
        "body": { "type": "string", "description": "A short paragraph, at most 30 words (image-left)." },
        "bullets": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Bullet points: 2 to 5 of at most 14 words (bullets), or 2 to 3 of at most 12 words (image-left)."
        },
        "stats": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "value": { "type": "string", "description": "The number, at most 6 characters, such as \"$28.6M\" or \"118%\"." },
                    "label": { "type": "string", "description": "What it measures, at most 8 words; units and context go here." },
                },
                "required": ["value", "label"],
            },
            "description": "2 to 4 figures (stat-row)."
        },
        "columns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kicker": { "type": "string", "description": "The column's label, at most 4 words." },
                    "body": { "type": "string", "description": "A paragraph, at most 30 words." },
                    "bullets": { "type": "array", "items": { "type": "string" }, "description": "2 to 4 points, each at most 10 words." },
                },
                "required": ["kicker"],
            },
            "description": "Exactly 2 columns, each with body or bullets (two-col)."
        },
        "quote": { "type": "string", "description": "The quotation, at most 30 words (quote)." },
        "cite": { "type": "string", "description": "Who said it, at most 8 words (quote)." },
        "chart": {
            "type": "object",
            "description": "A chart the app draws from your data (chart, image-left). Bar: {\"type\": \"bar\", \"categories\": [\"Q1\", \"Q2\"], \"series\": [{\"name\": \"Revenue\", \"values\": [12, 18]}], \"unit_prefix\": \"$\", \"unit_suffix\": \"M\", \"highlight\": [1]}, up to 12 categories and 3 series. Line: the same with \"type\": \"line\", up to 24 categories and 4 series. Funnel: {\"type\": \"funnel\", \"stages\": [{\"label\": \"Visits\", \"value\": 48000}, {\"label\": \"Signups\", \"value\": 3100}]}, 2 to 7 stages. Labels at most 4 words.",
            "properties": {
                "type": { "type": "string", "enum": ["bar", "line", "funnel"] },
                "categories": { "type": "array", "items": { "type": "string" }, "description": "Labels along the bottom (bar, line)." },
                "series": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "Shown in the legend when there is more than one series." },
                            "values": { "type": "array", "items": { "type": "number" }, "description": "One number per category." },
                        },
                        "required": ["values"],
                    },
                    "description": "The data (bar, line)."
                },
                "stages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string" },
                            "value": { "type": "number" },
                        },
                        "required": ["label", "value"],
                    },
                    "description": "Funnel stages, largest first (funnel)."
                },
                "unit_prefix": { "type": "string", "description": "Shown before every number, such as \"$\"." },
                "unit_suffix": { "type": "string", "description": "Shown after every number, such as \"%\" or \"K\"." },
                "highlight": { "type": "array", "items": { "type": "integer" }, "description": "0-based indexes of the categories to draw in the accent color (bar)." },
                "y_label": { "type": "string", "description": "What the numbers measure, at most 4 words (bar, line)." },
            },
            "required": ["type"],
        },
        "svg": { "type": "string", "description": "One <svg> element with a viewBox, for a diagram that chart cannot draw (chart, image-left). Colors only from var(--ink), var(--ink-2), var(--accent), var(--surface); no scripts, event attributes or external links. Use a viewBox about as wide as its box (1680 for chart, 820 for image-left) and font-size of at least 24." },
        "footnote": { "type": "string", "description": "A small source or note at the bottom, at most 20 words (every layout except title, section and custom)." },
        "html": { "type": "string", "description": "The slide's inner HTML, only for layout custom: every piece of text in an element with data-text=\"slot-name\", the theme's classes and color tokens, no scripts or external URLs." },
    });
    match props {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

fn add_slide_schema() -> Value {
    let mut props = serde_json::Map::new();
    props.insert(
        "layout".to_string(),
        serde_json::json!({
            "type": "string",
            "enum": slide_layouts::LAYOUT_NAMES,
            "description": "The slide's layout; it decides which fields the slide takes."
        }),
    );
    props.extend(slide_field_properties());
    props.insert(
        "notes".to_string(),
        serde_json::json!({ "type": "string", "description": "Optional speaker notes." }),
    );
    props.insert(
        "after_slide_id".to_string(),
        serde_json::json!({ "type": "string", "description": "Insert after this slide; omit to append." }),
    );
    serde_json::json!({ "type": "object", "properties": props, "required": ["layout"] })
}

fn update_slide_schema() -> Value {
    let mut props = serde_json::Map::new();
    props.insert(
        "slide_id".to_string(),
        serde_json::json!({ "type": "string" }),
    );
    props.insert(
        "layout".to_string(),
        serde_json::json!({
            "type": "string",
            "enum": slide_layouts::LAYOUT_NAMES,
            "description": "A new layout for the slide; omit to keep its layout."
        }),
    );
    props.extend(slide_field_properties());
    props.insert(
        "notes".to_string(),
        serde_json::json!({ "type": "string", "description": "New speaker notes." }),
    );
    props.insert("release_pinned".to_string(), release_pinned_schema());
    serde_json::json!({ "type": "object", "properties": props, "required": ["slide_id"] })
}

fn release_pinned_schema() -> Value {
    serde_json::json!({
        "type": "array",
        "items": { "type": "string" },
        "description": "Names of pinned slots you may change. Only when the user asked you to change that text."
    })
}

fn replace_in_deck_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "find": { "type": "string", "description": "The exact word or phrase to find (200 characters at most)." },
            "replace": { "type": "string", "description": "What to put in its place (200 characters at most)." },
            "match_case": { "type": "boolean", "description": "Match upper and lower case exactly. Default false." },
            "whole_word": { "type": "boolean", "description": "Only match whole words. Default false." },
        },
        "required": ["find", "replace"],
    })
}

fn update_slots_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slide_id": { "type": "string" },
                        "slot": { "type": "string", "description": "The slot's data-text name." },
                        "index": { "type": "integer", "description": "Which slot with that name, 0-based. Default 0." },
                        "html": { "type": "string", "description": "The slot's new inline HTML." },
                    },
                    "required": ["slide_id", "slot", "html"],
                },
            },
        },
        "required": ["edits"],
    })
}

fn patch_slide_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "slide_id": { "type": "string" },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "old_text": { "type": "string" },
                        "new_text": { "type": "string" },
                    },
                    "required": ["old_text", "new_text"],
                },
            },
            "release_pinned": release_pinned_schema(),
        },
        "required": ["slide_id", "edits"],
    })
}

/// The deck bound to this chat, or the message to give the model when none is.
async fn deck_for_chat(ctx: &AgentToolContext<'_>) -> Result<DeckDetail, String> {
    slides::get_by_conversation(ctx.db, ctx.encryption, ctx.conversation_id)
        .await
        .map_err(slides::user_message)?
        .ok_or_else(|| "This chat isn't attached to a deck.".to_string())
}

fn slide_not_found(slide_id: &str) -> String {
    format!("No slide '{slide_id}' in this deck. Call read_deck to see the slide ids.")
}

/// The first `max` characters of `text`, with an ellipsis when cut.
fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

/// A slide's slots as `{name, text, pinned}`, text clipped to `max` characters.
fn slot_summaries(slide: &DeckSlide, max: usize) -> Vec<Value> {
    slide
        .slots
        .iter()
        .map(|slot| {
            serde_json::json!({
                "name": slot.name,
                "text": clip_chars(&slot.text, max),
                "pinned": slot.pinned,
            })
        })
        .collect()
}

async fn read_deck(ctx: &AgentToolContext<'_>, input: ReadDeckInput) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    if let Some(slide_id) = input.slide_id {
        let slide = deck
            .slides
            .iter()
            .find(|s| s.id == slide_id)
            .ok_or_else(|| slide_not_found(&slide_id))?;
        // A slide built from fields is read as its fields; its html would
        // only cost tokens. Custom and older slides come with their html.
        let fields = slide_layouts::reconstruct(&slide.layout, &slide.html);
        let mut out = serde_json::json!({
            "slide_id": slide.id,
            "position": slide.position,
            "layout": slide.layout,
            "notes": slide.notes,
            "slots": slot_summaries(slide, usize::MAX),
            "fields": fields,
        });
        if fields.is_none() {
            out["html"] = Value::String(slide.html.clone());
        }
        return Ok(out);
    }
    let outline: Vec<Value> = deck
        .slides
        .iter()
        .map(|s| {
            serde_json::json!({
                "slide_id": s.id,
                "position": s.position,
                "layout": s.layout,
                "text": clip_chars(&slides::slide_visible_text(&s.html), 300),
                "slots": slot_summaries(s, 120),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "title": deck.title,
        "theme_name": deck.theme_name,
        "stage": deck.stage.as_str(),
        "storyline": deck.storyline.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        "slides": outline,
    }))
}

async fn set_storyline(
    ctx: &AgentToolContext<'_>,
    input: SetStorylineInput,
) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    // Validate before writing anything so a bad title or note changes nothing.
    let title = match input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(title) => Some(slides::validate_title(title).map_err(slides::user_message)?),
        None => None,
    };
    if let Some(text) = &input.assumptions {
        if text.trim().chars().count() > slides::MAX_ASSUMPTIONS_CHARS {
            return Err(format!(
                "Keep the assumptions under {} characters.",
                slides::MAX_ASSUMPTIONS_CHARS
            ));
        }
    }
    let items: Vec<StorylineItem> = input
        .lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|text| StorylineItem {
            id: String::new(),
            text: text.to_string(),
        })
        .collect();
    let updated = slides::set_storyline(ctx.db, ctx.encryption, &deck.id, items)
        .await
        .map_err(slides::user_message)?;
    if let Some(title) = title {
        slides::rename(ctx.db, &deck.id, &title)
            .await
            .map_err(slides::user_message)?;
        if let Some(conversation_id) = &deck.conversation_id {
            conversations::set_title(ctx.db, conversation_id, &title)
                .await
                .map_err(slides::user_message)?;
        }
    }
    if let Some(text) = &input.assumptions {
        slides::set_assumptions(ctx.db, ctx.encryption, &deck.id, text)
            .await
            .map_err(slides::user_message)?;
    }
    Ok(serde_json::json!({ "ok": true, "lines": updated.storyline.len() }))
}

/// Bind this (unbound) chat to a new deck. The app opens it in Slides.
async fn start_deck(ctx: &AgentToolContext<'_>, input: StartDeckInput) -> Result<Value, String> {
    let existing = slides::get_by_conversation(ctx.db, ctx.encryption, ctx.conversation_id)
        .await
        .map_err(slides::user_message)?;
    if existing.is_some() {
        return Err(
            "This chat is already a deck. Use set_storyline and the other deck tools.".to_string(),
        );
    }
    let title = slides::validate_title(&input.title).map_err(slides::user_message)?;
    let deck = slides::create(
        ctx.db,
        ctx.encryption,
        &title,
        "ink",
        "",
        Some(ctx.conversation_id),
    )
    .await
    .map_err(slides::user_message)?;
    slides::snapshot(
        ctx.db,
        ctx.encryption,
        &deck.id,
        DeckSnapshotCause::Created,
        &title,
    )
    .await
    .map_err(slides::user_message)?;
    conversations::set_title(ctx.db, ctx.conversation_id, &title)
        .await
        .map_err(slides::user_message)?;
    Ok(serde_json::json!({ "ok": true, "deck_id": deck.id }))
}

async fn add_slide(ctx: &AgentToolContext<'_>, input: AddSlideInput) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let layout =
        Layout::parse(&input.layout).ok_or_else(|| slide_layouts::unknown_layout(&input.layout))?;
    let fields = slide_layouts::validate(layout, &input.fields)?;
    let html = slide_layouts::render(layout, &fields)?;
    let (slide, slide_count) = slides::add_slide(
        ctx.db,
        ctx.encryption,
        &deck.id,
        layout.name(),
        &html,
        input.notes.as_deref().unwrap_or(""),
        input.after_slide_id.as_deref(),
    )
    .await
    .map_err(slides::user_message)?;
    if deck.stage != DeckStage::Slides {
        slides::set_stage(ctx.db, ctx.encryption, &deck.id, DeckStage::Slides)
            .await
            .map_err(slides::user_message)?;
    }
    Ok(serde_json::json!({
        "ok": true,
        "slide_id": slide.id,
        "position": slide.position,
        "slide_count": slide_count,
    }))
}

/// update_slide: the typed fields the call sent, as sent (a `null` removes a
/// field, so the raw arguments are read rather than the parsed input).
fn sent_fields(arguments: &Value) -> serde_json::Map<String, Value> {
    arguments
        .as_object()
        .map(|args| {
            args.iter()
                .filter(|(k, _)| slide_layouts::FIELD_NAMES.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

async fn update_slide(
    ctx: &AgentToolContext<'_>,
    input: UpdateSlideInput,
    arguments: &Value,
) -> Result<Value, String> {
    let changes = sent_fields(arguments);
    if input.layout.is_none() && changes.is_empty() && input.notes.is_none() {
        return Err("update_slide needs at least one field, layout or notes.".to_string());
    }
    let deck = deck_for_chat(ctx).await?;
    let current = deck
        .slides
        .iter()
        .find(|s| s.id == input.slide_id)
        .ok_or_else(|| slide_not_found(&input.slide_id))?;
    let released = input.release_pinned.unwrap_or_default();
    let mut changes_to_store = slides::SlideChanges {
        notes: input.notes,
        ..Default::default()
    };
    if input.layout.is_some() || !changes.is_empty() {
        let target_name = input.layout.unwrap_or_else(|| current.layout.clone());
        let target = Layout::parse(&target_name).ok_or_else(|| {
            if target_name == current.layout {
                format!(
                    "This slide's layout \"{target_name}\" is not one of the layouts; pass layout (one of {}) with all its fields, or change its html with patch_slide.",
                    slide_layouts::LAYOUT_NAMES.join(", ")
                )
            } else {
                slide_layouts::unknown_layout(&target_name)
            }
        })?;
        let html = if target == Layout::Custom {
            let fields: SlideFields = serde_json::from_value(Value::Object(changes))
                .map_err(|e| format!("invalid arguments for update_slide: {e}"))?;
            if fields.present_names().is_empty() && current.layout == target.name() {
                None
            } else {
                let fields = slide_layouts::validate(target, &fields)?;
                let html = fields.html.unwrap_or_default();
                Some(slide_html::check_pinned_kept(
                    &current.html,
                    &html,
                    &released,
                )?)
            }
        } else {
            let base = slide_layouts::reconstruct(&current.layout, &current.html);
            let from_fields = base.is_some();
            let merged = slide_layouts::merge_fields(&base.unwrap_or_default(), target, &changes)?;
            let fields = slide_layouts::validate(target, &merged).map_err(|e| {
                if from_fields {
                    e
                } else {
                    format!(
                        "This slide was not built from fields, so pass every field for layout {}. {e}",
                        target.name()
                    )
                }
            })?;
            let html = slide_layouts::render(target, &fields)?;
            Some(slide_layouts::carry_pinned(
                &current.html,
                &html,
                &released,
                target.name(),
            )?)
        };
        changes_to_store.layout = Some(target.name().to_string());
        changes_to_store.html = html;
    }
    let slide = slides::update_slide(
        ctx.db,
        ctx.encryption,
        &deck.id,
        &input.slide_id,
        changes_to_store,
    )
    .await
    .map_err(slides::user_message)?;
    Ok(serde_json::json!({
        "ok": true,
        "slide_id": slide.id,
        "kept_pinned": pinned_slot_names(&slide.html),
    }))
}

/// Names of the pinned (user-written) slots in a slide, so the model's reply
/// can say what it left alone.
fn pinned_slot_names(html: &str) -> Vec<String> {
    let mut names: Vec<String> = slide_html::slots(html)
        .into_iter()
        .filter(|slot| slot.pinned)
        .map(|slot| slot.name)
        .collect();
    names.dedup();
    names
}

async fn patch_slide(ctx: &AgentToolContext<'_>, input: PatchSlideInput) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let slide = deck
        .slides
        .iter()
        .find(|s| s.id == input.slide_id)
        .ok_or_else(|| slide_not_found(&input.slide_id))?;
    let patched = apply_document_edits(&slide.html, &input.edits)?;
    let patched = slide_html::check_pinned_kept(
        &slide.html,
        &patched,
        input.release_pinned.as_deref().unwrap_or(&[]),
    )?;
    let kept_pinned = pinned_slot_names(&patched);
    slides::update_slide(
        ctx.db,
        ctx.encryption,
        &deck.id,
        &slide.id,
        slides::SlideChanges {
            html: Some(patched),
            ..Default::default()
        },
    )
    .await
    .map_err(slides::user_message)?;
    Ok(serde_json::json!({
        "ok": true,
        "slide_id": slide.id,
        "edits_applied": input.edits.len(),
        "kept_pinned": kept_pinned,
    }))
}

async fn move_slide(ctx: &AgentToolContext<'_>, input: MoveSlideInput) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let position = slides::move_slide(
        ctx.db,
        &deck.id,
        &input.slide_id,
        usize::try_from(input.position).unwrap_or(0),
    )
    .await
    .map_err(slides::user_message)?;
    Ok(serde_json::json!({ "ok": true, "slide_id": input.slide_id, "position": position }))
}

async fn delete_slide(
    ctx: &AgentToolContext<'_>,
    input: DeleteSlideInput,
) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let slide_count = slides::delete_slide(ctx.db, &deck.id, &input.slide_id)
        .await
        .map_err(slides::user_message)?;
    Ok(serde_json::json!({ "ok": true, "slide_count": slide_count }))
}

async fn set_theme(ctx: &AgentToolContext<'_>, input: SetThemeInput) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Custom");
    // A model-written theme is saved under its name; it must not take a
    // built-in theme's name, or it would hide behind it in the picker.
    let name = if slides::is_starter_theme(name) {
        format!("{name} (custom)")
    } else {
        name.to_string()
    };
    slides::set_theme(ctx.db, ctx.encryption, &deck.id, &name, &input.css)
        .await
        .map_err(slides::user_message)?;
    Ok(serde_json::json!({ "ok": true }))
}

async fn replace_in_deck(
    ctx: &AgentToolContext<'_>,
    input: ReplaceInDeckInput,
) -> Result<Value, String> {
    let deck = deck_for_chat(ctx).await?;
    let report = slides::replace_in_deck(
        ctx.db,
        ctx.encryption,
        &deck.id,
        &input.find,
        &input.replace,
        input.match_case.unwrap_or(false),
        input.whole_word.unwrap_or(false),
        true,
    )
    .await
    .map_err(slides::user_message)?;
    let per_slide: Vec<Value> = report
        .result
        .slides
        .iter()
        .map(|s| serde_json::json!({ "slide_id": s.slide_id, "count": s.count + s.notes_count }))
        .collect();
    let pinned: Vec<Value> = report
        .pinned_changed
        .iter()
        .map(|(slide_id, slot)| serde_json::json!({ "slide_id": slide_id, "slot": slot }))
        .collect();
    Ok(serde_json::json!({
        "ok": true,
        "total": report.result.total,
        "slides": per_slide,
        "pinned_changed": pinned,
    }))
}

async fn update_slots(
    ctx: &AgentToolContext<'_>,
    input: UpdateSlotsInput,
) -> Result<Value, String> {
    if input.edits.is_empty() {
        return Err("update_slots needs at least one edit.".to_string());
    }
    let deck = deck_for_chat(ctx).await?;
    let updates: Vec<slides::SlotUpdate> = input
        .edits
        .into_iter()
        .map(|e| slides::SlotUpdate {
            slide_id: e.slide_id,
            name: e.slot,
            occurrence: e.index.unwrap_or(0),
            html: e.html,
        })
        .collect();
    let outcome = slides::update_slots(ctx.db, ctx.encryption, &deck.id, &updates)
        .await
        .map_err(slides::user_message)?;
    let skipped: Vec<Value> = outcome
        .skipped_pinned
        .iter()
        .map(|(slide_id, slot)| serde_json::json!({ "slide_id": slide_id, "slot": slot }))
        .collect();
    Ok(serde_json::json!({
        "ok": true,
        "updated": outcome.updated,
        "skipped_pinned": skipped,
    }))
}

// -----------------------------------------------------------------------------
// Draft tools
// -----------------------------------------------------------------------------

const READ_DRAFT_DESCRIPTION: &str = "Read the draft you are writing. Returns the title, stage, brief, outline (heading, intent, target_words) and the draft's blocks in order, each with its id, kind, owner (ai, user or mixed), pinned flag and Markdown text. from_block and to_block (block ids, both included) read a range; without them the whole draft comes back, cut at about 60,000 characters with a note saying where to continue. A pinned block holds text the user wrote: keep it word for word.";
const SET_OUTLINE_DESCRIPTION: &str = "Propose the draft's outline: 2 to 12 sections in order, each with a heading, its intent (one sentence on what the section does for the reader) and an optional target_words. Replaces the whole outline. The user reviews and edits it, and approves it before anything is written, so stop after proposing it. Pass title with the first outline: a short name for the draft (120 characters at most).";
const WRITE_SECTION_DESCRIPTION: &str = "Write one section of the draft in Markdown. heading is the section's heading from the outline; markdown is the section (it may start with its \"## heading\" line, which is added when missing). Replaces everything under that ## heading up to the next ## heading, or adds the section where the outline puts it. Write one section per call, then stop: the result lists the sections still to write in remaining, and you will be asked for the next one. Pinned blocks (text the user wrote) inside the section must stay word for word: the call is rejected otherwise.";
const EDIT_BLOCKS_DESCRIPTION: &str = "Replace the Markdown of blocks by id: for the user's selection actions (rewrite, shorten, expand, clarify, fix grammar) and other targeted edits. Each edit gives block_id and the block's new markdown; an empty markdown deletes the block, and markdown holding several blocks splits it. Edits to pinned blocks (text the user wrote) are rejected unless their id is in release_pinned. Pass release_pinned only for blocks the user's message asks you to change, such as a selection they chose an action on; a request to rewrite or polish the whole draft does not release them.";
const REPLACE_IN_DRAFT_DESCRIPTION: &str = "Swap an exact word or phrase everywhere in the draft in one step. Use it only for a swap the user asked for across the draft. It also changes pinned blocks, because the user named the word, and reports them in pinned_changed. match_case and whole_word default to false.";

fn read_draft_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "from_block": { "type": "string", "description": "First block id to return (default the first block)." },
            "to_block": { "type": "string", "description": "Last block id to return, included (default the last block)." },
        },
    })
}

fn set_outline_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": { "type": "string", "description": "The section's heading (120 characters at most)." },
                        "intent": { "type": "string", "description": "What the section does for the reader, in one sentence." },
                        "target_words": { "type": "integer", "description": "Planned length in words." },
                    },
                    "required": ["heading", "intent"],
                },
                "description": "2 to 12 sections, in order."
            },
            "title": {
                "type": "string",
                "description": "A short name for the draft (120 characters at most). Pass it with the first outline; it renames the draft and its chat."
            },
        },
        "required": ["sections"],
    })
}

fn write_section_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "heading": { "type": "string", "description": "The section's heading, as in the outline." },
            "markdown": { "type": "string", "description": "The section in Markdown." },
        },
        "required": ["heading", "markdown"],
    })
}

fn edit_blocks_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "block_id": { "type": "string" },
                        "markdown": { "type": "string", "description": "The block's new Markdown; empty deletes the block." },
                    },
                    "required": ["block_id", "markdown"],
                },
            },
            "release_pinned": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Ids of pinned blocks you may change. Only blocks the user asked you to change."
            },
        },
        "required": ["edits"],
    })
}

fn replace_in_draft_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "find": { "type": "string", "description": "The exact word or phrase to find (200 characters at most)." },
            "replace": { "type": "string", "description": "What to put in its place (200 characters at most)." },
            "match_case": { "type": "boolean", "description": "Match upper and lower case exactly. Default false." },
            "whole_word": { "type": "boolean", "description": "Only match whole words. Default false." },
        },
        "required": ["find", "replace"],
    })
}

/// The draft written in this chat, or the message to give the model when none is.
async fn draft_for_chat(ctx: &AgentToolContext<'_>) -> Result<drafts::Loaded, String> {
    drafts::load_by_conversation(ctx.db, ctx.encryption, ctx.conversation_id)
        .await
        .map_err(drafts::user_message)?
        .ok_or_else(|| "This chat isn't attached to a draft.".to_string())
}

fn block_position(draft: &drafts::Loaded, id: &str) -> Result<usize, String> {
    draft.blocks.iter().position(|b| b.id == id).ok_or_else(|| {
        format!("No block '{id}' in this draft. Call read_draft to see the block ids.")
    })
}

fn owner_name(owner: BlockOwner) -> &'static str {
    match owner {
        BlockOwner::Ai => "ai",
        BlockOwner::User => "user",
        BlockOwner::Mixed => "mixed",
    }
}

async fn read_draft(ctx: &AgentToolContext<'_>, input: ReadDraftInput) -> Result<Value, String> {
    let draft = draft_for_chat(ctx).await?;
    let from = match &input.from_block {
        Some(id) => block_position(&draft, id)?,
        None => 0,
    };
    let to = match &input.to_block {
        Some(id) => block_position(&draft, id)? + 1,
        None => draft.blocks.len(),
    };
    if to < from {
        return Err("to_block comes before from_block in the draft.".to_string());
    }
    let mut blocks = Vec::new();
    let mut chars = 0usize;
    let mut cut_at: Option<&str> = None;
    for block in &draft.blocks[from..to] {
        let text = draft.block_text(block);
        let len = text.chars().count();
        if !blocks.is_empty() && chars + len > READ_DRAFT_MAX_CHARS {
            cut_at = Some(&block.id);
            break;
        }
        chars += len;
        blocks.push(serde_json::json!({
            "id": block.id,
            "kind": block.kind,
            "owner": owner_name(block.owner),
            "pinned": block.pinned,
            "text": text,
        }));
    }
    let outline: Vec<Value> = draft
        .outline
        .iter()
        .map(|s| {
            serde_json::json!({
                "heading": s.heading,
                "intent": s.intent,
                "target_words": s.target_words,
            })
        })
        .collect();
    let mut out = serde_json::json!({
        "title": draft.title,
        "stage": draft.stage.as_str(),
        "brief": draft.brief,
        "outline": outline,
        "words": draft.words(),
        "block_count": draft.blocks.len(),
        "blocks": blocks,
    });
    if let Some(id) = cut_at {
        out["note"] = Value::String(format!(
            "Cut before block {id} to stay under {READ_DRAFT_MAX_CHARS} characters; call read_draft with from_block: \"{id}\" to read on."
        ));
    }
    Ok(out)
}

async fn set_outline(ctx: &AgentToolContext<'_>, input: SetOutlineInput) -> Result<Value, String> {
    let draft = draft_for_chat(ctx).await?;
    let sections: Vec<OutlineSection> = input
        .sections
        .into_iter()
        .map(|s| OutlineSection {
            heading: s.heading,
            intent: s.intent,
            target_words: s
                .target_words
                .filter(|w| w.is_finite() && *w >= 1.0)
                .map(|w| w.round().min(f64::from(u32::MAX)) as u32),
        })
        .collect();
    let detail = drafts::model_set_outline(
        ctx.db,
        ctx.encryption,
        &draft,
        sections,
        input.title.as_deref(),
    )
    .await
    .map_err(drafts::user_message)?;
    Ok(serde_json::json!({
        "ok": true,
        "sections": detail.outline.len(),
        "title": detail.title,
    }))
}

fn model_edit_json(edit: &drafts::ModelEdit) -> Value {
    serde_json::json!({
        "ok": true,
        "changed": edit.changed,
        "added": edit.added,
        "removed": edit.removed,
        "kept_pinned": edit.kept_pinned,
        "words": edit.words,
    })
}

async fn write_section(
    ctx: &AgentToolContext<'_>,
    input: WriteSectionInput,
) -> Result<Value, String> {
    let draft = draft_for_chat(ctx).await?;
    let written = drafts::model_write_section(
        ctx.db,
        ctx.encryption,
        &draft,
        &input.heading,
        &input.markdown,
    )
    .await
    .map_err(drafts::user_message)?;
    let mut out = model_edit_json(&written.edit);
    out["heading"] = Value::String(input.heading.trim().to_string());
    out["section_blocks"] = serde_json::json!(written.section);
    out["remaining"] = serde_json::json!(written.remaining);
    Ok(out)
}

async fn edit_blocks(ctx: &AgentToolContext<'_>, input: EditBlocksInput) -> Result<Value, String> {
    let draft = draft_for_chat(ctx).await?;
    let edits: Vec<(String, String)> = input
        .edits
        .into_iter()
        .map(|e| (e.block_id, e.markdown))
        .collect();
    let edit = drafts::model_edit_blocks(
        ctx.db,
        ctx.encryption,
        &draft,
        &edits,
        input.release_pinned.as_deref().unwrap_or(&[]),
    )
    .await
    .map_err(drafts::user_message)?;
    Ok(model_edit_json(&edit))
}

async fn replace_in_draft(
    ctx: &AgentToolContext<'_>,
    input: ReplaceInDraftInput,
) -> Result<Value, String> {
    let draft = draft_for_chat(ctx).await?;
    let outcome = drafts::model_replace(
        ctx.db,
        ctx.encryption,
        &draft,
        &input.find,
        &input.replace,
        input.match_case.unwrap_or(false),
        input.whole_word.unwrap_or(false),
    )
    .await
    .map_err(drafts::user_message)?;
    let blocks: Vec<Value> = outcome
        .blocks
        .iter()
        .map(|(id, count)| serde_json::json!({ "block_id": id, "count": count }))
        .collect();
    Ok(serde_json::json!({
        "ok": true,
        "total": outcome.total,
        "blocks": blocks,
        "pinned_changed": outcome.pinned_changed,
        "words": outcome.words,
    }))
}

#[derive(Debug, Deserialize)]
struct ReadDraftInput {
    from_block: Option<String>,
    to_block: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetOutlineInput {
    sections: Vec<OutlineSectionInput>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OutlineSectionInput {
    heading: String,
    #[serde(default)]
    intent: String,
    target_words: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct WriteSectionInput {
    heading: String,
    markdown: String,
    // `more_to_write` is no longer in the schema; a model that still sends it
    // is not refused (unknown fields are ignored).
}

#[derive(Debug, Deserialize)]
struct EditBlocksInput {
    edits: Vec<BlockEditInput>,
    release_pinned: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct BlockEditInput {
    block_id: String,
    #[serde(default)]
    markdown: String,
}

#[derive(Debug, Deserialize)]
struct ReplaceInDraftInput {
    find: String,
    replace: String,
    match_case: Option<bool>,
    whole_word: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ReplaceInDeckInput {
    find: String,
    replace: String,
    match_case: Option<bool>,
    whole_word: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpdateSlotsInput {
    edits: Vec<SlotUpdateInput>,
}

#[derive(Debug, Deserialize)]
struct SlotUpdateInput {
    slide_id: String,
    slot: String,
    index: Option<usize>,
    html: String,
}

#[derive(Debug, Deserialize)]
struct ReadDeckInput {
    slide_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetStorylineInput {
    lines: Vec<String>,
    title: Option<String>,
    assumptions: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StartDeckInput {
    title: String,
}

#[derive(Debug, Deserialize)]
struct AddSlideInput {
    layout: String,
    notes: Option<String>,
    after_slide_id: Option<String>,
    #[serde(flatten)]
    fields: SlideFields,
}

/// update_slide's own arguments; its slide fields are read from the raw
/// arguments (see `sent_fields`).
#[derive(Debug, Deserialize)]
struct UpdateSlideInput {
    slide_id: String,
    layout: Option<String>,
    notes: Option<String>,
    release_pinned: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PatchSlideInput {
    slide_id: String,
    edits: Vec<DocumentEdit>,
    release_pinned: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MoveSlideInput {
    slide_id: String,
    position: i64,
}

#[derive(Debug, Deserialize)]
struct DeleteSlideInput {
    slide_id: String,
}

#[derive(Debug, Deserialize)]
struct SetThemeInput {
    css: String,
    name: Option<String>,
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

/// One `patch_document` replacement.
#[derive(Debug, Clone, Deserialize)]
pub struct DocumentEdit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Deserialize)]
struct PatchDocumentInput {
    artifact_id: String,
    edits: Vec<DocumentEdit>,
}

#[derive(Debug, Deserialize)]
struct ReadDocumentInput {
    artifact_id: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
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

#[derive(Debug, Deserialize)]
struct GenerateImageInput {
    prompt: String,
    size: Option<String>,
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

#[derive(Debug, Deserialize)]
struct RememberInput {
    fact: String,
    kind: Option<String>,
}

async fn remember_fact(ctx: &AgentToolContext<'_>, input: RememberInput) -> Result<Value, String> {
    let kind = match input.kind.as_deref().unwrap_or("core") {
        "core" => crate::db::repository::memory::MemoryKind::Core,
        "note" => crate::db::repository::memory::MemoryKind::Note,
        other => return Err(format!("unknown memory kind {other:?}")),
    };
    let item = crate::db::repository::memory::create(
        ctx.db,
        ctx.encryption,
        crate::db::repository::memory::NewMemory {
            kind,
            body: input.fact,
            source_conversation_id: Some(ctx.conversation_id.to_string()),
            pinned: false,
            status: crate::db::repository::memory::MemoryStatus::Pending,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "memoryId": item.id,
        "status": "pending",
        "kind": item.kind.as_str(),
        "message": "Queued for the user to save in Settings → Memory. It will not be used until they save it.",
    }))
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

pub use crate::search::{parse_duckduckgo_instant_answer, EMPTY_INSTANT_ANSWER_NOTE};

/// Shape the tool result the model sees. Empty results include `empty_note`
/// so the agent stops retrying.
pub fn web_search_tool_output(query: &str, results: Vec<serde_json::Value>) -> serde_json::Value {
    web_search_tool_output_with_note(query, results, EMPTY_INSTANT_ANSWER_NOTE)
}

pub fn web_search_tool_output_with_note(
    query: &str,
    results: Vec<serde_json::Value>,
    empty_note: &str,
) -> serde_json::Value {
    if results.is_empty() {
        serde_json::json!({
            "ok": true,
            "query": query,
            "results": results,
            "note": empty_note,
        })
    } else {
        serde_json::json!({
            "ok": true,
            "query": query,
            "results": results,
        })
    }
}

// -------------------------------------------------------------------------
// Helper: web fetch (HTTP GET)
// -------------------------------------------------------------------------

/// Readable text of one page, through the same checked network path as the
/// workflow "Fetch page" step ([`crate::web_page`]): public https only, so a
/// page that tells the model to fetch a local or private address gets nothing.
async fn web_fetch(url: &str) -> Result<crate::web_page::Page, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported URL scheme: {scheme}")),
    }
    crate::web_page::fetch(
        &crate::web_page::upgrade_to_https(url),
        "chat",
        crate::artifact_network::AddressPolicy::APP,
        WEB_FETCH_MAX_CHARS,
    )
    .await
    .map_err(|e| e.to_string())
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
        assert!(is_builtin_tool_name(REMEMBER_TOOL));
        assert!(is_builtin_tool_name(GENERATE_IMAGE_TOOL));
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
    fn empty_instant_answer_body_parses_to_no_results() {
        let body = serde_json::json!({
            "Abstract": "",
            "AbstractText": "",
            "RelatedTopics": [],
            "Results": []
        });
        assert!(parse_duckduckgo_instant_answer(&body).is_empty());
    }

    #[test]
    fn empty_web_search_output_includes_stop_retry_note() {
        let out = web_search_tool_output("todays news", Vec::new());
        assert_eq!(out.get("ok"), Some(&serde_json::json!(true)));
        assert_eq!(out.get("results"), Some(&serde_json::json!([])));
        assert_eq!(
            out.get("note").and_then(|v| v.as_str()),
            Some(EMPTY_INSTANT_ANSWER_NOTE)
        );
    }

    #[test]
    fn non_empty_web_search_output_omits_note() {
        let results = vec![serde_json::json!({
            "title": "DuckDuckGo",
            "snippet": "A search engine.",
            "url": "https://duckduckgo.com"
        })];
        let out = web_search_tool_output("DuckDuckGo", results);
        assert!(out.get("note").is_none());
        assert_eq!(
            out.get("results")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(1)
        );
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
        // + 1 write_brand_theme (Phase 4)
        // + 5 workspace file tools
        // + 1 ask_user (t1-2)
        // + 1 remember (t1-5)
        // + patch_document + read_document
        // + 1 generate_image (t0-8 M3) = 26
        // + 8 deck tools (Slides) = 34
        // + replace_in_deck + update_slots (Slides phase 2) = 36
        // + start_deck (Slides Studio) = 37
        // + 5 draft tools (Writing) = 42
        assert_eq!(defs.len(), 42);
    }

    #[test]
    fn draft_tools_are_a_registered_writing_group() {
        let names = [
            READ_DRAFT_TOOL,
            SET_OUTLINE_TOOL,
            WRITE_SECTION_TOOL,
            EDIT_BLOCKS_TOOL,
            REPLACE_IN_DRAFT_TOOL,
        ];
        let defs = builtin_tool_definitions();
        for name in names {
            assert!(is_builtin_tool_name(name), "{name} is not builtin");
            let def = defs.iter().find(|d| d.name == name).expect(name);
            assert_eq!(def.display_group.as_deref(), Some("Writing"), "{name}");
            let expected = if name == READ_DRAFT_TOOL {
                PermissionLevel::ReadOnly
            } else {
                PermissionLevel::SideEffectful
            };
            assert_eq!(def.permission_level, Some(expected), "{name}");
            assert_eq!(is_draft_write_tool(name), name != READ_DRAFT_TOOL, "{name}");
            // Never mistaken for a document tool by the turn loop's guardrails.
            assert!(
                !crate::stream_manager::is_document_content_tool(name),
                "{name}"
            );
            assert!(
                !crate::stream_manager::is_document_write_tool(name),
                "{name}"
            );
        }
        assert_eq!(
            defs.iter()
                .filter(|d| d.display_group.as_deref() == Some("Writing"))
                .count(),
            names.len()
        );
    }

    #[test]
    fn deck_tools_are_a_registered_slides_group() {
        let names = [
            READ_DECK_TOOL,
            SET_STORYLINE_TOOL,
            ADD_SLIDE_TOOL,
            UPDATE_SLIDE_TOOL,
            PATCH_SLIDE_TOOL,
            MOVE_SLIDE_TOOL,
            DELETE_SLIDE_TOOL,
            SET_THEME_TOOL,
            REPLACE_IN_DECK_TOOL,
            UPDATE_SLOTS_TOOL,
            START_DECK_TOOL,
        ];
        let defs = builtin_tool_definitions();
        for name in names {
            assert!(is_builtin_tool_name(name), "{name} is not builtin");
            let def = defs.iter().find(|d| d.name == name).expect(name);
            assert_eq!(def.display_group.as_deref(), Some("Slides"), "{name}");
            let expected = if name == READ_DECK_TOOL {
                PermissionLevel::ReadOnly
            } else {
                PermissionLevel::SideEffectful
            };
            assert_eq!(def.permission_level, Some(expected), "{name}");
        }
        assert_eq!(
            defs.iter()
                .filter(|d| d.display_group.as_deref() == Some("Slides"))
                .count(),
            names.len()
        );
    }

    /// The deck tools' descriptions and schemas, exactly as the TS mirror
    /// (agentTools.ts) must have them. The provider receives the TS copy, so
    /// agentToolsParity.test.ts checks it against the same fixture. Run with
    /// UPDATE_DECK_TOOL_FIXTURE=1 to rewrite the fixture after a change here.
    #[test]
    fn deck_tool_schemas_match_the_shared_fixture() {
        let mut map = serde_json::Map::new();
        for def in builtin_tool_definitions()
            .into_iter()
            .filter(|d| d.display_group.as_deref() == Some("Slides"))
        {
            map.insert(
                def.name.clone(),
                serde_json::json!({ "description": def.description, "input_schema": def.input_schema }),
            );
        }
        let actual = Value::Object(map);
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/chat/__fixtures__/deckToolSchemas.json");
        if std::env::var_os("UPDATE_DECK_TOOL_FIXTURE").is_some() {
            let text = serde_json::to_string_pretty(&actual).unwrap() + "\n";
            std::fs::write(&path, text).unwrap();
        }
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            actual, expected,
            "deck tool descriptions or schemas drifted from {}; rerun with UPDATE_DECK_TOOL_FIXTURE=1 and make agentTools.ts match",
            path.display()
        );
    }

    #[test]
    fn layout_enum_matches_the_builder() {
        let schema = add_slide_schema();
        let names: Vec<&str> = schema["properties"]["layout"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(names, slide_layouts::LAYOUT_NAMES);
        for name in names {
            assert!(Layout::parse(name).is_some(), "{name}");
            assert!(slides::validate_layout(name).is_ok(), "{name}");
        }
        let props = schema["properties"].as_object().unwrap();
        for field in slide_layouts::FIELD_NAMES {
            assert!(props.contains_key(field), "add_slide schema lacks {field}");
            assert!(
                update_slide_schema()["properties"].get(field).is_some(),
                "update_slide schema lacks {field}"
            );
        }
    }

    #[test]
    fn clip_chars_cuts_on_characters() {
        assert_eq!(clip_chars("short", 10), "short");
        assert_eq!(clip_chars("héllo wörld", 6), "héllo…");
    }
}
