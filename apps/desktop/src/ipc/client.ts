import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AddLocalConnectorRequest,
  AddLocalConnectorResult,
  AppPaths,
  AppSettings,
  Artifact,
  ArtifactContent,
  ArtifactExportResult,
  Attachment,
  CancelChatStreamRequest,
  ConnectorCapability,
  ConnectorDefinition,
  ConnectorGrant,
  ConnectorRuntimeEvent,
  ConnectorRuntimeSnapshot,
  ConnectorServerInfo,
  ConnectorVersion,
  Conversation,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  DiagnosticsExport,
  FileState,
  InvokeConnectorToolRequest,
  Message,
  MockStreamRequest,
  ModelInfo,
  ProviderEvent,
  ProviderRequest,
  SettingsPatch,
  StreamEvent,
  StreamHandle,
  UpdateInfo,
  OnboardingState,
  ProviderDescriptor,
  SearchMessagesRequest,
  SearchResult,
} from './contracts';

export async function getAppPaths(): Promise<AppPaths> {
  return invoke<AppPaths>('get_app_paths');
}

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  return invoke<AppSettings>('update_settings', { patch });
}

export async function saveProviderCredential(request: CredentialRequest): Promise<CredentialSummary> {
  return invoke<CredentialSummary>('save_provider_credential', { request });
}

export async function loadProviderCredentialReference(providerId: string): Promise<CredentialSummary> {
  return invoke<CredentialSummary>('load_provider_credential_reference', { providerId });
}

export async function validateProviderCredentials(providerId: string): Promise<void> {
  await invoke('validate_provider_credentials', { providerId });
}

export async function listProviderDescriptors(): Promise<ProviderDescriptor[]> {
  return invoke<ProviderDescriptor[]>('list_provider_descriptors');
}

export async function listProviderModels(providerId: string): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_provider_models', { providerId });
}

export async function startChatStream(
  request: ProviderRequest,
  onEvent: (event: ProviderEvent) => void,
  onRuntimeEvent?: (event: ConnectorRuntimeEvent) => void,
): Promise<StreamHandle> {
  const channel = new Channel<ProviderEvent>();
  channel.onmessage = onEvent;
  const runtimeChannel = new Channel<ConnectorRuntimeEvent>();
  if (onRuntimeEvent) runtimeChannel.onmessage = onRuntimeEvent;
  return invoke<StreamHandle>('start_chat_stream', { request, channel, runtimeChannel });
}

export async function cancelChatStream(request: CancelChatStreamRequest): Promise<void> {
  await invoke('cancel_chat_stream', { request });
}

export async function getConversationMessages(conversationId: string): Promise<Message[]> {
  return invoke<Message[]>('get_conversation_messages', { conversationId });
}

export async function getRequestProviderEvents(
  conversationId: string,
  requestId: string,
): Promise<ProviderEvent[]> {
  return invoke<ProviderEvent[]>('get_request_provider_events', { conversationId, requestId });
}

export async function createConversation(title?: string): Promise<Conversation> {
  return invoke<Conversation>('create_conversation', { title });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>('list_conversations');
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  return invoke<Conversation | null>('get_conversation', { conversationId });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await invoke('delete_conversation', { conversationId });
}

export async function setConversationTitle(conversationId: string, title: string): Promise<void> {
  await invoke('set_conversation_title', { conversationId, title });
}

export async function deleteAllConversations(): Promise<Conversation> {
  return invoke<Conversation>('delete_all_conversations');
}

export async function exportDiagnostics(): Promise<DiagnosticsExport> {
  return invoke<DiagnosticsExport>('export_diagnostics');
}

// =============================================================================
// Phase 6 M6.5 — Diagnostics export hardening: disclosure gate + reveal.
//
// `getDiagnosticsDisclosureAcknowledged` reads the once-ever disclosure flag
// from raw settings JSON; `acknowledgeDiagnosticsDisclosure` persists it.
// `revealPath` opens a path in the OS file manager (Finder/Explorer) via the
// shell plugin — used to surface the exports folder after a successful export.
// =============================================================================

export async function getDiagnosticsDisclosureAcknowledged(): Promise<boolean> {
  return invoke<boolean>('get_diagnostics_disclosure_acknowledged');
}

export async function acknowledgeDiagnosticsDisclosure(): Promise<void> {
  await invoke('acknowledge_diagnostics_disclosure');
}

/// Reveal the app's exports directory in the OS file manager. Takes no path —
/// the Rust command opens `AppPaths::exports` server-side, so the renderer
/// cannot direct the shell to open an arbitrary path/URL.
export async function revealPath(): Promise<void> {
  await invoke('reveal_path');
}

