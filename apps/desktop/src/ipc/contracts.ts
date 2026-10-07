import type {
  AccentOverride,
  AppCategory,
  AppDetail,
  AppInput,
  AppSummary,
  DeckDetail,
  DeckReplaceResult,
  SlideReplaceCount,
  SlideSlot,
  SlotEdit,
  DeckSlide,
  DeckSnapshotCause,
  DeckSnapshotSummary,
  SlideTheme,
  DeckStage,
  DeckSummary,
  StorylineItem,
  DraftBlock,
  DraftDetail,
  DraftExportFormat,
  DraftSnapshotCause,
  DraftSnapshotSummary,
  DraftStage,
  DraftSummary,
  DraftSources,
  BlockOwner,
  OutlineSection,
  StarterAppInfo,
  PageLlmReply,
  PageLlmRequest,
  PageLlmState,
  AppActivityEntry,
  AppLlmSlot,
  AppModelChoice,
  AppSettingsView,
  PageLlmProviderGrant,
  PageStorageEntry,
  AppSettings,
  BrandConfig,
  ConsentDecision,
  ConsentPrompt,
  ConnectorPromptArgument,
  ConnectorPromptInfo,
  ConnectorResourceInfo,
  ConnectorGrant,
  ConnectorDefinition,
  ConnectorRuntimeEvent,
  ConnectorVersion,
  Conversation,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  GenerationControls,
  GrantStatus,
  Message,
  ModelInfo,
  ModelPrice,
  ModelPriceOverride,
  PermissionLevel,
  PriceSource,
  ProviderEvent,
  ProviderRequest,
  ResolvedModelPrice,
  RolloutChannel,
  SettingsPatch,
  SupportState,
  ToolCallRecord,
  ToolCallStatus,
  Transport,
  UpdatePolicy,
  PromptArguments,
  ResourceBlock,
  ResourceRef,
  SkippedResource,
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

/**
 * How an attachment reaches the model (`attachment_delivery`): an image as
 * today; a PDF sent as a document to a model that reads PDFs; a document whose
 * text is extracted locally; or not sent, with `reason` naming the file kind.
 */
export interface AttachmentDelivery {
  kind: 'image' | 'pdf_native' | 'text' | 'unsupported';
  reason?: string;
}

export type ConversationExportFormat = 'markdown' | 'json';
export interface ConversationExportResult {
  exportedTo: string;
  bytesWritten: number;
}

/** t0-3 message editing — result of `prepare_message_edit`. */
export type PrepareMessageEditMode = 'in_place' | 'forked';
export interface PrepareMessageEditResult {
  conversation: Conversation;
  mode: PrepareMessageEditMode;
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

// Mirrors the Rust `updater::UpdateStatus`. Answerable without touching the
// network: `lastChecked` is Unix seconds of the last completed check (null if
// this machine has never checked), and `staged` is set once a payload has been
// downloaded and signature-verified and is waiting for the user to quit.
export interface UpdateStatus {
  lastChecked: number | null;
  staged: UpdateInfo | null;
  /** False on a Linux `.deb` build, where installing shells out to a `pkexec`
   *  prompt that cannot be raised silently at quit. */
  automaticSupported: boolean;
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
  /** False once the backup has been discarded, so the dialog can stop offering
   *  a delete that would do nothing. */
  backupExists: boolean;
  /** Total bytes held by every recovery backup next to the database. */
  backupBytes: number;
}

/** What a discard or wipe actually removed. Reported back so the confirmation
 *  can name real paths instead of claiming success generically. */
export interface RemovalReport {
  removedPaths: string[];
  freedBytes: number;
}

/** How much to delete when the user asks to start over.
 *  - `conversations`: chats, attachments, artifacts, stream journals, backups.
 *    Settings and keychain credentials survive.
 *  - `everything`: the above plus settings, logs, diagnostics, exports, and
 *    connector working dirs — a first-run state. Keychain secrets are never
 *    touched by either scope. */
export type WipeScope = 'conversations' | 'everything';

export interface PendingWipeResult {
  /** Always true: the wipe is applied on next launch, never in place. */
  requiresRestart: boolean;
  estimatedBytes: number;
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

export interface SteerChatStreamRequest {
  requestId: string;
  conversationId?: string;
  text: string;
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
  AccentOverride,
  AppCategory,
  AppDetail,
  AppInput,
  AppSummary,
  DeckDetail,
  DeckReplaceResult,
  SlideReplaceCount,
  SlideSlot,
  SlotEdit,
  DeckSlide,
  DeckSnapshotCause,
  DeckSnapshotSummary,
  SlideTheme,
  DeckStage,
  DeckSummary,
  StorylineItem,
  DraftBlock,
  DraftDetail,
  DraftExportFormat,
  DraftSnapshotCause,
  DraftSnapshotSummary,
  DraftStage,
  DraftSummary,
  DraftSources,
  BlockOwner,
  OutlineSection,
  StarterAppInfo,
  PageLlmReply,
  PageLlmRequest,
  PageLlmState,
  AppActivityEntry,
  AppLlmSlot,
  AppModelChoice,
  AppSettingsView,
  PageLlmProviderGrant,
  PageStorageEntry,
  AppSettings,
  BrandConfig,
  Conversation,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  GenerationControls,
  Message,
  ProviderEvent,
  ProviderRequest,
  SettingsPatch,
  ModelInfo,
  ModelPrice,
  ModelPriceOverride,
  PriceSource,
  ResolvedModelPrice,
};

// =============================================================================
// Phase 4 — MCP connector runtime
// =============================================================================

// Re-export the ts-rs-generated connector + consent types.
export type {
  ConsentDecision,
  ConsentPrompt,
  ConnectorPromptArgument,
  ConnectorPromptInfo,
  ConnectorResourceInfo,
  PromptArguments,
  ResourceBlock,
  ResourceRef,
  SkippedResource,
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
  UpdatePolicy,
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

export interface AddRemoteConnectorRequest {
  name: string;
  description?: string;
  url: string;
  version?: string;
  consentCopy?: string;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description: string;
  version: string;
  remoteUrl?: string;
  remoteType?: string;
  installable: boolean;
  reason?: string;
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

/// Artifact kind. `html` renders in a sandboxed iframe (M6). `image` (t0-8 M5)
/// is always File-content (bytes fetched via `getArtifactContentBytes`,
/// rendered as a blob-URL `<img>` — never inline `contentText`/`contentJson`).
/// The `kind` column is TEXT and `create_artifact` takes `kind: string`, so
/// unknown kinds are tolerated by the backend; the renderer falls back to
/// plain text.
export type ArtifactKind = 'markdown' | 'text' | 'code' | 'json' | 'html' | 'image';

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

// =============================================================================
// FTS5 Full-Text Search (Competitive Feature — Conversation Search)
// =============================================================================

export interface SearchResult {
  messageId: string;
  conversationId: string;
  conversationTitle?: string;
  role: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  createdAt: string;
  pinned?: boolean;
  archived?: boolean;
  folderName?: string;
}

export interface SearchMessagesRequest {
  query: string;
  limit?: number;
}

// =============================================================================
// Usage Analytics (Competitive Feature)
// =============================================================================

export type UsagePeriod = 'today' | 'thisWeek' | 'thisMonth' | 'allTime';

export interface ProviderUsageBreakdown {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the model has no price: unpriced, which is not the same as free. */
  costCents: number | null;
  /** The price used and where it came from; null when unpriced. */
  price: ResolvedModelPrice | null;
}

export interface DailyUsage {
  date: string;
  /** Cost of the day's priced usage; unpriced models add nothing. */
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummaryResponse {
  /** Cost of the period's priced usage, in cents. */
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Models in the period with no price, so the total is a floor. */
  unpricedModels: number;
  /** When the bundled price snapshot was fetched, `YYYY-MM-DD`. */
  pricesAsOf: string;
  byProvider: ProviderUsageBreakdown[];
  dailyTotals: DailyUsage[];
}

// =============================================================================
// Prompts Library (Competitive Feature)
// =============================================================================

export interface Prompt {
  id: string;
  title: string;
  body: string;
  variables?: string[];
  folder?: string;
  tags?: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt?: string;
}

/** SKILL.md package metadata (t1-4). Body is omitted until the skill is enabled. */
export type SkillSource = 'conduit' | 'claude' | 'agents' | 'brand' | 'workspace';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  compatibility?: string;
  license?: string;
  parseError?: string;
}

export type MemoryKind = 'core' | 'note';
export type MemoryStatus = 'pending' | 'active';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  body: string;
  sourceConversationId?: string;
  pinned: boolean;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

/** One-level history-rail folder (t0-5). Empty folders stay as drop targets. */
export interface ConversationFolder {
  id: string;
  name: string;
  createdAt: string;
}

// =============================================================================
// Knowledge base (t1-6)
// =============================================================================

export interface KnowledgeCollection {
  id: string;
  name: string;
  providerId: string; // provider that embeds this collection
  embeddingModel: string;
  embeddingDimensions: number;
  documentCount: number; // computed, not a column
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  source: string; // absolute path it was imported from
  title: string;
  mimeType: string | null;
  byteSize: number;
  chunkCount: number;
  importedAt: string;
}

export type KnowledgeImportStatus = 'imported' | 'duplicate';

/** Progress for one import, pushed while `importKnowledgeDocument` runs.
 *  `reading` happens locally; `embedding` waits on the provider and is where
 *  a large document spends most of its time. Counts are 0 while reading. */
export interface KnowledgeImportProgress {
  phase: 'reading' | 'embedding';
  chunksDone: number;
  chunksTotal: number;
}

export interface KnowledgeImportOutcome {
  status: KnowledgeImportStatus;
  documentId: string;
  chunkCount: number;
  title: string;
}

/** The passage behind a citation chip. `content` is the document's own text,
 *  shown to its owner — render it as plain text, never as markup. */
export interface KnowledgePassage {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  source: string;
  mimeType: string | null;
  ordinal: number;
  documentChunkCount: number;
  charStart: number;
  charEnd: number;
  content: string;
}

export interface KnowledgeCitation {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  ordinal: number;
  charStart: number;
  charEnd: number;
  /** D14: which collection the cited document belongs to, so a citation names
   *  which `notes.md` it means. Absent for citations built before this field
   *  existed (never surfaced by a current backend, kept optional defensively). */
  collectionId?: string;
  collectionName?: string;
}

export interface KnowledgeContext {
  text: string; // fenced block for extraSystemSections; '' when nothing retrieved
  citations: KnowledgeCitation[];
  refusedTitles: string[]; // documents dropped by the reinjection gate, named for the user
  /** Names of collections attached to this conversation that could not be
   *  searched this turn (lost credential, withdrawn embedding consent, or a
   *  cloud provider while local_only is on). Distinct from `refusedTitles`:
   *  a whole collection went unsearched, not one document's text blocked. */
  unavailableCollections: string[];
}

/** A saved workflow (Rust `db::repository::workflows::WorkflowRecord`). */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  /** The stored definition (Rust `workflows::definition::WorkflowDefinition`). */
  definition: WorkflowDefinition;
  version: number;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  version: number;
  updatedAt: string;
  lastRunStatus: WorkflowRunStatus | null;
  lastRunAt: string | null;
  /** When it next runs on its own (UTC), if it has a schedule that is on. */
  nextRunAt: string | null;
}

/** When a workflow runs on its own (Rust `workflows::schedule::ScheduleSpec`). */
export type ScheduleSpec =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'interval'; hours: number };

export interface WorkflowSchedule {
  workflowId: string;
  spec: ScheduleSpec;
  enabled: boolean;
  /** UTC; null while the schedule is off. */
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** Sent when a scheduled run ends (Rust `workflows::scheduler::RunFinished`). */
export interface WorkflowRunFinished {
  workflowId: string;
  workflowName: string;
  runId: string | null;
  status: 'completed' | 'failed' | 'stopped' | 'skipped' | 'running';
  error: string | null;
  trigger: 'schedule' | 'catch_up';
  documents: { artifactId: string; conversationId: string; title: string }[];
}

/** A provider and one of its models; absent means "follow the chat model" (or the workflow's). */
export interface WorkflowModel {
  provider: string;
  model: string;
}

export interface WorkflowDefinition {
  /** The workflow's default model for steps that use one. */
  model?: WorkflowModel;
  inputs?: WorkflowInput[];
  steps: WorkflowStep[];
}

export interface WorkflowInput {
  id: string;
  label: string;
  default?: string | null;
}

export type WorkflowStep = {
  id: string;
  onError?: 'fail' | 'skip';
  /** Tries again after a failure; unset takes the step kind's default (`defaultRetries`). */
  retries?: number | null;
} & (
  | { type: 'fetch_page'; urls: string[] }
  | { type: 'web_search'; query: string; maxResults?: number | null }
  | { type: 'summarize'; prompt: string; input: string; schema?: Record<string, unknown> | null; model?: WorkflowModel }
  | { type: 'template'; template: string }
  | { type: 'for_each'; items: string; steps: WorkflowStep[] }
  | { type: 'save_artifact'; title: string; content: string; format?: 'markdown' | 'html'; mode?: 'update' | 'create' }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'ask'; question: string; choices?: string[]; default?: string | null }
  | { type: 'agent'; prompt: string; input?: string; tools?: string[]; model?: WorkflowModel }
);

export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  version: number;
  trigger: string;
  status: WorkflowRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRunStep {
  id: string;
  runId: string;
  stepId: string;
  iteration: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'reused';
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  steps: WorkflowRunStep[];
}

/** One thing a workflow may do on its own (Rust `workflows::permissions::Permission`). */
export type WorkflowPermission =
  | { kind: 'host'; host: string }
  | { kind: 'anyHost'; stepId: string }
  | { kind: 'webSearch'; backend: string }
  | { kind: 'model'; provider: string }
  | { kind: 'saveDocuments' }
  | { kind: 'agentTools'; stepId: string; tools: string[] };

/** A permission with its display name (provider, search backend) and, for a model, where it runs. */
export type WorkflowPermissionView = WorkflowPermission & { label: string | null; local: boolean | null };

/** What a workflow needs to run on its own, and what of that isn't approved yet. */
export interface WorkflowPermissions {
  required: WorkflowPermissionView[];
  missing: WorkflowPermissionView[];
  approvedAt: string | null;
}

/** A scheduled run paused to ask (Rust `workflows::permissions::PendingReview`). */
export interface WorkflowReview {
  runId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  permission: WorkflowPermissionView;
  /** For a fetch: the address it wants. */
  url: string | null;
  requestedAt: string;
  expiresAt: string;
}

export type WorkflowReviewDecision = 'allowOnce' | 'alwaysAllow' | 'deny';

/** A run waiting at an "Ask me" step (Rust `workflows::ask::PendingQuestion`). */
export interface WorkflowQuestion {
  runId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  question: string;
  /** Answers to pick from; empty for a typed answer. */
  choices: string[];
  /** Taken when nobody answers before `expiresAt`. */
  default: string | null;
  requestedAt: string;
  expiresAt: string;
}

// Research: the brief, the live run and its sources (ts-rs-generated).
export type {
  ResearchBrief,
  ResearchBudget,
  ResearchDepth,
  ResearchProgress,
  ResearchRun,
  ResearchSource,
  ResearchSourceStatus,
  ResearchStatus,
  ResearchReportSummary,
  ResearchMaterial,
  ResearchMaterialClaim,
} from '@conduit/config-schema';
