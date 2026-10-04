import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AppSettings, GenerationControls, ProviderUsage } from '@conduit/config-schema';
import {
  deleteAttachment,
  listKnowledgeDocuments,
  listProviderDescriptors,
  loadProviderCredentialReference,
  saveAttachment,
  saveDroppedAttachment,
} from '../ipc/client';
import { AttachIcon, ConnectorsIcon, FilePlainIcon, FilesIcon, FolderIcon, KnowledgeIcon, ResearchIcon, SearchIcon, SendIcon, SkillIcon, SlidersIcon, StopIcon } from '../icons';
import { researchUnavailableReasonId } from './researchAvailability';
import { ComposerMcpPrompts } from './ComposerMcpPrompts';
import { ComposerMcpResources } from './ComposerMcpResources';
import type { ConnectorPromptInfo, ConnectorResourceInfo, ResourceRef } from '../ipc/contracts';
import { brand } from '../brand';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';
import { StatusLine, type CredentialMode } from '../shell/StatusLine';
import {
  ATTACHMENT_INLINE_CAP_BYTES,
  COMPOSER_IMAGE_ACCEPT,
  isForwardableImageMime,
  turnAttachmentsFromPending,
  type KnowledgeRef,
  type PendingAttachment,
  type TurnAttachment,
} from './composerTypes';
import { useComposerAutosize } from './useComposerAutosize';
import { readSendWith } from '../shell/uiPrefs';
import { workspaceFolderLabel } from './agentTools';
import { localSearchBackendLabel, resolveSearchBackend } from './webSearchIntent';
import { ComposerChatSettings } from './ComposerChatSettings';
import { ComposerSkills } from './ComposerSkills';
import { ComposerCollections } from './ComposerCollections';
import { ComposerDocumentPicker, documentOptionId, type DocumentPickerOption } from './ComposerDocumentPicker';
import { findHashTrigger, type HashTrigger } from './hashTrigger';
import type { KnowledgeCollection, SkillSummary } from '../ipc/contracts';
import { previewText, type QueuedMessage } from './messageQueue';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';
import { ComposerPlusMenu, type PlusMenuItem } from './ComposerPlusMenu';
import { ComposerContextChips, type ContextChip } from './ComposerContextChips';
import { sameResource, toResourceRef } from './connectorCapabilities';

type ComposerPopover =
  | 'workspace'
  | 'chatSettings'
  | 'skills'
  | 'collections'
  | 'mcpPrompts'
  | 'mcpResources';

export interface ComposerHandle {
  focusPrompt: () => void;
  openChatSettings: () => void;
  /** M1 (t1-8, D13): a native window drop landed on the composer; attach each
   *  path the way an HTML5 drop's files would be. Ignored if an HTML5 drop
   *  already claimed this same drop (or vice versa) within the dedup window. */
  addDroppedPaths: (paths: string[]) => void;
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
  /** Research mode: the next send starts a Research run instead of a reply.
   *  Absent hides the "+" item. */
  researchOn?: boolean;
  onResearchToggle?: () => void;
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
  /** Knowledge base collections and which ones are attached to this chat (t1-6). */
  collections?: KnowledgeCollection[];
  enabledCollectionIds?: string[];
  onToggleCollection?: (collectionId: string, enabled: boolean) => void;
  /** M2 (t1-8, D1/D2): documents this chat leaves out of retrieval, and the
   *  toggle that flips one (ComposerCollections' expand rows). */
  excludedDocumentIds?: string[];
  onToggleDocumentExcluded?: (documentId: string, excluded: boolean) => void;
  /** M3 (t1-8, D6/D7): `#`-picked document references for the next message. */
  knowledgeRefs?: KnowledgeRef[];
  onAddKnowledgeRef?: (ref: KnowledgeRef) => void;
  onRemoveKnowledgeRef?: (documentId: string) => void;
  onRefreshKnowledgeCapabilities?: () => void;
  /** Prompts and resources advertised by the running connectors (t0-9). */
  mcpPrompts?: ConnectorPromptInfo[];
  mcpResources?: ConnectorResourceInfo[];
  /** Resources attached to the turn being composed. Cleared on send. */
  attachedResources?: ResourceRef[];
  onPickMcpPrompt?: (prompt: ConnectorPromptInfo) => void;
  onToggleMcpResource?: (resource: ConnectorResourceInfo, attached: boolean) => void;
  onRefreshMcpCapabilities?: () => void;
  /// Open a settings section ('providers' | 'privacy' …) from the strip.
  onOpenSettings?: (tab?: string) => void;
  /// Accumulated usage for spend (turns + live stream).
  usage?: ProviderUsage | null;
  /// Estimated tokens for the next request (prompt fill).
  contextTokens?: number;
  /// Auto-compact threshold percent for status warn styling.
  compactThresholdPercent?: number;
  /// A Writing draft's chat: its sources live in the studio's Sources tab.
  /// The "+" menu leaves out web search, Research and documents, and the
  /// draft's active sources show as chips that open that tab.
  draftSources?: ComposerDraftSources;
}

