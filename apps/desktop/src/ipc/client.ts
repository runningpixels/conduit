import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './errors';
import type {
  AddLocalConnectorRequest,
  AddLocalConnectorResult,
  AddRemoteConnectorRequest,
  AppPaths,
  AppSettings,
  Artifact,
  ArtifactContent,
  ArtifactExportResult,
  Attachment,
  BrandConfig,
  CancelChatStreamRequest,
  SteerChatStreamRequest,
  ConnectorCapability,
  ConnectorDefinition,
  ConnectorGrant,
  ConnectorRuntimeEvent,
  ConnectorRuntimeSnapshot,
  ConnectorServerInfo,
  ConnectorVersion,
  Conversation,
  ConversationExportFormat,
  ConversationExportResult,
  ConversationSummary,
  CredentialRequest,
  CredentialSummary,
  DiagnosticsExport,
  FileState,
  GenerationControls,
  InvokeConnectorToolRequest,
  Message,
  MockStreamRequest,
  ModelInfo,
  OnboardingState,
  PendingWipeResult,
  PrepareMessageEditResult,
  ProviderDescriptor,
  ProviderEvent,
  ProviderRequest,
  RegistryServer,
  RemovalReport,
  SettingsPatch,
  StreamEvent,
  StreamHandle,
  UpdateInfo,
  WipeScope,
  Prompt,
  SkillSummary,
  MemoryItem,
  ConversationFolder,
  SearchMessagesRequest,
  SearchResult,
  UsagePeriod,
  UsageSummaryResponse,
} from './contracts';

export async function getAppPaths(): Promise<AppPaths> {
  return invokeCommand<AppPaths>('get_app_paths');
}

export async function getSettings(): Promise<AppSettings> {
  return invokeCommand<AppSettings>('get_settings');
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  return invokeCommand<AppSettings>('update_settings', { patch });
}

/** ADR-008: OS folder picker for workspace tools (Rust-side only). `null` = cancel. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  return invokeCommand<string | null>('pick_workspace_folder');
}

/**
 * The active white-label brand, or `null` if none is configured. Rust-side
 * validated (hex grammar, dark/light symmetry) — the renderer's `applyBrand`
 * re-validates anyway, since this value also gets cached in localStorage for
 * the pre-paint boot path, and a cache is not a source of truth.
 */
export async function getBrandConfig(): Promise<BrandConfig | null> {
  return invokeCommand<BrandConfig | null>('get_brand_config');
}

/**
 * The active brand logo as a complete, ready-to-render `data:` URI, or `null`
 * if none is configured. Rust assembles the whole URI — including the MIME
 * type, chosen from the file's magic bytes rather than a caller-supplied
 * claim — specifically so a hostile MIME string can never be used to break
 * out of the URI here. The renderer must never build this string from parts
 * (bytes + a MIME it picked); see `brand/logo.ts`'s `isValidLogoDataUri` for
 * the defence-in-depth re-check applied before this value ever reaches an
 * `<img src>`.
 */
export async function getBrandLogo(): Promise<string | null> {
  return invokeCommand<string | null>('get_brand_logo');
}

/**
 * Save a picked logo file. `bytes` is the raw file content; `fileName` is
 * used for its extension only (Rust re-derives the actual type from magic
 * bytes, it does not trust either the extension or a MIME string). Resolves
 * to the stored filename.
 */
export async function saveBrandLogo(bytes: number[], fileName: string): Promise<string> {
  return invokeCommand<string>('save_brand_logo', { bytes, fileName });
}

export async function clearBrandLogo(): Promise<void> {
  return invokeCommand<void>('clear_brand_logo');
}

/**
 * Non-blocking brand warnings (e.g. a palette clearing validation but falling
 * short of WCAG AA). Empty when unbranded, `branding_enabled` is off, or
 * nothing is wrong. A `field`/`message` pair rather than a raw string — the
 * settings UI shows `message` and can point at `field` — mirroring
 * `commands::branding::BrandWarningPayload` on the Rust side, which is
 * hand-written (not ts-rs-derived) since that crate stays IO-agnostic. No
 * generated type exists for it, so the shape is declared here instead.
 */
