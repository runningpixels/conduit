//! C1: TypeScript schema generator.
//!
//! Rust is the canonical source of truth for every type that crosses the Tauri
//! IPC boundary. This binary regenerates the TypeScript bindings in
//! `packages/config-schema/src/generated/` from `provider_core::schema`.
//!
//! Run: `cargo run --example export_ts -p provider-core`
//!
//! `packages/config-schema`'s `check` script runs this and then `git diff
//! --exit-code src/generated` — the build fails if the committed bindings have
//! drifted from the Rust source.

use provider_core::schema::{
    AgentGuardrails, AppSettings, Artifact, ArtifactKind, Attachment, ConnectorDefinition,
    ConnectorGrant, ConnectorRuntimeEvent, ConnectorVersion, ConsentDecision, ConsentPrompt,
    ContentAnnotation, Conversation, ConversationSummary, CredentialRequest, CredentialSummary,
    GenerationControls, GrantScope, GrantStatus, KeychainMode, LicenseClaims, Message, MessagePart,
    MessagePartKind, MessageRole, ModelInfo, ModelPolicy, PermissionLevel, ProviderEndpointConfig,
    ProviderError, ProviderEvent, ProviderRequest, ProviderUsage, ResponseFormatHint,
    RetentionState, ReturnTokenBudget, RolloutChannel, SearchContextSize, SettingsPatch,
    SupportState, TenantConfig, TenantIdentity, Theme, ToolCallRecord, ToolCallStatus, ToolChoice,
    ToolDefinition, ToolKind, Transport, UserLocation, WebSearchDefaults, WebSearchFilters,
    WebSearchRequest,
};
use ts_rs::TS;

fn main() {
    // Message & content
    MessageRole::export().expect("export MessageRole");
    MessagePartKind::export().expect("export MessagePartKind");
    MessagePart::export().expect("export MessagePart");
    Message::export().expect("export Message");
    Conversation::export().expect("export Conversation");
    ConversationSummary::export().expect("export ConversationSummary");

    // Provider request/response
    ToolChoice::export().expect("export ToolChoice");
    GenerationControls::export().expect("export GenerationControls");
    ResponseFormatHint::export().expect("export ResponseFormatHint");
    ProviderRequest::export().expect("export ProviderRequest");
    ProviderUsage::export().expect("export ProviderUsage");
    ProviderError::export().expect("export ProviderError");
    ProviderEvent::export().expect("export ProviderEvent");

    // Agent web search (M-WebSearch).
    SearchContextSize::export().expect("export SearchContextSize");
    ReturnTokenBudget::export().expect("export ReturnTokenBudget");
    WebSearchFilters::export().expect("export WebSearchFilters");
    UserLocation::export().expect("export UserLocation");
    WebSearchRequest::export().expect("export WebSearchRequest");
    WebSearchDefaults::export().expect("export WebSearchDefaults");
    ContentAnnotation::export().expect("export ContentAnnotation");

    // Tools
    PermissionLevel::export().expect("export PermissionLevel");
    ToolKind::export().expect("export ToolKind");
    ToolDefinition::export().expect("export ToolDefinition");
    ToolCallStatus::export().expect("export ToolCallStatus");
    ToolCallRecord::export().expect("export ToolCallRecord");

    // Artifacts
    ArtifactKind::export().expect("export ArtifactKind");
    Artifact::export().expect("export Artifact");

    // Attachments
    RetentionState::export().expect("export RetentionState");
    Attachment::export().expect("export Attachment");

    // Tenant & connector
    TenantIdentity::export().expect("export TenantIdentity");
    ModelPolicy::export().expect("export ModelPolicy");
    TenantConfig::export().expect("export TenantConfig");
    Transport::export().expect("export Transport");
    ConnectorDefinition::export().expect("export ConnectorDefinition");
    RolloutChannel::export().expect("export RolloutChannel");
    SupportState::export().expect("export SupportState");
    ConnectorVersion::export().expect("export ConnectorVersion");
    GrantScope::export().expect("export GrantScope");
    GrantStatus::export().expect("export GrantStatus");
    ConnectorGrant::export().expect("export ConnectorGrant");

    // Phase 4 — MCP runtime / consent IPC
    ConsentDecision::export().expect("export ConsentDecision");
    ConsentPrompt::export().expect("export ConsentPrompt");
    ConnectorRuntimeEvent::export().expect("export ConnectorRuntimeEvent");

    // License
    LicenseClaims::export().expect("export LicenseClaims");

    // App shell config
    Theme::export().expect("export Theme");
    KeychainMode::export().expect("export KeychainMode");
    ProviderEndpointConfig::export().expect("export ProviderEndpointConfig");
    AgentGuardrails::export().expect("export AgentGuardrails");
    AppSettings::export().expect("export AppSettings");
    SettingsPatch::export().expect("export SettingsPatch");
    ModelInfo::export().expect("export ModelInfo");
    CredentialRequest::export().expect("export CredentialRequest");
    CredentialSummary::export().expect("export CredentialSummary");

    println!("TypeScript bindings exported to packages/config-schema/src/generated/");
}
