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
  /** The workflow whose run suggested this memory, by name (an empty name when it has none). */
  sourceWorkflow?: string;
  pinned: boolean;
  status: MemoryStatus;
  /** `global` (the user's own memory) or `agent:<id>` (one of the user's agents' notes). */
  scope: string;
  /** Where an agent's note came from; absent for the user's own memory and notes added by hand. */
  origin?: MemoryOrigin;
  createdAt: string;
  updatedAt: string;
}

/** Where an agent wrote a note: a chat, a workflow run, or a run nobody was watching. */
export type MemoryOrigin = 'chat' | 'run' | 'scheduled_run';

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
  /** Made as a routine (one of the user's agents on a schedule); listed on its agent's card. */
  routine: boolean;
}

/** What the routine form sends (Rust `workflows::routines::RoutineRequest`). */
export interface RoutineRequest {
  agentId: string;
  name: string;
  /** What the agent does each run, as written. */
  task: string;
  /** `{kind:'trigger'}` with `trigger` set for a feed or folder. */
  schedule: ScheduleSpec;
  trigger?: Extract<WorkflowTrigger, { kind: 'feed' | 'folder' }> | null;
  /** Also show a notification when a run finishes. */
  notify: boolean;
  /** A new document in Results each run, or a Markdown file in the exports folder. */
  output: 'document' | 'file';
  folder?: string | null;
}

/** A routine just made (Rust `commands::workflows::RoutineCreated`); its schedule is off until approved. */
export interface RoutineCreated {
  workflow: WorkflowRecord;
  permissions: WorkflowPermissions;
}

/** One routine, for its agent's card (Rust `workflows::routines::RoutineSummary`). */
export interface RoutineSummary {
  workflowId: string;
  agentId: string;
  name: string;
  task: string;
  schedule: ScheduleSpec | null;
  trigger: WorkflowTrigger | null;
  folder: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunId: string | null;
  lastRunStatus: WorkflowRunStatus | null;
  lastRunAt: string | null;
  /** What its latest run saved, when it saved something. */
  lastResultTitle: string | null;
}

/** When a workflow runs on its own (Rust `workflows::schedule::ScheduleSpec`). */
export type ScheduleSpec =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'interval'; hours: number }
  /** Polled for new items instead of timed: the definition's `trigger` says what to watch. */
  | { kind: 'trigger' };

export interface WorkflowSchedule {
  workflowId: string;
  spec: ScheduleSpec;
  enabled: boolean;
  /** UTC; null while the schedule is off. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Only for a `{kind:'trigger'}` schedule: what is watched and how it is going. */
  watch?: {
    kind: 'feed' | 'folder' | 'connector';
    target: string;
    everyMinutes: number;
    pausedReason: string | null;
    lastCheckedAt: string | null;
  } | null;
}

/** Sent when a scheduled run ends (Rust `workflows::scheduler::RunFinished`). */
export interface WorkflowRunFinished {
  workflowId: string;
  workflowName: string;
  runId: string | null;
  status: 'completed' | 'failed' | 'stopped' | 'skipped' | 'running';
  error: string | null;
  trigger: 'schedule' | 'catch_up' | 'feed' | 'folder' | 'connector';
  documents: { artifactId: string; conversationId: string; title: string }[];
  /** `nothing_new` when a condition stopped the run. */
  outcome?: string | null;
}

/** A provider and one of its models; absent means "follow the chat model" (or the workflow's). */
export interface WorkflowModel {
  provider: string;
  model: string;
}

/** What starts a workflow on its own (Rust `workflows::definition::Trigger`). */
export type WorkflowTrigger =
  | { kind: 'feed'; url: string; everyMinutes: number }
  | { kind: 'folder' }
  /** Calls a read-only connector tool every so often and runs once per new element of the list it returns. */
  | { kind: 'connector'; connector: string; tool: string; arguments: Record<string, unknown>; everyMinutes: number };

export interface WorkflowDefinition {
  /** The workflow's default model for steps that use one. */
  model?: WorkflowModel;
  inputs?: WorkflowInput[];
  /** Absolute directory that `read_file` steps read from (relative paths only). */
  folder?: string;
  /** How agents that use the computer behave; only read when an agent has the `computer` tool. */
  computer?: WorkflowComputer;
  /** Starts a run for each new feed item or new file in `folder`; absent means manual and timed runs only. */
  trigger?: WorkflowTrigger;
  /** Helpers: agents that agent steps (and other helpers) may hand work to. */
  agents?: AgentDef[];
  steps: WorkflowStep[];
}