export interface BrandWarning {
  field: string;
  message: string;
}

export async function getBrandWarnings(): Promise<BrandWarning[]> {
  return invokeCommand<BrandWarning[]>('get_brand_warnings');
}

/**
 * Remove the active brand config (and its logo). Idempotent. Does not touch
 * the renderer's applied state — callers pair this with `clearBrand()`
 * (`brand/applyBrand.ts`) to restore the stock look.
 */
export async function clearBrandConfig(): Promise<void> {
  return invokeCommand<void>('clear_brand_config');
}

/**
 * Import a `brand.md` from a caller-supplied path. Validated exactly like an
 * in-app edit; an invalid source file is rejected and nothing is written.
 *
 * The Branding section does NOT use this directly — see
 * `importBrandFileDialog` below for why (ADR-008: the renderer never invokes
 * a Tauri plugin's own JS command, including the dialog plugin, so a picked
 * path can never originate in the renderer). This wrapper is kept for any
 * caller that already has a trusted path in hand.
 */
export async function importBrandFile(path: string): Promise<BrandConfig> {
  return invokeCommand<BrandConfig>('import_brand_file', { path });
}

/**
 * Import a `brand.md` chosen through an OS file picker, entirely on the Rust
 * side (ADR 008: `docs/adr/adr-008-tauri-capability-surface.md`). The
 * default capability grants `core:*` only — no `dialog:default` — precisely
 * so the renderer cannot call `invokeCommand('plugin:dialog|open')` directly and
 * bypass Conduit's own command layer. This command shows the picker and does
 * the import in one Rust-side round trip; the renderer never sees, and
 * cannot supply, a filesystem path.
 *
 * Resolves to `null` when the user cancels the picker — that is not an
 * error and callers must not treat it as one (no error text, no status
 * toast, no state change). Resolves to the imported `BrandConfig` on
 * success.
 */
/**
 * Native file dialogs are drawn by the OS, outside the webview, so they cannot
 * reach the message catalog. The caller passes their chrome down already
 * translated (D15) — which is why these wrappers take a `dialogTitle` and,
 * where the picker has a file-type dropdown, a `filterName`.
 */
export async function importBrandFileDialog(
  dialogTitle: string,
  filterName: string,
): Promise<BrandConfig | null> {
  return invokeCommand<BrandConfig | null>('import_brand_file_dialog', {
    dialogTitle,
    filterName,
  });
}

/**
 * Apply renderer-authored edits (identity + palette) to the on-disk
 * `brand.md`. The renderer never authors TOML itself — this sends a typed
 * `BrandConfig` draft and Rust merges it surgically into any existing file,
 * preserving hand-written comments and the prose body. The response is the
 * re-parsed, authoritative config: treat it as truth, not the draft that was
 * sent, since Rust may normalize values the draft only approximated.
 *
 * Added alongside Phase 3 (Settings → Branding); a Rust agent registers the
 * command in parallel, so it may not exist yet in every build this runs
 * against. Callers must not assume it always resolves.
 */
export async function applyBrandEdits(config: BrandConfig): Promise<BrandConfig> {
  return invokeCommand<BrandConfig>('apply_brand_edits', { config });
}

/**
 * Parse and validate `source` (raw `brand.md`-shaped text, frontmatter and
 * all) as a `BrandConfig` — pure parse+validate, no persistence, no side
 * effects. This is what the document panel uses to decide whether a
 * `+++`-prefixed Markdown artifact is actually a brand proposal before it
 * shows any Preview/Apply affordance for it: a rejection here means "not a
 * valid brand," not "the command failed," and callers should treat it the
 * same way in both cases — show nothing, rather than surface an error for
 * what might just be an ordinary Markdown document that happens to start
 * with `+++`.
 *
 * Added alongside Phase 4 (chat-authored themes); a Rust agent registers the
 * `parse_brand_source` command in parallel, so it may not exist yet in every
 * build this runs against. Callers must not assume it always resolves.
 */
export async function parseBrandSource(source: string): Promise<BrandConfig> {
  return invokeCommand<BrandConfig>('parse_brand_source', { source });
}

