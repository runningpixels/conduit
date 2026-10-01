import { Channel } from '@tauri-apps/api/core';
import { invokeCommand, IpcError } from './errors';
import type { BridgeErrorCode } from '../artifacts/pageBridge';
import type {
  AddLocalConnectorRequest,
  AddLocalConnectorResult,
  AddRemoteConnectorRequest,
  AppCategory,
  AppDetail,
  AppInput,
  AppPaths,
  AppSummary,
  DeckDetail,
  DeckSnapshotCause,
  DeckSnapshotSummary,
  DeckStage,
  DeckSummary,
  StorylineItem,
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
  ConnectorPromptInfo,
  ConnectorResourceInfo,
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
  PromptArguments,
  ResourceBlock,
  ResourceRef,
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
  UpdateStatus,
  WipeScope,
  Prompt,
  SkillSummary,
  MemoryItem,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowSchedule,
  ScheduleSpec,
  WorkflowSummary,
  WorkflowPermissions,
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowQuestion,
  ConversationFolder,
  KnowledgeCollection,
  KnowledgeContext,
  KnowledgeDocument,
  KnowledgeImportOutcome,
  KnowledgeImportProgress,
  KnowledgePassage,
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
// Artifact network access (ADR-010)
// =============================================================================

/** Who a page belongs to, for network grants: `artifact:<id>` or `app:<id>`. */
export type PagePrincipal = `artifact:${string}` | `app:${string}`;

export function artifactPrincipal(artifactId: string): PagePrincipal {
  return `artifact:${artifactId}`;
}

export function appPrincipal(appId: string): PagePrincipal {
  return `app:${appId}`;
}

export interface ArtifactFetchRequest {
  principal: PagePrincipal;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  /** Base64. */
  body?: string;
}

export interface ArtifactFetchResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  /** Base64. */
  body: string;
  url: string;
}

/** Make a request for a page, to a site the user allowed it. Rust re-checks
 *  the grant, the address and every cap. */
export async function artifactFetch(request: ArtifactFetchRequest): Promise<ArtifactFetchResponse> {
  return invokeCommand<ArtifactFetchResponse>('artifact_fetch', { request });
}

/** `session`: until Conduit quits. `page`: remembered for this page. */
export type ArtifactNetworkGrantScope = 'session' | 'page';

export async function grantArtifactNetwork(
  principal: PagePrincipal,
  host: string,
  scope: ArtifactNetworkGrantScope,
): Promise<void> {
  await invokeCommand('grant_artifact_network', { principal, host, scope });
}

export interface ArtifactNetworkState {
  /** Why pages cannot connect at all right now, or null when they can. */
  blockedReason: string | null;
  always: string[];
  session: string[];
}

export async function getArtifactNetworkState(principal: PagePrincipal): Promise<ArtifactNetworkState> {
  return invokeCommand<ArtifactNetworkState>('get_artifact_network_state', { principal });
}

export interface ArtifactNetworkGrant {
  principal: PagePrincipal;
  /** Whether the page is an artifact in a chat or a saved app. */
  kind: 'artifact' | 'app';
  host: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The artifact's title or the app's name; null when untitled. */
  title: string | null;
}

export async function listArtifactNetworkGrants(): Promise<ArtifactNetworkGrant[]> {
  return invokeCommand<ArtifactNetworkGrant[]>('list_artifact_network_grants');
}

export async function revokeArtifactNetworkGrant(principal: PagePrincipal, host: string): Promise<void> {
  await invokeCommand('revoke_artifact_network_grant', { principal, host });
}

export async function clearArtifactNetworkGrants(principal?: PagePrincipal): Promise<void> {
  await invokeCommand('clear_artifact_network_grants', { principal: principal ?? null });
}

// =============================================================================
// Page bridge storage (ADR-012)
// =============================================================================

/** How much a page has stored, and how many keys. Hand-written: no
 *  `AppSummary.storage`/generated binding is depended on here — see
 *  `docs/private/bridge-storage-contract.md`. Mirrors Rust's
 *  `PageStorageUsage` (ts-rs) once that lands in `@conduit/config-schema`. */
