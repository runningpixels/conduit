use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

// =============================================================================
// Message and Content Types
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/message_role.ts"
)]
pub enum MessageRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/message_part_kind.ts"
)]
pub enum MessagePartKind {
    Text,
    ToolCall,
    ToolResult,
    ArtifactReference,
    AttachmentReference,
    Reasoning,
    Image,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/message_part.ts"
)]
pub struct MessagePart {
    pub id: String,
    pub message_id: String,
    pub index: u32,
    pub kind: MessagePartKind,
    #[ts(optional)]
    pub content: Option<String>,
    #[ts(optional)]
    pub mime_type: Option<String>,
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    #[ts(optional)]
    pub artifact_id: Option<String>,
    #[ts(optional)]
    pub attachment_id: Option<String>,
    #[ts(optional)]
    pub blob_ref: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/message.ts"
)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    #[ts(optional)]
    pub author_label: Option<String>,
    #[ts(optional)]
    pub provider_message_id: Option<String>,
    /// Stream `request_id` for assistant turns; used to replay rich UI from the event log.
    #[ts(optional)]
    pub request_id: Option<String>,
    // `interrupted_at` is nullable (always emitted, `null` when uninterrupted)
    // rather than merely optional — the shell distinguishes "field absent" from
    // "message was never interrupted".
    #[ts(optional)]
    pub interrupted_at: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<serde_json::Value>,
    pub parts: Vec<MessagePart>,
    pub created_at: String,
}

/// A conversation row. Phase 3 local persistence; `cloud_id` and `sync_state`
/// are nullable so local-only operation never depends on cloud concepts
/// (Phase 7 fills them).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/conversation.ts"
)]
pub struct Conversation {
    pub id: String,
    #[ts(optional)]
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[ts(optional)]
    pub cloud_id: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<serde_json::Value>,
}

/// A history-rail entry: a conversation plus enough derived state (message
/// count, last message preview) to render without a second round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/conversation_summary.ts"
)]
pub struct ConversationSummary {
    pub id: String,
    #[ts(optional)]
    pub title: Option<String>,
    /// Display-ready label for the history rail: explicit title, else the first
    /// words of the first user prompt, else `"Untitled chat"`.
    pub display_title: String,
    pub updated_at: String,
    pub message_count: u32,
    #[ts(optional)]
    pub last_message_preview: Option<String>,
    /// If this conversation is a fork of another, the source conversation's id.
    #[ts(optional)]
    pub forked_from_conversation_id: Option<String>,
}

// =============================================================================
// Provider Request/Response Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tool_choice.ts"
)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Specific { tool_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/generation_controls.ts"
)]
pub struct GenerationControls {
    #[ts(optional)]
    pub temperature: Option<f32>,
    #[ts(optional)]
    pub top_p: Option<f32>,
    #[ts(optional)]
    pub max_tokens: Option<u32>,
    #[ts(optional)]
    pub stop_sequences: Option<Vec<String>>,
    #[ts(optional)]
    pub tool_choice: Option<ToolChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/response_format_hint.ts"
)]
pub struct ResponseFormatHint {
    pub kind: String, // "text" | "json" | "structured"
    #[ts(optional)]
    pub schema_name: Option<String>,
}

// =============================================================================
// Agent Web Search — hosted-tool request types (Phase 7 / M-WebSearch)
//
// Conduit does not crawl, index, or proxy
// the web; web search is a provider-hosted tool. The renderer carries the
// per-turn config in `ProviderRequest.web_search`; the adapter decides how to
// serialize it (e.g. OpenAI's Responses API uses `{"type":"web_search", ...}`
// rather than a function tool).
// =============================================================================

/// How much search-result context the model sees before generating a response.
/// Provider-specific; the adapter maps it onto the hosted tool's wire field
/// (OpenAI: `search_context_size` on the `web_search` tool object).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/search_context_size.ts"
)]
pub enum SearchContextSize {
    Low,
    Medium,
    High,
}