/**
 * Parse, validate, and persist `source` as the active `brand.md` — the
 * "Apply" path for a chat-authored theme (white-label plan §4, Phase 4).
 * `source` is raw text (a whole `brand.md`, frontmatter and body), not a
 * `BrandConfig` draft — unlike `applyBrandEdits` above, which the Settings
 * editor uses for structured field-by-field edits and which is merged into
 * whatever `brand.md` already exists. This one replaces it outright, which
 * is why every caller must confirm with the user first: it is happy to
 * overwrite an existing brand with no merge.
 *
 * Returns the re-parsed, authoritative config, exactly like
 * `applyBrandEdits` — treat it as truth, not `source` itself.
 *
 * Unlike `parseBrandSource`/`write_brand_theme`, `set_brand_config` is
 * already registered on the Rust side (`commands/branding.rs`) — it
 * predates this phase, wired for the Settings → Branding import path.
 */
export async function setBrandConfig(source: string): Promise<BrandConfig> {
  return invokeCommand<BrandConfig>('set_brand_config', { source });
}

/**
 * Export the active brand (config + logo, if any) to `destPath` for sharing
 * or use as a Mode B build input. Same registration caveat as
 * `applyBrandEdits` above, and same ADR-008 note as `importBrandFile`: kept
 * for a caller with an already-trusted destination path, not used by the
 * Branding section — see `exportBrandConfigDialog` below.
 */
export async function exportBrandConfig(destPath: string): Promise<void> {
  return invokeCommand<void>('export_brand_config', { destPath });
}

/**
 * Export the active brand through an OS save-location picker, entirely on
 * the Rust side — the export counterpart of `importBrandFileDialog` above;
 * see that comment and ADR 008 for why this exists instead of a JS-side
 * `invokeCommand('plugin:dialog|save')`.
 *
 * Resolves to `null` when the user cancels the picker (not an error — no
 * error text, no status toast, no state change). A non-null resolution means
 * the export completed.
 */
export async function exportBrandConfigDialog(
  dialogTitle: string,
  filterName: string,
): Promise<void | null> {
  return invokeCommand<void | null>('export_brand_config_dialog', {
    dialogTitle,
    filterName,
  });
}

export async function saveProviderCredential(request: CredentialRequest): Promise<CredentialSummary> {
  return invokeCommand<CredentialSummary>('save_provider_credential', { request });
}

export async function loadProviderCredentialReference(providerId: string): Promise<CredentialSummary> {
  return invokeCommand<CredentialSummary>('load_provider_credential_reference', { providerId });
}

export async function validateProviderCredentials(providerId: string): Promise<void> {
  await invokeCommand('validate_provider_credentials', { providerId });
}

export async function listProviderDescriptors(): Promise<ProviderDescriptor[]> {
  return invokeCommand<ProviderDescriptor[]>('list_provider_descriptors');
}

export async function listProviderModels(providerId: string): Promise<ModelInfo[]> {
  return invokeCommand<ModelInfo[]>('list_provider_models', { providerId });
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
  return invokeCommand<StreamHandle>('start_chat_stream', { request, channel, runtimeChannel });
}

export async function cancelChatStream(request: CancelChatStreamRequest): Promise<void> {
  await invokeCommand('cancel_chat_stream', { request });
}

export async function steerChatStream(request: SteerChatStreamRequest): Promise<void> {
  await invokeCommand('steer_chat_stream', { request });
}

export async function submitAskUser(
  toolCallId: string,
  answers: Record<string, unknown>,
): Promise<void> {
  await invokeCommand('submit_ask_user', {
    request: { toolCallId, answers },
  });
}

export async function getConversationMessages(conversationId: string): Promise<Message[]> {
  return invokeCommand<Message[]>('get_conversation_messages', { conversationId });
}

export interface ConversationCompaction {
  id: string;
  conversationId: string;
  createdAt: string;
  summaryText: string;
  throughMessageId: string;
  keptFromMessageId: string;
  modelId: string;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
}

export async function getConversationCompaction(
  conversationId: string,
): Promise<ConversationCompaction | null> {
  return invokeCommand<ConversationCompaction | null>('get_conversation_compaction', { conversationId });
}