export interface PageStorageUsage {
  bytes: number;
  keys: number;
}

/** The value stored for `key`, or `null` when there is none. */
export async function pageStorageGet(principal: PagePrincipal, key: string): Promise<unknown> {
  return invokeCommand<unknown>('page_storage_get', { principal, key });
}

/** `value` must be JSON-serializable; Rust enforces the size and count caps
 *  (docs/private/bridge-storage-contract.md) and fails the whole write rather
 *  than partly applying it. */
export async function pageStorageSet(principal: PagePrincipal, key: string, value: unknown): Promise<void> {
  await invokeCommand('page_storage_set', { principal, key, value });
}

export async function pageStorageDelete(principal: PagePrincipal, key: string): Promise<void> {
  await invokeCommand('page_storage_delete', { principal, key });
}

/** Sorted keys, optionally limited to a prefix. */
export async function pageStorageKeys(principal: PagePrincipal, prefix?: string): Promise<string[]> {
  return invokeCommand<string[]>('page_storage_keys', { principal, prefix: prefix ?? null });
}

export async function pageStorageUsage(principal: PagePrincipal): Promise<PageStorageUsage> {
  return invokeCommand<PageStorageUsage>('page_storage_usage', { principal });
}

/** Erases every key the principal owns. Used by the app view's "Clear data". */
export async function pageStorageClear(principal: PagePrincipal): Promise<void> {
  await invokeCommand('page_storage_clear', { principal });
}

/** The data viewer's rows: each stored key with its size and last change. */
export async function pageStorageEntries(principal: PagePrincipal): Promise<PageStorageEntry[]> {
  return invokeCommand<PageStorageEntry[]>('page_storage_entries', { principal });
}

const BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set<BridgeErrorCode>([
  'invalid',
  'quota',
  'rate_limited',
  'unavailable',
  'not_granted',
  'timeout',
]);

/**
 * Maps a `page_storage_*`/`page_llm_*` rejection to a bridge error. Unlike the
 * rest of this file's commands (D9's `{ code, params, fallback }` `AppError`
 * envelope), these commands reject with a bare `Err(String)` whose text
 * starts with a code and a colon — `"quota: too big"` — per
 * `docs/private/bridge-storage-contract.md` (storage) and
 * `docs/private/page-llm-contract.md` (model access, which adds the
 * `not_granted` and `timeout` codes). An unrecognised prefix (or a command
 * that hasn't been converted at all) maps to `unavailable` rather than
 * guessing.
 */
export function bridgeErrorFromIpc(e: unknown): { code: BridgeErrorCode; message: string } {
  const text = e instanceof IpcError || e instanceof Error ? e.message : String(e);
  const at = text.indexOf(': ');
  if (at > 0) {
    const code = text.slice(0, at);
    if (BRIDGE_ERROR_CODES.has(code)) {
      return { code: code as BridgeErrorCode, message: text.slice(at + 2) };
    }
  }
  return { code: 'unavailable', message: text };
}

// =============================================================================
// Page model access (ADR-014)
//
// The page-model types come from the Rust schema (ts-rs); the request and
// reply keep the names callers already use.
// =============================================================================

export type { PageLlmState };
export type PageLlmCompleteRequest = PageLlmRequest;
export type PageLlmCompleteResult = PageLlmReply;

/** `session`: until Conduit quits. `page`: remembered for this page, for the
 *  provider active when granted — switching providers asks again. */
export type PageLlmGrantScope = 'session' | 'page';

/** A page's `window.conduit.llm.complete()` request (ADR-014). */
export async function pageLlmState(principal: PagePrincipal, slot?: AppLlmSlot): Promise<PageLlmState> {
  return invokeCommand<PageLlmState>('page_llm_state', { principal, slot: slot ?? null });
}

/** Grants `principal` model access for the CURRENT active provider. */
/** Grants the provider `slot` resolves to for this principal (an app's
 *  mapping, else the active provider). */
export async function grantPageLlm(
  principal: PagePrincipal,
  scope: PageLlmGrantScope,
  slot?: AppLlmSlot,
): Promise<void> {
  await invokeCommand('grant_page_llm', { principal, scope, slot: slot ?? null });
}