/// Returned-token budget for hosted web search. GPT-5+ reasoning only on
/// OpenAI's hosted `web_search`; other providers may ignore. `Default` matches
/// the provider's standard returned-token cap; `Unlimited` removes it for
/// long research runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/return_token_budget.ts"
)]
pub enum ReturnTokenBudget {
    #[default]
    Default,
    Unlimited,
}

/// Domain allow/block filters for hosted web search. Each list is bounded by
/// the provider (OpenAI: up to 100 entries). Domain entries omit the
/// `http(s)://` prefix; validation lives at the trust boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/web_search_filters.ts"
)]
pub struct WebSearchFilters {
    #[ts(optional)]
    pub allowed_domains: Option<Vec<String>>,
    #[ts(optional)]
    pub blocked_domains: Option<Vec<String>>,
}

/// Approximate user location for hosted web search localization. `country` is
/// ISO 3166-1 alpha-2 (e.g. "GB"). `city`/`region` are free-form strings; the
/// provider treats them as hints.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/user_location.ts"
)]
pub struct UserLocation {
    pub country: String,
    #[ts(optional)]
    pub city: Option<String>,
    #[ts(optional)]
    pub region: Option<String>,
}

/// Per-turn web search configuration. Adapters serialize this onto the
/// provider's hosted-search tool object (e.g. OpenAI's `web_search` tool).
///
/// `enabled = true` injects the hosted tool into the request. The remaining
/// fields are forwarded as-is; the provider validates the shape and rejects
/// malformed entries in-band (the OpenAI parser already surfaces them as
/// `ProviderEvent::Error`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/web_search_request.ts"
)]
pub struct WebSearchRequest {
    pub enabled: bool,
    #[ts(optional)]
    pub search_context_size: Option<SearchContextSize>,
    #[ts(optional)]
    pub filters: Option<WebSearchFilters>,
    #[ts(optional)]
    pub external_web_access: Option<bool>,
    #[ts(optional)]
    pub return_token_budget: Option<ReturnTokenBudget>,
    #[ts(optional)]
    pub user_location: Option<UserLocation>,
    /// When true, ask the provider to return sources via
    /// `include: ["web_search_call.action.sources"]`. UI defaults to false;
    /// providers may rate-limit or charge more for sources.
    #[ts(optional)]
    pub include_sources: Option<bool>,
}

/// Agent loop guardrails stored on `AppSettings`. Enforced by
/// `run_agent_turn` in the desktop stream manager.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/agent_guardrails.ts"
)]
pub struct AgentGuardrails {
    /// Maximum provider rounds (tool-call + continuation cycles) per user message.
    #[serde(default = "default_agent_max_steps")]
    pub max_steps: u32,
    /// Wall-clock time limit in seconds for a single agent turn.
    #[serde(default = "default_agent_wall_clock_secs")]
    pub wall_clock_budget_secs: u32,
}

fn default_agent_max_steps() -> u32 {
    25
}

fn default_agent_wall_clock_secs() -> u32 {
    300
}

impl Default for AgentGuardrails {
    fn default() -> Self {
        Self {
            max_steps: default_agent_max_steps(),
            wall_clock_budget_secs: default_agent_wall_clock_secs(),
        }
    }
}

/// Persistent web search defaults, stored on `AppSettings`. Per-turn overrides
/// on `ProviderRequest.web_search` win.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/web_search_defaults.ts"
)]
pub struct WebSearchDefaults {
    #[serde(default = "default_search_context_size")]
    pub search_context_size: SearchContextSize,
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    #[serde(default)]
    pub blocked_domains: Vec<String>,
    #[serde(default = "default_true")]
    pub external_web_access: bool,
    #[serde(default)]
    pub return_token_budget: ReturnTokenBudget,
    #[serde(default)]
    #[ts(optional)]
    pub user_location: Option<UserLocation>,
    #[serde(default)]
    pub include_sources: bool,
}

