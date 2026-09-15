import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, GenerationControls, MessageRole, ProviderRequest } from '@conduit/config-schema';
import {
  buildPromptArguments,
  needsArgumentDialog,
  sameResource,
  toResourceRef,
} from './connectorCapabilities';
import { McpPromptArgumentsDialog } from './McpPromptArgumentsDialog';
import { McpResourceConsentDialog } from './McpResourceConsentDialog';
import type {
  ConnectorPromptInfo,
  ConnectorResourceInfo,
  ResourceBlock,
  ResourceRef,
  SkippedResource,
} from '../ipc/contracts';
import type { ProviderUsage } from '@conduit/config-schema';
import {
  cancelChatStream,
  compactConversation,
  steerChatStream,
  discoverConnector,
  getArtifact,
  getConnectorRuntimeStates,
  getConversation,
  getConversationCompaction,
  getConversationMessages,
  getMessageIdByRequest,
  invokeConnectorTool,
  listConnectorCapabilities,
  pickWorkspaceFolder,
  prepareMessageEdit,
  removeLastTurn,
  setConversationWorkspace,
  setConversationChatSettings,
  startConnector,
  startChatStream,
  updateSettings,
  listSkills,
  listConversationSkills,
  setConversationSkills,
  getSkillPromptBlock,
  getMemoryPromptBlock,
  acknowledgeConnectorResources,
  getConnectorPrompt,
  isConnectorResourceAcknowledged,
  listConnectorPrompts,
  listConnectorResources,
  readConnectorResources,
  type ConversationCompaction,
} from '../ipc/client';
import type { Conversation, SkillSummary } from '../ipc/contracts';
import { ConfirmDialog } from '@conduit/ui';
import { AssistantMessage } from './AssistantMessage';
import { AssistantArtifactStrip } from './ArtifactResultCard';
import { BotGlyph, CopyIcon, ForkIcon, PencilIcon } from '../icons';
import { TurnModelLine, shouldShowModelLine } from './TurnModelLine';
import { InterruptedBanner } from './InterruptedBanner';
import { providerHueId } from '../lib/providerIdentity';
import { ChatMessageContent } from './ChatMessageContent';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { inlineArtifactIds } from './inlineArtifact';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX, looksLikeArtifactCreationRequest } from './artifactPrompt';
import { composeSystemPrompt, joinExtraSystemSections, mergeGenerationControls, resolveUserInstructions } from './systemPrompt';
import type { TurnAttachment } from './composerTypes';
import { UserTurnAttachments } from './UserTurnAttachments';
import { modelAcceptsImages } from './modelAcceptsImages';
import {
  webSearchCreateDeveloperPromptFor,
  webSearchDeveloperPromptFor,
  localWebSearchDeveloperPromptFor,
} from './webSearchDeveloperPrompt';
import {
  buildArtifactEditDeveloperPrompt,
  resolveFollowUpArtifactContext,
  type FollowUpArtifactContext,
} from './artifactFollowUpContext';
import type { Artifact, FileState } from '../ipc/contracts';
import {
  applyConnectorRuntimeEvent,
  applyProviderEvent,
  createAssistantStreamState,
  markInterrupted,
  toolCallAwaitsRuntimeFinish,
  type AssistantStreamState,
} from './streamState';
import { isWebSearchToolCall } from './SearchCallBlock';
import {
  excludeLiveAssistantTurns,
  hydrateAssistantTurn,
  upsertAssistantTurn,
  type ChatTurn,
} from './conversationHydration';
import { mergeProviderUsage, estimatePromptTokens, DEFAULT_COMPACT_THRESHOLD_PERCENT, getContextWindow } from '../lib/contextWindows';
import {
  formatCompactionDeveloperPrompt,
  historyForProviderRequest,
  splitTurnsAtCompaction,
} from './contextCompact';
import { dayRuleLabel, sameCalendarDay } from '../lib/dayGroup';
import { useFormatters, type Formatters } from '../i18n/formatters';
import type { StatusState } from './statusTypes';
import { makeStatus } from './statusTypes';
import { ChatErrorBoundary } from './ChatErrorBoundary';
import { Composer, type ComposerHandle } from './Composer';
import { useComposerAutosize } from './useComposerAutosize';
import { readSendWith } from '../shell/uiPrefs';
import { WebSearchConsentDialog } from '../workspace/settings/WebSearchConsentDialog';
import { WorkspaceToolsConsentDialog } from '../workspace/settings/WorkspaceToolsConsentDialog';
import { SuggestedPrompts } from './SuggestedPrompts';
import { deriveSuggestedPrompts } from './suggestedPromptLogic';
import { resolveSearchBackend, resolveWebSearchForTurn, type SearchBackend } from './webSearchIntent';
import type { ConnectorCapability, ConnectorRuntimeEvent } from '../ipc/contracts';
import type { ToolDefinition } from '@conduit/config-schema';
import {
  buildConnectorToolCatalog,
  isConnectorCallable,
  makeInvokeConnectorToolRequest,
  type ConnectorToolBinding,
} from './connectorTools';
import {
  failedDocumentToolCalls,
  hadSuccessfulDocumentToolCalls,
  documentWritesHistoryNote,
  isDocumentContentTool,
  selectBuiltinTurnTools,
  selectBuiltinWebTools,
  type DocumentToolActivity,
} from './agentTools';
import {
  activeDocumentWrite,
  documentWriteDetail,
  documentWriteLabel,
} from './documentWriteScan';
import { markDocumentWritesHeld, readDocumentWriteStreaming, recordDocumentWrite } from './streamingBehavior';
import { placeholderSections } from './documentBuild';
import {
  documentWriteDeveloperPromptFor,
  informationalDeveloperPromptFor,
  type DocumentTurnIntent,
} from './documentTurnIntent';
import { CONDUIT_BRAND_SYSTEM_APPENDIX, looksLikeBrandThemeRequest } from './brandPrompt';
import {
  createQueuedMessage,
  enqueue,
  listFor,
  remove,
  shift,
  type ConversationQueues,
} from './messageQueue';
import { allowUserBranding } from '../brand/buildFlags';
import { appName } from '../brand';
import { useRichT, useT, type Translate } from '../i18n';

export type { ChatTurn } from './conversationHydration';
export type { DocumentToolActivity } from './agentTools';

export interface ChatViewHandle {
  stopStreaming: () => void;
  copyLastAssistantMessage: () => Promise<boolean>;
  isStreaming: () => boolean;
  /// Scroll a message into view (used by FTS5 search navigation).
  scrollToMessage: (messageId: string) => void;
  /// Insert text at the composer cursor position (used by prompts library).
  insertPrompt: (text: string) => void;
  /// V7 — toggle conversation web-search (⌘⇧W / command palette).
  /// No-op when the composer's web toggle would not be visible.
  /// Stays on until the user turns it off.
  toggleWebSearch: () => void;
  /// V7 — fork the conversation at the current (last) turn (⌘⇧F / palette).
  /// Resolves true when a turn existed and the fork was requested.
  forkConversationHere: () => Promise<boolean>;
  /// t0-3 — begin editing the last user message (palette).
  editLastUserMessage: () => boolean;
  /// t0-6 — open the per-conversation chat settings popover (palette).
  openChatSettings: () => boolean;
  /// The document tool call whose arguments are streaming right now, raw.
  /// Read on demand by the document panel's live preview, so partial document
  /// text never has to travel through app state on every fragment.
  readActiveDocumentWrite: () => { toolName: string; argumentsText: string } | null;
}

interface ChatViewProps {
  settings: AppSettings;
  /** Write provider + model in one settings update. The chat surface only
   *  ever changes these two fields, so it takes the specific capability
   *  rather than a general settings setter. */
  onSelectModel: (providerId: string, modelId: string, defaultBaseUrl?: string | null) => void;
  onStatus: (message: string | StatusState) => void;
  /// Active conversation id (owned by App; the history rail drives selection).
  /// `null` only briefly during boot before App ensures a conversation exists.
  conversationId: string | null;
  /// M2: the conversation's artifacts, for in-chat reference chips + promote
  /// affordances at the end of each assistant turn.
  artifacts: Artifact[];
  /// Document currently open in the panel — preferred when resolving edit
  /// follow-up context ("add urls to the document").
  activeArtifact?: Artifact | null;
  /// M2: per-artifact file-state, for the chip state dots.
  fileStateMap: Record<string, FileState>;
  /// M2: promote a detected fenced-block candidate to an artifact (App owns the
  /// create + setContent + open flow).
  onPromoteArtifact: (messageId: string, candidate: ArtifactCandidate) => void;
  /// M2: open an existing artifact in the DocumentPanel (chip click).
  onOpenArtifact: (artifactId: string) => void;
  /// After a completed assistant turn — refresh/open artifacts created via agent tools.
  onChatTurnComplete?: (streamState: AssistantStreamState) => void;
  /// Fired when a document create/edit tool starts or finishes argument streaming.
  onDocumentToolActivity?: (activity: DocumentToolActivity) => void;
  /// Fired when the user requests to fork the conversation at a message.
  onForkConversation?: (conversationId: string, forkMessageId: string) => void;
  /// t0-3 — mid-thread edit forked a new conversation; switch + pending send.
  onEditForked?: (fork: Conversation, pendingText: string) => void;
  /// One-shot text to send after the conversation hydrates (edit-fork path).
  pendingSendText?: string | null;
  /// Clear `pendingSendText` after it has been consumed (or abandoned).
  onPendingSendConsumed?: () => void;
  /// Whether this pane is the active workspace tab (`data-active` for CSS). Defaults true for tests.
  paneActive?: boolean;
  /// Open a settings section ('providers' | 'privacy' …) from the status line.
  onOpenSettings?: (tab?: string) => void;
  /// Whether the settings sheet is open. Connectors are added there, so this
  /// toggling is the signal that the MCP prompt/resource lists may be stale.
  settingsOpen?: boolean;
  /// Renderer-only conversation → last-used provider map (sidebar row dots).
  /// Falls back to `settings.activeProvider` for per-turn hue + model line.
  convoProviders?: Record<string, string>;
}

/// Extracts a human-readable message from a Tauri `invoke` rejection.
/// Tauri commands returning `Result<T, String>` reject with the serialized
/// error (a plain string, or an object), not an `Error` instance — so
/// `error instanceof Error` is false and the generic "Stream failed" would
/// otherwise swallow the real reason. Fall back through the common shapes.
export function describeInvokeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
    try {
      return JSON.stringify(error);
    } catch {
      return 'Stream failed';
    }
  }
  return 'Stream failed';
}

export function baseSystemPrompt(): string {
  return `You are a helpful assistant in the ${appName()} desktop shell.`;
}

export interface ChatRequestOverrides {
  generationControls?: GenerationControls | null;
  userInstructions?: string | null;
  /** Journaled compaction summary injected as a developer prompt. */
  compactionSummary?: string | null;
  /** Enabled skills + workspace AGENTS.md (t1-4). */
  extraSystemSections?: string | null;
}

/**
 * The text a past turn contributes to the next request's history.
 *
 * History carries display text only — tool calls never reach it — and turns
 * with no text are dropped. A turn that ended right after writing a document
 * (the agent loop no longer spends a round on a confirmation) has no text, so
 * it would vanish and the model would not know it had written anything. Such
 * a turn contributes a short note naming what it wrote instead.
 */
export function historyContentForTurn(turn: ChatTurn): string {
  if (turn.content.trim() !== '' || turn.role !== 'assistant') return turn.content;
  return documentWritesHistoryNote(turn.streamState);
}