/** Settings for agents that use the computer (Rust `workflows::definition`). */
export interface WorkflowComputer {
  /** 'ask' (default) asks before changing a file; 'free' changes files in the folder without asking. */
  editMode?: 'ask' | 'free';
  /** What a question does when nobody answers: wait (default) or skip it. */
  whenNobodyAnswers?: 'wait' | 'skip';
  /** 1..1800; 120 when absent. */
  timeoutSecs?: number;
  /** Environment variable names passed to programs. */
  passEnv?: string[];
  /** On Windows commands are kept inside the folder (writes only there, almost no network); true turns that off. Left out when false. */
  allowOutside?: boolean;
}

/** A helper (Rust `workflows::definition::AgentDef`). */
export interface AgentDef {
  /** Lowercase letters, digits and `_`; unique in the workflow. */
  id: string;
  name: string;
  instructions: string;
  model?: WorkflowModel;
  tools?: string[];
  /** Ids of the other helpers it may hand work to. */
  agents?: string[];
  /** 1000..=300000; 120000 when absent. */
  maxTokens?: number;
  /** Can work alongside other agents even though its tools change things. */
  alongside?: boolean;
  /** Keeps its own notes between runs (one of the user's agents only). Left out when false. */
  memory?: boolean;
  /** Ids of the collections of documents it may search. Left out when empty. */
  knowledge?: string[];
  /**
   * Set when this helper is one of the user's agents (`LibraryAgent`): the
   * saved definition holds only `{ id, library }` (id === library) and the
   * rest comes from the library whenever the workflow runs. `resolve_workflow_agents`
   * returns it filled in.
   */
  library?: string;
}

/** One of the user's agents (Rust `agents::library::LibraryAgent`). */
export interface LibraryAgent {
  /** Its definition; `agents` are ids of other library agents. Never has `library`. */
  agent: AgentDef;
  createdAt: string;
  updatedAt: string;
  /** Workflows whose helpers refer to it (directly or through another agent). */
  usedBy: { workflowId: string; workflowName: string }[];
  /** Its work in chat (`@` turns and hand-offs), last 30 days. */
  chat: LibraryAgentChatActivity;
  /** How many notes it keeps (its `agent:<id>` memory). */
  notes: number;
}

export interface LibraryAgentChatActivity {
  tasks: number;
  failed: number;
  tokens: number;
  lastActive: string | null;
  currentTask: string | null;
  currentConversationId: string | null;
}

/** One row of a run's agent tree (`list_agent_calls`): a step, a helper or a chat hand-off. */
export interface AgentCallRow {
  id: string;
  parentId?: string | null;
  kind: 'step' | 'helper' | 'chat';
  stepId?: string | null;
  agentId: string;
  name: string;
  task: string;
  /** "provider/model" */
  model?: string | null;
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string | null;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  startedAt: string;
  finishedAt?: string | null;
}

/** One thing the Reviewer found in a document (`agents::review::ReviewIssue`). */
export interface ReviewIssue {
  problem: string;
  /** What to change; empty when the Reviewer didn't say. */
  change: string;
}

/** A document review (`review_document`): no issues means it meets the request. */
export interface DocumentReview {
  /** The reviewing agent's name. */
  reviewer: string;
  issues: ReviewIssue[];
}

/** An agent call that started or finished (`agent-call-changed`), or one still
 *  running (`list_running_agent_calls`): chat hand-offs and workflow agents. */
export interface AgentCallChange {
  id: string;
  kind: 'step' | 'helper' | 'chat';
  agentId: string;
  name: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string | null;
  /** The chat it works for; null for workflow agents. */
  conversationId?: string | null;
  /** The workflow run it works for; null in chat. */
  runId?: string | null;
  workflowId?: string | null;
  parentId?: string | null;
  /** Its workflow step waits for the user: open, but not working. */
  waiting?: boolean;
  startedAt: string;
  finishedAt?: string | null;
}

/** One hand-off in an agent step's output. */
export interface AgentHandoff {
  agent: string;
  name: string;
  task: string;
  answer?: string;
  error?: string;
  tokens: number;
}

/** One row of the Agents page (`list_agents`). */
export interface AgentEntry {
  workflowId: string;
  workflowName: string;
  kind: 'step' | 'helper';
  agentId: string;
  /** For a helper that is one of the user's agents: its library id (=== agentId). */
  library?: string;
  /** The helper's name; empty for a step. */
  name: string;
  /** The helper's instructions, or the step's prompt. */
  about: string;
  model: WorkflowModel | null;
  tools: string[];
  /** Names of the helpers it may hand work to. */
  handsTo: string[];
  currentTask: string | null;
  currentRunId: string | null;
  lastActive: string | null;
  tasks: number;
  failed: number;
  /** Last 30 days. */
  tokens: number;
}