fn default_search_context_size() -> SearchContextSize {
    SearchContextSize::Medium
}

impl Default for WebSearchDefaults {
    fn default() -> Self {
        Self {
            search_context_size: SearchContextSize::Medium,
            allowed_domains: Vec::new(),
            blocked_domains: Vec::new(),
            external_web_access: true,
            return_token_budget: ReturnTokenBudget::Default,
            user_location: None,
            include_sources: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/provider_request.ts"
)]
pub struct ProviderRequest {
    pub request_id: String,
    pub conversation_id: String,
    pub model_id: String,
    pub messages: Vec<Message>,
    #[ts(optional)]
    pub system_prompt: Option<String>,
    #[ts(optional)]
    pub developer_prompt: Option<String>,
    #[ts(optional)]
    pub attachments: Option<Vec<String>>,
    pub tool_definitions: Vec<ToolDefinition>,
    #[ts(optional)]
    pub generation_controls: Option<GenerationControls>,
    #[ts(optional)]
    pub response_format: Option<ResponseFormatHint>,
    /// Agent web search (Phase 7). Per-turn config; the adapter decides how to
    /// serialize it onto the provider's hosted-search tool. Absent means "no
    /// web search on this turn" regardless of `AppSettings.web_search_enabled`.
    #[ts(optional)]
    pub web_search: Option<WebSearchRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/provider_usage.ts"
)]
pub struct ProviderUsage {
    #[ts(optional)]
    pub input_tokens: Option<u64>,
    #[ts(optional)]
    pub output_tokens: Option<u64>,
    #[ts(optional)]
    pub cache_tokens: Option<u64>,
    /// Cache read (hit) tokens — separate from `cache_tokens` for cost estimation.
    #[ts(optional)]
    pub cache_read_tokens: Option<u64>,
    /// Cache write (creation) tokens — separate from `cache_tokens` for cost estimation.
    #[ts(optional)]
    pub cache_write_tokens: Option<u64>,
    #[ts(optional)]
    pub cost_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/provider_error.ts"
)]
pub struct ProviderError {
    #[ts(optional)]
    pub provider_code: Option<String>,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/provider_event.ts"
)]
pub enum ProviderEvent {
    MessageStart {
        request_id: String,
        index: usize,
    },
    ContentBlockStart {
        request_id: String,
        block_id: String,
        index: usize,
        block_kind: String,
    },
    ContentDelta {
        request_id: String,
        block_id: String,
        index: usize,
        content: String,
    },
    ReasoningDelta {
        request_id: String,
        block_id: String,
        index: usize,
        content: String,
    },
    ContentBlockStop {
        request_id: String,
        block_id: String,
        index: usize,
    },
    ToolCallStart {
        request_id: String,
        tool_call_id: String,
        index: usize,
        tool_id: String,
        name: String,
    },
    ToolCallDelta {
        request_id: String,
        tool_call_id: String,
        index: usize,
        content: String,
    },
    ToolCallComplete {
        request_id: String,
        tool_call_id: String,
        index: usize,
        #[ts(type = "Record<string, unknown>")]
        arguments: serde_json::Value,
    },
    Usage {
        request_id: String,
        usage: ProviderUsage,
    },
    Ping {
        request_id: String,
    },
    MessageComplete {
        request_id: String,
        index: usize,
        finish_reason: String,
    },
    Error {
        request_id: String,
        error: ProviderError,
    },
    // ---------------------------------------------------------------------
    // Agent web search events (Phase 7 / M-WebSearch).
    //
    // Hosted web search runs as a provider-native output item. Adapters map
    // the provider's items onto Conduit's envelope:
    //   - `web_search_call` items → ToolCallStart/Delta/Complete with
    //     tool_id="web_search" (so the renderer reuses ToolCallBlock).
    //   - `url_citation` annotations on `output_text` → Citation events
    //     bound to the originating ContentBlock.
    //   - `web_search_call.action.sources` (when `include_sources` is true)
    //     → SearchSources with the raw source list.
    //   - Per-call tool cost from the provider's usage payload → SearchCost.
    //   - When the adapter silently strips the hosted tool because the
    //     endpoint does not support it → SearchUnavailable, surfaced to the
    //     UI so it can render an explicit "not supported" state instead of
    //     silently losing search.
    // ---------------------------------------------------------------------
    SearchSources {
        request_id: String,
        index: usize,
        /// Pass-through raw sources from `web_search_call.action.sources`.
        /// The renderer shapes for display; the adapter does not parse.
        #[ts(type = "Array<Record<string, unknown>>")]
        sources: serde_json::Value,
    },
    Citation {
        request_id: String,
        /// Block the citation is attached to. The renderer walks these in
        /// `start_index`/`end_index` order and inserts inline `[n]` markers.
        block_id: String,
        index: usize,
        annotation: ContentAnnotation,
    },
    SearchCost {
        request_id: String,
        index: usize,
        /// Number of web_search tool calls the model issued in this response.
        tool_calls: u32,
    },
    SearchUnavailable {
        request_id: String,
        index: usize,
        /// Why the hosted search tool was stripped or refused. Stable codes
        /// the renderer can branch on; `message` is human-readable.
        code: String,
        message: String,
    },
    // ---------------------------------------------------------------------
    // Agent loop phase events (Phase 1 — Agent Feedback & Status UI).
    //
    // These are emitted by the Rust agent loop (`run_agent_turn` in
    // stream_manager.rs) to communicate phase transitions to the frontend
    // so the UI can show progress during multi-round tool execution.
    // ---------------------------------------------------------------------
    /// Emitted when the agent loop enters a new phase or round.
    AgentPhase {
        request_id: String,
        /// Human-readable label for the current phase.
        label: String,
        /// Round number (1-based).
        round: u32,
        /// Total rounds or 0 if unknown.
        total_rounds: u32,
        /// Sub-phase identifier: "thinking", "executing_tools", "reviewing", "connecting", "finalizing"
        sub_phase: String,
    },
    /// Emitted when a tool execution starts in the agent loop.
    ToolExecutionStarted {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
    },
    /// Emitted when a tool execution completes.
    ToolExecutionFinished {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
        /// True if the tool execution failed.
        is_error: bool,
        /// Optional error message.
        #[ts(optional)]
        error: Option<String>,
    },
}