export async function compactConversation(
  conversationId: string,
): Promise<ConversationCompaction | null> {
  return invokeCommand<ConversationCompaction | null>('compact_conversation', { conversationId });
}

export async function getRequestProviderEvents(
  conversationId: string,
  requestId: string,
): Promise<ProviderEvent[]> {
  return invokeCommand<ProviderEvent[]>('get_request_provider_events', { conversationId, requestId });
}

export async function createConversation(title?: string): Promise<Conversation> {
  return invokeCommand<Conversation>('create_conversation', { title });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return invokeCommand<ConversationSummary[]>('list_conversations');
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  return invokeCommand<Conversation | null>('get_conversation', { conversationId });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await invokeCommand('delete_conversation', { conversationId });
}

export async function setConversationTitle(conversationId: string, title: string): Promise<void> {
  await invokeCommand('set_conversation_title', { conversationId, title });
}

export async function setConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
  await invokeCommand('set_conversation_pinned', { conversationId, pinned });
}

export async function setConversationArchived(
  conversationId: string,
  archived: boolean,
): Promise<void> {
  await invokeCommand('set_conversation_archived', { conversationId, archived });
}

export async function setConversationFolder(
  conversationId: string,
  folderId: string | null,
): Promise<void> {
  await invokeCommand('set_conversation_folder', { conversationId, folderId });
}

export async function listConversationFolders(): Promise<ConversationFolder[]> {
  return invokeCommand<ConversationFolder[]>('list_conversation_folders');
}

export async function createConversationFolder(name: string): Promise<ConversationFolder> {
  return invokeCommand<ConversationFolder>('create_conversation_folder', { name });
}

export async function renameConversationFolder(
  folderId: string,
  name: string,
): Promise<ConversationFolder> {
  return invokeCommand<ConversationFolder>('rename_conversation_folder', { folderId, name });
}

export async function deleteConversationFolder(folderId: string): Promise<void> {
  await invokeCommand('delete_conversation_folder', { folderId });
}

/** Bind or clear the workspace folder for a conversation. `null` clears. */
export async function setConversationWorkspace(
  conversationId: string,
  workspaceRoot: string | null,
): Promise<Conversation> {
  return invokeCommand<Conversation>('set_conversation_workspace', {
    conversationId,
    workspaceRoot,
  });
}

/** Set or clear per-conversation generation controls / user instructions. `null` clears. */
export async function setConversationChatSettings(
  conversationId: string,
  generationControls: GenerationControls | null,
  userInstructions: string | null,
): Promise<Conversation> {
  return invokeCommand<Conversation>('set_conversation_chat_settings', {
    conversationId,
    generationControls,
    userInstructions,
  });
}

export async function deleteAllConversations(): Promise<Conversation> {
  return invokeCommand<Conversation>('delete_all_conversations');
}

export async function exportDiagnostics(): Promise<DiagnosticsExport> {
  return invokeCommand<DiagnosticsExport>('export_diagnostics');
}

export async function previewConversationExport(
  conversationId: string,
  format: ConversationExportFormat,
): Promise<string> {
  return invokeCommand<string>('preview_conversation_export', { conversationId, format });
}

export async function exportConversationDialog(
  conversationId: string,
  format: ConversationExportFormat,
  dialogTitle: string,
  filterName: string,
  includeAttachments = false,
): Promise<ConversationExportResult | null> {
  return invokeCommand<ConversationExportResult | null>('export_conversation_dialog', {
    conversationId,
    format,
    includeAttachments,
    dialogTitle,
    filterName,
  });
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
  return invokeCommand<boolean>('get_diagnostics_disclosure_acknowledged');
}

export async function acknowledgeDiagnosticsDisclosure(): Promise<void> {
  await invokeCommand('acknowledge_diagnostics_disclosure');
}

/// Reveal the app's exports directory in the OS file manager. Takes no path —
/// the Rust command opens `AppPaths::exports` server-side, so the renderer
/// cannot direct the shell to open an arbitrary path/URL.
export async function revealPath(): Promise<void> {
  await invokeCommand('reveal_path');
}

/// Reveal the artifacts workspace directory in the OS file manager.
/// Path is resolved server-side from `AppPaths::artifacts`.
export async function revealArtifactsDir(): Promise<void> {
  await invokeCommand('reveal_artifacts_dir');
}