/** What drafting a workflow from a description (or a chat) returns: an unsaved definition. */
/** One tool of a connector, as `list_workflow_connector_tools` reports it. */
export interface WorkflowConnectorTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  permissionLevel: 'readOnly' | 'sideEffectful' | 'sensitive';
  /** It says nothing about changing things, so it asks first unless marked as only reading. */
  undeclared?: boolean;
}

/** One tool of a running connector, as the Connectors page shows its access. */
export interface ConnectorToolAccess {
  name: string;
  /** What the tool says about itself; null when it says nothing. */
  declared: 'readOnly' | 'sideEffectful' | 'sensitive' | null;
  /** The user marked it as only reading. */
  markedReadOnly: boolean;
}

export interface WorkflowDraftResult {
  name: string;
  description: string;
  definition: WorkflowDefinition;
  /** Plain-English problems the checker still finds (shown in the editor). */
  problems: string[];
  attempts: number;
  /** Things only the user can fill in ("Pick the deck to update"). */
  notes: string[];
}

export interface WorkflowInput {
  id: string;
  label: string;
  default?: string | null;
}

/** What a `condition` step checks (Rust `workflows::definition`). */
export type ConditionTest = 'changed' | 'not_empty' | 'empty' | 'contains' | 'not_contains' | 'equals';

/** How deep a `research` step goes (no `deep` in workflows). */
export type ResearchStepDepth = 'quick' | 'standard';

/** How a `parse_data` step reads its text (Rust `workflows::definition`). */
export type DataFormat = 'csv' | 'tsv' | 'json';

export type WorkflowStep = {
  id: string;
  onError?: 'fail' | 'skip';
  /** Tries again after a failure; unset takes the step kind's default (`defaultRetries`). */
  retries?: number | null;
  /** Top level only: the steps this one waits for (ids, or `<branchId>.yes` / `.no`). Absent: the step before it; `[]`: the start. */
  after?: string[];
} & (
  | { type: 'fetch_page'; urls: string[] }
  | { type: 'web_search'; query: string; maxResults?: number | null }
  | { type: 'summarize'; prompt: string; input: string; schema?: Record<string, unknown> | null; model?: WorkflowModel }
  | { type: 'template'; template: string }
  | { type: 'for_each'; items: string; steps: WorkflowStep[] }
  | { type: 'save_artifact'; title: string; content: string; format?: 'markdown' | 'html'; mode?: 'update' | 'create'; onlyIfChanged?: boolean }
  | { type: 'export_file'; name: string; content: string }
  | { type: 'save_memory'; text: string }
  | { type: 'notify'; title: string; body?: string; onlyIfChanged?: boolean }
  | { type: 'condition'; value: string; is: ConditionTest; text?: string }
  /** If… otherwise: later steps wait on the yes or no arm through `after`. */
  | { type: 'branch'; value: string; is: ConditionTest; text?: string }
  | { type: 'ask'; question: string; choices?: string[]; default?: string | null }
  /**
   * `agent`: one of the user's agents (library id) the step runs as; its instructions lead the turn, and its
   * model, tools and helpers are used when the step sets none.
   */
  | {
      type: 'agent';
      prompt: string;
      input?: string;
      tools?: string[];
      model?: WorkflowModel;
      agents?: string[];
      agent?: string;
    }
  | { type: 'read_file'; path: string }
  | { type: 'edit_deck'; deck: string; instructions: string; input?: string; model?: WorkflowModel }
  | { type: 'edit_draft'; draft: string; instructions: string; input?: string; model?: WorkflowModel }
  | { type: 'parse_data'; input: string; format: DataFormat }
  | { type: 'research'; question: string; depth: ResearchStepDepth; model?: WorkflowModel }
  | { type: 'search_documents'; collections: string[]; query: string; topK?: number | null }
  /** A read-only tool of an installed connector; every string inside `arguments` is a template. */
  | { type: 'connector_tool'; connector: string; tool: string; arguments: Record<string, unknown> }
);

/** What an `edit_deck` / `edit_draft` step records (Rust `workflows::runner`). */
export interface WorkflowDocumentEditOutput {
  deckId?: string;
  draftId?: string;
  title: string;
  /** Ids of the slides or blocks the step changed. */
  changed: string[];
  /** Pinned text the step left alone: `{slideId, slot}` for decks, `{blockId}` or `{heading}` for drafts. */
  skippedPinned: ({ slideId: string; slot: string } | { blockId: string } | { heading: string })[];
  /** The model's one-sentence account of what it changed. */
  reply: string;
  /** Decks only: false until the deck is next opened. */
  layoutChecked?: boolean;
  model?: WorkflowModel;
}

