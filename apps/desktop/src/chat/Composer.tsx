import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, GenerationControls, ProviderUsage } from '@conduit/config-schema';
import {
  attachmentDelivery,
  deleteAttachment,
  listKnowledgeDocuments,
  listProviderDescriptors,
  loadProviderCredentialReference,
  saveAttachment,
  saveDroppedAttachment,
} from '../ipc/client';
import { AttachIcon, ConnectorsIcon, FilePlainIcon, FilesIcon, FolderIcon, GlobeIcon, KnowledgeIcon, ResearchIcon, SearchIcon, SendIcon, SkillIcon, SlidersIcon, StopIcon } from '../icons';
import { researchUnavailableReasonId, webSearchUnavailableReasonId } from './researchAvailability';
import { ComposerMcpPrompts } from './ComposerMcpPrompts';
import { ComposerMcpResources } from './ComposerMcpResources';
import type { AttachmentDelivery, ConnectorPromptInfo, ConnectorResourceInfo, ResourceRef } from '../ipc/contracts';
import { brand } from '../brand';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';
import { StatusLine, type CredentialMode } from '../shell/StatusLine';
import {
  ATTACHMENT_INLINE_CAP_BYTES,
  COMPOSER_ATTACH_ACCEPT,
  attachmentChipState,
  deliveryKeyFor,
  deliveryPending,
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
import { ComposerSlashMenu, slashOptionId, type SlashMenuOption } from './ComposerSlashMenu';
import {
  SLASH_COMMAND_IDS,
  findSlashTrigger,
  removeSlashCommand,
  slashCommandMatches,
  type SlashCommandId,
  type SlashTrigger,
} from './slashTrigger';

/** Below this composer width the Web and Research toggles drop their labels. */
const COMPOSER_NARROW_PX = 520;

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
  /** The shell's native drag-drop says a file hovering over the chat will attach here. */
  attachDropActive?: boolean;
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
   *  Absent hides the Research toggle. */
  researchOn?: boolean;
  onResearchToggle?: () => void;
  /** Absolute workspace folder this conversation's tools use, if any: its own
   *  or the Settings default. */
  workspaceRoot?: string | null;
  /** `workspaceRoot` is the default folder from Settings, not one picked for this chat. */
  workspaceFromSettings?: boolean;
  /** Pick / change folder (parent handles consent). */
  onWorkspacePick?: () => void;
  /** Turn folder access off for this conversation (the default folder too). */
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
  /// The Web and Research toggles and the "+" menu's documents are left out,
  /// and the draft's active sources show as chips that open that tab.
  draftSources?: ComposerDraftSources;
  /// The chat has no messages yet: offer starter chips under the composer.
  showStarters?: boolean;
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
  attachDropActive = false,
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
  workspaceFromSettings = false,
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
  showStarters = false,
}, ref) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
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
  // The `/` tools menu: open while the message starts with a command word.
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  // Escape closed the menu: it stays closed until the `/` word is gone, so
  // the next keystroke does not bring it straight back.
  const slashDismissedRef = useRef(false);
  // The text a pick just consumed, until the next frame. React's select event
  // for the picking keystroke still carries it, and must not reopen the menu.
  const slashPickedTextRef = useRef<string | null>(null);
  // The composer is narrow (a docked panel, a small window): the Web and
  // Research toggles show their icons only.
  const [narrow, setNarrow] = useState(false);
  // True while an IME composition is in progress (D12): the trigger and the
  // Enter-to-send guard both go quiet until it ends.
  const composingRef = useRef(false);
  // t1-8 M1 (D13): whichever of an HTML5 drop and a native composer drop
  // fires first for one physical drop wins; the other is ignored.
  const lastDropAtRef = useRef(0);
  const deliveryQueriesRef = useRef<Set<string>>(new Set());
  const deliveryKey = deliveryKeyFor(settings.activeProvider, settings.activeModel);

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
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                attachment,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
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

  function updateSlashTrigger(text: string, caret: number) {
    if (streaming || composingRef.current) {
      if (slashTrigger) setSlashTrigger(null);
      return;
    }
    if (slashPickedTextRef.current !== null) {
      if (text === slashPickedTextRef.current) return;
      slashPickedTextRef.current = null;
    }
    const next = findSlashTrigger(text, caret);
    if (!next) slashDismissedRef.current = false;
    const shown = next && !slashDismissedRef.current ? next : null;
    if (shown?.query !== slashTrigger?.query) setSlashActiveIndex(0);
    setSlashTrigger(shown);
  }

  function updateTriggers(text: string, caret: number) {
    updateHashTrigger(text, caret);
    updateSlashTrigger(text, caret);
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
    setSlashTrigger(null);
  }, [conversationId]);

  useEffect(() => {
    const box = composerBoxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? box.clientWidth;
      setNarrow(width > 0 && width < COMPOSER_NARROW_PX);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // What each uploaded attachment will do with the active model. The answer
  // depends on the model (native PDF, vision), so it is asked again when the
  // model changes; `deliveryQueriesRef` keeps one query per attachment+model
  // in flight however often pendingAttachments changes.
  useEffect(() => {
    for (const item of pendingAttachments) {
      const id = item.attachment?.id;
      if (item.status !== 'uploaded' || !id || item.deliveryKey === deliveryKey) continue;
      const queryKey = `${id}|${deliveryKey}`;
      if (deliveryQueriesRef.current.has(queryKey)) continue;
      deliveryQueriesRef.current.add(queryKey);
      const settle = (delivery: AttachmentDelivery | undefined) => {
        deliveryQueriesRef.current.delete(queryKey);
        setPendingAttachments((current) =>
          current.map((entry) =>
            entry.attachment?.id === id ? { ...entry, delivery, deliveryKey } : entry,
          ),
        );
      };
      // `Promise.resolve().then` so a synchronous throw is a failed query too.
      void Promise.resolve()
        .then(() => attachmentDelivery(settings.activeProvider, settings.activeModel, id))
        .then(settle, () => settle(undefined));
    }
  }, [pendingAttachments, deliveryKey, settings.activeProvider, settings.activeModel]);

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
    setSlashTrigger(null);
  }, [streaming]);

  const togglePop = (pop: ComposerPopover) => {
    setPlusOpen(false);
    setOpenPop((current) => (current === pop ? null : pop));
  };
  const closePop = () => setOpenPop(null);

  const workspaceBound = Boolean(workspaceRoot?.trim());
  const workspaceLabel = workspaceBound ? workspaceFolderLabel(workspaceRoot!) : null;
  // The Settings default shows like a picked folder, marked as the default, so
  // a chat never has file access it does not show.
  const workspaceTitle = workspaceBound
    ? workspaceFromSettings
      ? t('chat.composer.workspace.defaultTitle', { path: workspaceRoot! })
      : workspaceRoot!
    : null;
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
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                attachment,
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
    // Sending before the active model's answer arrives could drop a document.
    if (deliveryPending(pendingAttachments, deliveryKey)) return;
    const attachments = turnAttachmentsFromPending(pendingAttachments, deliveryKey);
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

    if (slashMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSlashActiveIndex((i) => (i + step + slashOptions.length) % slashOptions.length);
        return;
      }
      // Unlike `#`, a `/` word at the very start of a message is a command
      // far more often than text, so Enter picks rather than sends.
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pickSlashCommand(slashOptions[slashActiveIndex] ?? slashOptions[0]);
        return;
      }
      // Escape is taken in the capture phase (see the effect below), before
      // any shell or panel listener can read it as "close".
    }

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
    updateTriggers(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
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

  /** The chip's words for what will happen to an uploaded attachment. */
  function deliveryChipLabel(state: ReturnType<typeof attachmentChipState>): { text: string; title: string } {
    switch (state.kind) {
      case 'image':
        return { text: t('chat.composer.attachment.status.ready'), title: t('chat.composer.attachment.readyTitle') };
      case 'pdf':
        return {
          text: t('chat.composer.attachment.status.sentAsPdf'),
          title: t('chat.composer.attachment.title.sentAsPdf'),
        };
      case 'text':
        return {
          text: t('chat.composer.attachment.status.sentAsText'),
          title: t('chat.composer.attachment.title.sentAsText'),
        };
      case 'unsupported': {
        const text = state.reason
          ? t('chat.composer.attachment.status.notSentType', { reason: state.reason })
          : t('chat.composer.attachment.status.notSentUnknownType');
        return { text, title: text };
      }
      case 'unknown':
        return {
          text: t('chat.composer.attachment.status.notSent'),
          title: t('chat.composer.attachment.title.unknown'),
        };
      default:
        return {
          text: t('chat.composer.attachment.status.checking'),
          title: t('chat.composer.attachment.status.checking'),
        };
    }
  }

  const attachDisabled = !conversationId || streaming;
  const hasForwardableAttachments = turnAttachmentsFromPending(pendingAttachments, deliveryKey).length > 0;
  const uploading =
    pendingAttachments.some((item) => item.status === 'uploading') ||
    deliveryPending(pendingAttachments, deliveryKey);
  const canSend =
    !uploading && (prompt.trim().length > 0 || hasForwardableAttachments);

  const queueCount = queuedMessages.length;

  // The Web and Research toggles sit in the bar whenever the host wires them,
  // available or not: an unavailable one is disabled and its title says why.
  // A draft's chat leaves both out, because its Sources tab owns them. Like
  // the "+" menu they used to live in, neither changes mid-turn.
  const webReasonId = webSearchUnavailableReasonId(settings);
  const webSearchAvailable = !draftSources && webReasonId === null;
  const showWebToggle = !draftSources;
  const webPressed = webSearchAvailable && webSearchOn;
  const webToggleDisabled = streaming || !webSearchAvailable;
  const webToggleTitle = streaming
    ? t('chat.composer.plus.titleStreaming')
    : webReasonId !== null
      ? t(webReasonId)
      : webSearchOn
        ? searchOnTitle
        : searchOffTitle;
  const researchReasonId = researchUnavailableReasonId(settings);
  const researchAvailable = researchReasonId === null;
  const showResearchToggle = Boolean(onResearchToggle) && !draftSources;
  // Turning it off stays possible whatever changed since it was turned on.
  const researchToggleDisabled = streaming || (!researchAvailable && !researchOn);
  const researchToggleTitle = streaming
    ? t('chat.composer.plus.titleStreaming')
    : researchAvailable
      ? t(researchOn ? 'chat.composer.research.onTitle' : 'chat.composer.research.offTitle')
      : t(researchReasonId);
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
  if (onWorkspacePick) {
    plusItems.push({
      id: 'workspace',
      label: t('chat.composer.plus.workspace'),
      icon: <FolderIcon />,
      title: workspaceTitle ?? t('chat.composer.workspace.unbound'),
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
      label: workspaceFromSettings
        ? t('chat.composer.workspace.defaultChipLabel', { label: workspaceLabel! })
        : workspaceLabel!,
      icon: <FolderIcon />,
      title: workspaceTitle!,
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
  // Web and Research have no chip: their toggles in the bar already show
  // whether they are on, and turn them off.
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

  /** One tool, run the way its own control runs it: the toggle, the "+"
   *  menu's folder and attach items, the skills popover. The `/` menu and the
   *  starter chips both come through here. */
  function runTool(id: SlashCommandId) {
    switch (id) {
      case 'web':
        onWebSearchToggle();
        return;
      case 'research':
        onResearchToggle?.();
        return;
      case 'folder':
        selectWorkspace();
        return;
      case 'file':
        setOpenPop(null);
        fileInputRef.current?.click();
        return;
      case 'skill':
        setPlusOpen(false);
        setOpenPop('skills');
        return;
    }
  }

  const folderToolAvailable = Boolean(onWorkspacePick) && Boolean(conversationId) && !streaming;
  const skillToolAvailable = Boolean(onToggleSkill) && Boolean(conversationId) && !streaming;
  const toolLabels: Record<SlashCommandId, string> = {
    web: t('chat.composer.tools.webHint'),
    research: t('chat.composer.tools.researchHint'),
    folder: t('chat.composer.tools.folder'),
    file: t('chat.composer.tools.file'),
    skill: t('chat.composer.tools.skill'),
  };
  const toolIcons: Record<SlashCommandId, ReactNode> = {
    web: <GlobeIcon />,
    research: <ResearchIcon />,
    folder: <FolderIcon />,
    file: <AttachIcon />,
    skill: <SkillIcon />,
  };
  // Only what can run right now is offered.
  const toolAvailable: Record<SlashCommandId, boolean> = {
    web: showWebToggle && !webToggleDisabled,
    research: showResearchToggle && !researchToggleDisabled,
    folder: folderToolAvailable,
    file: !attachDisabled,
    skill: skillToolAvailable,
  };
  const slashOptions: SlashMenuOption[] = slashTrigger
    ? SLASH_COMMAND_IDS.filter(
        (id) => toolAvailable[id] && slashCommandMatches(id, toolLabels[id], slashTrigger.query),
      ).map((id) => ({
        id,
        label: toolLabels[id],
        icon: toolIcons[id],
        on: id === 'web' ? webPressed : id === 'research' ? researchOn : undefined,
      }))
    : [];
  // Nothing matching closes the menu, so "/usr/bin" or "/shrug" type on as text.
  const slashMenuOpen = slashOptions.length > 0;

  function pickSlashCommand(option: SlashMenuOption) {
    const trigger = slashTrigger;
    if (!trigger) return;
    setSlashTrigger(null);
    slashPickedTextRef.current = prompt;
    onPromptChange(removeSlashCommand(prompt, trigger));
    runTool(option.id);
    requestAnimationFrame(() => {
      slashPickedTextRef.current = null;
      const ta = textareaRef.current;
      if (ta && document.activeElement === ta) ta.setSelectionRange(0, 0);
    });
  }

  // Escape closes the `/` menu and nothing else. The shell's Escape (stop the
  // stream, close an overlay) and the document panel's listen on window and
  // document, so the key is claimed in window's capture phase, before them.
  useEffect(() => {
    if (!slashMenuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (event.target !== textareaRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      slashDismissedRef.current = true;
      setSlashTrigger(null);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [slashMenuOpen]);

  // New chat only: a few ways in, under the composer. A folder already in
  // use (the Settings default) shows as its chip, so it is not offered again.
  const starterIds: SlashCommandId[] = showStarters
    ? (['folder', 'file', 'skill'] as const).filter((id) =>
        id === 'folder' ? folderToolAvailable && !workspaceBound : toolAvailable[id],
      )
    : [];

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
        ref={composerBoxRef}
        className={`composer${dropActive || (attachDropActive && !attachDisabled) ? ' drop-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ComposerContextChips chips={chips} disabled={streaming} />
        {pendingAttachments.length > 0 && (
          <div className="composer-attachments" aria-label={t('chat.composer.attachments.ariaLabel')}>
            {pendingAttachments.map((item) => {
              const delivery = item.status === 'uploaded' ? attachmentChipState(item, deliveryKey) : null;
              const deliveryLabel = delivery ? deliveryChipLabel(delivery) : null;
              return (
              <div
                key={item.localId}
                className="composer-attachment-chip"
                data-status={item.status}
                data-delivery={delivery?.kind}
                title={item.status === 'uploaded' ? deliveryLabel?.title : item.error}
              >
                <FilePlainIcon />
                <span className="composer-attachment-name">{item.fileName}</span>
                <span className="composer-attachment-meta">
                  {item.status === 'uploading'
                    ? t('chat.composer.attachment.status.uploading')
                    : item.status === 'failed'
                      ? t('chat.composer.attachment.status.failed')
                      : item.status === 'uploaded'
                        ? deliveryLabel?.text
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
              );
            })}
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
            updateTriggers(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            updateTriggers(target.value, target.selectionStart ?? 0);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={(event) => void handlePaste(event)}
          placeholder={brand().tagline ?? t('chat.composer.placeholderTools')}
          rows={1}
          aria-label={t('chat.composer.prompt.ariaLabel')}
          aria-expanded={slashMenuOpen || hashTrigger ? true : undefined}
          aria-controls={
            slashMenuOpen ? 'composer-slash-menu-list' : hashTrigger ? 'composer-doc-picker-list' : undefined
          }
          aria-activedescendant={
            slashMenuOpen
              ? slashOptionId((slashOptions[slashActiveIndex] ?? slashOptions[0]).id)
              : hashTrigger && filteredDocumentOptions[docPickerActiveIndex]
                ? documentOptionId(filteredDocumentOptions[docPickerActiveIndex].documentId)
                : undefined
          }
        />
        {slashMenuOpen ? (
          <ComposerSlashMenu
            id="composer-slash-menu-list"
            options={slashOptions}
            activeIndex={Math.min(slashActiveIndex, slashOptions.length - 1)}
            onHover={setSlashActiveIndex}
            onPick={pickSlashCommand}
          />
        ) : null}
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
            accept={COMPOSER_ATTACH_ACCEPT}
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
                <p className="composer-workspace-path" title={workspaceTitle!}>
                  {workspaceRoot}
                </p>
                {workspaceFromSettings ? (
                  <p className="composer-workspace-note">{t('chat.composer.workspace.defaultNote')}</p>
                ) : null}
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
          {/* Web and Research are the two tools people reach for per message,
              so they live in the bar rather than in the "+" menu. Narrow, they
              keep their icon and move the label to aria-label. */}
          {showWebToggle ? (
            <button
              className="composer-tool"
              type="button"
              aria-pressed={webPressed}
              aria-label={narrow ? t('chat.composer.tools.web') : undefined}
              title={webToggleTitle}
              disabled={webToggleDisabled}
              data-icon-only={narrow ? 'true' : undefined}
              onClick={onWebSearchToggle}
            >
              <GlobeIcon />
              {narrow ? null : <span>{t('chat.composer.tools.web')}</span>}
            </button>
          ) : null}
          {showResearchToggle ? (
            <button
              className="composer-tool"
              type="button"
              aria-pressed={researchOn}
              aria-label={narrow ? t('chat.composer.tools.research') : undefined}
              title={researchToggleTitle}
              disabled={researchToggleDisabled}
              data-icon-only={narrow ? 'true' : undefined}
              onClick={onResearchToggle}
            >
              <ResearchIcon />
              {narrow ? null : <span>{t('chat.composer.tools.research')}</span>}
            </button>
          ) : null}
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
      {starterIds.length > 0 ? (
        <div
          className="composer-starters"
          role="group"
          aria-label={t('chat.composer.tools.startersAriaLabel')}
        >
          {starterIds.map((id) => (
            <button
              key={id}
              className="composer-starter"
              type="button"
              onClick={() => {
                // Focus first: the folder and file pickers are native dialogs
                // that hand focus back to the textbox when they close.
                textareaRef.current?.focus();
                runTool(id);
              }}
            >
              {toolIcons[id]}
              <span>{toolLabels[id]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