/// Annotations attached to a `ContentBlock`. OpenAI's `url_citation` is the
/// first variant; future annotations (file citations, container citations,
/// etc.) ride the same enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/content_annotation.ts"
)]
pub enum ContentAnnotation {
    #[serde(rename_all = "camelCase")]
    UrlCitation {
        url: String,
        title: String,
        #[serde(rename = "startIndex")]
        start_index: u32,
        #[serde(rename = "endIndex")]
        end_index: u32,
    },
}

// =============================================================================
// Tool Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/permission_level.ts"
)]
pub enum PermissionLevel {
    ReadOnly,
    SideEffectful,
    Sensitive,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tool_kind.ts"
)]
pub enum ToolKind {
    /// JSON-schema function tool. Serialized as
    /// `{"type":"function","function":{...}}`. Default for `ToolDefinition`s
    /// without an explicit `kind`.
    Function,
    /// Provider-defined hosted tool. Identified by `tool_id`; the adapter
    /// owns the wire shape. Used for OpenAI's `web_search`, `code_interpreter`,
    /// `file_search`, etc. `host_config` carries provider-agnostic knobs.
    Hosted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tool_definition.ts"
)]
pub struct ToolDefinition {
    pub tool_id: String,
    pub name: String,
    pub description: String,
    #[ts(type = "Record<string, unknown>")]
    pub input_schema: serde_json::Value,
    /// Discriminates function tools from hosted (provider-defined) tools.
    /// Defaults to `Function` on deserialize when absent.
    #[ts(optional)]
    pub kind: Option<ToolKind>,
    /// Hosted-tool options (only meaningful when `kind = Hosted`). Provider-
    /// agnostic JSON blob; the adapter interprets it.
    #[ts(optional, type = "Record<string, unknown>")]
    pub host_config: Option<serde_json::Value>,
    #[ts(optional)]
    pub permission_level: Option<PermissionLevel>,
    #[ts(optional)]
    pub display_group: Option<String>,
    #[ts(optional)]
    pub tenant_scope: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tool_call_status.ts"
)]
pub enum ToolCallStatus {
    Pending,
    Approved,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tool_call_record.ts"
)]
pub struct ToolCallRecord {
    pub id: String,
    pub tool_id: String,
    pub request_id: String,
    pub status: ToolCallStatus,
    #[ts(optional, type = "Record<string, unknown>")]
    pub arguments: Option<serde_json::Value>,
    #[ts(optional, type = "unknown")]
    pub result: Option<serde_json::Value>,
    #[ts(optional)]
    pub error: Option<String>,
    #[ts(optional)]
    pub approved_at: Option<String>,
    #[ts(optional)]
    pub completed_at: Option<String>,
}