export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  version: number;
  /** `schedule`, `catch_up`, `manual`, or `feed` / `folder` for a run a trigger started. */
  trigger: string;
  /** What a trigger run was started for: a feed item's `title` or a file's `name`. */
  triggerItem?: { title?: string; name?: string; [field: string]: unknown } | null;
  status: WorkflowRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Set to `nothing_new` when a condition stopped the run (the field name may change; read it through `runOutcome.ts`). */
  outcome?: string | null;
  /** The step id the run stopped at, when `outcome` says so. */
  outcomeStep?: string | null;
  /** When the user opened (or saw in place) what the run produced; null while unread. */
  seenAt?: string | null;
  /** What the run saved, for a finished run; absent while running. */
  outputs?: WorkflowRunOutput[] | null;
}

/** One thing a run saved (a document, deck, draft or file), for "Open". */
export interface WorkflowRunOutput {
  kind: 'document' | 'deck' | 'draft' | 'file';
  title: string;
  /** The step that saved it. */
  stepId: string;
  artifactId?: string;
  /** Where a document lives (the workflow's own conversation). */
  conversationId?: string;
  deckId?: string;
  draftId?: string;
  /** For a file: where it was written. */
  path?: string;
  /** The start of what was saved, as one line of plain text. */
  preview?: string;
  /** A save that found the same content as last time and kept it. */
  unchanged?: boolean;
}

/** A finished run in the Results list. */
export interface WorkflowResult {
  run: WorkflowRun;
  workflowName: string;
}