/// Reveal the artifacts workspace directory in the OS file manager.
/// Path is resolved server-side from `AppPaths::artifacts`.
export async function revealArtifactsDir(): Promise<void> {
  await invoke('reveal_artifacts_dir');
}

/// Reveal a file-backed artifact's parent folder in the OS file manager.
/// The renderer supplies only the artifact id; the path is resolved server-side.
export async function revealArtifact(artifactId: string): Promise<void> {
  await invoke('reveal_artifact', { artifactId });
}

// =============================================================================
// Phase 6 — Consumer release: updater (trust-promise gate)
//
// `checkForUpdate` reads `updateChannel` + `updateCheckEnabled` from settings
// and fetches the per-channel manifest WITHOUT downloading the payload. Returns
// `null` when update checks are disabled or no update is available.
// `downloadAndInstallUpdate` re-checks, runs the Rust-side migration
// precheck on a copy of the local DB, and only then applies the
// signature-verified payload and restarts. Refuses (rejects with a user-safe
// message) if the precheck fails — your local data is never touched by it.
// =============================================================================

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>('check_for_update');
}

export async function downloadAndInstallUpdate(): Promise<void> {
  await invoke('download_and_install_update');
}

// =============================================================================
// Phase 6 M6.4 — First-run onboarding (BYOK gate)
// =============================================================================

/** Boot-time onboarding state. `App.tsx` gates the workspace on this:
 *  migration recovery takes priority, then the BYOK gate (`onboardingCompleted`
 *  + `hasProviderCredential`). */
export async function getOnboardingState(): Promise<OnboardingState> {
  return invoke<OnboardingState>('get_onboarding_state');
}

export async function startMockStream(
  request: MockStreamRequest,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamHandle> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke<StreamHandle>('start_mock_stream', { request, channel });
}

export async function cancelMockStream(requestId: string): Promise<void> {
  await invoke('cancel_mock_stream', { requestId });
}

// =============================================================================
// Phase 4 — MCP connector runtime
// =============================================================================

export async function listConnectorDefinitions(): Promise<ConnectorDefinition[]> {
  return invoke<ConnectorDefinition[]>('list_connector_definitions');
}

export async function listConnectorVersions(connectorId: string): Promise<ConnectorVersion[]> {
  return invoke<ConnectorVersion[]>('list_connector_versions', { connectorId });
}

export async function listConnectorGrants(status?: 'active' | 'revoked' | 'pending' | 'provisioned'): Promise<ConnectorGrant[]> {
  return invoke<ConnectorGrant[]>('list_connector_grants', { status });
}

export async function listConnectorCapabilities(connectorVersionId: string): Promise<ConnectorCapability[]> {
  return invoke<ConnectorCapability[]>('list_connector_capabilities', { connectorVersionId });
}

export async function getConnectorRuntimeStates(): Promise<ConnectorRuntimeSnapshot[]> {
  return invoke<ConnectorRuntimeSnapshot[]>('get_connector_runtime_states');
}

export async function startConnector(connectorVersionId: string): Promise<ConnectorServerInfo> {
  return invoke<ConnectorServerInfo>('start_connector', { connectorVersionId });
}

export async function stopConnector(connectorVersionId: string): Promise<void> {
  await invoke('stop_connector', { connectorVersionId });
}

export async function discoverConnector(connectorVersionId: string): Promise<ConnectorCapability[]> {
  return invoke<ConnectorCapability[]>('discover_connector', { connectorVersionId });
}

/// Invoke a connector tool. Runtime events (consent prompts, completion) stream
/// over the per-call `Channel<ConnectorRuntimeEvent>`; the returned
/// `StreamHandle.requestId` is the `toolCallId`. Consent is resolved via a
/// separate `approveConnectorToolCall` / `denyConnectorToolCall` call.
export async function invokeConnectorTool(
  request: InvokeConnectorToolRequest,
  onEvent: (event: ConnectorRuntimeEvent) => void,
): Promise<StreamHandle> {
  const channel = new Channel<ConnectorRuntimeEvent>();
  channel.onmessage = onEvent;
  return invoke<StreamHandle>('invoke_connector_tool', { request, channel });
}

export async function approveConnectorToolCall(toolCallId: string): Promise<void> {
  await invoke('approve_connector_tool_call', { toolCallId });
}

export async function denyConnectorToolCall(toolCallId: string): Promise<void> {
  await invoke('deny_connector_tool_call', { toolCallId });
}

export async function revokeConnectorGrant(
  grantId: string,
  connectorVersionId?: string,
): Promise<void> {
  await invoke('revoke_connector_grant', { grantId, connectorVersionId });
}