// =============================================================================
// Artifact Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/artifact_kind.ts"
)]
pub enum ArtifactKind {
    Markdown,
    Text,
    Code,
    Json,
    Html,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/artifact.ts"
)]
pub struct Artifact {
    pub id: String,
    pub conversation_id: String,
    pub kind: ArtifactKind,
    #[ts(optional)]
    pub title: Option<String>,
    #[ts(optional)]
    pub source_message_id: Option<String>,
    #[ts(optional)]
    pub cloud_share_id: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    #[ts(optional)]
    pub updated_at: Option<String>,
    #[ts(optional)]
    pub mime_type: Option<String>,
    #[ts(optional)]
    pub content_text: Option<String>,
    #[ts(optional, type = "unknown")]
    pub content_json: Option<serde_json::Value>,
    #[ts(optional)]
    pub content_path: Option<String>,
    #[ts(optional)]
    pub content_hash: Option<String>,
    #[ts(optional)]
    pub size_bytes: Option<i64>,
}

// =============================================================================
// Attachment Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/retention_state.ts"
)]
pub enum RetentionState {
    Active,
    Deleted,
    Redacted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/attachment.ts"
)]
pub struct Attachment {
    pub id: String,
    pub conversation_id: String,
    pub path: String,
    pub mime_type: String,
    pub size_bytes: u64,
    #[ts(optional)]
    pub hash: Option<String>,
    #[ts(optional)]
    pub origin: Option<String>,
    #[ts(optional)]
    pub retention_state: Option<RetentionState>,
    pub created_at: String,
}