export interface WorkflowRunStep {
  id: string;
  runId: string;
  stepId: string;
  iteration: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'reused' | 'not_taken';
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** A running step that is waiting for you (an approval or an answer). */
  waiting?: boolean;
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
  | { kind: 'readFolder'; path: string }
  | { kind: 'agentTools'; stepId: string; tools: string[] }
  /** Run commands and change files in the workflow's folder (each still asks unless a rule allows it). */
  | { kind: 'computer'; path: string }
  /** Research on the web (Rust `Permission::Research`). */
  | { kind: 'research' }
  /** Search these Documents collections (Rust `Permission::Documents`). */
  | { kind: 'documents'; collections: { id: string; title: string }[] }
  /** Change a saved deck or draft (Rust `Permission::EditDocument`); `documentKind` is the tag's payload name, since `kind` is taken. */
  | { kind: 'editDocument'; documentKind: 'deck' | 'draft'; id: string; title: string }
  /** Use a read-only connector tool (Rust `Permission::Connector`). */
  | { kind: 'connector'; connectorId: string; name: string; tool: string };

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

/** A command or file change an agent wants to make on this computer. */
export interface ComputerRequest {
  kind: 'run_command' | 'write_file' | 'edit_file';
  /** The workflow folder. */
  folder: string;
  /** run_command: the program's full path as found on this computer. */
  program?: string;
  args?: string[];
  /** run_command: where it runs inside the folder ('.' = the folder); files: the file, relative. */
  path: string;
  /** Files: the new content (capped). */
  content?: string;
  /** Files: the old content, when the file exists. */
  previous?: string;
  /** What the agent said it is for. */
  why?: string;
  /** Why this asks, in plain English. */
  reason: string;
  /** What outside content it read first, e.g. "2 web pages and a web search". */
  readBefore?: string;
  /** The rule "Allow from now on" would add; absent = not offered. */
  suggestedRule?: string;
  /** It matched an always-ask rule or the built-in list (deletes files, throws work away…): warn, and don't default to Run. */
  risky?: boolean;
  /** What this step already did on the computer, oldest first (no output or file content). */
  soFar?: ComputerRecord[];
  /**
   * The command already ran kept in the folder (Windows) and failed in a way
   * that looks caused by that: the card offers to run this one command outside
   * the folder. Never remembered, never editable.
   */
  outside?: ComputerOutsideOffer;
}

/** Why a kept-in command failed (Rust `computer::KeptInFailure`), and the end of what it printed. */
export interface ComputerOutsideOffer {
  /** namedObjects: Windows refused the named system objects compilers use (rustc's jobserver); accessDenied: it was refused access to something. */
  cause: 'namedObjects' | 'accessDenied';
  output?: string;
}

/**
 * A run waiting for the user to check an outside action: a connector tool that
 * changes things (Rust `workflows::actions::PendingAction`).
 */
export interface WorkflowAction {
  runId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  connectorId: string;
  connectorName: string;
  tool: string;
  /** What the connector says the tool does. */
  description: string | null;
  /** The call's arguments, exactly as they would be sent. */
  arguments: Record<string, unknown>;
  /** The tool's JSON Schema for its arguments (the Edit form). */
  inputSchema: Record<string, unknown>;
  /** Always asks; "Don't ask again" isn't offered. */
  sensitive: boolean;
  /** Present when this is a command or file change on this computer, not a connector call. */
  computer?: ComputerRequest;
  requestedAt: string;
  expiresAt: string;
}

/** The answer to a `WorkflowAction`. */
export interface WorkflowActionAnswer {
  send: boolean;
  /** The changed arguments; leave out to send them as they were. */
  arguments?: Record<string, unknown>;
  /** Don't ask again for this tool in this workflow (ignored for a sensitive tool). */
  remember?: boolean;
  /** The rule to remember (computer commands); used only with `remember: true`. */
  rule?: string;
}

/** An outside action a workflow takes without asking. */
export interface WorkflowAllowedAction {
  connectorId: string;
  /** The connector's name when it was allowed. */
  connectorName: string;
  tool: string;
}

/** Which of a workflow's outside actions go ahead without asking. */
export interface WorkflowActionRules {
  /** Every action goes ahead without asking (except sensitive ones). */
  allowAll: boolean;
  allowed: WorkflowAllowedAction[];
  /** Command rules; when left out on save, the stored ones are kept. */
  commands?: WorkflowCommandRules;
}

/** Command rules: a program plus leading arguments, optionally ending in ` *`. */
export interface WorkflowCommandRules {
  allow: string[];
  /** Always-ask rules: a matching command asks every time, even when an allow rule covers it. */
  deny: string[];
  /** How often each allow rule let a command run (read-only; kept by the backend on save). */
  uses?: CommandRuleUse[];
}

/** One allow rule's use. */
export interface CommandRuleUse {
  rule: string;
  count: number;
  /** ISO 8601. */
  lastUsedAt: string;
}

/** A rule worth adding: commands the user approved by hand in recent runs that it would have covered (`suggest_command_rules`). */
export interface CommandRuleSuggestion {
  rule: string;
  /** How many approved commands it would have covered. */
  times: number;
  /** One of them, e.g. "git diff --stat". */
  example: string;
}

/** What a command rule matches (`preview_command_rule`). */
export interface CommandRulePreview {
  error: string | null;
  covers: string[];
  doesNotCover: string[];
}

export type ComputerOutcome = 'ran' | 'timedOut' | 'failed' | 'notRun' | 'declined' | 'skipped' | 'changed';

/** One thing an agent did on the computer, in a step's output (`computer[]`). */
export type ComputerRecord =
  | {
      kind: 'command';
      program: string;
      args: string[];
      cwd: string;
      approvedBy: string;
      outcome: ComputerOutcome;
      exitCode?: number;
      durationMs?: number;
      output?: string;
      reason?: string;
      error?: string;
      /** Approved by hand: the rule its card offered (for rule suggestions). */
      suggestedRule?: string;
      /** Kept in the folder, it failed apparently because of that (`computer::KeptInFailure`). */
      keptIn?: 'namedObjects' | 'accessDenied';
      /** Run once outside the folder, approved by hand after it failed kept in. */
      outside?: boolean;
    }
  | {
      kind: 'write' | 'edit';
      path: string;
      approvedBy: string;
      outcome: ComputerOutcome;
      /** A change that went through: the file before and after, when both are under 20,000 characters. */
      previous?: string;
      content?: string;
    };

/** How an outside action ended, in a step's output (`action` or `actions[]`). */
export type WorkflowActionOutcome = 'sent' | 'sentWithoutAsking' | 'notSent' | 'failed';

export interface WorkflowActionRecord {
  connector: { id: string; name: string };
  tool: string;
  arguments: Record<string, unknown>;
  outcome: WorkflowActionOutcome;
  error?: string;
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

/** One thing Conduit added on first run to show the user around. */
export interface ExampleItem {
  kind: 'app' | 'chat' | 'deck' | 'workflow';
  itemId: string;
}

export interface SeedExamplesRequest {
  /** Resolved interface locale, e.g. `de` or `pt-BR`. */
  locale: string;
  themeName: string;
  themeCss: string;
  /** The Morning briefing workflow definition, as the Workflows page builds it. */
  briefingDefinition: unknown;
}

export interface SeedExamplesOutcome {
  seeded: boolean;
  items: ExampleItem[];
}