/// Reveal a file-backed artifact's parent folder in the OS file manager.
/// The renderer supplies only the artifact id; the path is resolved server-side.
export async function revealArtifact(artifactId: string): Promise<void> {
  await invokeCommand('reveal_artifact', { artifactId });
}

/// Open a validated http(s) URL in the system browser. Rust rejects non-http(s)
/// schemes, userinfo, empty hosts, and overlong strings before calling shell.
export async function openExternalUrl(url: string): Promise<void> {
  await invokeCommand('open_external_url', { url });
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
  return invokeCommand<UpdateInfo | null>('check_for_update');
}

export async function downloadAndInstallUpdate(): Promise<void> {
  await invokeCommand('download_and_install_update');
}

// =============================================================================
// Phase 6 M6.4 — First-run onboarding (BYOK gate)
// =============================================================================

/** Boot-time onboarding state. `App.tsx` gates the workspace on this:
 *  migration recovery takes priority, then the BYOK gate (`onboardingCompleted`
 *  + `hasProviderCredential`). */
export async function getOnboardingState(): Promise<OnboardingState> {
  return invokeCommand<OnboardingState>('get_onboarding_state');
}

/** Dismiss the migration-recovery notice and continue with the fresh store.
 *  The backup file is left on disk — acknowledging the failure is not consent
 *  to delete the only copy of the user's data. */
export async function acknowledgeMigrationRecovery(): Promise<void> {
  await invokeCommand('acknowledge_migration_recovery');
}

/** Delete the recovery backups and dismiss the notice. Runs in-session: the
 *  backups are inert copies, and the live store is untouched. */
export async function discardMigrationBackup(): Promise<RemovalReport> {
  return invokeCommand<RemovalReport>('discard_migration_backup');
}

/** Schedule a local-data wipe for the next launch. Nothing is deleted until
 *  the app restarts — the live database is held open for the whole session, so
 *  the delete has to happen at startup. Follow this with `restartApp()`. */
export async function requestLocalDataWipe(scope: WipeScope): Promise<PendingWipeResult> {
  return invokeCommand<PendingWipeResult>('request_local_data_wipe', { scope });
}

/** Abandon a scheduled wipe (the user backed out of the restart). */
export async function cancelLocalDataWipe(): Promise<void> {
  await invokeCommand('cancel_local_data_wipe');
}

/** Restart the app process. `window.location.reload()` is not a substitute:
 *  it reloads the webview but leaves the Rust process and its startup state
 *  untouched, so migrations never re-run and a pending wipe never applies. */
export async function restartApp(): Promise<void> {
  await invokeCommand('restart_app');
}

export async function startMockStream(
  request: MockStreamRequest,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamHandle> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invokeCommand<StreamHandle>('start_mock_stream', { request, channel });
}

export async function cancelMockStream(requestId: string): Promise<void> {
  await invokeCommand('cancel_mock_stream', { requestId });
}

// =============================================================================
// Phase 4 — MCP connector runtime
// =============================================================================

export async function listConnectorDefinitions(): Promise<ConnectorDefinition[]> {
  return invokeCommand<ConnectorDefinition[]>('list_connector_definitions');
}

export async function listConnectorVersions(connectorId: string): Promise<ConnectorVersion[]> {
  return invokeCommand<ConnectorVersion[]>('list_connector_versions', { connectorId });
}

export async function listConnectorGrants(status?: 'active' | 'revoked' | 'pending' | 'provisioned'): Promise<ConnectorGrant[]> {
  return invokeCommand<ConnectorGrant[]>('list_connector_grants', { status });
}

export async function listConnectorCapabilities(connectorVersionId: string): Promise<ConnectorCapability[]> {
  return invokeCommand<ConnectorCapability[]>('list_connector_capabilities', { connectorVersionId });
}

export async function getConnectorRuntimeStates(): Promise<ConnectorRuntimeSnapshot[]> {
  return invokeCommand<ConnectorRuntimeSnapshot[]>('get_connector_runtime_states');
}

