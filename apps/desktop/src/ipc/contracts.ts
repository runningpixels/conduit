import type {
  AppSettings,
  ConsentDecision,
  ConsentPrompt,
  ConnectorGrant,
  ConnectorDefinition,
  ConnectorRuntimeEvent,
  ConnectorVersion,
  Conversation,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  GrantStatus,
  Message,
  ModelInfo,
  PermissionLevel,
  ProviderEvent,
  ProviderRequest,
  RolloutChannel,
  SettingsPatch,
  SupportState,
  ToolCallRecord,
  ToolCallStatus,
  Transport,
} from '@conduit/config-schema';

export interface AppPaths {
  root: string;
  settingsFile: string;
  database: string;
  attachments: string;
  artifacts: string;
  logs: string;
  diagnostics: string;
  updates: string;
  streams: string;
}

export interface DiagnosticsExport {
  exportedTo: string;
  redactedFields: string[];
}

export interface MockStreamRequest {
  requestId: string;
  conversationId: string;
  prompt: string;
  chunks: string[];
}

export interface CancelChatStreamRequest {
  requestId: string;
  conversationId?: string;
}

export interface StreamHandle {
  requestId: string;
}

export type StreamEvent =
  | { kind: 'messageStart'; requestId: string; index: number }
  | { kind: 'contentDelta'; requestId: string; index: number; content: string }
  | { kind: 'messageComplete'; requestId: string; index: number; finishReason: string }
  | { kind: 'error'; requestId: string; index: number; message: string };

export type {
  AppSettings,
  Conversation,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  Message,
  ProviderEvent,
  ProviderRequest,
  SettingsPatch,
  ModelInfo,
};

// =============================================================================
// Phase 4 — MCP connector runtime
// =============================================================================

// Re-export the ts-rs-generated connector + consent types.
export type {
  ConsentDecision,
  ConsentPrompt,
  ConnectorRuntimeEvent,
  ConnectorDefinition,
  ConnectorVersion,
  ConnectorGrant,
  GrantStatus,
  PermissionLevel,
  RolloutChannel,
  SupportState,
  ToolCallRecord,
  ToolCallStatus,
  Transport,
};

/// A discovered connector capability (repo struct; not ts-rs-generated).
export interface ConnectorCapability {
  id: string;
  connectorVersionId: string;
  kind: 'tool' | 'resource' | 'prompt';
  name: string;
  schemaJson?: Record<string, unknown>;
  discoveredAt: string;
}

/// One row of the connectors rail: a version joined with its definition,
/// runtime health, support state, and grant status. (commands.rs struct,
/// serde camelCase — not ts-rs-generated.)
export interface ConnectorRuntimeSnapshot {
  connectorVersionId: string;
  connectorId: string;
  connectorName: string;
  version: string;
  transport: Transport;
  health?: string;
  lastError?: string;
  lastStartedAt?: string;
  restartCount: number;
  supportState?: SupportState;
  grantStatus?: GrantStatus;
  running: boolean;
}

/// Request body for `invoke_connector_tool`.
export interface InvokeConnectorToolRequest {
  connectorVersionId: string;
  toolCallId: string;
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/// Request body for `add_local_connector` (untrusted transport config —
/// validated server-side by `StdioConfig` before persist).
export interface AddLocalConnectorRequest {
  name: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  consentCopy?: string;
  capabilityAllowlist?: string[];
}

export interface AddLocalConnectorResult {
  connectorId: string;
  connectorVersionId: string;
}

export interface ConnectorServerInfo {
  name: string;
  version: string;
}