export function buildProviderRequest(
  settings: AppSettings,
  prompt: string,
  history: ChatTurn[],
  conversationId: string,
  toolDefinitions: ToolDefinition[],
  followUpArtifact?: FollowUpArtifactContext,
  /// Hosted XOR local. Absent / null = no search on this turn.
  searchBackend?: SearchBackend | null,
  chatOverrides?: ChatRequestOverrides,
): ProviderRequest {
  const now = new Date().toISOString();
  const messages = history
    .map((turn) => ({ ...turn, content: historyContentForTurn(turn) }))
    .filter((turn) => {
      if (turn.role !== 'user' && turn.role !== 'assistant') return false;
      if (turn.content.trim() !== '') return true;
      // Image-only user turns still go to the provider.
      return turn.role === 'user' && (turn.attachments?.length ?? 0) > 0;
    })
    .map((turn) => {
      const parts: Array<{
        id: string;
        messageId: string;
        index: number;
        kind: 'text' | 'attachmentReference';
        content?: string;
        mimeType?: string;
        attachmentId?: string;
        createdAt: string;
      }> = [];
      if (turn.content.trim() !== '') {
        parts.push({
          id: `${turn.id}-part-0`,
          messageId: turn.id,
          index: 0,
          kind: 'text',
          content: turn.content,
          createdAt: now,
        });
      }
      for (const att of turn.attachments ?? []) {
        parts.push({
          id: `${turn.id}-att-${att.id}`,
          messageId: turn.id,
          index: parts.length,
          kind: 'attachmentReference',
          attachmentId: att.id,
          mimeType: att.mimeType,
          createdAt: now,
        });
      }
      return {
        // Use each turn's own globally-unique id (UUID for new user turns, DB
        // primary key for reloaded turns) so re-sent history dedupes WITHIN a
        // conversation via `INSERT OR IGNORE`, but never collides ACROSS
        // conversations. The previous `msg-${index}` scheme reset to `msg-0`
        // for every conversation, so the second conversation's first user turn
        // silently failed the PK insert and its content was lost on reload.
        id: turn.id,
        conversationId,
        role: turn.role as MessageRole,
        parts,
        createdAt: now,
      };
    });
  // Creation intent is used only to gate tool visibility, the post-hoc warning,
  // and to suppress edit/informational developer prompts. We deliberately do NOT
  // inject a positive "you must create an artifact" developer prompt here: the
  // system appendix already states the contract, and a false-positive intent
  // match would otherwise pressure the model into creating an artifact on a
  // question turn (the original cause of the spurious "no artifact content"
  // warning).
  const isCreationIntent = looksLikeArtifactCreationRequest(prompt);
  // Gated separately from the artifact appendix (see brandPrompt.ts's module
  // comment for why): this appendix is only worth its tokens on a turn that
  // plausibly wants `write_brand_theme`, not on every turn. Also gated on
  // `allowUserBranding` (`brand/buildFlags.ts`) -- same reasoning as
  // `agentTools.ts`'s `selectBuiltinBrandTools`: a locked build can never
  // apply a `write_brand_theme` result, so this appendix's tokens (and the
  // tool itself, selected below from this same flag) would be spent
  // teaching the model about a capability the app cannot let the user use.
  const isBrandIntent = looksLikeBrandThemeRequest(prompt) && allowUserBranding;
  const searchActive = searchBackend === 'hosted' || searchBackend === 'local';
  // Hosted only: inject ProviderRequest.web_search. Local turns declare
  // web_search/web_fetch as function tools instead — never both.
  const webSearch =
    searchBackend === 'hosted'
      ? {
          enabled: true,
          searchContextSize: settings.webSearch.searchContextSize,
          ...(settings.webSearch.allowedDomains.length > 0 ||
          settings.webSearch.blockedDomains.length > 0
            ? {
                filters: {
                  ...(settings.webSearch.allowedDomains.length > 0
                    ? { allowedDomains: settings.webSearch.allowedDomains }
                    : {}),
                  ...(settings.webSearch.blockedDomains.length > 0
                    ? { blockedDomains: settings.webSearch.blockedDomains }
                    : {}),
                },
              }
            : {}),
          externalWebAccess: settings.webSearch.externalWebAccess,
          returnTokenBudget: settings.webSearch.returnTokenBudget,
          userLocation: settings.webSearch.userLocation,
          includeSources: settings.webSearch.includeSources,
        }
      : undefined;
  const infoDevPrompt =
    !isCreationIntent && !searchActive ? informationalDeveloperPromptFor(prompt) : undefined;
  const editDevPrompt =
    !isCreationIntent && !infoDevPrompt && followUpArtifact
      ? buildArtifactEditDeveloperPrompt(followUpArtifact, prompt)
      : undefined;
  const webSearchDevPrompt = !searchActive
    ? undefined
    : isCreationIntent
      ? webSearchCreateDeveloperPromptFor()
      : searchBackend === 'local'
        ? localWebSearchDeveloperPromptFor(settings.webSearch.localBackend)
        : webSearchDeveloperPromptFor();
  const compactionDevPrompt = chatOverrides?.compactionSummary?.trim()
    ? formatCompactionDeveloperPrompt(chatOverrides.compactionSummary)
    : undefined;
  const documentWriteDevPrompt = documentWriteDeveloperPromptFor(
    toolDefinitions.map((tool) => tool.name),
    {
      heldDocuments:
        readDocumentWriteStreaming(settings.activeProvider, settings.activeModel) === 'holds',
    },
  );
  const developerPrompt =
    [compactionDevPrompt, infoDevPrompt, editDevPrompt, documentWriteDevPrompt, webSearchDevPrompt]
      .filter(Boolean)
      .join('\n\n') || undefined;
  const systemPrompt = composeSystemPrompt(
    [
      baseSystemPrompt(),
      ...(searchActive && !isCreationIntent ? [] : [CONDUIT_ARTIFACT_SYSTEM_APPENDIX()]),
      ...(isBrandIntent ? [CONDUIT_BRAND_SYSTEM_APPENDIX()] : []),
    ],
    resolveUserInstructions(settings, chatOverrides?.userInstructions),
    chatOverrides?.extraSystemSections,
  );

  const attachmentIds = [
    ...new Set(
      history.flatMap((turn) => (turn.attachments ?? []).map((att) => att.id)).filter(Boolean),
    ),
  ];

  return {
    requestId: crypto.randomUUID(),
    conversationId,
    modelId: settings.activeModel,
    messages,
    systemPrompt,
    developerPrompt,
    toolDefinitions,
    webSearch,
    ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
    generationControls: mergeGenerationControls(
      settings.generationControls,
      chatOverrides?.generationControls,
    ),
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const EMPTY_RESOURCE_BLOCK: ResourceBlock = { text: '', included: [], skipped: [] };

/**
 * Read this turn's attached MCP resources. Rust does the sanitizing — redaction,
 * the reinjection gate, and the size caps — so this only has to survive the call
 * failing outright, which must not cost the user their turn.
 */
async function readAttachedResources(refs: ResourceRef[]): Promise<ResourceBlock> {
  if (refs.length === 0) return EMPTY_RESOURCE_BLOCK;
  try {
    return await readConnectorResources(refs);
  } catch (err) {
    return {
      text: '',
      included: [],
      skipped: refs.map((r) => ({
        uri: r.uri,
        reason: err instanceof Error ? err.message : String(err),
      })),
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Minimum gap between document-write progress updates sent to the panel. */
const DOCUMENT_PROGRESS_INTERVAL_MS = 250;

/** Derive agent loop phase from stream state and pending calls.
 *  Prefers backend-sent agent phase info when available (from ProviderEvent::AgentPhase
 *  events emitted by run_agent_turn in Rust). Falls back to frontend derivation when
 *  the backend hasn't sent phase info yet (e.g. during the initial provider round). */
function deriveAgentPhase(
  state: AssistantStreamState | null,
  pendingCalls: Set<string>,
  t: Translate,
  fmt: Formatters,
): AssistantStreamState['agentPhase'] | undefined {
  if (!state) return undefined;

  // A document whose arguments are still streaming outranks every other
  // phase, the backend's included: the backend only knows the round is
  // "thinking", and for the tens of seconds a large document takes that label
  // (or no label at all, once text has been produced) is what made the turn
  // look stuck.
  const write = activeDocumentWrite(state);
  if (write) {
    return {
      label: documentWriteLabel(write, t),
      round: state.agentPhase?.round ?? 1,
      totalRounds: state.agentPhase?.totalRounds,
      subPhase: 'writing_document',
      detail: documentWriteDetail(write, t, fmt),
    };
  }

  // Prefer backend-sent phase info when available.
  if (state.agentPhase) {
    // If the backend says we're in executing_tools but no pending calls remain,
    // the backend is still updating — trust the backend timestamp.
    return state.agentPhase;
  }

  if (!state.streaming && state.finishReason && pendingCalls.size === 0) {
    return undefined; // not in agent loop
  }
  if (pendingCalls.size > 0) {
    return {
      label: t('chat.view.agentPhase.runningTools', { count: pendingCalls.size }),
      round: 1,
      subPhase: 'executing_tools',
    };
  }
  if (state.streaming && state.blocks.length === 0 && state.toolCalls.length === 0) {
    return {
      label: t('chat.view.agentPhase.thinking'),
      round: 1,
      subPhase: 'thinking',
    };
  }
  if (state.streaming && state.toolCalls.length > 0) {
    // Still streaming with tool calls visible — in the "reviewing" sub-phase
    // between tool execution results and next content blocks.
    const anyComplete = state.toolCalls.some((tc) => tc.complete);
    if (anyComplete) {
      return {
        label: t('chat.view.agentPhase.reviewing'),
        round: 1,
        subPhase: 'reviewing',
      };
    }
  }
  return undefined;
}

function formatMsgTime(iso: string, fmt: Formatters): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return fmt.wallClock(ms);
}

/** Session-scoped map of turn id → { provider, model }.
 *
 *  The backend does not persist provider/model per message (out of scope for
 *  V7 — §12 lists the renderer as the only changed surface), so mid-session
 *  provider/model switches are tracked here. Hydrated turns from previous
 *  sessions fall back to the conversation's last-used provider (§6.4
 *  degradation: the model line then shows on the first turn of such a
 *  conversation and at every switch within the current session). */
const sessionTurnProviders = new Map<string, { provider: string; model: string }>();

function recordSessionTurnProvider(turnId: string, provider: string, model: string): void {
  sessionTurnProviders.set(turnId, { provider, model });
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView(
  {
    settings,
    onSelectModel,
    onStatus,
    conversationId,
    artifacts,
    activeArtifact = null,
    fileStateMap,
    onPromoteArtifact,
    onOpenArtifact,
    onChatTurnComplete,
    onDocumentToolActivity,
    onForkConversation,
    onEditForked,
    pendingSendText = null,
    onPendingSendConsumed,
    paneActive = true,
    onOpenSettings,
  settingsOpen = false,
    convoProviders = {},
  },
  ref,
) {
  const t = useT();
  const tr = useRichT();
  const fmt = useFormatters();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<AssistantStreamState | null>(null);
  const [messageQueues, setMessageQueues] = useState<ConversationQueues>({});
  const [threadLoading, setThreadLoading] = useState(false);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [showJumpPill, setShowJumpPill] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editConfirm, setEditConfirm] = useState<{
    messageId: string;
    text: string;
    kind: 'tip' | 'fork';
  } | null>(null);
  const [autoSend, setAutoSend] = useState<{ text: string; history: ChatTurn[] } | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  useComposerAutosize(editTextareaRef, editDraft);
  // Phase 7 / M-WebSearch: conversation-scoped search toggle. Visible only when
  // `settings.webSearchEnabled` is on; defaults to off on mount. Stays on until
  // the user clicks it off (no longer reset after each send).
  const [webSearchOn, setWebSearchOn] = useState(false);
  // Phase 7 / M-WebSearch: consent dialog for first-time chat-bar toggle.
  // If the user has already acknowledged via Settings, this never shows.
  // Session-only dismissal (same UX as diagnostics disclosure M6.5).
  const [showChatConsent, setShowChatConsent] = useState(false);
  const [chatConsentDismissed, setChatConsentDismissed] = useState(false);
  const [conversationWorkspaceRoot, setConversationWorkspaceRoot] = useState<string | null>(null);
  const [conversationGenerationControls, setConversationGenerationControls] =
    useState<GenerationControls | null>(null);
  const [conversationUserInstructions, setConversationUserInstructions] = useState<string | null>(
    null,
  );
  const [discoveredSkills, setDiscoveredSkills] = useState<SkillSummary[]>([]);
  const [enabledSkillIds, setEnabledSkillIds] = useState<string[]>([]);
  const enabledSkillIdsRef = useRef<string[]>([]);
  enabledSkillIdsRef.current = enabledSkillIds;
  // Attached MCP resources are per turn, not per conversation: they contribute
  // to the turn they were attached for and are cleared on send, so a large or
  // fast-changing resource never rides along silently on later turns.
  const [attachedResources, setAttachedResources] = useState<ResourceRef[]>([]);
  const attachedResourcesRef = useRef<ResourceRef[]>([]);
  attachedResourcesRef.current = attachedResources;
  const [skippedResources, setSkippedResources] = useState<SkippedResource[]>([]);
  const [mcpPrompts, setMcpPrompts] = useState<ConnectorPromptInfo[]>([]);
  const [mcpResources, setMcpResources] = useState<ConnectorResourceInfo[]>([]);
  const [mcpPromptNeedingArgs, setMcpPromptNeedingArgs] = useState<ConnectorPromptInfo | null>(null);
  const [mcpResourceNeedingConsent, setMcpResourceNeedingConsent] =
    useState<ConnectorResourceInfo | null>(null);
  const [mcpReloadToken, setMcpReloadToken] = useState(0);
  const [skillPromptBlock, setSkillPromptBlock] = useState('');
  const [memoryPromptBlock, setMemoryPromptBlock] = useState('');
  const [showWorkspaceConsent, setShowWorkspaceConsent] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [compaction, setCompaction] = useState<ConversationCompaction | null>(null);
  const [showCompactedOriginals, setShowCompactedOriginals] = useState(false);
  const compactionRef = useRef<ConversationCompaction | null>(null);
  compactionRef.current = compaction;
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const stuckRef = useRef(true);
  const stickPrefRef = useRef<Record<string, boolean>>({});
  const currentConversationIdRef = useRef<string | null>(conversationId);
  const activeRequestRef = useRef<{ requestId: string; conversationId: string; isAgent: boolean } | null>(null);
  // Synchronous source of truth for the active stream's state. The `activeStream`
  // state mirrors it for render, but is updated by React async (and the ref that
  // synced to it via `useEffect` only caught up after paint — so the finally
  // block could read a state missing the last delta). Computing each event from
  // `streamStateRef` keeps the ref and state in lockstep, synchronously.
  const streamStateRef = useRef<AssistantStreamState | null>(null);
  const toolBindingsRef = useRef<Record<string, ConnectorToolBinding>>({});
  const providerToolByCallIdRef = useRef<Record<string, string>>({});
  /** Last document-write progress handed to the panel, for throttling. */
  const documentProgressSentRef = useRef<{ toolCallId: string; at: number; title?: string } | null>(
    null,
  );
  const pendingRuntimeCallsRef = useRef<Set<string>>(new Set());
  const onPendingSendConsumedRef = useRef(onPendingSendConsumed);
  onPendingSendConsumedRef.current = onPendingSendConsumed;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const messageQueuesRef = useRef(messageQueues);
  messageQueuesRef.current = messageQueues;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  /** When true, the in-flight handleSend finally must not auto-drain (Send now). */
  const skipNextDrainRef = useRef(false);
  const [agentPhase, setAgentPhase] = useState<AssistantStreamState['agentPhase']>(undefined);
  /** The live turn offers document tools to a model known to send documents
   *  all at once (`streamingBehavior.ts`). */
  const [activeTurnDocumentWriteHeld, setActiveTurnDocumentWriteHeld] = useState(false);
  /** Max tokens the active turn was sent with — not the setting, which a
   *  one-off retry can override. */
  const [activeTurnOutputLimit, setActiveTurnOutputLimit] = useState<number | undefined>(undefined);

  const queuedForConversation = listFor(messageQueues, conversationId);

  function enqueueFollowUp(text: string, attachments?: TurnAttachment[]) {
    if (!conversationId) return;
    const item = createQueuedMessage(text, attachments);
    setMessageQueues((current) => {
      const next = enqueue(current, conversationId, item);
      messageQueuesRef.current = next;
      return next;
    });
    setPrompt('');
    const count = listFor(messageQueuesRef.current, conversationId).length;
    onStatus(makeStatus(t('chat.view.status.queuedFollowUp', { count }), 'success', 'chat'));
  }

  function removeQueued(id: string) {
    if (!conversationId) return;
    setMessageQueues((current) => {
      const next = remove(current, conversationId, id);
      messageQueuesRef.current = next;
      return next;
    });
  }

  /** After a turn settles, send the next queued follow-up (FIFO, one at a time). */
  function maybeDrainNext(forConversationId: string) {
    if (currentConversationIdRef.current !== forConversationId) return;
    if (activeRequestRef.current) return;
    const { queues: nextQueues, item } = shift(messageQueuesRef.current, forConversationId);
    if (!item) return;
    messageQueuesRef.current = nextQueues;
    setMessageQueues(nextQueues);
    void handleSend({
      text: item.text,
      history: turnsRef.current,
      attachments: item.attachments,
    });
  }
  const maybeDrainNextRef = useRef(maybeDrainNext);
  maybeDrainNextRef.current = maybeDrainNext;

  useEffect(() => {
    currentConversationIdRef.current = conversationId;
    if (activeRequestRef.current?.conversationId === conversationId) {
      setActiveRequestId(activeRequestRef.current.requestId);
      return;
    }
    if (activeRequestRef.current?.conversationId !== conversationId) {
      setActiveRequestId(null);
      setActiveStream(null);
    }
  }, [conversationId]);

  // Load the active conversation's messages whenever the selection changes. A
  // null id (brief, during boot) leaves the thread empty.
  useEffect(() => {
    if (!conversationId) {
      setTurns([]);
      setConversationWorkspaceRoot(null);
      setConversationGenerationControls(null);
      setConversationUserInstructions(null);
      setDiscoveredSkills([]);
      setEnabledSkillIds([]);
      setSkillPromptBlock('');
      setCompaction(null);
      setShowCompactedOriginals(false);
      setThreadLoading(false);
      return;
    }
    const pref = stickPrefRef.current[conversationId];
    stuckRef.current = pref !== false;
    setStuckToBottom(stuckRef.current);
    setShowJumpPill(false);
    setEditingTurnId(null);
    setEditConfirm(null);
    setShowCompactedOriginals(false);

    let cancelled = false;
    setThreadLoading(true);
    void (async () => {
      try {
        const [messages, conversation, latestCompaction] = await Promise.all([
          getConversationMessages(conversationId),
          getConversation(conversationId),
          getConversationCompaction(conversationId),
        ]);
        if (!cancelled) {
          const nextTurns = (
            await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))
          ).filter((t): t is ChatTurn => t !== null);
          const liveRequestId =
            activeRequestRef.current?.requestId ?? streamStateRef.current?.requestId ?? null;
          const visible = excludeLiveAssistantTurns(nextTurns, liveRequestId);
          setTurns(visible);
          setCompaction(latestCompaction);
          setConversationWorkspaceRoot(conversation?.workspaceRoot?.trim() || null);
          setConversationGenerationControls(conversation?.generationControls ?? null);
          setConversationUserInstructions(conversation?.userInstructions ?? null);
          const pending = pendingSendText?.trim();
          if (pending) {
            onPendingSendConsumedRef.current?.();
            setAutoSend({ text: pending, history: visible });
          }
        }
      } catch (error) {
        if (!cancelled) {
          onStatusRef.current(
            error instanceof Error ? error.message : t('chat.view.status.failedToLoadConversation'),
          );
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, pendingSendText]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [prompts, resources] = await Promise.all([
          listConnectorPrompts(),
          listConnectorResources(),
        ]);
        if (!cancelled) {
          setMcpPrompts(prompts);
          setMcpResources(resources);
        }
      } catch {
        // A connector that is not running yet is the normal case, not an
        // error worth a status line: the pickers simply stay empty.
        if (!cancelled) {
          setMcpPrompts([]);
          setMcpResources([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mcpReloadToken, settingsOpen]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [listed, enabled] = await Promise.all([
          listSkills(conversationWorkspaceRoot),
          listConversationSkills(conversationId),
        ]);
        if (!cancelled) {
          setDiscoveredSkills(listed);
          setEnabledSkillIds(enabled);
        }
      } catch (error) {
        if (!cancelled) {
          onStatusRef.current(
            error instanceof Error ? error.message : t('chat.view.status.failedToLoadSkills'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, conversationWorkspaceRoot]);

  useEffect(() => {
    if (!conversationId) {
      setSkillPromptBlock('');
      return;
    }
    let cancelled = false;
    void getSkillPromptBlock(enabledSkillIds, conversationWorkspaceRoot)
      .then((block) => {
        if (!cancelled) setSkillPromptBlock(block);
      })
      .catch(() => {
        if (!cancelled) setSkillPromptBlock('');
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, enabledSkillIds, conversationWorkspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    void getMemoryPromptBlock()
      .then((block) => {
        if (!cancelled) setMemoryPromptBlock(block);
      })
      .catch(() => {
        if (!cancelled) setMemoryPromptBlock('');
      });
    return () => {
      cancelled = true;
    };
  }, [settings.memoryEnabled, conversationId]);

  const STICK_THRESHOLD_PX = 48;

  function measureStuck(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }

  function jumpToBottom() {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setStuckToBottom(true);
    setShowJumpPill(false);
    if (conversationId) stickPrefRef.current[conversationId] = true;
  }

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const stuck = measureStuck(el);
      stuckRef.current = stuck;
      setStuckToBottom(stuck);
      if (conversationId) stickPrefRef.current[conversationId] = stuck;
      if (stuck) setShowJumpPill(false);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  // Auto-scroll only while the user is stuck to the bottom.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJumpPill(false);
    } else if (activeStream || activeRequestId != null) {
      setShowJumpPill(true);
    }
  }, [turns, activeStream, activeRequestId]);

  // Derive agent loop phase from stream state + pending calls.
  useEffect(() => {
    const phase = deriveAgentPhase(activeStream, pendingRuntimeCallsRef.current, t, fmt);
    setAgentPhase(phase);
  }, [activeStream, t, fmt]);

  async function loadConnectorToolDefinitions(): Promise<ToolDefinition[]> {
    try {
      const snapshots = await getConnectorRuntimeStates();
      const callable = snapshots.filter(isConnectorCallable);
      const capabilityEntries = await Promise.all(
        callable.map(async (snapshot) => {
          let caps: ConnectorCapability[] = [];
          try {
            caps = await listConnectorCapabilities(snapshot.connectorVersionId);
            if (caps.length === 0 && snapshot.running) {
              caps = await discoverConnector(snapshot.connectorVersionId);
            }
          } catch {
            caps = [];
          }
          return [snapshot.connectorVersionId, caps] as const;
        }),
      );
      const catalog = buildConnectorToolCatalog(
        snapshots,
        Object.fromEntries(capabilityEntries),
      );
      toolBindingsRef.current = catalog.bindings;
      return catalog.toolDefinitions;
    } catch {
      toolBindingsRef.current = {};
      return [];
    }
  }

  async function loadToolDefinitions(
    prompt: string,
    searchBackend: SearchBackend | null,
    intent?: DocumentTurnIntent,
  ): Promise<ToolDefinition[]> {
    const connectorTools = await loadConnectorToolDefinitions();
    const { tools: builtinTools } = selectBuiltinTurnTools(
      prompt,
      settings,
      conversationWorkspaceRoot,
      intent,
    );
    // Local builtin only when this turn resolved to local — never alongside
    // ProviderRequest.web_search (same name collision with hosted web_search).
    const webTools = searchBackend === 'local' ? selectBuiltinWebTools() : [];
    return [...builtinTools, ...webTools, ...connectorTools];
  }

  function applyRuntimeEventToActiveStream(
    requestId: string,
    targetConversationId: string,
    event: ConnectorRuntimeEvent,
  ) {
    const active = activeRequestRef.current;
    if (
      !active ||
      active.requestId !== requestId ||
      currentConversationIdRef.current !== targetConversationId
    ) {
      return;
    }
    if (event.kind === 'toolCallFinished') {
      pendingRuntimeCallsRef.current.delete(event.tool_call_id);
    }
    const base = streamStateRef.current ?? createAssistantStreamState(requestId);
    const next = applyConnectorRuntimeEvent(base, event);
    streamStateRef.current = next;
    setActiveStream(next);

    // A document write that failed at runtime ends the panel's generating state
    // now rather than at end of turn — otherwise the skeleton keeps shimmering
    // over a write that already died.
    if (event.kind === 'toolCallFinished' && event.status === 'failed') {
      const toolName =
        providerToolByCallIdRef.current[event.tool_call_id] ??
        next.toolCalls.find((tc) => tc.toolCallId === event.tool_call_id)?.name;
      if (toolName && isDocumentContentTool(toolName)) {
        onDocumentToolActivity?.({ phase: 'error', toolName, error: event.error ?? undefined });
      }
    }
  }

  function recordRuntimeFailure(
    requestId: string,
    targetConversationId: string,
    toolCallId: string,
    message: string,
  ) {
    pendingRuntimeCallsRef.current.delete(toolCallId);
    applyRuntimeEventToActiveStream(requestId, targetConversationId, {
      kind: 'toolCallFinished',
      tool_call_id: toolCallId,
      status: 'failed',
      size_bytes: 0n,
      mime_hints: [],
      error: message,
    });
  }

  async function handoffConnectorTool(
    requestId: string,
    targetConversationId: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ) {
    const providerToolName = providerToolByCallIdRef.current[toolCallId];
    const binding = providerToolName ? toolBindingsRef.current[providerToolName] : undefined;
    if (!binding) {
      recordRuntimeFailure(
        requestId,
        targetConversationId,
        toolCallId,
        'No connector binding matched this provider tool call.',
      );
      return;
    }

    pendingRuntimeCallsRef.current.add(toolCallId);
    const runtimeRequest = makeInvokeConnectorToolRequest(binding, requestId, toolCallId, args);
    try {
      try {
        await invokeConnectorTool(runtimeRequest, (event) =>
          applyRuntimeEventToActiveStream(requestId, targetConversationId, event),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not running')) {
          throw error;
        }
        await startConnector(binding.connectorVersionId);
        await invokeConnectorTool(runtimeRequest, (event) =>
          applyRuntimeEventToActiveStream(requestId, targetConversationId, event),
        );
      }
    } catch (error) {
      recordRuntimeFailure(
        requestId,
        targetConversationId,
        toolCallId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function waitForPendingRuntimeCalls(requestId: string) {
    const deadline = Date.now() + 30000;
    while (activeRequestRef.current?.requestId === requestId && Date.now() < deadline) {
      const hasPending = pendingRuntimeCallsRef.current.size > 0;
      const hasUnresolvedComplete = (() => {
        const state = streamStateRef.current;
        if (!state) return false;
        // Hosted web_search completes on the provider with no runtime finish —
        // `toolCallAwaitsRuntimeFinish` excludes it so we do not burn the 30s
        // deadline after the model already said "Done". Local DuckDuckGo waits.
        return state.toolCalls.some((tc) =>
          toolCallAwaitsRuntimeFinish(tc, state.searchBackend),
        );
      })();
      if (!hasPending && !hasUnresolvedComplete) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  async function handleSend(
    override?: {
      text: string;
      history: ChatTurn[];
      attachments?: TurnAttachment[];
      /** Document intent for an app-authored prompt, whatever language it is in. */
      intent?: DocumentTurnIntent;
      /** One-off generation controls for this send, over the conversation's own
       *  (a key set to `undefined` clears that control). */
      generationControls?: GenerationControls;
    },
    composerAttachments?: TurnAttachment[],
  ) {
    const trimmed = (override?.text ?? prompt).trim();
    const attachments = override?.attachments ?? composerAttachments ?? [];
    if ((!trimmed && attachments.length === 0) || !conversationId) return;

    // t1-2 M1: while a turn is in flight, enqueue instead of starting another stream.
    // Use the ref (synchronous) so a just-finished turn's stale React state does
    // not block the FIFO drain that runs from `finally`.
    if (activeRequestRef.current) {
      if (override) {
        // Programmatic send (queue drain / autoSend) must not re-enqueue.
        return;
      }
      enqueueFollowUp(trimmed, attachments.length > 0 ? attachments : undefined);
      return;
    }

    // t1-3: auto-compact older turns before the pending user message is sent.
    // Compaction reads DB messages only — never the in-flight composer turn.
    let activeCompaction = compactionRef.current;
    if (settings.contextCompactEnabled) {
      const windowTokens = getContextWindow(settings.activeModel);
      const threshold =
        settings.contextCompactThresholdPercent ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;
      if (windowTokens != null && windowTokens > 0) {
        const priorForEstimate = override?.history ?? turns;
        const keptForEstimate = historyForProviderRequest(priorForEstimate, activeCompaction);
        const { tools: estimateTools } = selectBuiltinTurnTools(
          trimmed,
          settings,
          conversationWorkspaceRoot,
        );
        const systemPrompt = composeSystemPrompt(
          [baseSystemPrompt(), CONDUIT_ARTIFACT_SYSTEM_APPENDIX()],
          resolveUserInstructions(settings, conversationUserInstructions),
          joinExtraSystemSections(skillPromptBlock, memoryPromptBlock),
        );
        const est = estimatePromptTokens({
          historyTexts: keptForEstimate.map((t) => t.content).filter(Boolean),
          systemTexts: [
            systemPrompt,
            ...(activeCompaction?.summaryText
              ? [formatCompactionDeveloperPrompt(activeCompaction.summaryText)]
              : []),
          ],
          toolDefinitions: estimateTools,
          composerText: trimmed,
          compactionSummary: activeCompaction?.summaryText,
        });
        if ((est / windowTokens) * 100 >= threshold) {
          onStatus(makeStatus(t('chat.view.status.compactingContext'), 'active', 'chat'));
          try {
            const row = await compactConversation(conversationId);
            if (row) {
              activeCompaction = row;
              compactionRef.current = row;
              setCompaction(row);
              setShowCompactedOriginals(false);
              onStatus(makeStatus(t('chat.view.status.earlierSummarized'), 'success', 'chat'));
            }
          } catch (error) {
            onStatus(
              makeStatus(
                error instanceof Error ? error.message : t('chat.view.status.contextCompactionFailed'),
                'warning',
                'chat',
              ),
            );
          }
        }
      }
    }

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const history = [...(override?.history ?? turns), userTurn];
    setTurns(history);
    if (!override) setPrompt('');
    const imagesDropped =
      attachments.length > 0 &&
      !modelAcceptsImages(settings.activeProvider, settings.activeModel);
    onStatus(
      makeStatus(
        imagesDropped
          ? t('chat.view.status.imagesNotSent')
          : t('chat.view.status.loadingConnectorTools'),
        imagesDropped ? 'warning' : 'active',
        'chat',
      ),
    );

    const searchOn = resolveWebSearchForTurn(settings, webSearchOn, trimmed);
    const searchBackend = searchOn
      ? resolveSearchBackend(
          settings.webSearch.mode,
          settings.activeProvider,
          settings.providerEndpoints,
        )
      : null;
    const toolDefinitions = await loadToolDefinitions(trimmed, searchBackend, override?.intent);
    const priorHistory = history.slice(0, -1);
    const followUpArtifact = await resolveFollowUpArtifactContext(
      priorHistory,
      trimmed,
      artifacts,
      getArtifact,
      activeArtifact,
      { forceEdit: override?.intent === 'edit' },
    );
    const providerHistory = [
      ...historyForProviderRequest(priorHistory, activeCompaction),
      userTurn,
    ];
    const [skillBlock, memoryBlock, resourceBlock] = await Promise.all([
      getSkillPromptBlock(enabledSkillIdsRef.current, conversationWorkspaceRoot).catch(
        () => skillPromptBlock,
      ),
      getMemoryPromptBlock().catch(() => memoryPromptBlock),
      readAttachedResources(attachedResourcesRef.current),
    ]);
    // Surface anything the gate refused or truncated, then clear the chips:
    // the content belongs to this turn only.
    setSkippedResources(resourceBlock.skipped);
    if (attachedResourcesRef.current.length > 0) setAttachedResources([]);
    const extraSystemSections = joinExtraSystemSections(
      skillBlock,
      memoryBlock,
      resourceBlock.text,
    );
    const request = buildProviderRequest(
      settings,
      trimmed,
      providerHistory,
      conversationId,
      toolDefinitions,
      followUpArtifact,
      searchBackend,
      {
        generationControls: override?.generationControls
          ? { ...conversationGenerationControls, ...override.generationControls }
          : conversationGenerationControls,
        userInstructions: conversationUserInstructions,
        compactionSummary: activeCompaction?.summaryText ?? null,
        extraSystemSections,
      },
    );
    // Keep the chat-bar search toggle armed until the user turns it off.
    const initialStream = createAssistantStreamState(request.requestId, searchBackend);
    setActiveTurnOutputLimit(request.generationControls?.maxTokens ?? undefined);
    setActiveTurnDocumentWriteHeld(
      toolDefinitions.some((tool) => isDocumentContentTool(tool.name)) &&
        readDocumentWriteStreaming(settings.activeProvider, settings.activeModel) === 'holds',
    );
    providerToolByCallIdRef.current = {};
    pendingRuntimeCallsRef.current = new Set();
    activeRequestRef.current = {
      requestId: request.requestId,
      conversationId,
      isAgent: toolDefinitions.length > 0,
    };
    streamStateRef.current = initialStream;
    setActiveRequestId(request.requestId);
    setActiveStream(initialStream);
    // Track the provider/model that produced this turn so the conditional
    // model line (§6.4) can show switches within the session.
    recordSessionTurnProvider(`assistant-${request.requestId}`, settings.activeProvider, settings.activeModel);

    // `start_chat_stream` spawns the provider stream and returns a handle
    // immediately — the invoke promise resolves *before* any provider events
    // arrive (network RTT + time-to-first-token). Awaiting it as if it marked
    // completion used to run the finally block at once: it nulled
    // `activeRequestRef.current` and cleared the live bubble before the first
    // `contentDelta` landed, so every event was dropped by the guard and the
    // turn rendered as a blank "stream complete". Await a promise that only
    // resolves on the terminal `messageComplete`/`error` event instead.
    let terminalError: string | null = null;
    const streamDone = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      startChatStream(
        request,
        (event) => {
        const active = activeRequestRef.current;
        if (!active || active.requestId !== request.requestId) {
          return;
        }
        if (currentConversationIdRef.current !== conversationId) {
          // The user moved to another chat mid-turn. Render nothing, but keep
          // the turn's state and let it end: dropping the terminal event here
          // left `streamDone` pending forever, so this turn never released the
          // single active-request slot and every later send — in any chat —
          // was queued and never sent.
          streamStateRef.current = applyProviderEvent(
            streamStateRef.current ?? createAssistantStreamState(request.requestId, searchBackend),
            event,
          );
          if (event.kind === 'messageComplete' || event.kind === 'error') {
            if (event.kind === 'error') terminalError = event.error.message;
            finish();
          }
          return;
        }
        // `streamStateRef` is the synchronous source of truth; `activeStream`
        // mirrors it for render. Computing from the ref (not the state) avoids
        // the render-lag where the finally block would read a state missing the
        // last delta — the useEffect-synced ref only caught up after paint.
        const base =
          streamStateRef.current ??
          createAssistantStreamState(request.requestId, searchBackend);
        const next = applyProviderEvent(base, event);
        streamStateRef.current = next;
        setActiveStream(next);

        // The agent loop retries a document round in parts when the provider
        // gave up on its silent stream, and reports a second timeout with
        // `idle_timeout`. Either way this model holds documents back.
        if (
          (event.kind === 'agentPhase' && event.label === 'Retrying in parts') ||
          (event.kind === 'error' && event.error.providerCode === 'idle_timeout')
        ) {
          markDocumentWritesHeld(settings.activeProvider, settings.activeModel);
        }
        if (event.kind === 'toolCallStart') {
          providerToolByCallIdRef.current[event.toolCallId] = event.toolId || event.name;
          if (isDocumentContentTool(event.name)) {
            onDocumentToolActivity?.({ phase: 'start', toolName: event.name });
          }
        } else if (event.kind === 'toolCallDelta') {
          // Every fragment re-renders the chat already; the panel lives in App
          // and does not need to. Forward a new title at once, counts at most
          // a few times a second.
          const write = activeDocumentWrite(next);
          if (write && write.toolCallId === event.toolCallId) {
            const sent = documentProgressSentRef.current;
            const title = write.title ?? write.filename;
            const now = Date.now();
            const due =
              !sent ||
              sent.toolCallId !== write.toolCallId ||
              sent.title !== title ||
              now - sent.at >= DOCUMENT_PROGRESS_INTERVAL_MS;
            if (due) {
              documentProgressSentRef.current = { toolCallId: write.toolCallId, at: now, title };
              onDocumentToolActivity?.({
                phase: 'progress',
                toolName: write.toolName,
                titleHint: write.mode === 'create' ? title : undefined,
                progress: {
                  contentChars: write.contentChars,
                  contentLines: write.contentLines,
                  lastActivityAt: write.lastActivityAt,
                },
              });
            }
          }
        } else if (event.kind === 'toolExecutionFinished') {
          // The document exists now. The model may keep talking for a while
          // before the turn ends; the panel should not keep a skeleton up over
          // a document that is already saved.
          if (!event.isError && isDocumentContentTool(event.toolName)) {
            const call = next.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);
            const artifactId = call?.arguments?.artifact_id;
            onDocumentToolActivity?.({
              phase: 'written',
              toolName: event.toolName,
              artifactId:
                typeof artifactId === 'string' && artifactId.trim() !== '' ? artifactId : undefined,
            });
          }
        } else if (event.kind === 'toolCallComplete') {
          // Phase A: tool execution is now owned by the Rust `AgentLoop` inside
          // `start_chat_stream`. The UI no longer hands off tool calls via IPC.
          // The `toolCallComplete` event is still rendered for the tool card.
          // Track client tools so `waitForPendingRuntimeCalls` blocks until the
          // matching `toolCallFinished` arrives. Hosted web_search never gets
          // one — the provider already ran it — so skip those ids. Local
          // DuckDuckGo web_search is a normal builtin and must wait.
          const completedCall = next.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);
          const hostedWebSearch =
            completedCall &&
            isWebSearchToolCall(completedCall) &&
            next.searchBackend !== 'local';
          if (!hostedWebSearch) {
            pendingRuntimeCallsRef.current.add(event.toolCallId);
          }
          const toolName =
            providerToolByCallIdRef.current[event.toolCallId] ??
            next.toolCalls.find((tc) => tc.toolCallId === event.toolCallId)?.name;
          if (toolName && isDocumentContentTool(toolName)) {
            const finishedCall = next.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);
            if (finishedCall) {
              recordDocumentWrite(settings.activeProvider, settings.activeModel, finishedCall);
            }
            const title =
              typeof event.arguments?.title === 'string' ? event.arguments.title : undefined;
            const artifactId =
              typeof event.arguments?.artifact_id === 'string'
                ? event.arguments.artifact_id
                : undefined;
            onDocumentToolActivity?.({
              phase: 'complete',
              toolName,
              titleHint: title,
              artifactId,
            });
          }
        } else if (event.kind === 'messageComplete' || event.kind === 'error') {
          if (event.kind === 'error') terminalError = event.error.message;
          finish();
        }
      },
      (event) => applyRuntimeEventToActiveStream(request.requestId, conversationId, event),
      ).catch((error) => {
        // Pre-stream rejection (bad model/key/connection) — the invoke rejects
        // before any event. Surface it and resolve so the finally block
        // finalizes the turn with the error rather than hanging on `streamDone`.
        terminalError = describeInvokeError(error);
        finish();
      });
    });

    try {
      await streamDone;
      // Only wait on the runtime when the turn ended cleanly. After a terminal
      // error the agent loop has already exited, so the `toolCallFinished`
      // events this polls for will never arrive and it would burn its full 30s
      // deadline with the UI still reading as busy.
      // Off screen, runtime events are not applied and nothing is committed, so
      // waiting for tool results would only hold the active slot for up to 30s.
      if (!terminalError && currentConversationIdRef.current === conversationId) {
        onStatus(makeStatus(t('chat.view.status.waitingForToolResults'), 'active', 'chat'));
        await waitForPendingRuntimeCalls(request.requestId);
      }
      // A turn that saved a document already gets "Document updated" from the
      // workspace; a second success toast for the same moment is noise.
      const documentWritten =
        !terminalError &&
        streamStateRef.current !== null &&
        hadSuccessfulDocumentToolCalls(streamStateRef.current);
      if (!documentWritten) {
        onStatus(
          makeStatus(
            terminalError ?? t('chat.view.status.streamComplete'),
            terminalError ? 'error' : 'success',
            'chat',
          ),
        );
      }
    } catch (error) {
      console.error('[startChatStream] rejected:', error);
      onStatus(makeStatus(describeInvokeError(error), 'error', 'chat'));
    } finally {
      const finalState = streamStateRef.current;
      if (currentConversationIdRef.current === conversationId && finalState) {
        const content = finalState.blocks.map((block) => block.content).join('');
        const errorText = finalState.error ?? (terminalError ?? undefined);
        const hasToolCalls = finalState.toolCalls.length > 0;
        // Don't commit an empty turn with no error. A pre-stream rejection or
        // an empty provider response would otherwise append a blank assistant
        // bubble whose `content: ""` then poisons the next request — normalize
        // rejects empty text parts with "text and reasoning parts require
        // content". Error turns are kept so the failure shows in the rail;
        // `buildProviderRequest` skips empty-content turns when sending.
        // Tool-only turns (no assistant text) are kept so tool cards persist.
        if (content.trim() !== '' || errorText || hasToolCalls) {
          void (async () => {
            let turnId = `assistant-${request.requestId}`;
            try {
              const realId = await getMessageIdByRequest(request.requestId);
              if (realId) turnId = realId;
            } catch {
              /* keep client turn id */
            }

            setTurns((current) =>
              upsertAssistantTurn(
                current,
                {
                  id: turnId,
                  role: 'assistant',
                  content,
                  streamState: { ...finalState, streaming: false, error: errorText },
                  interrupted: finalState.interrupted,
                  modelId: settings.activeModel,
                },
                request.requestId,
              ),
            );
            recordSessionTurnProvider(turnId, settings.activeProvider, settings.activeModel);

          })();
          // Notify on every ended turn, errors included. This is the only path
          // that resolves the workspace's pending-artifact state; gating it on
          // success left the document panel shimmering "Generating…" forever
          // after a failure. The handler branches on the state it is given.
          onChatTurnComplete?.({ ...finalState, streaming: false, error: errorText });
          // Warn when the user asked for an artifact but none was produced.
          const docToolsSucceeded = hadSuccessfulDocumentToolCalls(finalState);
          // Skip when the turn ended with an error: the turn already says why,
          // and a guess here ("No artifact content detected") contradicts it.
          if (looksLikeArtifactCreationRequest(trimmed) && !docToolsSucceeded && !errorText) {
            const failedDocTools = failedDocumentToolCalls(finalState);
            const hasFences = detectArtifactCandidates(content).length > 0;
            if (failedDocTools.length > 0) {
              const detail = failedDocTools
                .map((tc) => tc.error)
                .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
                .join(' ');
              onStatus(
                makeStatus(
                  detail
                    ? t('chat.view.status.documentToolFailed', { detail })
                    : t('chat.view.status.documentToolFailedGeneric'),
                  'warning',
                  'chat',
                ),
              );
            } else if (!hasFences) {
              onStatus(
                makeStatus(
                  t('chat.view.status.noArtifactContent'),
                  'warning',
                  'chat',
                ),
              );
            }
          }
        }
      }
      if (activeRequestRef.current?.requestId === request.requestId) {
        activeRequestRef.current = null;
      }
      streamStateRef.current = null;
      if (currentConversationIdRef.current === conversationId) {
        setActiveStream(null);
        setActiveRequestId(null);
      }
      providerToolByCallIdRef.current = {};
      pendingRuntimeCallsRef.current = new Set();
      // t1-2 M1: drain the next queued follow-up after the turn settles — for
      // the conversation on screen, not necessarily this turn's. A message sent
      // from a new chat while this turn was still wrapping up is queued under
      // the new chat; draining only this turn's conversation left it queued
      // forever, since nothing else would end a turn there.
      if (skipNextDrainRef.current) {
        skipNextDrainRef.current = false;
      } else {
        window.setTimeout(() => {
          const onScreen = currentConversationIdRef.current;
          // Through the ref: this closure belongs to the render that started the
          // turn, and its `handleSend` would send into that turn's conversation.
          if (onScreen) maybeDrainNextRef.current(onScreen);
        }, 0);
      }
    }
  }

  async function handleCancel() {
    const active = activeRequestRef.current;
    if (!active || active.conversationId !== conversationId) return;
    await cancelChatStream({
      requestId: active.requestId,
      conversationId,
    });
    // Tear down the live stream state. The interrupted banner for the
    // persisted turn comes from the reloaded messages (the backend's cancel
    // path marks the assistant turn `interrupted`), so there's nothing to
    // render live here — clear and reload. The in-flight `handleSend` await
    // (`streamDone`) is left pending; its finally is a no-op once the request
    // id no longer matches, and a new send overwrites `streamStateRef`.
    // Notify first, though: that finally being a no-op is exactly why nothing
    // used to clear the workspace's pending-artifact state on a cancel.
    const cancelledState = streamStateRef.current;
    if (cancelledState) onChatTurnComplete?.(markInterrupted(cancelledState));
    activeRequestRef.current = null;
    streamStateRef.current = null;
    setActiveStream(null);
    setActiveRequestId(null);
    try {
      const messages = await getConversationMessages(conversationId);
      const turns = (
        await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))
      ).filter((t): t is ChatTurn => t !== null);
      setTurns(turns);
    } catch {
      /* ignore */
    }
    onStatus(makeStatus(t('chat.view.status.streamCancelled'), 'success', 'chat'));
    // Cancelled turns do not auto-drain: the user stopped on purpose. Queued
    // follow-ups stay until they send again or hit Send now / remove.
  }

  useImperativeHandle(ref, () => ({
    stopStreaming: () => {
      void handleCancel();
    },
    readActiveDocumentWrite: () => {
      const state = streamStateRef.current;
      const write = activeDocumentWrite(state);
      const call = write && state?.toolCalls.find((tc) => tc.toolCallId === write.toolCallId);
      return call ? { toolName: call.name, argumentsText: call.argumentsText } : null;
    },
    isStreaming: () => activeRequestRef.current != null,
    copyLastAssistantMessage: async () => {
      const last = [...turns].reverse().find((t) => t.role === 'assistant');
      const text =
        last?.content?.trim() ||
        last?.streamState?.blocks.map((b) => b.content).join('').trim() ||
        activeStream?.blocks.map((b) => b.content).join('').trim() ||
        '';
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    scrollToMessage: (messageId: string) => {
      // Small delay to let the DOM settle after conversation switch
      setTimeout(() => {
        const el = document.querySelector(`[data-message-id="${messageId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('message-highlight');
          setTimeout(() => el.classList.remove('message-highlight'), 2000);
        }
      }, 100);
    },
    insertPrompt: insertPromptText,
    toggleWebSearch: () => {
      // Only reachable when the composer's web toggle would be visible.
      if (settings.webSearchEnabled && !settings.localOnly) {
        handleWebSearchToggle();
      }
    },
    forkConversationHere: async () => {
      if (!conversationId) return false;
      const last = turns[turns.length - 1];
      if (!last) return false;
      onForkConversation?.(conversationId, last.id);
      return true;
    },
    editLastUserMessage: () => {
      if (activeRequestId || editBusy) return false;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === 'user') {
          handleEditUserTurn(turns[i]);
          return true;
        }
      }
      return false;
    },
    openChatSettings: () => {
      if (activeRequestId || !conversationId) return false;
      composerRef.current?.openChatSettings();
      return true;
    },
  }));

  function handleWebSearchToggle() {
    if (!webSearchOn && !settings.webSearchConsentAcknowledged && !chatConsentDismissed) {
      setShowChatConsent(true);
      return;
    }
    setWebSearchOn((on) => !on);
  }

  async function bindWorkspaceFolder(path: string) {
    if (!conversationId) return;
    try {
      const updated = await setConversationWorkspace(conversationId, path);
      setConversationWorkspaceRoot(updated.workspaceRoot?.trim() || path);
      // Remember as Settings default for future new chats (does not force enable).
      await updateSettings({
        workspaceRoot: path,
        workspaceToolsConsentAcknowledged: true,
      });
      onStatus(t('chat.view.status.workingInFolder', { path }));
    } catch (error) {
      onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotSetWorkspaceFolder'));
    }
  }

  async function handleWorkspacePick() {
    if (!conversationId || workspacePicking) return;
    if (!settings.workspaceToolsConsentAcknowledged) {
      setShowWorkspaceConsent(true);
      return;
    }
    setWorkspacePicking(true);
    try {
      const path = await pickWorkspaceFolder();
      if (path == null) return;
      await bindWorkspaceFolder(path);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotPickFolder'));
    } finally {
      setWorkspacePicking(false);
    }
  }

  async function handleWorkspaceClear() {
    if (!conversationId) return;
    try {
      await setConversationWorkspace(conversationId, null);
      setConversationWorkspaceRoot(null);
      onStatus(t('chat.view.status.workspaceFolderCleared'));
    } catch (error) {
      onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotClearWorkspaceFolder'));
    }
  }

  async function handleSaveChatSettings(
    generationControls: GenerationControls | null,
    userInstructions: string | null,
  ) {
    if (!conversationId) return;
    try {
      const updated = await setConversationChatSettings(
        conversationId,
        generationControls,
        userInstructions,
      );
      setConversationGenerationControls(updated.generationControls ?? null);
      setConversationUserInstructions(updated.userInstructions ?? null);
      onStatus(
        generationControls || userInstructions
          ? t('chat.view.status.chatSettingsSaved')
          : t('chat.view.status.chatSettingsReset'),
      );
    } catch (error) {
      onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotSaveChatSettings'));
    }
  }

  /// Insert text at the composer's cursor, or append it when the composer is
  /// not focused. Shared by the prompts library (via the imperative handle)
  /// and the MCP prompt picker.
  function insertPromptText(text: string) {
    setPrompt((prev) => {
      const ta = document.querySelector('.composer-textarea') as HTMLTextAreaElement | null;
      if (ta && document.activeElement === ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        return prev.slice(0, start) + text + prev.slice(end);
      }
      return prev + (prev ? '\n' : '') + text;
    });
    requestAnimationFrame(() => {
      const ta = document.querySelector('.composer-textarea') as HTMLTextAreaElement | null;
      ta?.focus();
    });
  }

  /**
   * Picking a prompt either resolves straight into the composer, or opens the
   * argument form first. Either way the result is editable draft text, so the
   * user sees exactly what will be sent.
   */
  function handlePickMcpPrompt(prompt: ConnectorPromptInfo) {
    if (needsArgumentDialog(prompt)) {
      setMcpPromptNeedingArgs(prompt);
      return;
    }
    void resolveMcpPrompt(prompt, {});
  }

  async function resolveMcpPrompt(prompt: ConnectorPromptInfo, values: Record<string, string>) {
    setMcpPromptNeedingArgs(null);
    try {
      const text = await getConnectorPrompt({
        connectorVersionId: prompt.connectorVersionId,
        name: prompt.name,
        arguments: buildPromptArguments(prompt, values),
      });
      composerRef.current?.focusPrompt();
      insertPromptText(text);
    } catch (error) {
      onStatusRef.current(error instanceof Error ? error.message : String(error));
    }
  }

  function attachMcpResource(resource: ConnectorResourceInfo) {
    const ref = toResourceRef(resource);
    setAttachedResources((prev) =>
      prev.some((r) => sameResource(r, ref)) ? prev : [...prev, ref],
    );
  }

  /**
   * Detaching is unconditional. Attaching asks once per connector first,
   * because it is what sends that server's content to the model provider.
   * Rust enforces the same check, so declining here is not the only thing
   * standing between an unacknowledged server and a read.
   */
  function handleToggleMcpResource(resource: ConnectorResourceInfo, attach: boolean) {
    if (!attach) {
      const ref = toResourceRef(resource);
      setAttachedResources((prev) => prev.filter((r) => !sameResource(r, ref)));
      return;
    }
    void (async () => {
      let acknowledged = false;
      try {
        acknowledged = await isConnectorResourceAcknowledged(resource.connectorVersionId);
      } catch {
        // Treat an unreadable answer as "not yet asked": the prompt is
        // cheap, and silently attaching would be the wrong way to fail.
        acknowledged = false;
      }
      if (acknowledged) {
        attachMcpResource(resource);
      } else {
        setMcpResourceNeedingConsent(resource);
      }
    })();
  }

  async function confirmMcpResourceConsent(resource: ConnectorResourceInfo) {
    setMcpResourceNeedingConsent(null);
    try {
      await acknowledgeConnectorResources(resource.connectorVersionId);
      attachMcpResource(resource);
    } catch (error) {
      onStatusRef.current(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleToggleSkill(skillId: string, enabled: boolean) {
    if (!conversationId) return;
    const next = enabled
      ? [...enabledSkillIdsRef.current, skillId]
      : enabledSkillIdsRef.current.filter((id) => id !== skillId);
    const unique = [...new Set(next)];
    setEnabledSkillIds(unique);
    try {
      await setConversationSkills(conversationId, unique);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotUpdateSkills'));
    }
  }

  function handleSuggestionSelect(text: string) {
    setPrompt(text);
    requestAnimationFrame(() => composerRef.current?.focusPrompt());
  }

  const suggestedPrompts = useMemo(
    () => deriveSuggestedPrompts({ turns, artifacts }),
    [turns, artifacts],
  );

  // Accumulated usage across the whole conversation: every committed assistant
  // turn's usage plus the live streaming turn. Spend (not context fill) uses this.
  const accumulatedUsage = useMemo(() => {
    let merged: ProviderUsage | null = null;
    for (const turn of turns) {
      const usage = turn.streamState?.usage;
      if (usage) merged = mergeProviderUsage(merged, usage);
    }
    if (activeStream?.usage) merged = mergeProviderUsage(merged, activeStream.usage);
    return merged;
  }, [turns, activeStream]);

  // Next-request prompt size (chars÷4). Live as history/composer change — do not
  // sum per-turn API usage (that double-counts re-sent history).
  const contextTokens = useMemo(() => {
    const kept = historyForProviderRequest(turns, compaction);
    const historyTexts: string[] = [];
    for (const turn of kept) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      if (turn.content) historyTexts.push(turn.content);
    }
    if (activeStream) {
      const live = activeStream.blocks.map((b) => b.content).join('');
      if (live) historyTexts.push(live);
    }
    const { tools: toolDefinitions } = selectBuiltinTurnTools(
      prompt,
      settings,
      conversationWorkspaceRoot,
    );
    const systemPrompt = composeSystemPrompt(
      [baseSystemPrompt(), CONDUIT_ARTIFACT_SYSTEM_APPENDIX()],
      resolveUserInstructions(settings, conversationUserInstructions),
      joinExtraSystemSections(skillPromptBlock, memoryPromptBlock),
    );
    const compactionDev = compaction?.summaryText
      ? formatCompactionDeveloperPrompt(compaction.summaryText)
      : undefined;
    return estimatePromptTokens({
      historyTexts,
      systemTexts: [systemPrompt, ...(compactionDev ? [compactionDev] : [])],
      toolDefinitions,
      composerText: prompt,
      compactionSummary: compaction?.summaryText,
    });
  }, [
    turns,
    compaction,
    activeStream,
    prompt,
    settings,
    conversationUserInstructions,
    conversationWorkspaceRoot,
    skillPromptBlock,
    memoryPromptBlock,
  ]);

  const compactThresholdPercent =
    settings.contextCompactThresholdPercent ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;

  const showInlineSuggestions =
    turns.length > 0 &&
    !activeStream &&
    activeRequestId == null &&
    !prompt.trim();

  // Drives both the greeting and the `data-empty` hook that centres the
  // greeting and composer as one group (§10). One condition, one source.
  const threadEmpty = !threadLoading && turns.length === 0 && !activeStream;
  const visibleTurns = excludeLiveAssistantTurns(
    turns,
    activeStream?.requestId ?? activeRequestId,
  );
  const { kept: keptTurns, compacted: compactedTurns } = splitTurnsAtCompaction(
    visibleTurns,
    compaction,
  );
  const displayTurns = showCompactedOriginals ? visibleTurns : keptTurns;

  // Per-turn provider/model for the conditional model line (§6.4).
  // Session-tracked turns win; hydrated turns fall back to the conversation's
  // last-used provider (or the active provider) and the active model.
  const turnModelInfo = useMemo(() => {
    const info: Record<
      string,
      { provider: string; model: string; switchedFrom?: string; showModelLine: boolean; time?: string }
    > = {};
    let lastProvider: string | undefined;
    let lastModel: string | undefined;
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue;
      const session = sessionTurnProviders.get(turn.id);
      const provider =
        session?.provider ?? convoProviders[conversationId ?? ''] ?? settings.activeProvider;
      const model = session?.model ?? turn.modelId ?? settings.activeModel;
      const prev =
        lastProvider !== undefined && lastModel !== undefined
          ? { provider: lastProvider, model: lastModel }
          : undefined;
      info[turn.id] = {
        provider,
        model,
        switchedFrom: prev && prev.provider !== provider ? prev.provider : undefined,
        showModelLine: shouldShowModelLine(prev, { provider, model }),
        time: turn.createdAt ? formatMsgTime(turn.createdAt, fmt) : undefined,
      };
      lastProvider = provider;
      lastModel = model;
    }
    return info;
  }, [turns, convoProviders, conversationId, settings.activeProvider, settings.activeModel, fmt]);

  // Provider/model of the last committed assistant turn (for the live turn's
  // model line + "switched from …" note).
  const lastAssistantTurn = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.role !== 'assistant') continue;
      const info = turnModelInfo[turn.id];
      if (info) return { provider: info.provider, model: info.model };
    }
    return undefined;
  }, [turns, turnModelInfo]);

  const liveTurnInfo = useMemo(() => {
    const provider = settings.activeProvider;
    const model = settings.activeModel;
    return {
      provider,
      model,
      switchedFrom:
        lastAssistantTurn && lastAssistantTurn.provider !== provider
          ? lastAssistantTurn.provider
          : undefined,
      showModelLine: shouldShowModelLine(lastAssistantTurn, { provider, model }),
    };
  }, [lastAssistantTurn, settings.activeProvider, settings.activeModel]);

  useEffect(() => {
    if (!autoSend) return;
    const payload = autoSend;
    setAutoSend(null);
    void handleSend(payload);
    // handleSend closes over latest settings/tools; run once per staged payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

  function handleEditUserTurn(turn: ChatTurn) {
    if (activeRequestId || editBusy) return;
    setEditingTurnId(turn.id);
    setEditDraft(turn.content);
    requestAnimationFrame(() => editTextareaRef.current?.focus());
  }

  function cancelInlineEdit() {
    setEditingTurnId(null);
    setEditDraft('');
    setEditConfirm(null);
  }

  function requestSubmitInlineEdit() {
    if (!editingTurnId || editBusy || activeRequestId) return;
    const text = editDraft.trim();
    if (!text) return;
    const idx = turns.findIndex((t) => t.id === editingTurnId);
    if (idx < 0) return;
    const later = turns.slice(idx + 1);
    const hasLaterUser = later.some((t) => t.role === 'user');
    const hasLaterAssistant = later.some((t) => t.role === 'assistant');
    if (hasLaterUser) {
      setEditConfirm({ messageId: editingTurnId, text, kind: 'fork' });
      return;
    }
    if (hasLaterAssistant) {
      setEditConfirm({ messageId: editingTurnId, text, kind: 'tip' });
      return;
    }
    void commitMessageEdit(editingTurnId, text);
  }

  /** The Max tokens limit in effect: the conversation's own, else the app default. */
  const effectiveMaxTokens = mergeGenerationControls(
    settings.generationControls,
    conversationGenerationControls,
  )?.maxTokens;

  /** Send the last prompt again with Max tokens cleared for this one request. */
  async function retryLastPromptWithoutLimit() {
    const lastUser = [...turns].reverse().find((turn) => turn.role === 'user');
    if (!lastUser) return;
    await commitMessageEdit(lastUser.id, lastUser.content, { maxTokens: undefined });
  }

  async function commitMessageEdit(
    messageId: string,
    text: string,
    generationControls?: GenerationControls,
  ) {
    if (!conversationId || activeRequestId) return;
    const editedTurn = turns.find((t) => t.id === messageId);
    const preservedAttachments = editedTurn?.attachments;
    setEditBusy(true);
    setEditConfirm(null);
    try {
      const result = await prepareMessageEdit(conversationId, messageId);
      setEditingTurnId(null);
      setEditDraft('');
      if (result.mode === 'forked') {
        onEditForked?.(result.conversation, text);
        onStatus(makeStatus(t('chat.view.status.editingOnNewBranch'), 'success', 'chat'));
        return;
      }
      const messages = await getConversationMessages(conversationId);
      const nextTurns = (
        await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))
      ).filter((t): t is ChatTurn => t !== null);
      setTurns(nextTurns);
      await handleSend({
        text,
        history: nextTurns,
        attachments: preservedAttachments,
        generationControls,
      });
    } catch (error) {
      onStatus(
        makeStatus(
          error instanceof Error ? error.message : t('chat.view.status.failedToPrepareMessageEdit'),
          'error',
          'chat',
        ),
      );
    } finally {
      setEditBusy(false);
    }
  }

  function handleEditKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelInlineEdit();
      return;
    }
    const sendWith = readSendWith();
    const isEnter = event.key === 'Enter' && !event.shiftKey;
    const isCmdEnter = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if ((sendWith === 'enter' && isEnter) || (sendWith === 'cmd-enter' && isCmdEnter)) {
      event.preventDefault();
      requestSubmitInlineEdit();
    }
  }

  /** P3.1/P3.2 — retry/delete the last assistant turn: remove it locally + in
   *  the DB (`removeLastTurn` deletes the last assistant turn + its event log
   *  + tool rows), then reload the thread. The user keeps their prompt so they
   *  can re-send or edit. */
  async function handleRemoveLastAssistantTurn() {
    if (!conversationId || activeRequestId) return;
    try {
      const count = await removeLastTurn(conversationId);
      const messages = await getConversationMessages(conversationId);
      const nextTurns = (await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))).filter(
        (t): t is ChatTurn => t !== null,
      );
      setTurns(nextTurns);
      onStatus(
        makeStatus(
          count > 0 ? t('chat.view.status.removedLastResponse') : t('chat.view.status.nothingToRemove'),
          'success',
          'chat',
        ),
      );
    } catch (error) {
      onStatus(
        makeStatus(
          error instanceof Error ? error.message : t('chat.view.status.failedToRemoveResponse'),
          'error',
          'chat',
        ),
      );
    }
  }

  async function handleCopyText(content: string) {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <>
    <section
      className="tab-pane"
      data-pane="chat"
      data-active={paneActive ? 'true' : 'false'}
      data-empty={threadEmpty ? 'true' : 'false'}
      aria-label={t('chat.view.aria.chatSession')}
    >
      <a
        className="skip-link"
        href="#composer-anchor"
        aria-label={t('chat.view.skipToComposer')}
        onClick={(e) => {
          e.preventDefault();
          composerRef.current?.focusPrompt();
        }}
      >
        {t('chat.view.skipToComposer')}
      </a>
      <ChatErrorBoundary>
      <div className="thread scroll" ref={threadRef}>
        <div className="thread-inner">
          {threadLoading && (
            <div className="thread-skeleton" aria-busy="true" aria-label={t('chat.view.aria.loadingConversation')}>
              <div className="skel-msg">
                <div className="skel-av" />
                <div className="skel-lines">
                  <div className="skel-line w-90" />
                  <div className="skel-line w-75" />
                  <div className="skel-line w-40" />
                </div>
              </div>
            </div>
          )}
          {threadEmpty && (
            <div className="welcome">
              <h1>
                <BotGlyph className="brand-mark" aria-hidden="true" />
                {t('chat.view.welcomeTitle')}
              </h1>
              {!conversationWorkspaceRoot && conversationId ? (
                <p style={{ marginTop: 12, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', maxWidth: 360 }}>
                  {tr('chat.view.welcomeWorkspaceHint', {
                    action: (chunks: ReactNode[]) => (
                      <button
                        key="workspace-hint-button"
                        type="button"
                        className="btn ghost"
                        style={{ padding: '2px 6px', fontSize: 'var(--fs-3xl)' }}
                        disabled={workspacePicking}
                        onClick={() => void handleWorkspacePick()}
                      >
                        {chunks}
                      </button>
                    ),
                  })}
                </p>
              ) : null}
            </div>
          )}
          {!threadLoading && compactedTurns.length > 0 && (
            <div className="compaction-block">
              <button
                type="button"
                className="compaction-toggle"
                aria-expanded={showCompactedOriginals}
                onClick={() => setShowCompactedOriginals((v) => !v)}
              >
                {t('chat.view.compaction.toggleLabel')}
                <span className="compaction-toggle-meta">
                  {showCompactedOriginals
                    ? t('chat.view.compaction.hideOriginals')
                    : t('chat.view.compaction.showCount', { count: compactedTurns.length })}
                </span>
              </button>
              {showCompactedOriginals && compaction?.summaryText ? (
                <p className="compaction-summary">{compaction.summaryText}</p>
              ) : null}
            </div>
          )}
          {!threadLoading && displayTurns.flatMap((turn, turnIndex) => {
            // Day separator (V9 §4): rendered only where the calendar day
            // actually changes, so it marks a boundary instead of captioning
            // every turn. Never above the first turn — there is no boundary
            // between a thread and its own beginning.
            const prevTurn = turnIndex > 0 ? displayTurns[turnIndex - 1] : undefined;
            const dayRule =
              turn.createdAt &&
              prevTurn?.createdAt &&
              !sameCalendarDay(prevTurn.createdAt, turn.createdAt) ? (
                <div className="day-rule" key={`day-${turn.id}`}>
                  <span>{dayRuleLabel(turn.createdAt, { locale: fmt.locale, t })}</span>
                </div>
              ) : null;
            // Returned as a flat pair so the rule is a sibling of the turn
            // rather than nested inside it — a separator that lived in the turn
            // would inherit its left rule and indent. Both halves carry keys.
            const withDay = (node: ReactNode) => (dayRule ? [dayRule, node] : node);

            if (turn.role === 'user') {
              const isEditing = editingTurnId === turn.id;
              return withDay(
                <article
                  key={turn.id}
                  className="turn user"
                  data-message-id={turn.id}
                  data-role-label={t('chat.turn.roleLabel.user')}
                >
                  {isEditing ? (
                    <div className="bubble bubble-editing">
                      <textarea
                        ref={editTextareaRef}
                        className="bubble-edit"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        disabled={editBusy}
                        aria-label={t('chat.view.aria.editMessage')}
                        rows={2}
                      />
                      <div className="turn-actions" style={{ opacity: 1, pointerEvents: 'auto' }}>
                        <button
                          type="button"
                          className="act"
                          disabled={editBusy || !editDraft.trim()}
                          onClick={() => requestSubmitInlineEdit()}
                        >
                          {t('chat.view.inlineEdit.send')}
                        </button>
                        <button
                          type="button"
                          className="act"
                          disabled={editBusy}
                          onClick={cancelInlineEdit}
                        >
                          {t('common.actions.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="bubble">
                        {turn.attachments && turn.attachments.length > 0 ? (
                          <UserTurnAttachments attachments={turn.attachments} />
                        ) : null}
                        {turn.content.trim() ? (
                          <p dangerouslySetInnerHTML={{ __html: escapeHtml(turn.content) }} />
                        ) : null}
                      </div>
                      {turn.interrupted && <InterruptedBanner visible />}
                      <div className="turn-actions">
                        <button
                          type="button"
                          className="act"
                          disabled={!!activeRequestId || editBusy}
                          onClick={() => handleEditUserTurn(turn)}
                        >
                          <PencilIcon />
                          {t('common.actions.edit')}
                        </button>
                        <button
                          type="button"
                          className="act"
                          onClick={() => onForkConversation?.(conversationId ?? '', turn.id)}
                          title={t('chat.view.aria.forkAtMessage')}
                        >
                          <ForkIcon />
                          {t('common.actions.fork')}
                        </button>
                        <button
                          type="button"
                          className="act"
                          onClick={() => void handleCopyText(turn.content)}
                        >
                          <CopyIcon />
                          {t('common.actions.copy')}
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            }
            const info = turnModelInfo[turn.id];
            const provider = info?.provider ?? settings.activeProvider;
            const model = info?.model ?? settings.activeModel;
            if (turn.streamState) {
              return withDay(
                <AssistantMessage
                  key={turn.id}
                  state={turn.streamState}
                  provider={provider}
                  modelId={model}
                  time={info?.time}
                  switchedFrom={info?.switchedFrom}
                  showModelLine={info?.showModelLine ?? false}
                  messageId={turn.id}
                  artifacts={artifacts}
                  fileStateMap={fileStateMap}
                  onPromoteArtifact={onPromoteArtifact}
                  onOpenArtifact={onOpenArtifact}
                  onStatus={onStatus}
                  isLast={turn.id === visibleTurns[visibleTurns.length - 1]?.id}
                  onRetry={() => void handleRemoveLastAssistantTurn()}
                  onRetryWithoutLimit={effectiveMaxTokens ? () => void retryLastPromptWithoutLimit() : undefined}
                  onContinueBuilding={() =>
                    void handleSend({
                      text: t('chat.documentBuild.continuePrompt'),
                      history: turnsRef.current,
                      intent: 'edit',
                    })
                  }
                  onDelete={() => void handleRemoveLastAssistantTurn()}
                  onCopy={() => void handleCopyText(turn.content)}
                  onFork={() => onForkConversation?.(conversationId ?? '', turn.id)}
                  conversationId={conversationId}
                />
              );
            }
            return withDay(
              <article
                key={turn.id}
                className="turn assistant"
                data-provider={providerHueId(provider)}
                data-message-id={turn.id}
                data-role-label={t('chat.turn.roleLabel.assistant')}
              >
                {info?.showModelLine && (
                  <TurnModelLine
                    provider={provider}
                    model={model}
                    time={info?.time}
                    switchedFrom={info?.switchedFrom}
                  />
                )}
                <ChatMessageContent
                  content={turn.content}
                  messageId={turn.id}
                  artifacts={artifacts}
                  fileStateMap={fileStateMap}
                  onPromoteArtifact={onPromoteArtifact}
                  onOpenArtifact={onOpenArtifact}
                  onStatus={onStatus}
                />
                <InterruptedBanner
                  visible={Boolean(turn.interrupted)}
                  onRetry={() => void handleRemoveLastAssistantTurn()}
                />
                <AssistantArtifactStrip
                  messageId={turn.id}
                  artifacts={artifacts}
                  fileStateMap={fileStateMap}
                  excludeArtifactIds={inlineArtifactIds(
                    detectArtifactCandidates(turn.content),
                    artifacts,
                    turn.id,
                  )}
                  onOpenArtifact={onOpenArtifact}
                  onStatus={onStatus}
                />
                <div className="turn-actions">
                  <button
                    type="button"
                    className="act"
                    onClick={() => void handleCopyText(turn.content)}
                  >
                    <CopyIcon />
                    {t('common.actions.copy')}
                  </button>
                  <button
                    type="button"
                    className="act"
                    onClick={() => void handleRemoveLastAssistantTurn()}
                  >
                    <PencilIcon />
                    {t('common.actions.retry')}
                  </button>
                  <button
                    type="button"
                    className="act"
                    onClick={() => onForkConversation?.(conversationId ?? '', turn.id)}
                  >
                    <ForkIcon />
                    {t('common.actions.fork')}
                  </button>
                </div>
              </article>
            );
          })}
          {activeStream && (
            <AssistantMessage
              state={{
                ...activeStream,
                agentPhase: (() => {
                  const phase = agentPhase ?? activeStream.agentPhase;
                  // While the model builds a document in parts, say how much is
                  // left — the open document refreshes after every patch, and
                  // its placeholders are the sections still to write.
                  const building = activeStream.toolCalls.some(
                    (tc) => isDocumentContentTool(tc.name) && tc.arguments?.more_to_write === true,
                  );
                  const sectionsLeft = building
                    ? placeholderSections(activeArtifact?.contentText).length
                    : 0;
                  const base =
                    phase && sectionsLeft > 0
                      ? {
                          ...phase,
                          detail: [
                            phase.detail,
                            t('chat.documentBuild.sectionsLeft', { count: sectionsLeft }),
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        }
                      : phase;
                  if (queuedForConversation.length === 0 || !base) {
                    return queuedForConversation.length > 0
                      ? {
                          label: t('chat.view.agentPhase.queuedOnly', {
                            count: queuedForConversation.length,
                          }),
                          round: 0,
                          totalRounds: 0,
                          subPhase: 'thinking',
                        }
                      : base;
                  }
                  return {
                    ...base,
                    label: t('chat.view.agentPhase.queuedWithBase', {
                      base: base.label,
                      count: queuedForConversation.length,
                    }),
                  };
                })(),
              }}
              outputLimit={activeTurnOutputLimit}
              provider={liveTurnInfo.provider}
              modelId={liveTurnInfo.model}
              switchedFrom={liveTurnInfo.switchedFrom}
              showModelLine={liveTurnInfo.showModelLine}
              conversationId={conversationId}
              documentWriteHeld={activeTurnDocumentWriteHeld}
            />
          )}
        </div>
      </div>
      </ChatErrorBoundary>

      {showJumpPill && !stuckToBottom && (
        <button
          className="jump-to-bottom"
          type="button"
          onClick={jumpToBottom}
        >
          {t('chat.view.jumpToBottom')}
        </button>
      )}

      {showInlineSuggestions && (
        <SuggestedPrompts prompts={suggestedPrompts} onSelect={handleSuggestionSelect} />
      )}

      {mcpPromptNeedingArgs && (
        <McpPromptArgumentsDialog
          prompt={mcpPromptNeedingArgs}
          onConfirm={(values) => void resolveMcpPrompt(mcpPromptNeedingArgs, values)}
          onCancel={() => setMcpPromptNeedingArgs(null)}
        />
      )}

      {mcpResourceNeedingConsent && (
        <McpResourceConsentDialog
          resource={mcpResourceNeedingConsent}
          onConfirm={() => void confirmMcpResourceConsent(mcpResourceNeedingConsent)}
          onCancel={() => setMcpResourceNeedingConsent(null)}
        />
      )}

      {skippedResources.length > 0 && (
        <div className="mcp-resource-skipped" role="status">
          <p>{t('chat.mcpResources.skippedIntro')}</p>
          <ul>
            {skippedResources.map((s) => (
              <li key={s.uri}>
                <code>{s.uri}</code> — {s.reason}
              </li>
            ))}
          </ul>
          <button type="button" className="btn ghost" onClick={() => setSkippedResources([])}>
            {t('chat.mcpResources.dismissSkipped')}
          </button>
        </div>
      )}

      <Composer
        ref={composerRef}
        settings={settings}
        onSelectModel={onSelectModel}
        conversationId={conversationId}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={(attachments) => void handleSend(undefined, attachments)}
        onStop={() => void handleCancel()}
        streaming={activeRequestId != null}
        queuedMessages={queuedForConversation}
        onRemoveQueued={removeQueued}
        onSendQueuedNow={(id) => {
          // Steer wins: interrupt the in-flight agent iteration and inject this
          // text; remaining queue stays. Non-agent streams cancel + resend.
          if (!conversationId) return;
          const item = listFor(messageQueuesRef.current, conversationId).find((q) => q.id === id);
          if (!item) return;
          setMessageQueues((current) => {
            const next = remove(current, conversationId, id);
            messageQueuesRef.current = next;
            return next;
          });
          void (async () => {
            const active = activeRequestRef.current;
            if (active?.isAgent) {
              try {
                await steerChatStream({
                  requestId: active.requestId,
                  conversationId,
                  text: item.text,
                });
                onStatus(makeStatus(t('chat.view.status.steering'), 'active', 'chat'));
                return;
              } catch (error) {
                onStatus(
                  makeStatus(
                    error instanceof Error ? error.message : t('chat.view.status.steerFailed'),
                    'error',
                    'chat',
                  ),
                );
              }
            }
            if (activeRequestRef.current) {
              skipNextDrainRef.current = true;
              await handleCancel();
            }
            await handleSend({
              text: item.text,
              history: turnsRef.current,
              attachments: item.attachments,
            });
          })();
        }}
        webSearchOn={webSearchOn}
        onWebSearchToggle={handleWebSearchToggle}
        workspaceRoot={conversationWorkspaceRoot}
        onWorkspacePick={() => void handleWorkspacePick()}
        onWorkspaceClear={() => void handleWorkspaceClear()}
        generationControls={conversationGenerationControls}
        userInstructions={conversationUserInstructions}
        onSaveChatSettings={(controls, instructions) =>
          void handleSaveChatSettings(controls, instructions)
        }
        skills={discoveredSkills}
        enabledSkillIds={enabledSkillIds}
        onToggleSkill={(id, on) => void handleToggleSkill(id, on)}
        mcpPrompts={mcpPrompts}
        mcpResources={mcpResources}
        attachedResources={attachedResources}
        onPickMcpPrompt={handlePickMcpPrompt}
        onToggleMcpResource={handleToggleMcpResource}
        onRefreshMcpCapabilities={() => setMcpReloadToken((n) => n + 1)}
        onOpenSettings={onOpenSettings}
        usage={accumulatedUsage}
        contextTokens={contextTokens}
        compactThresholdPercent={compactThresholdPercent}
      />
      <div id="composer-anchor" tabIndex={-1} />
    </section>
      {/* Phase 7 / M-WebSearch: first-use consent dialog for the chat-bar toggle. */}
      <WebSearchConsentDialog
        visible={showChatConsent}
        onAllow={() => {
          setShowChatConsent(false);
          setWebSearchOn(true);
          // Persist the acknowledgement so the dialog never reappears.
          void updateSettings({ webSearchConsentAcknowledged: true });
        }}
        onDeny={() => {
          setShowChatConsent(false);
          // Remember the dismissal for this session only.
          setChatConsentDismissed(true);
        }}
      />
      <WorkspaceToolsConsentDialog
        visible={showWorkspaceConsent}
        onAllow={() => {
          setShowWorkspaceConsent(false);
          void (async () => {
            try {
              await updateSettings({ workspaceToolsConsentAcknowledged: true });
              setWorkspacePicking(true);
              const path = await pickWorkspaceFolder();
              if (path == null) return;
              await bindWorkspaceFolder(path);
            } catch (error) {
              onStatus(error instanceof Error ? error.message : t('chat.view.status.couldNotSetWorkspaceFolder'));
            } finally {
              setWorkspacePicking(false);
            }
          })();
        }}
        onDeny={() => {
          setShowWorkspaceConsent(false);
        }}
      />
      <ConfirmDialog
        cancelLabel={t('common.actions.cancel')}
        open={editConfirm != null}
        title={
          editConfirm?.kind === 'fork'
            ? t('chat.view.editConfirm.forkTitle')
            : t('chat.view.editConfirm.replaceTitle')
        }
        description={
          editConfirm?.kind === 'fork'
            ? t('chat.view.editConfirm.forkDescription')
            : t('chat.view.editConfirm.replaceDescription')
        }
        confirmLabel={
          editConfirm?.kind === 'fork'
            ? t('chat.view.editConfirm.forkConfirmLabel')
            : t('chat.view.editConfirm.replaceConfirmLabel')
        }
        destructive={editConfirm?.kind === 'tip'}
        onCancel={() => setEditConfirm(null)}
        onConfirm={() => {
          if (!editConfirm) return;
          const { messageId, text } = editConfirm;
          void commitMessageEdit(messageId, text);
        }}
      />
    </>
  );
});