export async function startConnector(connectorVersionId: string): Promise<ConnectorServerInfo> {
  return invokeCommand<ConnectorServerInfo>('start_connector', { connectorVersionId });
}

export async function stopConnector(connectorVersionId: string): Promise<void> {
  await invokeCommand('stop_connector', { connectorVersionId });
}

export async function discoverConnector(connectorVersionId: string): Promise<ConnectorCapability[]> {
  return invokeCommand<ConnectorCapability[]>('discover_connector', { connectorVersionId });
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
  return invokeCommand<StreamHandle>('invoke_connector_tool', { request, channel });
}

export async function approveConnectorToolCall(
  toolCallId: string,
  options?: { remember?: 'conversation' | 'always'; conversationId?: string },
): Promise<void> {
  await invokeCommand('approve_connector_tool_call', {
    toolCallId,
    remember: options?.remember ?? null,
    conversationId: options?.conversationId ?? null,
  });
}

export async function denyConnectorToolCall(toolCallId: string): Promise<void> {
  await invokeCommand('deny_connector_tool_call', { toolCallId });
}

export interface ToolApprovalMemoryRow {
  id: string;
  toolKey: string;
  scope: string;
  conversationId: string | null;
  createdAt: string;
}

export async function listToolApprovalMemory(): Promise<ToolApprovalMemoryRow[]> {
  return invokeCommand<ToolApprovalMemoryRow[]>('list_tool_approval_memory');
}

export async function revokeToolApprovalMemory(id: string): Promise<boolean> {
  return invokeCommand<boolean>('revoke_tool_approval_memory', { id });
}

export async function revokeConnectorGrant(
  grantId: string,
  connectorVersionId?: string,
): Promise<void> {
  await invokeCommand('revoke_connector_grant', { grantId, connectorVersionId });
}

export async function addLocalConnector(request: AddLocalConnectorRequest): Promise<AddLocalConnectorResult> {
  return invokeCommand<AddLocalConnectorResult>('add_local_connector', { request });
}

export async function searchMcpRegistry(query: string): Promise<RegistryServer[]> {
  return invokeCommand<RegistryServer[]>('search_mcp_registry', { query });
}

export async function addRemoteConnector(request: AddRemoteConnectorRequest): Promise<AddLocalConnectorResult> {
  return invokeCommand<AddLocalConnectorResult>('add_remote_connector', { request });
}

/**
 * `signedInMessage` and `signInFailedMessage` are the callback page's copy.
 * That page is served on loopback and rendered in the user's system browser,
 * outside the webview, so it cannot reach the catalog — the caller translates
 * it here and Rust only substitutes the authorization server's own error text
 * into the `{detail}` placeholder (D15).
 */
export async function signinRemoteConnector(
  connectorVersionId: string,
  signedInMessage: string,
  signInFailedMessage: string,
): Promise<void> {
  await invokeCommand('signin_remote_connector', {
    connectorVersionId,
    signedInMessage,
    signInFailedMessage,
  });
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
  return invokeCommand<Artifact>('create_artifact', { conversationId, kind, title, sourceMessageId });
}

/// List a conversation's artifacts, newest-first. Payload metadata is included
/// but inline content is NOT — fetch via `getArtifact` or `getArtifactContentBytes`.
export async function listArtifacts(conversationId: string): Promise<Artifact[]> {
  return invokeCommand<Artifact[]>('list_artifacts', { conversationId });
}

/// Resolve the persisted message row id for a chat stream `requestId`.
export async function getMessageIdByRequest(requestId: string): Promise<string | null> {
  return invokeCommand<string | null>('get_message_id_by_request', { requestId });
}

// =============================================================================
// FTS5 Full-Text Search
// =============================================================================

/// Search messages using the FTS5 index. Returns results ordered by relevance.
export async function searchMessages(
  request: SearchMessagesRequest,
): Promise<SearchResult[]> {
  return invokeCommand<SearchResult[]>('search_messages', { request });
}

// --- Usage Analytics -------------------------------------------------------

export async function getUsageSummary(period: UsagePeriod): Promise<UsageSummaryResponse> {
  return invokeCommand<UsageSummaryResponse>('get_usage_summary', { period });
}

