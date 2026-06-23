import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AddLocalConnectorRequest,
  AddLocalConnectorResult,
  AppPaths,
  AppSettings,
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
  InvokeConnectorToolRequest,
  Message,
  MockStreamRequest,
  ModelInfo,
  ProviderEvent,
  ProviderRequest,
  SettingsPatch,
  StreamEvent,
  StreamHandle,
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

export async function listProviderModels(providerId: string): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_provider_models', { providerId });
}

export async function startChatStream(
  request: ProviderRequest,
  onEvent: (event: ProviderEvent) => void,
): Promise<StreamHandle> {
  const channel = new Channel<ProviderEvent>();
  channel.onmessage = onEvent;
  return invoke<StreamHandle>('start_chat_stream', { request, channel });
}

export async function cancelChatStream(request: CancelChatStreamRequest): Promise<void> {
  await invoke('cancel_chat_stream', { request });
}

export async function getConversationMessages(conversationId: string): Promise<Message[]> {
  return invoke<Message[]>('get_conversation_messages', { conversationId });
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

export async function exportDiagnostics(): Promise<DiagnosticsExport> {
  return invoke<DiagnosticsExport>('export_diagnostics');
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