/** Clears both the session and the stored (page-scoped) grant. */
export async function revokePageLlm(principal: PagePrincipal): Promise<void> {
  await invokeCommand('revoke_page_llm', { principal });
}

/** Text in, text out: no tools, no history, no memory (ADR-014). Rejects with
 *  the `code: message` convention `bridgeErrorFromIpc` parses — `not_granted`,
 *  `unavailable`, `rate_limited`, `invalid`, or `timeout`. */
export async function pageLlmComplete(
  principal: PagePrincipal,
  request: PageLlmCompleteRequest,
): Promise<PageLlmCompleteResult> {
  return invokeCommand<PageLlmCompleteResult>('page_llm_complete', { principal, request });
}

// =============================================================================
// Per-app settings (docs/private/app-settings-contract.md)
// =============================================================================

export type { AppActivityEntry, AppLlmSlot, AppModelChoice, AppSettingsView, PageLlmProviderGrant, PageStorageEntry };

export async function getAppSettings(id: string): Promise<AppSettingsView> {
  return invokeCommand<AppSettingsView>('get_app_settings', { id });
}

/** `choice: null` returns the slot to following its fallback. */
/** Providers an app's model slot can be mapped to now (configured and usable). */
export async function listConfiguredProviders(): Promise<string[]> {
  return invokeCommand<string[]>('list_configured_providers');
}

export async function setAppModelSlot(
  id: string,
  slot: AppLlmSlot,
  choice: AppModelChoice | null,
): Promise<AppSettingsView> {
  return invokeCommand<AppSettingsView>('set_app_model_slot', { id, slot, choice });
}

/** `cap: null` returns to the default limit; Rust rejects outside 1,000–10,000,000. */
export async function setAppDailyTokenCap(id: string, cap: number | null): Promise<AppSettingsView> {
  return invokeCommand<AppSettingsView>('set_app_daily_token_cap', { id, cap });
}

/** Newest first. */
export async function listAppActivity(id: string, limit?: number): Promise<AppActivityEntry[]> {
  return invokeCommand<AppActivityEntry[]>('list_app_activity', { id, limit: limit ?? null });
}

/** Opens a save dialog in Rust; the saved path, or `null` when cancelled. */
export async function exportAppDataDialog(id: string): Promise<string | null> {
  return invokeCommand<string | null>('export_app_data_dialog', { id });
}

export async function listPageLlmGrants(principal: PagePrincipal): Promise<PageLlmProviderGrant[]> {
  return invokeCommand<PageLlmProviderGrant[]>('list_page_llm_grants', { principal });
}