// --- Retry & Fork ----------------------------------------------------------

/** Remove the last assistant turn's data; returns remaining message count. */
export async function removeLastTurn(conversationId: string): Promise<number> {
  return invokeCommand<number>('remove_last_turn', { conversationId });
}

/** Fork a conversation at a message; returns the new conversation. */
export async function forkConversation(
  conversationId: string,
  forkMessageId: string,
): Promise<Conversation> {
  return invokeCommand<Conversation>('fork_conversation', { conversationId, forkMessageId });
}

/** Truncate tip or fork mid-thread before edit-and-resend. Does not start a stream. */
export async function prepareMessageEdit(
  conversationId: string,
  messageId: string,
): Promise<PrepareMessageEditResult> {
  return invokeCommand<PrepareMessageEditResult>('prepare_message_edit', {
    conversationId,
    messageId,
  });
}

// --- Prompts Library -------------------------------------------------------

export async function createPrompt(
  title: string,
  body: string,
  folder?: string,
  tags?: string[],
): Promise<Prompt> {
  return invokeCommand<Prompt>('create_prompt', { title, body, folder, tags });
}

export async function listPrompts(folder?: string): Promise<Prompt[]> {
  return invokeCommand<Prompt[]>('list_prompts', { folder });
}

export async function getPrompt(id: string): Promise<Prompt | null> {
  return invokeCommand<Prompt | null>('get_prompt', { id });
}

export async function updatePrompt(
  id: string,
  title: string,
  body: string,
  folder?: string,
  tags?: string[],
): Promise<Prompt> {
  return invokeCommand<Prompt>('update_prompt', { id, title, body, folder, tags });
}

export async function deletePrompt(id: string): Promise<void> {
  return invokeCommand<void>('delete_prompt', { id });
}

export async function listPromptFolders(): Promise<string[]> {
  return invokeCommand<string[]>('list_prompt_folders');
}