// =============================================================================
// Tenant and Connector Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tenant_identity.ts"
)]
pub struct TenantIdentity {
    pub app_name: String,
    pub display_name: String,
    #[ts(optional)]
    pub accent_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/model_policy.ts"
)]
pub struct ModelPolicy {
    pub default_model_id: String,
    pub allowed_model_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/tenant_config.ts"
)]
pub struct TenantConfig {
    pub id: String,
    pub version: String,
    pub identity: TenantIdentity,
    pub model_policy: ModelPolicy,
    pub feature_flags: Vec<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub connector_policy: Option<serde_json::Value>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub license_policy: Option<serde_json::Value>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub audit_policy: Option<serde_json::Value>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub cloud_policy: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/transport.ts"
)]
pub enum Transport {
    Stdio,
    HttpSse,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/connector_definition.ts"
)]
pub struct ConnectorDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub transport: Transport,
    pub owner: String,
    #[ts(optional)]
    pub icon: Option<String>,
    #[ts(optional)]
    pub support_url: Option<String>,
    #[ts(optional)]
    pub consent_copy: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub policy_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/rollout_channel.ts"
)]
pub enum RolloutChannel {
    #[default]
    Stable,
    Beta,
    Pinned,
    TenantSpecific,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/support_state.ts"
)]
pub enum SupportState {
    Available,
    Degraded,
    AdminDisabled,
    Revoked,
    Unsupported,
    AuthRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/connector_version.ts"
)]
pub struct ConnectorVersion {
    pub id: String,
    pub connector_id: String,
    pub version: String,
    #[ts(type = "Record<string, unknown>")]
    pub transport_config: serde_json::Value,
    #[ts(optional)]
    pub scope_grants: Option<Vec<String>>,
    #[ts(optional)]
    pub capability_allowlist: Option<Vec<String>>,
    #[ts(optional)]
    pub rollout_channel: Option<RolloutChannel>,
    #[ts(optional)]
    pub support_state: Option<SupportState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/grant_scope.ts"
)]
pub enum GrantScope {
    Tenant,
    Team,
    Seat,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/grant_status.ts"
)]
pub enum GrantStatus {
    Provisioned,
    Active,
    Revoked,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/connector_grant.ts"
)]
pub struct ConnectorGrant {
    pub id: String,
    pub connector_version_id: String,
    pub scope: GrantScope,
    pub status: GrantStatus,
    #[ts(optional)]
    pub credential_ref: Option<String>,
    #[ts(optional)]
    pub approved_by: Option<String>,
    #[ts(optional)]
    pub revoked_at: Option<String>,
    #[ts(optional)]
    pub notes: Option<String>,
}

// =============================================================================
// Phase 4 — MCP runtime / consent IPC shapes
// =============================================================================

/// A user's decision on a pending tool-consent prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/consent_decision.ts"
)]
pub enum ConsentDecision {
    Approved,
    Denied,
}

/// The payload rendered in a tool-consent prompt. Carried by
/// `ConnectorRuntimeEvent::ConsentRequested`. All tenant-authored text
/// (`consent_copy`) and connector output (`arguments`, `data_summary`) is
/// untrusted display data — redacted before it reaches the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/consent_prompt.ts"
)]
pub struct ConsentPrompt {
    pub tool_call_id: String,
    pub connector_version_id: String,
    pub connector_name: String,
    pub tool_name: String,
    #[ts(type = "Record<string, unknown>")]
    pub arguments: serde_json::Value,
    pub expected_effect: String,
    pub data_summary: String,
    #[ts(optional)]
    pub consent_copy: Option<String>,
}

/// Streamed runtime events for a connector lifecycle / tool execution, sent
/// over a per-request Tauri `Channel<ConnectorRuntimeEvent>` (the Phase 1
/// "connector runtime status" + "tool execution status" channel uses).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/connector_runtime_event.ts"
)]
pub enum ConnectorRuntimeEvent {
    ConnectorStarted {
        connector_version_id: String,
        server_name: String,
    },
    ConnectorHealthChanged {
        connector_version_id: String,
        health: String,
        #[ts(optional)]
        last_error: Option<String>,
    },
    ConnectorRevoked {
        connector_version_id: String,
    },
    ConsentRequested {
        prompt: ConsentPrompt,
    },
    ToolCallFinished {
        tool_call_id: String,
        status: ToolCallStatus,
        #[ts(optional)]
        is_error: Option<bool>,
        size_bytes: u64,
        mime_hints: Vec<String>,
        #[ts(optional)]
        error: Option<String>,
    },
}

// =============================================================================
// License Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/license_claims.ts"
)]
pub struct LicenseClaims {
    pub tenant_id: String,
    pub seat_id: String,
    pub tier: String,
    pub exp: u64,
    pub config_version: String,
    #[ts(optional)]
    pub feature_flags: Option<Vec<String>>,
    #[ts(optional)]
    pub offline_grace_deadline: Option<u64>,
    #[ts(optional)]
    pub key_set_version: Option<String>,
    #[ts(optional)]
    pub issued_at: Option<u64>,
}

