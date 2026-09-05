import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AppSettings, GenerationControls, ProviderUsage } from '@conduit/config-schema';
import {
  deleteAttachment,
  listProviderDescriptors,
  loadProviderCredentialReference,
  saveAttachment,
} from '../ipc/client';
import { AttachIcon, FilePlainIcon, FolderIcon, SearchIcon, SendIcon, SkillIcon, SlidersIcon, StopIcon } from '../icons';
import { brand } from '../brand';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';
import { StatusLine, type CredentialMode } from '../shell/StatusLine';
import {
  ATTACHMENT_INLINE_CAP_BYTES,
  COMPOSER_IMAGE_ACCEPT,
  isForwardableImageMime,
  turnAttachmentsFromPending,
  type PendingAttachment,
  type TurnAttachment,
} from './composerTypes';
import { useComposerAutosize } from './useComposerAutosize';
import { readSendWith } from '../shell/uiPrefs';
import { workspaceFolderLabel } from './agentTools';
import { localSearchBackendLabel, resolveSearchBackend } from './webSearchIntent';
import { ComposerChatSettings } from './ComposerChatSettings';
import { ComposerSkills } from './ComposerSkills';
import type { SkillSummary } from '../ipc/contracts';
import { previewText, type QueuedMessage } from './messageQueue';

export interface ComposerHandle {
  focusPrompt: () => void;
  openChatSettings: () => void;
}