export async function listSkills(workspaceRoot?: string | null): Promise<SkillSummary[]> {
  return invokeCommand<SkillSummary[]>('list_skills', {
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function getSkillPromptBlock(
  skillIds: string[],
  workspaceRoot?: string | null,
): Promise<string> {
  return invokeCommand<string>('get_skill_prompt_block', {
    skillIds,
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function listConversationSkills(conversationId: string): Promise<string[]> {
  return invokeCommand<string[]>('list_conversation_skills', { conversationId });
}

export async function setConversationSkills(
  conversationId: string,
  skillIds: string[],
): Promise<string[]> {
  return invokeCommand<string[]>('set_conversation_skills', { conversationId, skillIds });
}

export async function importSkillFolder(dialogTitle: string): Promise<SkillSummary | null> {
  return invokeCommand<SkillSummary | null>('import_skill_folder', { dialogTitle });
}

export async function importSkillZip(
  dialogTitle: string,
  filterName: string,
): Promise<SkillSummary | null> {
  return invokeCommand<SkillSummary | null>('import_skill_zip', { dialogTitle, filterName });
}

export async function exportSkillFolder(
  skillId: string,
  dialogTitle: string,
  workspaceRoot?: string | null,
): Promise<string | null> {
  return invokeCommand<string | null>('export_skill_folder', {
    skillId,
    workspaceRoot: workspaceRoot ?? null,
    dialogTitle,
  });
}

export async function exportSkillZip(
  skillId: string,
  dialogTitle: string,
  filterName: string,
  workspaceRoot?: string | null,
): Promise<string | null> {
  return invokeCommand<string | null>('export_skill_zip', {
    skillId,
    workspaceRoot: workspaceRoot ?? null,
    dialogTitle,
    filterName,
  });
}

export async function deleteManagedSkill(skillId: string): Promise<void> {
  return invokeCommand('delete_managed_skill', { skillId });
}

export async function revealSkillsDir(): Promise<string> {
  return invokeCommand<string>('reveal_skills_dir');
}

export async function listMemoryItems(status?: 'pending' | 'active' | null): Promise<MemoryItem[]> {
  return invokeCommand<MemoryItem[]>('list_memory_items', { status: status ?? null });
}

export async function createMemoryItem(
  body: string,
  kind?: 'core' | 'note',
  pinned?: boolean,
): Promise<MemoryItem> {
  return invokeCommand<MemoryItem>('create_memory_item', { body, kind: kind ?? null, pinned: pinned ?? null });
}

export async function updateMemoryItem(
  id: string,
  body: string,
  kind?: 'core' | 'note',
  pinned?: boolean,
): Promise<MemoryItem> {
  return invokeCommand<MemoryItem>('update_memory_item', { id, body, kind: kind ?? null, pinned: pinned ?? null });
}

export async function deleteMemoryItem(id: string): Promise<void> {
  return invokeCommand('delete_memory_item', { id });
}

export async function acceptMemoryItem(id: string): Promise<MemoryItem> {
  return invokeCommand<MemoryItem>('accept_memory_item', { id });
}

export async function getMemoryPromptBlock(): Promise<string> {
  return invokeCommand<string>('get_memory_prompt_block');
}

/// Fetch a single payload-bearing artifact (inline content decrypted).
export async function getArtifact(artifactId: string): Promise<Artifact | null> {
  return invokeCommand<Artifact | null>('get_artifact', { artifactId });
}

/// Overwrite the artifact's single payload in place (no version history). For
/// `File` content the bytes are written as an encrypted blob; inline `Text`/`Json`
/// are encrypted in the artifact row. Returns the updated artifact.
export async function setArtifactContent(
  artifactId: string,
  content: ArtifactContent,
  mimeType?: string,
): Promise<Artifact> {
  return invokeCommand<Artifact>('set_artifact_content', { artifactId, mimeType, content });
}

export async function setArtifactTitle(artifactId: string, title: string): Promise<Artifact> {
  return invokeCommand<Artifact>('set_artifact_title', { artifactId, title });
}

/// Read the artifact's content as raw bytes (inline content as UTF-8; File-content
/// as the decrypted blob). Capped at 5 MiB for preview — larger File-content must
/// use `exportArtifact`.
export async function getArtifactContentBytes(artifactId: string): Promise<number[]> {
  return invokeCommand<number[]>('get_artifact_content_bytes', { artifactId });
}

/// Read full File-content bytes for recovery ("Use disk"). Not capped; only for
/// the modified-file recovery path.
export async function readArtifactFileBytes(artifactId: string): Promise<number[]> {
  return invokeCommand<number[]>('read_artifact_file_bytes', { artifactId });
}

/// File-state machine for File-content artifacts. `noFileContent` for inline
/// (non-file) payloads; otherwise the on-disk blob hash is compared to
/// `content_hash` → `ok` | `modified` | `missing`.
export async function checkArtifactFileState(artifactId: string): Promise<FileState> {
  return invokeCommand<FileState>('check_artifact_file_state', { artifactId });
}

/// Export the artifact's current payload to disk, with an optional `.conduit.json`
/// metadata sidecar. (M5.)
export async function exportArtifact(
  artifactId: string,
  includeMetadata: boolean,
): Promise<ArtifactExportResult> {
  return invokeCommand<ArtifactExportResult>('export_artifact', { artifactId, includeMetadata });
}

// --- Attachments -----------------------------------------------------------

export async function saveAttachment(
  conversationId: string,
  bytes: number[],
  mimeType: string,
  origin?: string,
): Promise<Attachment> {
  return invokeCommand<Attachment>('save_attachment', { conversationId, bytes, mimeType, origin });
}

export async function listAttachments(conversationId: string): Promise<Attachment[]> {
  return invokeCommand<Attachment[]>('list_attachments', { conversationId });
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  await invokeCommand('delete_attachment', { attachmentId });
}

export async function getAttachmentBytes(attachmentId: string): Promise<number[]> {
  return invokeCommand<number[]>('get_attachment_bytes', { attachmentId });
}

// Phase 7 / M-WebSearch: local database reset (Privacy & Data section).
// Backs up the current DB and deletes the live file. The user must restart
// Conduit to create a fresh store. Attachments and artifacts on disk are
// left in place but are no longer indexed.
export async function resetLocalDatabase(): Promise<{ backupPath: string }> {
  return invokeCommand<{ backupPath: string }>('reset_local_database');
}