export async function revokePageLlmProvider(principal: PagePrincipal, providerId: string): Promise<void> {
  await invokeCommand('revoke_page_llm_provider', { principal, providerId });
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

/// Non-networked read: when this machine last completed a check, and whether a
/// verified payload is already staged for the next quit. The scheduler calls
/// this before deciding to check, so an app opened twenty times a day still
/// checks once.
export async function getUpdateStatus(): Promise<UpdateStatus> {
  return invokeCommand<UpdateStatus>('get_update_status');
}

/// The `automatic` policy's install path: re-checks, runs the same migration
/// precheck as `downloadAndInstallUpdate`, downloads and verifies the payload,
/// then holds it in memory for the next quit. Does NOT restart, so it is safe
/// to call while the user is mid-conversation. Returns `null` when checks are
/// disabled or nothing is available.
export async function stageUpdate(): Promise<UpdateInfo | null> {
  return invokeCommand<UpdateInfo | null>('stage_update');
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

/// Prompts advertised by the running connectors, for the composer picker.
/// Reads the capability cache; no connector round-trip.
export async function listConnectorPrompts(): Promise<ConnectorPromptInfo[]> {
  return invokeCommand<ConnectorPromptInfo[]>('list_connector_prompts');
}

/// Resources advertised by the running connectors, for the composer picker.
export async function listConnectorResources(): Promise<ConnectorResourceInfo[]> {
  return invokeCommand<ConnectorResourceInfo[]>('list_connector_resources');
}

/// Resolve a prompt template into composer draft text. The result is editable
/// by the user before it is sent, so it needs no consent gate.
export async function getConnectorPrompt(request: PromptArguments): Promise<string> {
  return invokeCommand<string>('get_connector_prompt', { request });
}

/// Whether this connector's resources may already be sent to the model.
export async function isConnectorResourceAcknowledged(
  connectorVersionId: string,
): Promise<boolean> {
  return invokeCommand<boolean>('is_connector_resource_acknowledged', { connectorVersionId });
}

/// Record the user's first-use agreement for this connector's resources.
export async function acknowledgeConnectorResources(connectorVersionId: string): Promise<void> {
  return invokeCommand<void>('acknowledge_connector_resources', { connectorVersionId });
}

/// Read the resources attached to one turn into a sanitized context block.
/// Rust redacts, runs the reinjection gate and caps the size; a resource that
/// fails any of those comes back in `skipped` with a reason rather than
/// failing the turn.
export async function readConnectorResources(refs: ResourceRef[]): Promise<ResourceBlock> {
  return invokeCommand<ResourceBlock>('read_connector_resources', { refs });
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

// =============================================================================
// Knowledge base (t1-6)
// =============================================================================

export async function listKnowledgeCollections(): Promise<KnowledgeCollection[]> {
  return invokeCommand<KnowledgeCollection[]>('list_knowledge_collections');
}

export async function createKnowledgeCollection(name: string): Promise<KnowledgeCollection> {
  return invokeCommand<KnowledgeCollection>('create_knowledge_collection', { name });
}

export async function renameKnowledgeCollection(
  collectionId: string,
  name: string,
): Promise<void> {
  return invokeCommand<void>('rename_knowledge_collection', { collectionId, name });
}

export async function deleteKnowledgeCollection(collectionId: string): Promise<void> {
  return invokeCommand<void>('delete_knowledge_collection', { collectionId });
}

export async function listKnowledgeDocuments(collectionId: string): Promise<KnowledgeDocument[]> {
  return invokeCommand<KnowledgeDocument[]>('list_knowledge_documents', { collectionId });
}

/** OS file picker for a document to import. `null` = cancel. */
export async function pickKnowledgeDocument(): Promise<string | null> {
  return invokeCommand<string | null>('pick_knowledge_document');
}

/** The cited passage for a citation chip, or null if the document has since
 *  been deleted. */
export async function getKnowledgePassage(chunkId: string): Promise<KnowledgePassage | null> {
  return invokeCommand<KnowledgePassage | null>('get_knowledge_passage', { chunkId });
}

export async function importKnowledgeDocument(
  collectionId: string,
  path: string,
  onProgress?: (progress: KnowledgeImportProgress) => void,
): Promise<KnowledgeImportOutcome> {
  // Per-call channel, the same shape the connector and chat streams use. The
  // Rust side takes it unconditionally (`Option<Channel<_>>` is not a valid
  // command argument), so one is always created; without a listener its
  // messages are simply dropped.
  const progress = new Channel<KnowledgeImportProgress>();
  if (onProgress) progress.onmessage = onProgress;
  return invokeCommand<KnowledgeImportOutcome>('import_knowledge_document', {
    collectionId,
    path,
    progress,
  });
}

export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  return invokeCommand<void>('delete_knowledge_document', { documentId });
}

export async function listConversationCollections(conversationId: string): Promise<string[]> {
  return invokeCommand<string[]>('list_conversation_collections', { conversationId });
}

/** Returns the canonical set actually stored -- deduplicated, blank ids
 *  dropped -- so callers sync optimistic state to what was really saved
 *  rather than trusting their own pre-write guess. */
export async function setConversationCollections(
  conversationId: string,
  collectionIds: string[],
): Promise<string[]> {
  return invokeCommand<string[]>('set_conversation_collections', { conversationId, collectionIds });
}

export async function retrieveKnowledgeContext(
  conversationId: string,
  query: string,
  documentIds?: string[],
): Promise<KnowledgeContext> {
  return invokeCommand<KnowledgeContext>('retrieve_knowledge_context', {
    conversationId,
    query,
    documentIds,
  });
}

/** M2 (t1-8): documents this conversation leaves out of retrieval (D1). */
export async function listConversationExcludedDocuments(
  conversationId: string,
): Promise<string[]> {
  return invokeCommand<string[]>('list_conversation_excluded_documents', { conversationId });
}

/** Toggle one document's exclusion (D2). Returns the canonical excluded set
 *  actually stored, for the UI to reconcile against rather than trust its own
 *  optimistic guess. */
export async function setConversationDocumentExcluded(
  conversationId: string,
  documentId: string,
  excluded: boolean,
): Promise<string[]> {
  return invokeCommand<string[]>('set_conversation_document_excluded', {
    conversationId,
    documentId,
    excluded,
  });
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

/** M1 (D13): attach a file the OS just dropped on the composer. Rust accepts
 *  only a path it recorded from a native `Drop` in the last 60s, once — never
 *  an arbitrary renderer-supplied path. */
export async function saveDroppedAttachment(
  conversationId: string,
  path: string,
): Promise<Attachment> {
  return invokeCommand<Attachment>('save_dropped_attachment', { conversationId, path });
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

/** Everything wrong with a definition, in plain English; empty when it can be saved. */
export async function validateWorkflow(definition: WorkflowDefinition): Promise<string[]> {
  return invokeCommand<string[]>('validate_workflow', { definition });
}

// ── Apps (saved mini-apps) ────────────────────────────────────────────────────

/** What the user fills in when saving or editing an app. */
export interface AppMetaInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  category: AppCategory;
}

/** Save an HTML artifact as an app. `declaredHosts` come from the page's
 *  `conduit-network` meta tags; `keepHosts` are the page's remembered grants
 *  the user chose to carry over (Rust refuses any it doesn't have).
 *  `declaredCapabilities` comes from the page's `conduit-capability` meta
 *  tags (`declaredCapabilities` in `artifacts/networkHosts.ts`); Rust rejects
 *  anything it doesn't recognise (ADR-012). `declaredInputs` comes from the
 *  page's `application/conduit-inputs+json` block (`declaredInputs` in
 *  `artifacts/networkHosts.ts`); Rust re-validates the declaration (ADR-013). */
export async function saveApp(
  artifactId: string,
  meta: AppMetaInput,
  declaredHosts: string[],
  keepHosts: string[],
  declaredCapabilities: string[],
  declaredInputs: AppInput[],
): Promise<AppSummary> {
  return invokeCommand<AppSummary>('save_app', {
    artifactId,
    meta,
    declaredHosts,
    keepHosts,
    declaredCapabilities,
    declaredInputs,
  });
}

export async function listApps(): Promise<AppSummary[]> {
  return invokeCommand<AppSummary[]>('list_apps');
}

/** An app with its page; also records when it was opened. */
export async function openApp(id: string): Promise<AppDetail> {
  return invokeCommand<AppDetail>('open_app', { id });
}

export async function updateApp(id: string, meta: AppMetaInput): Promise<AppSummary> {
  return invokeCommand<AppSummary>('update_app', { id, meta });
}

/** Refresh a saved app from its still-open source artifact. Values for
 *  inputs that are still declared (and still valid) survive; the rest are
 *  dropped (ADR-013). */
export async function updateAppFromArtifact(
  id: string,
  declaredHosts: string[],
  declaredCapabilities: string[],
  declaredInputs: AppInput[],
): Promise<AppSummary> {
  return invokeCommand<AppSummary>('update_app_from_artifact', {
    id,
    declaredHosts,
    declaredCapabilities,
    declaredInputs,
  });
}

export async function deleteApp(id: string): Promise<void> {
  await invokeCommand('delete_app', { id });
}

// =============================================================================
// Slides
// =============================================================================

export async function listDecks(): Promise<DeckSummary[]> {
  return invokeCommand<DeckSummary[]>('list_decks');
}

/** A new deck with its own chat and a first history entry. */
export async function createDeck(
  title: string,
  themeName: string,
  themeCss: string,
): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('create_deck', { title, themeName, themeCss });
}

export async function getDeck(id: string): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('get_deck', { id });
}

/** The deck a chat builds, or null for an ordinary chat. */
export async function getDeckForConversation(conversationId: string): Promise<DeckDetail | null> {
  return invokeCommand<DeckDetail | null>('get_deck_for_conversation', { conversationId });
}

/** Open a deck: stamps when it was opened and gives it a chat if it lost its own. */
export async function openDeck(id: string): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('open_deck', { id });
}