export interface ComposerDraftSources {
  webSearch: boolean;
  documents: number;
  reports: number;
  onOpen?: () => void;
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
  researchOn = false,
  onResearchToggle,
  workspaceRoot = null,
  onWorkspacePick,
  onWorkspaceClear,
  generationControls = null,
  userInstructions = null,
  onSaveChatSettings,
  skills = [],
  enabledSkillIds = [],
  onToggleSkill,
  collections = [],
  enabledCollectionIds = [],
  onToggleCollection,
  excludedDocumentIds = [],
  onToggleDocumentExcluded,
  knowledgeRefs = [],
  onAddKnowledgeRef,
  onRemoveKnowledgeRef,
  onRefreshKnowledgeCapabilities,
  mcpPrompts = [],
  mcpResources = [],
  attachedResources = [],
  onPickMcpPrompt,
  onToggleMcpResource,
  onRefreshMcpCapabilities,
  onOpenSettings,
  usage,
  contextTokens = 0,
  compactThresholdPercent,
  draftSources,
}, ref) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<ComposerModelPickerHandle>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [credentialRef, setCredentialRef] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('loading');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  // One popover at a time, all anchored at the "+" button. Opened from the
  // menu, from a context chip, or (chat settings) from the imperative handle.
  const [openPop, setOpenPop] = useState<ComposerPopover | null>(null);
  // Skills turned off in bulk from their chip, one per render: the parent's
  // toggle reads its current list from a ref updated on render, so two
  // toggles in one tick would each see the other's skill still on.
  const [skillRemovalQueue, setSkillRemovalQueue] = useState<string[]>([]);
  // t1-8 M3: the `#` document-reference trigger (D11) and its picker.
  const [hashTrigger, setHashTrigger] = useState<HashTrigger | null>(null);
  const [docPickerActiveIndex, setDocPickerActiveIndex] = useState(0);
  // True once the reader has moved through the picker with the arrow keys:
  // only then does Enter pick for a bare `#` (D11).
  const docPickerNavigatedRef = useRef(false);
  const [allDocuments, setAllDocuments] = useState<DocumentPickerOption[]>([]);
  // True while an IME composition is in progress (D12): the trigger and the
  // Enter-to-send guard both go quiet until it ends.
  const composingRef = useRef(false);
  // t1-8 M1 (D13): whichever of an HTML5 drop and a native composer drop
  // fires first for one physical drop wins; the other is ignored.
  const lastDropAtRef = useRef(0);

  useComposerAutosize(textareaRef, prompt);

  // D6: at least one collection with at least one document must exist before
  // `#` does anything at all -- same "zero cost, zero UI" gate as the
  // Documents button itself (acceptance criterion 13).
  const docPickerFeatureAvailable = collections.some((c) => c.documentCount > 0);

  const DROP_DEDUP_WINDOW_MS = 500;
  function claimDrop(): boolean {
    const now = Date.now();
    if (now - lastDropAtRef.current < DROP_DEDUP_WINDOW_MS) return false;
    lastDropAtRef.current = now;
    return true;
  }

  async function uploadDroppedPath(path: string) {
    if (!conversationId) return;
    const localId = crypto.randomUUID();
    const fileName = path.split(/[\\/]/).pop() || path;
    const pending: PendingAttachment = {
      localId,
      fileName,
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      status: 'uploading',
    };
    setPendingAttachments((current) => [...current, pending]);
    try {
      const attachment = await saveDroppedAttachment(conversationId, path);
      const note = isForwardableImageMime(attachment.mimeType)
        ? undefined
        : t('chat.composer.attachment.notSentNote');
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                attachment,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                error: note,
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

  /** Every document across every collection, attached or not (D6): the `#`
   *  picker's corpus. Cached while the composer is mounted, refreshed each
   *  time the picker opens (not on every keystroke). */
  async function loadAllDocuments() {
    try {
      const lists = await Promise.all(
        collections.map((c) => listKnowledgeDocuments(c.id).catch(() => [])),
      );
      const docs: DocumentPickerOption[] = [];
      collections.forEach((collection, index) => {
        for (const doc of lists[index] ?? []) {
          docs.push({
            documentId: doc.id,
            title: doc.title,
            collectionId: collection.id,
            collectionName: collection.name,
          });
        }
      });
      setAllDocuments(docs);
    } catch {
      // Keep whatever the cache already had; the picker just shows that.
    }
  }

  function updateHashTrigger(text: string, caret: number) {
    if (!docPickerFeatureAvailable || composingRef.current) {
      if (hashTrigger) setHashTrigger(null);
      return;
    }
    const next = findHashTrigger(text, caret);
    const wasOpen = hashTrigger != null;
    setHashTrigger(next);
    setDocPickerActiveIndex(0);
    docPickerNavigatedRef.current = false;
    if (next && !wasOpen) void loadAllDocuments();
  }

  const filteredDocumentOptions = hashTrigger
    ? allDocuments.filter((doc) => doc.title.toLowerCase().includes(hashTrigger.query.toLowerCase()))
    : [];

  function pickDocument(option: DocumentPickerOption) {
    const trigger = hashTrigger;
    if (!trigger) return;
    const caret = textareaRef.current?.selectionStart ?? trigger.start + 1 + trigger.query.length;
    const before = prompt.slice(0, trigger.start);
    const after = prompt.slice(caret);
    setHashTrigger(null);
    onPromptChange(before + after);
    // The same document twice is ignored rather than added again.
    if (!knowledgeRefs.some((ref) => ref.documentId === option.documentId)) {
      onAddKnowledgeRef?.({
        documentId: option.documentId,
        title: option.title,
        collectionId: option.collectionId,
        collectionName: option.collectionName,
      });
    }
    const caretAfter = before.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caretAfter, caretAfter);
    });
  }

  useImperativeHandle(ref, () => ({
    focusPrompt: () => {
      textareaRef.current?.focus();
    },
    openChatSettings: () => {
      if (streaming || !conversationId || !onSaveChatSettings) return;
      setPlusOpen(false);
      setOpenPop('chatSettings');
    },
    addDroppedPaths: (paths: string[]) => {
      if (!conversationId || streaming) return;
      if (!claimDrop()) return;
      for (const path of paths) void uploadDroppedPath(path);
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
    setPlusOpen(false);
    setOpenPop(null);
    setSkillRemovalQueue([]);
    setHashTrigger(null);
  }, [conversationId]);

  useEffect(() => {
    if (skillRemovalQueue.length === 0) return;
    const [head, ...rest] = skillRemovalQueue;
    setSkillRemovalQueue(rest);
    if (head && enabledSkillIds.includes(head)) onToggleSkill?.(head, false);
  }, [skillRemovalQueue, enabledSkillIds, onToggleSkill]);

  // Popovers and the menu are not usable mid-turn (their controls were hidden
  // while streaming before the "+" menu, too), so a turn starting closes them.
  useEffect(() => {
    if (!streaming) return;
    setPlusOpen(false);
    setOpenPop(null);
    setHashTrigger(null);
  }, [streaming]);

  const togglePop = (pop: ComposerPopover) => {
    setPlusOpen(false);
    setOpenPop((current) => (current === pop ? null : pop));
  };
  const closePop = () => setOpenPop(null);

  const workspaceBound = Boolean(workspaceRoot?.trim());
  const workspaceLabel = workspaceBound ? workspaceFolderLabel(workspaceRoot!) : null;
  const searchBackend = resolveSearchBackend(
    settings.webSearch.mode,
    settings.activeProvider,
    settings.providerEndpoints,
  );
  const localLabel = localSearchBackendLabel(settings.webSearch.localBackend);
  const searchOnTitle = t(
    searchBackend === 'local'
      ? 'chat.composer.webSearch.onTitleLocal'
      : 'chat.composer.webSearch.onTitleProvider',
    { backend: localLabel },
  );
  const searchOffTitle = t('chat.composer.webSearch.offTitle');
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
                error: t('chat.composer.attachment.exceedsLimit', {
                  size: formatBytes(ATTACHMENT_INLINE_CAP_BYTES),
                }),
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
        : t('chat.composer.attachment.notSentNote');
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
    // D12: never act on the Enter (or any other key) that belongs to an IME
    // composition -- `keyCode === 229` is the same fallback `useHotkeys.ts`
    // documents for browsers that don't set `isComposing` reliably.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (hashTrigger) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        docPickerNavigatedRef.current = true;
        setDocPickerActiveIndex((i) =>
          filteredDocumentOptions.length === 0 ? 0 : (i + 1) % filteredDocumentOptions.length,
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        docPickerNavigatedRef.current = true;
        setDocPickerActiveIndex((i) =>
          filteredDocumentOptions.length === 0
            ? 0
            : (i - 1 + filteredDocumentOptions.length) % filteredDocumentOptions.length,
        );
        return;
      }
      const isPlainEnter = event.key === 'Enter' && !event.shiftKey;
      if (isPlainEnter || event.key === 'Tab') {
        const picked = filteredDocumentOptions[docPickerActiveIndex] ?? filteredDocumentOptions[0];
        // Enter on a bare `#` the reader never navigated is not a choice --
        // it is someone finishing a line ("#" heading, "#1 priority").
        const chose = event.key === 'Tab' || hashTrigger.query !== '' || docPickerNavigatedRef.current;
        if (picked && chose) {
          event.preventDefault();
          pickDocument(picked);
          return;
        }
        // Nothing chosen: close the picker and let the key do what it always
        // does (Enter sends or breaks the line; Tab moves focus). A `#` is
        // ordinary text far more often than it is a reference.
        setHashTrigger(null);
      }
      if (event.key === 'Escape') {
        // D11: closes and leaves the text exactly as typed.
        event.preventDefault();
        setHashTrigger(null);
        return;
      }
      // Any other key edits the query text; onChange recomputes the trigger.
    }

    const sendWith = readSendWith();
    const isEnter = event.key === 'Enter' && !event.shiftKey;
    const isCmdEnter =
      event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if ((sendWith === 'enter' && isEnter) || (sendWith === 'cmd-enter' && isCmdEnter)) {
      event.preventDefault();
      sendWithAttachments();
    }
  }

  function handleCompositionStart() {
    composingRef.current = true;
  }

  function handleCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = false;
    updateHashTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
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
    // M1 (D13): whichever of this HTML5 drop and a native composer drop
    // fires first for one physical drop wins; ignore the loser.
    if (!claimDrop()) return;
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

  // Availability of each "+" item. These are the gates the separate bar
  // buttons had; only what is available is listed.
  const webSearchAvailable = !draftSources && settings.webSearchEnabled && !settings.localOnly;
  const collectionsAvailable = !draftSources && Boolean(onToggleCollection) && collections.length > 0;
  const mcpPromptsAvailable = Boolean(onPickMcpPrompt) && mcpPrompts.length > 0;
  const mcpResourcesAvailable = Boolean(onToggleMcpResource) && mcpResources.length > 0;

  function selectWorkspace() {
    if (!onWorkspacePick) return;
    if (!workspaceBound) {
      setOpenPop(null);
      onWorkspacePick();
      return;
    }
    togglePop('workspace');
  }

  const plusItems: PlusMenuItem[] = [
    {
      id: 'attach',
      label: t('chat.composer.plus.attach'),
      icon: <AttachIcon />,
      title: attachDisabled ? t('chat.composer.attach.titleDisabled') : undefined,
      disabled: attachDisabled,
      onSelect: () => {
        setOpenPop(null);
        fileInputRef.current?.click();
      },
    },
  ];
  if (webSearchAvailable) {
    plusItems.push({
      id: 'webSearch',
      label: t('chat.composer.plus.webSearch'),
      icon: <SearchIcon />,
      title: webSearchOn ? searchOnTitle : searchOffTitle,
      checked: webSearchOn,
      onSelect: onWebSearchToggle,
    });
  }
  const researchReasonId = researchUnavailableReasonId(settings);
  const researchAvailable = researchReasonId === null;
  if (onResearchToggle && !draftSources) {
    plusItems.push({
      id: 'research',
      label: t('chat.composer.plus.research'),
      icon: <ResearchIcon />,
      title: researchAvailable
        ? t(researchOn ? 'chat.composer.research.onTitle' : 'chat.composer.research.offTitle')
        : t(researchReasonId),
      checked: researchOn,
      // Turning it off stays possible whatever changed since it was turned on.
      disabled: !researchAvailable && !researchOn,
      onSelect: onResearchToggle,
    });
  }
  if (onWorkspacePick) {
    plusItems.push({
      id: 'workspace',
      label: t('chat.composer.plus.workspace'),
      icon: <FolderIcon />,
      title: workspaceBound ? workspaceRoot! : t('chat.composer.workspace.unbound'),
      disabled: !conversationId,
      onSelect: selectWorkspace,
    });
  }
  if (collectionsAvailable) {
    plusItems.push({
      id: 'collections',
      label: t('chat.composer.plus.documents'),
      icon: <KnowledgeIcon />,
      title: t('chat.composer.knowledge.title'),
      disabled: !conversationId,
      onSelect: () => togglePop('collections'),
    });
  }
  if (onToggleSkill) {
    plusItems.push({
      id: 'skills',
      label: t('chat.composer.plus.skills'),
      icon: <SkillIcon />,
      title: t('chat.composer.skills.title'),
      disabled: !conversationId,
      onSelect: () => togglePop('skills'),
    });
  }
  if (mcpPromptsAvailable) {
    plusItems.push({
      id: 'mcpPrompts',
      label: t('chat.composer.plus.connectorPrompts'),
      icon: <ConnectorsIcon />,
      onSelect: () => togglePop('mcpPrompts'),
    });
  }
  if (mcpResourcesAvailable) {
    plusItems.push({
      id: 'mcpResources',
      label: t('chat.composer.plus.connectorResources'),
      icon: <FilesIcon />,
      onSelect: () => togglePop('mcpResources'),
    });
  }
  if (onSaveChatSettings) {
    plusItems.push({
      id: 'chatSettings',
      label: t('chat.composer.plus.chatSettings'),
      icon: <SlidersIcon />,
      title: t('chat.composer.chatSettings.title'),
      disabled: !conversationId,
      onSelect: () => togglePop('chatSettings'),
    });
  }

  // Active context, shown above the input. Each chip's remove goes through the
  // same handler its popover uses; its body opens that popover.
  const chips: ContextChip[] = [];
  if (onWorkspacePick && workspaceBound) {
    chips.push({
      id: 'workspace',
      label: workspaceLabel!,
      icon: <FolderIcon />,
      title: workspaceRoot!,
      onOpen: conversationId ? () => togglePop('workspace') : undefined,
      onRemove: onWorkspaceClear,
      removeLabel: t('chat.composer.chips.removeWorkspace', { label: workspaceLabel }),
    });
  }
  if (collectionsAvailable) {
    for (const id of enabledCollectionIds) {
      const collection = collections.find((c) => c.id === id);
      if (!collection) continue;
      chips.push({
        id: `collection:${id}`,
        label: collection.name,
        icon: <KnowledgeIcon />,
        title: t('chat.composer.knowledge.title'),
        onOpen: conversationId ? () => togglePop('collections') : undefined,
        onRemove: () => onToggleCollection!(id, false),
        removeLabel: t('chat.composer.chips.removeCollection', { name: collection.name }),
      });
    }
  }
  if (knowledgeRefs.length > 0) {
    for (const ref of knowledgeRefs) {
      chips.push({
        id: `knowledgeRef:${ref.documentId}`,
        label: `${ref.title} · ${ref.collectionName}`,
        icon: <KnowledgeIcon />,
        title: t('chat.composer.knowledgeRef.chipTitle', { title: ref.title, collection: ref.collectionName }),
        onRemove: onRemoveKnowledgeRef ? () => onRemoveKnowledgeRef(ref.documentId) : undefined,
        removeLabel: t('chat.composer.chips.removeKnowledgeRef', { title: ref.title }),
      });
    }
  }
  if (onToggleSkill && enabledSkillIds.length > 0) {
    const count = enabledSkillIds.length;
    const names = skills
      .filter((skill) => enabledSkillIds.includes(skill.id))
      .map((skill) => skill.name)
      .join(', ');
    chips.push({
      id: 'skills',
      label: t('chat.composer.chips.skills', { count }),
      icon: <SkillIcon />,
      title: names || undefined,
      onOpen: conversationId ? () => togglePop('skills') : undefined,
      onRemove: () => setSkillRemovalQueue([...enabledSkillIds]),
      removeLabel: t('chat.composer.chips.removeSkills', { count }),
    });
  }
  if (webSearchAvailable && webSearchOn) {
    chips.push({
      id: 'webSearch',
      label: t('chat.composer.chips.webSearch'),
      icon: <SearchIcon />,
      title: searchOnTitle,
      onRemove: onWebSearchToggle,
      removeLabel: t('chat.composer.chips.removeWebSearch'),
    });
  }
  if (onResearchToggle && researchOn && researchAvailable && !draftSources) {
    chips.push({
      id: 'research',
      label: t('chat.composer.chips.research'),
      icon: <ResearchIcon />,
      title: t('chat.composer.research.onTitle'),
      onRemove: onResearchToggle,
      removeLabel: t('chat.composer.chips.removeResearch'),
    });
  }
  if (draftSources) {
    const openSources = draftSources.onOpen;
    if (draftSources.webSearch) {
      chips.push({
        id: 'draftWebSearch',
        label: t('chat.composer.chips.webSearch'),
        icon: <SearchIcon />,
        title: t('writing.sources.chipTitle'),
        onOpen: openSources,
        removeLabel: '',
      });
    }
    if (draftSources.documents > 0) {
      chips.push({
        id: 'draftDocuments',
        label: t('writing.sources.chips.documents', { count: draftSources.documents }),
        icon: <KnowledgeIcon />,
        title: t('writing.sources.chipTitle'),
        onOpen: openSources,
        removeLabel: '',
      });
    }
    if (draftSources.reports > 0) {
      chips.push({
        id: 'draftReports',
        label: t('writing.sources.chips.reports', { count: draftSources.reports }),
        icon: <ResearchIcon />,
        title: t('writing.sources.chipTitle'),
        onOpen: openSources,
        removeLabel: '',
      });
    }
  }
  if (mcpResourcesAvailable) {
    for (const resourceRef of attachedResources) {
      const resource = mcpResources.find((r) => sameResource(resourceRef, toResourceRef(r)));
      chips.push({
        id: `resource:${resourceRef.connectorVersionId}:${resourceRef.uri}`,
        label: resourceRef.name,
        icon: <FilesIcon />,
        title: resourceRef.uri,
        onOpen: () => togglePop('mcpResources'),
        onRemove: resource ? () => onToggleMcpResource!(resource, false) : undefined,
        removeLabel: t('chat.composer.chips.removeResource', { name: resourceRef.name }),
      });
    }
  }
  if (onSaveChatSettings && (generationControls || userInstructions)) {
    chips.push({
      id: 'chatSettings',
      label: t('chat.composer.chatSettings.ariaLabel'),
      icon: <SlidersIcon />,
      title: t('chat.composer.chatSettings.title'),
      onOpen: conversationId ? () => togglePop('chatSettings') : undefined,
      onRemove: () => onSaveChatSettings(null, null),
      removeLabel: t('chat.composer.chips.removeChatSettings'),
    });
  }

  return (
    <div className="composer-wrap">
      {queueCount > 0 && (
        <div
          className="composer-queue"
          aria-label={t('chat.composer.queue.ariaLabel', { count: queueCount })}
        >
          <span className="composer-queue-label">
            {t('chat.composer.queue.label', { count: queueCount })}
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
                  {t('chat.composer.queue.sendNow')}
                </button>
              )}
              {onRemoveQueued && (
                <button
                  className="composer-queue-remove"
                  type="button"
                  aria-label={t('chat.composer.queue.removeAriaLabel')}
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
        <ComposerContextChips chips={chips} disabled={streaming} />
        {pendingAttachments.length > 0 && (
          <div className="composer-attachments" aria-label={t('chat.composer.attachments.ariaLabel')}>
            {pendingAttachments.map((item) => (
              <div
                key={item.localId}
                className="composer-attachment-chip"
                data-status={item.status}
                title={
                  item.status === 'uploaded'
                    ? item.error ?? t('chat.composer.attachment.readyTitle')
                    : item.error
                }
              >
                <FilePlainIcon />
                <span className="composer-attachment-name">{item.fileName}</span>
                <span className="composer-attachment-meta">
                  {item.status === 'uploading'
                    ? t('chat.composer.attachment.status.uploading')
                    : item.status === 'failed'
                      ? t('chat.composer.attachment.status.failed')
                      : item.status === 'uploaded'
                        ? isForwardableImageMime(item.mimeType)
                          ? t('chat.composer.attachment.status.ready')
                          : t('chat.composer.attachment.status.notSent')
                        : formatBytes(item.sizeBytes)}
                </span>
                {item.status === 'failed' && item.file ? (
                  <button
                    className="composer-attachment-action"
                    type="button"
                    aria-label={t('chat.composer.attachment.retryAriaLabel', { fileName: item.fileName })}
                    onClick={() => void retryAttachment(item)}
                  >
                    {t('common.actions.retry')}
                  </button>
                ) : null}
                <button
                  className="composer-attachment-remove"
                  type="button"
                  aria-label={t('chat.composer.attachment.removeAriaLabel', { fileName: item.fileName })}
                  onClick={() => void removeAttachment(item)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* A brand tagline is the brand's own copy and is shown verbatim.
            Without one the placeholder is ours, so it comes from the
            catalog and is translated. */}
        <textarea
          ref={textareaRef}
          className="composer-textarea scroll"
          value={prompt}
          onChange={(event) => {
            onPromptChange(event.target.value);
            updateHashTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            updateHashTrigger(target.value, target.selectionStart ?? 0);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={(event) => void handlePaste(event)}
          placeholder={brand().tagline ?? t('chat.composer.placeholder')}
          rows={1}
          aria-label={t('chat.composer.prompt.ariaLabel')}
          aria-expanded={hashTrigger ? true : undefined}
          aria-controls={hashTrigger ? 'composer-doc-picker-list' : undefined}
          aria-activedescendant={
            hashTrigger && filteredDocumentOptions[docPickerActiveIndex]
              ? documentOptionId(filteredDocumentOptions[docPickerActiveIndex].documentId)
              : undefined
          }
        />
        {docPickerFeatureAvailable && hashTrigger ? (
          <ComposerDocumentPicker
            id="composer-doc-picker-list"
            options={filteredDocumentOptions}
            activeIndex={docPickerActiveIndex}
            onHover={setDocPickerActiveIndex}
            onPick={pickDocument}
          />
        ) : null}
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
          {/* Every popover opens upward from the "+" button, whichever of the
              menu or a context chip asked for it. */}
          <span className="composer-plus">
            <ComposerPlusMenu
              ref={plusBtnRef}
              open={plusOpen}
              onOpenChange={(next) => {
                if (next) setOpenPop(null);
                setPlusOpen(next);
              }}
              items={plusItems}
              disabled={streaming}
              title={streaming ? t('chat.composer.plus.titleStreaming') : undefined}
            />
            {!streaming && onWorkspacePick && workspaceBound ? (
              <Menu
                open={openPop === 'workspace'}
                onClose={closePop}
                triggerRef={plusBtnRef}
                className="menu composer-workspace-menu"
                label={t('chat.composer.workspace.ariaBound', { label: workspaceLabel ?? '' })}
                dismissOnOutsidePress
              >
                <p className="composer-workspace-path" title={workspaceRoot!}>
                  {workspaceRoot}
                </p>
                <button
                  className="btn"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closePop();
                    onWorkspacePick();
                  }}
                >
                  {t('chat.composer.workspace.changeFolder')}
                </button>
                {onWorkspaceClear ? (
                  <button
                    className="btn ghost"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closePop();
                      onWorkspaceClear();
                    }}
                  >
                    {t('chat.composer.workspace.clearForChat')}
                  </button>
                ) : null}
                {onOpenSettings ? (
                  <button
                    className="btn ghost"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closePop();
                      onOpenSettings('workspace');
                    }}
                  >
                    {t('chat.composer.workspace.defaultsInSettings')}
                  </button>
                ) : null}
              </Menu>
            ) : null}
            {onSaveChatSettings && !streaming ? (
              <ComposerChatSettings
                open={openPop === 'chatSettings'}
                streaming={streaming}
                defaults={{
                  generationControls: settings.generationControls,
                  userInstructions: settings.userInstructions,
                }}
                override={{ generationControls, userInstructions }}
                onClose={closePop}
                onSave={onSaveChatSettings}
                onOpenSettingsDefaults={
                  onOpenSettings ? () => onOpenSettings('chat') : undefined
                }
              />
            ) : null}
            {onToggleSkill && !streaming ? (
              <ComposerSkills
                open={openPop === 'skills'}
                streaming={streaming}
                skills={skills}
                enabledIds={enabledSkillIds}
                onClose={closePop}
                onToggle={onToggleSkill}
                onOpenSettings={onOpenSettings ? () => onOpenSettings('skills') : undefined}
              />
            ) : null}
            {/* `collections.length > 0` (in collectionsAvailable) is
                load-bearing, not a tidy-up: a user who has never made a
                collection must see no Documents item at all (t1-6 acceptance
                criterion 13). Same shape as the connector prompt item, which
                hides itself when the server offers no prompts. */}
            {collectionsAvailable && !streaming ? (
              <ComposerCollections
                open={openPop === 'collections'}
                streaming={streaming}
                collections={collections}
                enabledIds={enabledCollectionIds}
                excludedDocumentIds={excludedDocumentIds}
                onToggleDocument={onToggleDocumentExcluded}
                onClose={closePop}
                onToggle={onToggleCollection!}
                onOpenSettings={onOpenSettings ? () => onOpenSettings('knowledge') : undefined}
                onRefresh={
                  onRefreshKnowledgeCapabilities ? () => onRefreshKnowledgeCapabilities() : undefined
                }
              />
            ) : null}
            {mcpPromptsAvailable && !streaming ? (
              <ComposerMcpPrompts
                open={openPop === 'mcpPrompts'}
                prompts={mcpPrompts}
                onClose={closePop}
                onPick={(picked) => {
                  closePop();
                  onPickMcpPrompt!(picked);
                }}
                onRefresh={() => onRefreshMcpCapabilities?.()}
              />
            ) : null}
            {mcpResourcesAvailable && !streaming ? (
              <ComposerMcpResources
                open={openPop === 'mcpResources'}
                resources={mcpResources}
                attached={attachedResources}
                onClose={closePop}
                onToggle={onToggleMcpResource!}
                onRefresh={() => onRefreshMcpCapabilities?.()}
              />
            ) : null}
          </span>
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
                  aria-label={t('chat.composer.queueSend.ariaLabel')}
                  title={t('chat.composer.queueSend.title')}
                  onClick={sendWithAttachments}
                >
                  <SendIcon />
                </button>
              )}
              <button
                className="send stop"
                type="button"
                aria-label={t('chat.composer.stop.label')}
                title={t('chat.composer.stop.label')}
                onClick={onStop}
              >
                <StopIcon />
              </button>
            </>
          ) : (
            <button
              className="send"
              type="button"
              aria-label={t('chat.composer.send.label')}
              title={t('chat.composer.send.label')}
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