// =============================================================================
// App Shell Configuration (IPC schema shared with the renderer)
// =============================================================================
//
// These are the data shapes that cross the Tauri IPC boundary for settings and
// credentials. They live in the shared schema crate so the renderer's TS is
// generated from the same source as the desktop's Rust (C1). Behavior (defaults,
// validation, keychain access) stays in the desktop crate.

/// `Dark` is the default (see `AppSettings::default`): the app ships a dark
/// look, and `System` would hand a first-run light-mode machine a light window
/// before the user has expressed any preference. `System` stays available and
/// still tracks the OS from the moment it is chosen.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../packages/config-schema/src/generated/theme.ts")]
pub enum Theme {
    System,
    Dark,
    Light,
}

/// Where provider secrets are stored (V9 design spec §2.6).
///
/// `Os` is the default and the only mode with real OS-level protection: the
/// platform keychain guards the secret with the user's login session.
///
/// `File` exists for machines that have no usable keychain — headless CI, a
/// locked-down container, a Linux box with no Secret Service. It is a strictly
/// weaker posture and the app says so. Its key comes from the environment
/// (`CONDUIT_CREDENTIAL_KEY`), never from a file beside the ciphertext: a key
/// stored next to what it encrypts is obfuscation wearing encryption's clothes,
/// and the setting would be misreporting the protection it provides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/keychain_mode.ts"
)]
pub enum KeychainMode {
    #[default]
    Os,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/provider_endpoint_config.ts"
)]
pub struct ProviderEndpointConfig {
    #[ts(optional)]
    pub base_url: Option<String>,
    #[ts(optional)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/app_settings.ts"
)]
pub struct AppSettings {
    pub active_provider: String,
    pub active_model: String,
    pub local_only: bool,
    pub diagnostics_enabled: bool,
    pub theme: Theme,
    #[serde(default)]
    pub provider_endpoints: HashMap<String, ProviderEndpointConfig>,
    /// Phase 5: origins a rendered HTML/JS artifact may load passive resources
    /// (images/fonts/styles) from. Default empty → fully offline artifacts
    /// (`connect-src 'none'`, no remote scripts regardless). Validated as
    /// absolute http(s) URLs on save. See `buildArtifactCsp` + the artifact
    /// rendering security decision record.
    #[serde(default)]
    pub artifact_remote_allowlist: Vec<String>,
    /// Phase 6: whether rendered artifacts (markdown, html, code, json) receive
    /// app-like base styling (typography, spacing, colors) in the preview pane.
    /// Defaults true so previews feel native; user can disable in Settings.
    #[serde(default = "default_true")]
    pub artifact_styled_preview: bool,
    /// Phase 6: which update channel the client checks. Consumer UI only offers
    /// `Stable`/`Beta`; `Pinned`/`TenantSpecific` are reserved for Phase 7/8/9.
    /// Defaults to `Stable`. Drives the updater endpoint URL in `updater.rs`.
    #[serde(default)]
    pub update_channel: RolloutChannel,
    /// Phase 6: whether the app may check for updates. Defaults `true` but is a
    /// checkbox — updates are never automatic; "Check now" is explicit and
    /// `installMode: passive` requires user confirmation before applying.
    #[serde(default = "default_true")]
    pub update_check_enabled: bool,
    /// Phase 6: first-run onboarding completion flag. `false` until the user
    /// finishes the BYOK gate; `App.tsx` renders `<Onboarding>` instead of the
    /// workspace while false (and while no provider credential is configured).
    #[serde(default)]
    pub onboarding_completed: bool,
    /// Phase 7: whether web search is enabled globally. Off by default.
    /// Honored only when the active provider is non-local; ignored when
    /// `local_only` is true (see `agent-web-search` spec).
    #[serde(default)]
    pub web_search_enabled: bool,
    /// Phase 7: persistent web search defaults. Per-turn overrides on
    /// `ProviderRequest.web_search` win.
    #[serde(default)]
    pub web_search: WebSearchDefaults,
    /// Phase 7 / M-WebSearch: first-use consent acknowledgement. `false`
    /// until the user has seen and accepted the one-time consent dialog
    /// for web search. The dialog surfaces when the user first enables
    /// `web_search_enabled` (settings) or flips the per-turn search toggle
    /// (chat bar). The consent copy is untrusted display data that the
    /// renderer renders but never executes.
    #[serde(default)]
    pub web_search_consent_acknowledged: bool,
    /// Agent loop guardrails: max provider rounds and wall-clock budget per turn.
    #[serde(default)]
    pub agent: AgentGuardrails,
    /// V9 §2.6: where provider secrets live. Defaults to the OS keychain; the
    /// file-backed store is an escape hatch for machines without one. Existing
    /// settings files predate the field, so it must default rather than fail
    /// to deserialize.
    #[serde(default)]
    pub keychain_mode: KeychainMode,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            active_provider: "anthropic".to_string(),
            active_model: "claude-sonnet-4".to_string(),
            local_only: true,
            diagnostics_enabled: true,
            theme: Theme::Dark,
            provider_endpoints: HashMap::new(),
            artifact_remote_allowlist: Vec::new(),
            artifact_styled_preview: true,
            update_channel: RolloutChannel::Stable,
            update_check_enabled: true,
            onboarding_completed: false,
            web_search_enabled: false,
            web_search: WebSearchDefaults::default(),
            web_search_consent_acknowledged: false,
            agent: AgentGuardrails::default(),
            keychain_mode: KeychainMode::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/settings_patch.ts"
)]
pub struct SettingsPatch {
    #[ts(optional)]
    pub active_provider: Option<String>,
    #[ts(optional)]
    pub active_model: Option<String>,
    #[ts(optional)]
    pub local_only: Option<bool>,
    #[ts(optional)]
    pub diagnostics_enabled: Option<bool>,
    #[ts(optional)]
    pub theme: Option<Theme>,
    #[ts(optional)]
    pub provider_endpoints: Option<HashMap<String, ProviderEndpointConfig>>,
    /// Replace the artifact remote allowlist. Each entry must be an absolute
    /// http(s) URL or the whole update is rejected.
    #[ts(optional)]
    pub artifact_remote_allowlist: Option<Vec<String>>,
    #[ts(optional)]
    pub artifact_styled_preview: Option<bool>,
    #[ts(optional)]
    pub update_channel: Option<RolloutChannel>,
    #[ts(optional)]
    pub update_check_enabled: Option<bool>,
    #[ts(optional)]
    pub onboarding_completed: Option<bool>,
    /// Phase 7: master web search toggle. The renderer also enforces UI
    /// gating on `local_only` and provider capability.
    #[ts(optional)]
    pub web_search_enabled: Option<bool>,
    /// Phase 7: replace the persistent web search defaults. Each domain-list
    /// entry must be a bare host (no http(s) prefix) and ≤253 chars; entries
    /// are capped at 100 per list (provider limit).
    #[ts(optional)]
    pub web_search: Option<WebSearchDefaults>,
    /// Phase 7 / M-WebSearch: first-use consent acknowledgement.
    #[ts(optional)]
    pub web_search_consent_acknowledged: Option<bool>,
    /// Replace agent loop guardrails. Values are validated on save.
    #[ts(optional)]
    pub agent: Option<AgentGuardrails>,
}

/// A model offered by a provider. Returned by `list_models` over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/model_info.ts"
)]
pub struct ModelInfo {
    pub id: String,
    #[ts(optional)]
    pub display_name: Option<String>,
}

/// Request body for storing a provider secret in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/credential_request.ts"
)]
pub struct CredentialRequest {
    pub provider_id: String,
    pub secret: String,
}

/// Result of a credential lookup/store — never carries the secret itself,
/// only a `keychain://` reference. M2: the keychain is the sole source of truth.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../packages/config-schema/src/generated/credential_summary.ts"
)]
pub struct CredentialSummary {
    pub provider_id: String,
    pub credential_ref: String,
    pub stored_in_keychain: bool,
}