/** Renames the deck and its chat. */
export async function renameDeck(id: string, title: string): Promise<void> {
  await invokeCommand('rename_deck', { id, title });
}

/** Deletes the deck and its chat. */
export async function deleteDeck(id: string): Promise<void> {
  await invokeCommand('delete_deck', { id });
}

export async function setDeckStoryline(id: string, storyline: StorylineItem[]): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('set_deck_storyline', { id, storyline });
}

export async function setDeckStage(id: string, stage: DeckStage): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('set_deck_stage', { id, stage });
}

export async function setDeckTheme(
  id: string,
  themeName: string,
  themeCss: string,
): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('set_deck_theme', { id, themeName, themeCss });
}

/** The deck's history, newest first. */
export async function listDeckSnapshots(deckId: string): Promise<DeckSnapshotSummary[]> {
  return invokeCommand<DeckSnapshotSummary[]>('list_deck_snapshots', { deckId });
}

/** Record the deck's state in its history; null when nothing changed since the newest entry. */
export async function snapshotDeck(
  deckId: string,
  cause: DeckSnapshotCause,
  label: string,
): Promise<DeckSnapshotSummary | null> {
  return invokeCommand<DeckSnapshotSummary | null>('snapshot_deck', { deckId, cause, label });
}

export async function restoreDeckSnapshot(deckId: string, snapshotId: string): Promise<DeckDetail> {
  return invokeCommand<DeckDetail>('restore_deck_snapshot', { deckId, snapshotId });
}