export async function addLocalConnector(request: AddLocalConnectorRequest): Promise<AddLocalConnectorResult> {
  return invoke<AddLocalConnectorResult>('add_local_connector', { request });
}

// =============================================================================
// Phase 5 — Artifacts (single-payload model) + attachments
// =============================================================================

/// Create an artifact row with no payload. Follow up with `setArtifactContent`
/// to write the payload. `kind` is the `ArtifactKind` string; `sourceMessageId`
/// links the artifact back to the assistant message that produced it.
export async function createArtifact(
  conversationId: string,
  kind: string,
  title?: string,
  sourceMessageId?: string,
): Promise<Artifact> {
  return invoke<Artifact>('create_artifact', { conversationId, kind, title, sourceMessageId });
}

/// List a conversation's artifacts, newest-first. Payload metadata is included
/// but inline content is NOT — fetch via `getArtifact` or `getArtifactContentBytes`.
export async function listArtifacts(conversationId: string): Promise<Artifact[]> {
  return invoke<Artifact[]>('list_artifacts', { conversationId });
}

/// Resolve the persisted message row id for a chat stream `requestId`.
export async function getMessageIdByRequest(requestId: string): Promise<string | null> {
  return invoke<string | null>('get_message_id_by_request', { requestId });
}

// =============================================================================
// FTS5 Full-Text Search
// =============================================================================

/// Search messages using the FTS5 index. Returns results ordered by relevance.
export async function searchMessages(
  request: SearchMessagesRequest,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_messages', { request });
}

/// Fetch a single payload-bearing artifact (inline content decrypted).
export async function getArtifact(artifactId: string): Promise<Artifact | null> {
  return invoke<Artifact | null>('get_artifact', { artifactId });
}

/// Overwrite the artifact's single payload in place (no version history). For
/// `File` content the bytes are written as an encrypted blob; inline `Text`/`Json`
/// are encrypted in the artifact row. Returns the updated artifact.
export async function setArtifactContent(
  artifactId: string,
  content: ArtifactContent,
  mimeType?: string,
): Promise<Artifact> {
  return invoke<Artifact>('set_artifact_content', { artifactId, mimeType, content });
}

export async function setArtifactTitle(artifactId: string, title: string): Promise<Artifact> {
  return invoke<Artifact>('set_artifact_title', { artifactId, title });
}

/// Read the artifact's content as raw bytes (inline content as UTF-8; File-content
/// as the decrypted blob). Capped at 5 MiB for preview — larger File-content must
/// use `exportArtifact`.
export async function getArtifactContentBytes(artifactId: string): Promise<number[]> {
  return invoke<number[]>('get_artifact_content_bytes', { artifactId });
}

/// Read full File-content bytes for recovery ("Use disk"). Not capped; only for
/// the modified-file recovery path.
export async function readArtifactFileBytes(artifactId: string): Promise<number[]> {
  return invoke<number[]>('read_artifact_file_bytes', { artifactId });
}

/// File-state machine for File-content artifacts. `noFileContent` for inline
/// (non-file) payloads; otherwise the on-disk blob hash is compared to
/// `content_hash` → `ok` | `modified` | `missing`.
export async function checkArtifactFileState(artifactId: string): Promise<FileState> {
  return invoke<FileState>('check_artifact_file_state', { artifactId });
}

/// Export the artifact's current payload to disk, with an optional `.conduit.json`
/// metadata sidecar. (M5.)
export async function exportArtifact(
  artifactId: string,
  includeMetadata: boolean,
): Promise<ArtifactExportResult> {
  return invoke<ArtifactExportResult>('export_artifact', { artifactId, includeMetadata });
}

// --- Attachments -----------------------------------------------------------

export async function saveAttachment(
  conversationId: string,
  bytes: number[],
  mimeType: string,
  origin?: string,
): Promise<Attachment> {
  return invoke<Attachment>('save_attachment', { conversationId, bytes, mimeType, origin });
}

export async function listAttachments(conversationId: string): Promise<Attachment[]> {
  return invoke<Attachment[]>('list_attachments', { conversationId });
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  await invoke('delete_attachment', { attachmentId });
}

export async function getAttachmentBytes(attachmentId: string): Promise<number[]> {
  return invoke<number[]>('get_attachment_bytes', { attachmentId });
}

// Phase 7 / M-WebSearch: local database reset (Privacy & Data section).
// Backs up the current DB and deletes the live file. The user must restart
// Conduit to create a fresh store. Attachments and artifacts on disk are
// left in place but are no longer indexed.
export async function resetLocalDatabase(): Promise<{ backupPath: string }> {
  return invoke<{ backupPath: string }>('reset_local_database');
}
