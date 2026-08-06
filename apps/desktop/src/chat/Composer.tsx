import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import {
  deleteAttachment,
  listProviderDescriptors,
  loadProviderCredentialReference,
  saveAttachment,
} from '../ipc/client';
import { AttachIcon, FilePlainIcon, SearchIcon, SendIcon, StopIcon } from '../icons';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';
import { ProvenanceStrip, type CredentialMode } from '../shell/ProvenanceStrip';
import {
  ATTACHMENT_INLINE_CAP_BYTES,
  type PendingAttachment,
} from './composerTypes';
import { useComposerAutosize } from './useComposerAutosize';
import { readSendWith } from '../shell/uiPrefs';

export interface ComposerHandle {
  focusPrompt: () => void;
}

export interface ComposerProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  conversationId: string | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  webSearchOn: boolean;
  onWebSearchToggle: () => void;
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
  onSettingsChange,
  conversationId,
  prompt,
  onPromptChange,
  onSend,
  onStop,
  streaming,
  webSearchOn,
  onWebSearchToggle,
  onOpenSettings,
  usage,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<ComposerModelPickerHandle>(null);
  const [credentialRef, setCredentialRef] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('loading');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);

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
  }, [conversationId]);

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
          className="composer-textarea"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder="Message Conduit…"
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
            className="tool-btn attach-btn"
            type="button"
            aria-label="Attach file"
            title={attachDisabled ? 'Start a conversation to attach files' : 'Attach file'}
            disabled={attachDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <AttachIcon />
          </button>
          <ComposerModelPicker
            ref={modelPickerRef}
            settings={settings}
            onSettingsChange={onSettingsChange}
            disabled={streaming}
          />
          {settings.webSearchEnabled && !settings.localOnly && !streaming && (
            <button
              className={`tool-btn${webSearchOn ? ' search-active' : ''}`}
              type="button"
              aria-label={
                webSearchOn ? 'Web search on — click to disable' : 'Web search off — click to enable'
              }
              title={webSearchOn ? 'Web search on' : 'Web search off'}
              aria-pressed={webSearchOn}
              onClick={onWebSearchToggle}
            >
              <SearchIcon />
            </button>
          )}
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
      <ProvenanceStrip
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