/** The ready-made apps bundled with Conduit, and which the user has added. */
export async function listStarterApps(): Promise<StarterAppInfo[]> {
  return invokeCommand<StarterAppInfo[]>('list_starter_apps');
}

/** Add a starter app — or get the copy already added. `name` and
 *  `description` are its Ideas strings in the user's language. */
export async function installStarterApp(
  id: string,
  name: string,
  description: string | null,
): Promise<AppSummary> {
  return invokeCommand<AppSummary>('install_starter_app', { id, name, description });
}

// =============================================================================
// Launch inputs (ADR-013)
// =============================================================================

/** The app's current effective input values: every declared input that has a
 *  stored-and-valid value or a default. Read on opening the app view, and
 *  after `set_app_inputs` (which returns the same shape). */
export async function getAppInputs(id: string): Promise<Record<string, unknown>> {
  return invokeCommand<Record<string, unknown>>('get_app_inputs', { id });
}

/** Replaces every stored value for the app in one call: an id not declared
 *  is refused, and `null` clears one. Rejects with `invalid: …` for a value
 *  that does not fit its input. Returns the new effective values. */
export async function setAppInputs(id: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  return invokeCommand<Record<string, unknown>>('set_app_inputs', { id, values });
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return invokeCommand<WorkflowSummary[]>('list_workflows');
}

export async function getWorkflow(id: string): Promise<WorkflowRecord> {
  return invokeCommand<WorkflowRecord>('get_workflow', { id });
}

export async function createWorkflow(
  name: string,
  description: string | null,
  definition: WorkflowDefinition,
): Promise<WorkflowRecord> {
  return invokeCommand<WorkflowRecord>('create_workflow', { name, description, definition });
}

export async function updateWorkflow(
  id: string,
  name: string,
  description: string | null,
  definition: WorkflowDefinition,
): Promise<WorkflowRecord> {
  return invokeCommand<WorkflowRecord>('update_workflow', { id, name, description, definition });
}

export async function deleteWorkflow(id: string): Promise<void> {
  return invokeCommand('delete_workflow', { id });
}

/** Runs the workflow now; resolves when the whole run has finished. */
export async function runWorkflow(id: string, inputs: Record<string, string>): Promise<WorkflowRunDetail> {
  return invokeCommand<WorkflowRunDetail>('run_workflow', { id, inputs });
}

