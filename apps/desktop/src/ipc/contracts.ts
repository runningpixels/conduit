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

// =============================================================================
// Phase 6 — Consumer release: updater (trust-promise gate)
//
// Mirrors the Rust `updater::UpdateInfo` struct (serde `camelCase`). Returned by
// `check_for_update` WITHOUT downloading the payload. `date` is a Unix
// timestamp (seconds) or null; the renderer formats it locale-aware.
// =============================================================================

export interface UpdateInfo {
  version: string;
  date: number | null;
  notes: string | null;
}

// =============================================================================
// Phase 6 M6.4 — First-run onboarding (BYOK gate)
//
// Mirrors the Rust `commands::OnboardingState` (serde `camelCase`). `App.tsx`
// reads this at boot and renders `<Onboarding>` instead of the workspace while
// `onboardingCompleted` is false or no provider credential is configured.
// `migrationRecovery` takes priority (shown first) when a startup migration
// failed and the live DB was rolled back to a fresh store.
// =============================================================================

export interface MigrationRecoveryInfo {
  /** Absolute path of the `.corrupt-<unix>.bak` backup (the user's own path,
   *  shown to them so they can find their data — stays on-device). */
  backupPath: string;
  /** The migration error that caused the recovery. */
  error: string;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  defaultBaseUrl: string | null;
  credentialMode: 'none' | 'optional' | 'required';
  isLocal: boolean;
  showBaseUrlField: boolean;
  tier: number;
  description: string | null;
}

export interface OnboardingState {
  onboardingCompleted: boolean;
  hasProviderCredential: boolean;
  migrationRecovery: MigrationRecoveryInfo | null;
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

// =============================================================================
// Phase 5 — Artifacts (single-payload model)
//
// These mirror the repo structs in `src-tauri/src/db/repository/{artifacts,
// attachments}.rs` (serde `camelCase`), NOT the ts-rs-generated types. The repo
// `Attachment`/`Artifact` diverge from the ts-rs schema structs: `size_bytes` is
// `i64` (serializes as a JSON number, not the ts-rs `bigint`), and the repo
// `Attachment.retention_state` is a `String` (not the optional `RetentionState`
// enum). `ArtifactVersion` is gone — there is no version history (user-directed
// override of ADR-002); saving overwrites the single payload in place.
// =============================================================================

/// Artifact kind. `html` renders in a sandboxed iframe (M6). The `kind` column
/// is TEXT and `create_artifact` takes `kind: string`, so unknown kinds are
/// tolerated by the backend; the renderer falls back to plain text.
export type ArtifactKind = 'markdown' | 'text' | 'code' | 'json' | 'html';

/// Content payload for `set_artifact_content`. Tagged (`kind`) to match the
/// Rust `ArtifactContent` enum (`#[serde(tag = "kind")]`). `File` payloads are
/// written as encrypted content-addressed blobs; inline `Text`/`Json` are
/// encrypted in their artifact-row columns.
export type ArtifactContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; json: unknown }
  | { kind: 'file'; bytes: number[]; filename: string };

/// File-state machine for File-content artifacts (`check_artifact_file_state`).
/// `noFileContent` = inline (non-file) payload; the rest compare the on-disk
/// blob hash against `content_hash`.
export type FileState = 'ok' | 'missing' | 'modified' | 'noFileContent';

/// A single-payload artifact (payload-bearing when read via `get_artifact`).
/// `list_artifacts` returns these WITHOUT inline content (contentText/contentJson
/// are absent); fetch via `get_artifact` or `get_artifact_content_bytes`.
export interface Artifact {
  id: string;
  conversationId: string;
  kind: ArtifactKind;
  title?: string;
  sourceMessageId?: string;
  cloudShareId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  mimeType?: string;
  contentText?: string;
  contentJson?: unknown;
  contentPath?: string;
  contentHash?: string;
  sizeBytes?: number;
}

/// Result of `export_artifact` (M5): the exported file path + bytes written.
export interface ArtifactExportResult {
  exportedTo: string;
  bytesWritten: number;
}

/// An attachment row (repo struct). `retentionState` is the raw string column
/// (`active` | `deleted` | `redacted`); `sizeBytes` is the plaintext byte count.
export interface Attachment {
  id: string;
  conversationId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  hash?: string;
  origin?: string;
  retentionState: string;
  createdAt: string;
}