export interface ComposerProps {
  settings: AppSettings;
  /** Write provider + model in one settings update. The chat surface only
   *  ever changes these two fields, so it takes the specific capability
   *  rather than a general settings setter. */
  onSelectModel: (providerId: string, modelId: string, defaultBaseUrl?: string | null) => void;
  conversationId: string | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: (attachments?: TurnAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  /** t1-2: follow-ups queued while a run is in flight. */
  queuedMessages?: QueuedMessage[];
  /** Remove a queued follow-up by id. */
  onRemoveQueued?: (id: string) => void;
  /** Steer: interrupt the in-flight turn with this queued item (M2). */
  onSendQueuedNow?: (id: string) => void;
  webSearchOn: boolean;
  onWebSearchToggle: () => void;
  /** Absolute workspace folder for this conversation, if bound. */
  workspaceRoot?: string | null;
  /** Pick / change folder (parent handles consent). */
  onWorkspacePick?: () => void;
  /** Clear per-conversation workspace binding. */
  onWorkspaceClear?: () => void;
  /** Per-conversation generation / instructions override. */
  generationControls?: GenerationControls | null;
  userInstructions?: string | null;
  onSaveChatSettings?: (
    generationControls: GenerationControls | null,
    userInstructions: string | null,
  ) => void;
  /** Discovered SKILL.md packages and which ones are on for this chat. */
  skills?: SkillSummary[];
  enabledSkillIds?: string[];
  onToggleSkill?: (skillId: string, enabled: boolean) => void;
  /// Open a settings section ('providers' | 'privacy' …) from the strip.
  onOpenSettings?: (tab?: string) => void;
  /// Accumulated usage for spend (turns + live stream).
  usage?: ProviderUsage | null;
  /// Estimated tokens for the next request (prompt fill).
  contextTokens?: number;
  /// Auto-compact threshold percent for status warn styling.
  compactThresholdPercent?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBytes(file: File): Promise<number[]> {
  return file.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)));
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  settings,
  onSelectModel,
  conversationId,
  prompt,
  onPromptChange,
  onSend,
  onStop,
  streaming,
  queuedMessages = [],
  onRemoveQueued,
  onSendQueuedNow,
  webSearchOn,
  onWebSearchToggle,
  workspaceRoot = null,
  onWorkspacePick,
  onWorkspaceClear,
  generationControls = null,
  userInstructions = null,
  onSaveChatSettings,
  skills = [],
  enabledSkillIds = [],
  onToggleSkill,
  onOpenSettings,
  usage,
  contextTokens = 0,
  compactThresholdPercent,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<ComposerModelPickerHandle>(null);
  const workspaceBtnRef = useRef<HTMLButtonElement>(null);
  const [credentialRef, setCredentialRef] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('loading');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);

  useComposerAutosize(textareaRef, prompt);

  useImperativeHandle(ref, () => ({
    focusPrompt: () => {
      textareaRef.current?.focus();
    },
    openChatSettings: () => {
      if (streaming || !conversationId) return;
      setWorkspaceMenuOpen(false);
      setChatSettingsOpen(true);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [summary, descriptors] = await Promise.all([
          loadProviderCredentialReference(settings.activeProvider),
          listProviderDescriptors(),
        ]);
        if (cancelled) return;
        setCredentialRef(summary.credentialRef || null);
        const descriptor = descriptors.find((d) => d.id === settings.activeProvider);
        setCredentialMode(descriptor?.credentialMode ?? 'required');
      } catch {
        if (cancelled) return;
        setCredentialRef(null);
        setCredentialMode('required');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.activeProvider]);

  useEffect(() => {
    setPendingAttachments([]);
    setWorkspaceMenuOpen(false);
    setChatSettingsOpen(false);
  }, [conversationId]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    function onDocMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (workspaceBtnRef.current?.contains(target)) return;
      const menu = document.getElementById('composer-workspace-menu');
      if (menu?.contains(target)) return;
      setWorkspaceMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [workspaceMenuOpen]);

  const workspaceBound = Boolean(workspaceRoot?.trim());
  const workspaceLabel = workspaceBound ? workspaceFolderLabel(workspaceRoot!) : null;
  const searchBackend = resolveSearchBackend(
    settings.webSearch.mode,
    settings.activeProvider,
    settings.providerEndpoints,
  );
  const localLabel = localSearchBackendLabel(settings.webSearch.localBackend);
  const searchOnTitle =
    searchBackend === 'local' ? `Web search on (${localLabel})` : 'Web search on (provider)';
  const searchOffTitle = 'Web search off';
  const searchAria = webSearchOn
    ? `${searchOnTitle} — click to disable`
    : 'Web search off — click to enable';

  async function uploadAttachment(file: File) {
    if (!conversationId) return;

    const localId = crypto.randomUUID();
    const mimeType = file.type || 'application/octet-stream';
    const pending: PendingAttachment = {
      localId,
      fileName: file.name,
      mimeType,
      sizeBytes: file.size,
      status: 'uploading',
      file,
    };
    setPendingAttachments((current) => [...current, pending]);

    if (file.size > ATTACHMENT_INLINE_CAP_BYTES) {
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'failed',
                error: `File exceeds ${formatBytes(ATTACHMENT_INLINE_CAP_BYTES)} limit`,
              }
            : item,
        ),
      );
      return;
    }

    try {
      const bytes = await fileToBytes(file);
      const attachment = await saveAttachment(conversationId, bytes, mimeType, file.name);
      const note = isForwardableImageMime(mimeType)
        ? undefined
        : 'Stored — not sent to the model (images only)';
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                attachment,
                error: note,
                file: undefined,
              }
            : item,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId ? { ...item, status: 'failed', error: message } : item,
        ),
      );
    }
  }

  function sendWithAttachments() {
    if (pendingAttachments.some((item) => item.status === 'uploading')) return;
    const attachments = turnAttachmentsFromPending(pendingAttachments);
    setPendingAttachments([]);
    onSend(attachments.length > 0 ? attachments : undefined);
  }

  async function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    await Promise.all(Array.from(files).map((file) => uploadAttachment(file)));
    event.target.value = '';
  }

  async function removeAttachment(item: PendingAttachment) {
    setPendingAttachments((current) => current.filter((entry) => entry.localId !== item.localId));
    if (item.attachment?.id) {
      try {
        await deleteAttachment(item.attachment.id);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  async function retryAttachment(item: PendingAttachment) {
    if (!item.file || item.status !== 'failed') return;
    setPendingAttachments((current) => current.filter((entry) => entry.localId !== item.localId));
    await uploadAttachment(item.file);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const sendWith = readSendWith();
    const isEnter = event.key === 'Enter' && !event.shiftKey;
    const isCmdEnter =
      event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if ((sendWith === 'enter' && isEnter) || (sendWith === 'cmd-enter' && isCmdEnter)) {
      event.preventDefault();
      sendWithAttachments();
    }
  }

  function handleDragOver(event: React.DragEvent) {
    if (attachDisabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropActive(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDropActive(false);
    if (attachDisabled) return;
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) void uploadAttachment(file);
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0 || attachDisabled) return;
    event.preventDefault();
    for (const file of files) void uploadAttachment(file);
  }

  const attachDisabled = !conversationId || streaming;
  const hasForwardableImages = turnAttachmentsFromPending(pendingAttachments).length > 0;
  const uploading = pendingAttachments.some((item) => item.status === 'uploading');
  const canSend =
    !uploading && (prompt.trim().length > 0 || hasForwardableImages);

  const queueCount = queuedMessages.length;

  return (
    <div className="composer-wrap">
      {queueCount > 0 && (
        <div className="composer-queue" aria-label={`${queueCount} queued follow-up${queueCount === 1 ? '' : 's'}`}>
          <span className="composer-queue-label">
            {queueCount} queued
          </span>
          {queuedMessages.map((item) => (
            <div key={item.id} className="composer-queue-chip" title={item.text}>
              <span className="composer-queue-preview">{previewText(item)}</span>
              {streaming && onSendQueuedNow && (
                <button
                  className="composer-queue-action"
                  type="button"
                  onClick={() => onSendQueuedNow(item.id)}
                >
                  Send now
                </button>
              )}
              {onRemoveQueued && (
                <button
                  className="composer-queue-remove"
                  type="button"
                  aria-label="Remove queued message"
                  onClick={() => onRemoveQueued(item.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer${dropActive ? ' drop-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {pendingAttachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached files">
            {pendingAttachments.map((item) => (
              <div
                key={item.localId}
                className="composer-attachment-chip"
                data-status={item.status}
                title={
                  item.status === 'uploaded'
                    ? item.error ?? 'Ready to send with your next message'
                    : item.error
                }
              >
                <FilePlainIcon />
                <span className="composer-attachment-name">{item.fileName}</span>
                <span className="composer-attachment-meta">
                  {item.status === 'uploading'
                    ? 'Uploading…'
                    : item.status === 'failed'
                      ? 'Failed'
                      : item.status === 'uploaded'
                        ? isForwardableImageMime(item.mimeType)
                          ? 'Ready'
                          : 'Not sent'
                        : formatBytes(item.sizeBytes)}
                </span>
                {item.status === 'failed' ? (
                  <button
                    className="composer-attachment-action"
                    type="button"
                    aria-label={`Retry ${item.fileName}`}
                    onClick={() => void retryAttachment(item)}
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  className="composer-attachment-remove"
                  type="button"
                  aria-label={`Remove ${item.fileName}`}
                  onClick={() => void removeAttachment(item)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer-textarea scroll"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder={brand().tagline}
          rows={1}
          aria-label="Message the active provider"
        />
        <div className="composer-bar">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-hidden
            accept={COMPOSER_IMAGE_ACCEPT}
            onChange={(event) => void handleFileInputChange(event)}
          />
          <button
            className="cbtn attach-btn"
            type="button"
            aria-label="Attach image"
            title={attachDisabled ? 'Start a conversation to attach images' : 'Attach image'}
            disabled={attachDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <AttachIcon />
          </button>
          {settings.webSearchEnabled && !settings.localOnly && !streaming && (
            <button
              className={`cbtn${webSearchOn ? ' armed' : ''}`}
              type="button"
              aria-label={searchAria}
              title={webSearchOn ? searchOnTitle : searchOffTitle}
              aria-pressed={webSearchOn}
              onClick={onWebSearchToggle}
            >
              <SearchIcon />
            </button>
          )}
          {onWorkspacePick && !streaming && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                ref={workspaceBtnRef}
                className={`cbtn${workspaceBound ? ' armed' : ''}`}
                type="button"
                aria-label={
                  workspaceBound
                    ? `Workspace folder ${workspaceLabel} — click for options`
                    : 'Work in a folder'
                }
                title={workspaceBound ? workspaceRoot! : 'Work in a folder'}
                aria-pressed={workspaceBound}
                aria-haspopup={workspaceBound ? 'menu' : undefined}
                aria-expanded={workspaceBound ? workspaceMenuOpen : undefined}
                disabled={!conversationId}
                onClick={() => {
                  if (!workspaceBound) {
                    onWorkspacePick();
                    return;
                  }
                  setWorkspaceMenuOpen((open) => !open);
                }}
              >
                <FolderIcon />
                {workspaceLabel ? (
                  <span
                    style={{
                      maxWidth: 88,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                      marginLeft: 4,
                    }}
                  >
                    {workspaceLabel}
                  </span>
                ) : null}
              </button>
              {workspaceMenuOpen && workspaceBound ? (
                <div
                  id="composer-workspace-menu"
                  role="menu"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    zIndex: 40,
                    minWidth: 220,
                    maxWidth: 320,
                    padding: 8,
                    borderRadius: 'var(--r-md, 8px)',
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: 11,
                      color: 'var(--ink-3)',
                      fontFamily: 'var(--font-mono)',
                      wordBreak: 'break-all',
                    }}
                    title={workspaceRoot!}
                  >
                    {workspaceRoot}
                  </p>
                  <button
                    className="btn"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      onWorkspacePick();
                    }}
                  >
                    Change folder…
                  </button>
                  {onWorkspaceClear ? (
                    <button
                      className="btn ghost"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        onWorkspaceClear();
                      }}
                    >
                      Clear for this chat
                    </button>
                  ) : null}
                  {onOpenSettings ? (
                    <button
                      className="btn ghost"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        onOpenSettings('workspace');
                      }}
                    >
                      Defaults in Settings
                    </button>
                  ) : null}
                </div>
              ) : null}
            </span>
          )}
          {onSaveChatSettings && !streaming && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className={`cbtn${generationControls || userInstructions ? ' armed' : ''}${chatSettingsOpen ? ' armed' : ''}`}
                type="button"
                aria-label="Chat settings"
                title="Chat settings — temperature, instructions"
                aria-haspopup="dialog"
                aria-expanded={chatSettingsOpen}
                disabled={!conversationId}
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setSkillsOpen(false);
                  setChatSettingsOpen((open) => !open);
                }}
              >
                <SlidersIcon />
              </button>
              <ComposerChatSettings
                open={chatSettingsOpen}
                streaming={streaming}
                defaults={{
                  generationControls: settings.generationControls,
                  userInstructions: settings.userInstructions,
                }}
                override={{ generationControls, userInstructions }}
                onClose={() => setChatSettingsOpen(false)}
                onSave={onSaveChatSettings}
                onOpenSettingsDefaults={
                  onOpenSettings ? () => onOpenSettings('chat') : undefined
                }
              />
            </span>
          )}
          {onToggleSkill && !streaming && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className={`cbtn${enabledSkillIds.length > 0 ? ' armed' : ''}${skillsOpen ? ' armed' : ''}`}
                type="button"
                aria-label="Skills for this chat"
                title="Skills — enable SKILL.md packages for this chat"
                aria-haspopup="dialog"
                aria-expanded={skillsOpen}
                disabled={!conversationId}
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  setChatSettingsOpen(false);
                  setSkillsOpen((open) => !open);
                }}
              >
                <SkillIcon />
              </button>
              <ComposerSkills
                open={skillsOpen}
                streaming={streaming}
                skills={skills}
                enabledIds={enabledSkillIds}
                onClose={() => setSkillsOpen(false)}
                onToggle={onToggleSkill}
                onOpenSettings={onOpenSettings ? () => onOpenSettings('skills') : undefined}
              />
            </span>
          )}
          {/* Everything before the spacer acts on the message; everything after
              it says who will answer and sends. */}
          <span className="spacer" />
          <ComposerModelPicker
            ref={modelPickerRef}
            settings={settings}
            onSelectModel={onSelectModel}
            disabled={streaming}
          />
          {streaming ? (
            <>
              {canSend && (
                <button
                  className="send queue"
                  type="button"
                  aria-label="Queue follow-up"
                  title="Queue follow-up (sends when this turn ends)"
                  onClick={sendWithAttachments}
                >
                  <SendIcon />
                </button>
              )}
              <button
                className="send stop"
                type="button"
                aria-label="Stop generating"
                title="Stop generating"
                onClick={onStop}
              >
                <StopIcon />
              </button>
            </>
          ) : (
            <button
              className="send"
              type="button"
              aria-label="Send message"
              title="Send message"
              onClick={sendWithAttachments}
              disabled={!canSend}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      <StatusLine
        settings={settings}
        onOpenSettings={onOpenSettings}
        usage={usage ?? null}
        contextTokens={contextTokens}
        compactThresholdPercent={compactThresholdPercent}
        credentialMode={credentialMode}
        credentialRef={credentialRef ?? ''}
        modelMenuOpen={() => modelPickerRef.current?.open()}
      />
    </div>
  );
});