/** Run a workflow again from `stepId`, reusing what run `runId` did before it; resolves when the run has finished. */
export async function rerunWorkflowFrom(runId: string, stepId: string): Promise<WorkflowRunDetail> {
  return invokeCommand<WorkflowRunDetail>('rerun_workflow_from', { runId, stepId });
}

export async function listWorkflowRuns(id: string, limit?: number): Promise<WorkflowRun[]> {
  return invokeCommand<WorkflowRun[]>('list_workflow_runs', { id, limit: limit ?? null });
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return invokeCommand<WorkflowRunDetail>('get_workflow_run', { runId });
}

export async function getWorkflowSchedule(id: string): Promise<WorkflowSchedule | null> {
  return invokeCommand<WorkflowSchedule | null>('get_workflow_schedule', { id });
}

/** Set a workflow's schedule; `spec: null` removes it. */
export async function setWorkflowSchedule(
  id: string,
  spec: ScheduleSpec | null,
  enabled: boolean,
): Promise<WorkflowSchedule | null> {
  return invokeCommand<WorkflowSchedule | null>('set_workflow_schedule', { id, spec, enabled });
}

/** Show a desktop notification (text already translated) for a finished scheduled run. */
export async function notifyWorkflowRun(title: string, body: string): Promise<void> {
  return invokeCommand('notify_workflow_run', { title, body });
}

/** Everything the tray and the quit prompt say, translated (Rust has no locale). */
export interface TrayLabels {
  open: string;
  quit: string;
  tooltip: string;
  /** The run count `running` and `confirmBody` are formatted for. */
  count: number;
  running: string;
  stopAll: string;
  confirmTitle: string;
  confirmBody: string;
  confirmQuit: string;
  confirmCancel: string;
}

export async function setTrayLabels(labels: TrayLabels): Promise<void> {
  return invokeCommand('set_tray_labels', { labels });
}

export async function getRunningWorkflowCount(): Promise<number> {
  return invokeCommand<number>('get_running_workflow_count');
}

/** What a workflow would be allowed to do on its own, and what isn't approved yet. */
export async function getWorkflowPermissions(id: string): Promise<WorkflowPermissions> {
  return invokeCommand<WorkflowPermissions>('get_workflow_permissions', { id });
}

/** Approve everything the workflow needs now to run on its own. */
export async function approveWorkflowPermissions(id: string): Promise<WorkflowPermissions> {
  return invokeCommand<WorkflowPermissions>('approve_workflow_permissions', { id });
}

/** Scheduled runs waiting for an answer, oldest first. */
export async function listWorkflowReviews(): Promise<WorkflowReview[]> {
  return invokeCommand<WorkflowReview[]>('list_workflow_reviews');
}

/** Answer a paused run; resolves `false` if it was no longer waiting. */
export async function answerWorkflowReview(runId: string, decision: WorkflowReviewDecision): Promise<boolean> {
  return invokeCommand<boolean>('answer_workflow_review', { runId, decision });
}

/** Runs waiting at an "Ask me" step, oldest first. */
export async function listWorkflowQuestions(): Promise<WorkflowQuestion[]> {
  return invokeCommand<WorkflowQuestion[]>('list_workflow_questions');
}

/** Answer a run waiting at an "Ask me" step; resolves `false` if it was no longer waiting. */
export async function answerWorkflowQuestion(runId: string, answer: string): Promise<boolean> {
  return invokeCommand<boolean>('answer_workflow_question', { runId, answer });
}

/** Ask a workflow's run in progress to stop; resolves `false` if it wasn't running. */
export async function stopWorkflowRun(id: string): Promise<boolean> {
  return invokeCommand<boolean>('stop_workflow_run', { id });
}

export async function getStartAtLogin(): Promise<boolean> {
  return invokeCommand<boolean>('get_start_at_login');
}

/** Start at sign-in, into the tray; resolves to whether it is now on. */
export async function setStartAtLogin(enabled: boolean): Promise<boolean> {
  return invokeCommand<boolean>('set_start_at_login', { enabled });
}
