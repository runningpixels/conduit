import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import {
  deleteAttachment,
  listProviderDescriptors,
  loadProviderCredentialReference,
  saveAttachment,
} from '../ipc/client';
import { AttachIcon, FilePlainIcon, FolderIcon, SearchIcon, SendIcon, StopIcon } from '../icons';
import { brand } from '../brand';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';
import { StatusLine, type CredentialMode } from '../shell/StatusLine';
import {
  ATTACHMENT_INLINE_CAP_BYTES,
  type PendingAttachment,
} from './composerTypes';
import { useComposerAutosize } from './useComposerAutosize';
import { readSendWith } from '../shell/uiPrefs';
import { workspaceFolderLabel } from './agentTools';
import { resolveSearchBackend } from './webSearchIntent';

export interface ComposerHandle {
  focusPrompt: () => void;
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
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  webSearchOn: boolean;
  onWebSearchToggle: () => void;
  /** Absolute workspace folder for this conversation, if bound. */
  workspaceRoot?: string | null;
  /** Pick / change folder (parent handles consent). */
  onWorkspacePick?: () => void;
  /** Clear per-conversation workspace binding. */
  onWorkspaceClear?: () => void;
  /// Open a settings section ('providers' | 'privacy' …) from the strip.
  onOpenSettings?: (tab?: string) => void;
  /// Accumulated usage for the whole conversation (turns + live stream).
  usage?: ProviderUsage | null;
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
  webSearchOn,
  onWebSearchToggle,
  workspaceRoot = null,
  onWorkspacePick,
  onWorkspaceClear,
  onOpenSettings,
  usage,
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

  useComposerAutosize(textareaRef, prompt);

  useImperativeHandle(ref, () => ({
    focusPrompt: () => {
      textareaRef.current?.focus();
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
  const searchOnTitle =
    searchBackend === 'local' ? 'Web search on (DuckDuckGo)' : 'Web search on (provider)';
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
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? { ...item, status: 'uploaded', attachment, error: undefined, file: undefined }
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
      onSend();
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

  const tokenCount = prompt.trim() ? Math.max(1, Math.round(prompt.trim().length / 4)) : 0;
  const attachDisabled = !conversationId || streaming;

  return (
    <div className="composer-wrap">
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
                    ? 'Ready to send with your next message'
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
                        ? 'Ready'
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
            onChange={(event) => void handleFileInputChange(event)}
          />
          <button
            className="cbtn attach-btn"
            type="button"
            aria-label="Attach file"
            title={attachDisabled ? 'Start a conversation to attach files' : 'Attach file'}
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
            <button
              className="send stop"
              type="button"
              aria-label="Stop generating"
              title="Stop generating"
              onClick={onStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="send"
              type="button"
              aria-label="Send message"
              title="Send message"
              onClick={onSend}
              disabled={!prompt.trim()}
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
        composerTokenEstimate={tokenCount}
        credentialMode={credentialMode}
        credentialRef={credentialRef ?? ''}
        modelMenuOpen={() => modelPickerRef.current?.open()}
      />
    </div>
  );
});
