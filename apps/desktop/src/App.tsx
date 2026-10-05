import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppPaths, AppSettings, Artifact, ArtifactContent, BrandConfig, ConversationFolder, ConversationSummary, FileState, OnboardingState, ProviderDescriptor, SearchResult } from './ipc/contracts';
import type { ArtifactCandidate } from './chat/artifactCandidates';
import type { StatusState } from './chat/statusTypes';
import { useUpdateScheduler } from './updates/useUpdateScheduler';
import { ToastStack } from './workspace/ToastStack';
import { useSpendAlert } from './workspace/useSpendAlert';
import { makeStatus, fromString, STATUS_DISMISS_MS, TOAST_DISMISS_MS, TOAST_STATUS_KINDS } from './chat/statusTypes';
import {
  checkArtifactFileState,
  createArtifact,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  exportArtifact,
  getAppPaths,
  getArtifact,
  getBrandConfig,
  getMessageIdByRequest,
  getOnboardingState,
  getSettings,
  listConversations,
  getConversation,
  notifyWorkflowRun,
  listConversationFolders,
  listConnectorGrants,
  listProviderDescriptors,
  listProviderModels,
  listKnowledgeCollections,
  revealArtifactsDir,
  searchMessages,
  setArtifactContent,
  setArtifactTitle,
  setConversationArchived,
  setConversationFolder,
  setConversationPinned,
  createConversationFolder,
  renameConversationFolder,
  deleteConversationFolder,
  updateSettings,
} from './ipc/client';
import { ChatView, type ChatTranscript, type ChatViewHandle, type RunStatus } from './chat/ChatView';
import {
  documentToolArtifactKind,
  hadSuccessfulDocumentToolCalls,
  isDocumentCreateTool,
  isDocumentPatchTool,
  looksLikeDeckRequest,
  resolveDocumentArtifactId,
  type DocumentToolActivity,
} from './chat/agentTools';
import type { AssistantStreamState } from './chat/streamState';
import { findPromotedArtifact, finishedDocumentFence } from './chat/inlineArtifact';
import {
  resolveFailedPendingArtifact,
  type PendingArtifact,
} from './artifacts/pendingArtifact';
import { applyTheme, resolveTheme, watchSystemTheme } from './theme';
import { applyAccent } from './themes/accent';
import { useLocale, useRichT, useT } from './i18n';
import { applyBrand, applyBrandTheme, clearBrand } from './brand/applyBrand';
import { fetchBrandLogo } from './brand/logo';
import { appName } from './brand';
import { providerDisplayName, providerHueId } from './lib/providerIdentity';
import { MainHead } from './workspace/MainHead';
import { TitleBar } from './shell/TitleBar';
import { deriveConnectionState } from './lib/connectionState';
import { DocumentPanel } from './workspace/DocumentPanel';
import { Sidebar } from './shell/Sidebar';
import { SettingsSheet, type SettingsSection } from './shell/SettingsSheet';
import { DocumentsSheet } from './shell/DocumentsSheet';
import { Rail, type Destination } from './shell/Rail';
import { HomePage, type HomeAction } from './home/HomePage';
import { researchUnavailableReasonId } from './chat/researchAvailability';
import { InspectorTabs, type InspectorTab } from './inspector/InspectorTabs';
import { ActivityView } from './inspector/ActivityView';
import { SourcesView } from './inspector/SourcesView';
import { turnActivity, turnSites } from './inspector/turnActivity';
import { readArtifactNetworkLog } from './workspace/useArtifactNetwork';
import { LibraryPage, type LibraryTab } from './pages/LibraryPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { MemoryPage } from './pages/MemoryPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import {
  notificationFor,
  notificationForQuestion,
  notificationForReview,
  useWorkflowQuestionEvents,
  useWorkflowReviewEvents,
  useWorkflowRunEvents,
} from './workflows/workflowRunEvents';
import { useTrayLabels } from './shell/useTrayLabels';
import { IdeasSheet } from './ideas/IdeasSheet';
import type { Idea } from './ideas/catalog';
import { readyCapabilities, resolveCapabilities, type SetupTarget } from './ideas/capabilities';
import { notePicked, observeReady, setRowHidden, useIdeaState } from './ideas/ideaState';
import { useKnowledgeDrop } from './workspace/useKnowledgeDrop';
import { applyUiPrefs, migrateRetiredThemePrefs, THEME_CHANGED_EVENT } from './shell/uiPrefs';
import {
  useColumnOverlay,
  useColumnResize,
  useDocPanelCollapse,
  usePanelExpand,
  useSidebarCollapse,
  useSidebarResize,
} from './workspace/useLayout';
import { useFocusTrap } from './shell/useFocusTrap';
import { useHotkeys } from './workspace/useHotkeys';
import { ShortcutsSheet } from './workspace/ShortcutsSheet';
import { useWindowTitle } from './shell/useWindowTitle';
import { CommandPalette } from './workspace/CommandPalette';
import { refreshArtifactList } from './workspace/useArtifacts';
import { modShortcutHint } from './lib/shortcuts';
import { Onboarding, MigrationRecoveryNotice } from './onboarding/Onboarding';
import { readDevRoute } from './devRoute';
import { ConfirmDialog } from '@conduit/ui';
import { AppsPage } from './pages/AppsPage';
import type { AppSummary, StarterAppInfo } from './ipc/contracts';
import { AppDetailsDialog, type AppDetailsTarget } from './apps/AppDetailsDialog';
import {
  artifactPrincipal,
  exportConversationDialog,
  exportDeckHtml,
  exportDeckPdf,
  installStarterApp,
  listApps,
  listStarterApps,
  exportDiagnostics,
  forkConversation,
  previewConversationExport,
  setConversationTitle,
} from './ipc/client';
import { SlidesPage } from './pages/SlidesPage';
import { DeckWorkspace } from './slides/DeckWorkspace';
import { buildDeckHtmlExport, buildDeckPrintHtml } from './slides/deckExport';
import { PresentationView } from './slides/PresentationView';
import { STARTER_THEMES } from './slides/themes';
import { DeckDock, type DockTab } from './slides/DeckDock';
import { ScriptPanel, type ScriptFocusRequest } from './slides/ScriptPanel';
import { DeckHistory } from './slides/DeckHistory';
import { appPrompt, appPromptLabel } from './chat/appPrompt';
import type { DeckDetail, SlideTheme, SlotEdit, StorylineItem } from './ipc/contracts';
import {
  createDeck,
  undoStartDeck,
  editSlideWords,
  insertBullet,
  removeBullet,
  replaceInDeck,
  setSlotPinned,
  getDeckForConversation,
  listDeckSnapshots,
  listSlideThemes,
  openDeck,
  renameDeck,
  restoreDeckSnapshot,
  setDeckStage,
  setDeckStoryline,
  setDeckTheme,
  snapshotDeck,
} from './ipc/client';
import { WritingPage } from './pages/WritingPage';
import { WritingStudio } from './writing/WritingStudio';
import { DraftDock, type DraftDockTab } from './writing/DraftDock';
import { DraftHistory } from './writing/DraftHistory';
import { OutlineEditor } from './writing/OutlineEditor';
import { selectionMessage, type SelectionRequest } from './writing/selectionMessage';
import { DraftSourcesPanel } from './writing/DraftSourcesPanel';
import { buildDraftPreview, type SectionPreview } from './writing/sectionPreview';
import { draftSourcesOf, draftWebSearchUnavailableReasonId } from './writing/draftSources';
import type {
  DraftDetail,
  DraftExportFormat,
  KnowledgeCollection,
  OutlineSection,
  ResearchReportSummary,
} from './ipc/contracts';
import {
  createDraft,
  draftForConversation,
  exportDraft,
  getDraft,
  listConversationCollections,
  listResearchReports,
  setConversationCollections,
  setDraftSources,
  listDraftSnapshots,
  renameDraft,
  restoreDraftSnapshot,
  saveDraftMarkdown,
  setBlockPinned,
  setDraftOutline,
  setDraftStage,
  snapshotDraft,
} from './ipc/client';

/** How long the user's typing must pause before it is saved as an "Edited by you" version. */
const DRAFT_EDIT_SESSION_IDLE_MS = 120_000;

/* Dev-only (`?route=gallery`, see `devRoute.ts`): the theming project's
 * component gallery. Lazy so its fixtures and every component it renders
 * standalone (`dev/Gallery.tsx`) ship as a separate chunk that a production
 * build — where `devRoute` is always `null` — never fetches. */
const LazyGallery = import.meta.env.DEV ? lazy(() => import('./dev/Gallery')) : null;

const DOC_PANEL_HINT_KEY = 'conduit:v5-doc-panel-hint-seen';
const CONVO_PROVIDERS_KEY = 'conduit:v7-convo-providers';

/** Shorten an absolute path to the last few segments for the sidebar chip. */
function shortenWorkspacePath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/') || absolutePath;
  return parts.slice(-3).join('/');
}

/** Renderer-only map of conversationId → last-used provider id (the sidebar
 *  row dot). Persisted to localStorage; the backend has no such field. */
function readConvoProviders(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONVO_PROVIDERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeConvoProviders(map: Record<string, string>): void {
  try {
    localStorage.setItem(CONVO_PROVIDERS_KEY, JSON.stringify(map));
  } catch {
    /* storage may be unavailable; fail silently */
  }
}

const defaultSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
  language: 'system',
  providerEndpoints: {},
  modelPriceOverrides: [],
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  artifactNetworkEnabled: true,
  closeToTray: false,
  closeToTrayOffered: false,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual',
  onboardingCompleted: false,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto',
    localBackend: 'duckduckgo',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  imageGenerationConsentAcknowledged: false,
  embeddingConsentProviders: [],
  pdfImportNoticeAcknowledged: false,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
  accent: {},
};

const ASSISTANT_TURN_PREFIX = 'assistant-';

async function resolveSourceMessageId(messageId: string): Promise<string> {
  if (!messageId.startsWith(ASSISTANT_TURN_PREFIX)) return messageId;
  const requestId = messageId.slice(ASSISTANT_TURN_PREFIX.length);
  try {
    const realId = await getMessageIdByRequest(requestId);
    if (realId) return realId;
  } catch {
    /* fall back to the client turn id */
  }
  return messageId;
}

/**
 * Moves focus into an overlay: its first control, or the overlay itself when it
 * has none (the artifact panel's empty state). Without the fallback, focus
 * would stay on the button that opened it, outside the trap.
 */
function focusInto(root: HTMLElement | null) {
  if (!root) return;
  const first = root.querySelector<HTMLElement>('button:not([disabled]), [href], input, textarea, select, [tabindex="0"]');
  if (first) {
    first.focus();
    return;
  }
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus();
}

export default function App() {
  const t = useT();
  /* Read once per mount, not per render: it never changes within a page load
     (see `devRoute.ts`), and `null` in every production build. */
  const [devRoute] = useState(readDevRoute);
  const tr = useRichT();
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  /* Whether `settings` holds the authoritative Rust read yet, or is still the
   * `defaultSettings` placeholder. Only the language mirror below needs to
   * know, and it needs to badly — see the comment there. */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [status, setStatus] = useState<StatusState | null>(makeStatus(t('app.status.booting'), 'active'));
  const [boundaryOk, setBoundaryOk] = useState(true);
  // UI revamp (docs/plans/ui-revamp.md): where the rail points. Chats is the
  // chat sidebar and the chat; every other destination is a page over the
  // body, with the chat kept mounted underneath so a running turn goes on.
  // The app opens on Home. Boot still selects a conversation underneath, so
  // "Continue" is instant.
  const [destination, setDestination] = useState<Destination>('home');
  // Home's "New workflow" opens the Workflows page on its picker.
  const [workflowsStartNew, setWorkflowsStartNew] = useState(false);
  useEffect(() => {
    if (destination !== 'workflows') setWorkflowsStartNew(false);
  }, [destination]);
  // Apps: the one open app (null = the list), the saved apps for the
  // new-chat row, and the Save as app / edit dialog.
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const [savedApps, setSavedApps] = useState<AppSummary[]>([]);
  const [appDetailsTarget, setAppDetailsTarget] = useState<AppDetailsTarget | null>(null);
  const [starterApps, setStarterApps] = useState<StarterAppInfo[]>([]);
  const refreshSavedApps = useCallback(async () => {
    try {
      const [apps, starters] = await Promise.all([listApps(), listStarterApps()]);
      setSavedApps(apps);
      setStarterApps(starters);
    } catch {
      setSavedApps([]);
    }
  }, []);
  useEffect(() => {
    void refreshSavedApps();
  }, [refreshSavedApps, destination]);
  const openSavedApp = useCallback((id: string | null) => {
    setOpenAppId(id);
    setDestination('apps');
  }, []);
  // A starter app: add it the first time (named in the user's language, from
  // its Ideas strings), then it is an ordinary app.
  const addStarterApp = useCallback(
    async (starter: StarterAppInfo): Promise<string | null> => {
      if (starter.installedAppId) return starter.installedAppId;
      try {
        const app = await installStarterApp(
          starter.id,
          t(`ideas.item.${starter.ideaId}.title`),
          t(`ideas.item.${starter.ideaId}.blurb`),
        );
        await refreshSavedApps();
        setStatusMessage(t('apps.status.added', { name: app.name }));
        return app.id;
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [refreshSavedApps, t],
  );
  const openStarterApp = useCallback(
    async (starter: StarterAppInfo) => {
      const id = await addStarterApp(starter);
      if (id) openSavedApp(id);
    },
    [addStarterApp, openSavedApp],
  );
  const readyMadeIdeas = useMemo(() => new Set(starterApps.map((s) => s.ideaId)), [starterApps]);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('prompts');
  const settingsOpen = destination === 'settings';
  // t1-8: files dropped onto the window wait on the Documents page for the
  // user to pick a collection.
  const documentsOpen = destination === 'documents';
  const ideasOpen = destination === 'ideas';
  /** Leave `from` for Chats, if it is where we are. */
  const leave = useCallback(
    (from: Destination) => setDestination((current) => (current === from ? 'chats' : current)),
    [],
  );
  const [collectionCount, setCollectionCount] = useState<number | null>(null);
  const [queuedIdea, setQueuedIdea] = useState<Idea | null>(null);
  // A deck idea's story, for the Slides start box.
  const [slidesPrefill, setSlidesPrefill] = useState<{ text: string; seq: number } | null>(null);
  // Used once: coming back to Slides later starts with an empty box.
  useEffect(() => {
    if (destination !== 'slides') setSlidesPrefill(null);
  }, [destination]);
  const ideaState = useIdeaState();
  const [droppedPaths, setDroppedPaths] = useState<string[]>([]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>();
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [brandConfig, setBrandConfig] = useState<BrandConfig | null>(null);
  // Deliberately not part of the localStorage pre-paint cache — see
  // brand/logo.ts and applyBrand.ts's "why the logo is never cached"
  // comments. Arrives a frame later than the palette/identity; that's the
  // accepted trade-off.
  const [brandLogo, setBrandLogo] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [openArtifactIds, setOpenArtifactIds] = useState<string[]>([]);
  const [pendingArtifact, setPendingArtifact] = useState<PendingArtifact | null>(null);
  const [fileStateMap, setFileStateMap] = useState<Record<string, FileState>>({});
  const [docTab, setDocTab] = useState<'preview' | 'source'>('preview');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationSummary, setActiveConversationSummary] = useState<ConversationSummary | null>(null);
  useWindowTitle(activeConversationSummary?.displayTitle);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationFolders, setConversationFolders] = useState<ConversationFolder[]>([]);
  const [convoProviders, setConvoProviders] = useState<Record<string, string>>(readConvoProviders);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [connectorCount, setConnectorCount] = useState<number | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [pendingSendText, setPendingSendText] = useState<string | null>(null);
  // The pending text starts a Research run (Home's Research chip), not a reply.
  const [pendingSendResearch, setPendingSendResearch] = useState(false);
  const consumePendingSend = useCallback(() => {
    setPendingSendText(null);
    setPendingSendResearch(false);
  }, []);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [toasts, setToasts] = useState<StatusState[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteConversations, setPaletteConversations] = useState<
    /* `title` is optional for the same reason `ConversationSummary.displayTitle`
     * is: a chat with no name and nothing said in it has none, and the palette
     * names that case itself, in the reader's language. */
    { id: string; title?: string; pinned?: boolean; archived?: boolean }[]
  >([]);
  const chatViewRef = useRef<ChatViewHandle>(null);

  const panelResize = useColumnResize();
  const { open: openSidebar, close: closeSidebar, toggle: toggleSidebar } = useSidebarCollapse();
  const sidebarResize = useSidebarResize({ open: openSidebar, close: closeSidebar });
  // The artifact panel opens for a chat that has something to put in it. A new
  // chat, or one that never produced an artifact, used to open onto a 420px
  // "Artifacts live here" card — about a third of the window, empty. Now the
  // panel stays shut there until an artifact is promoted, a document tool
  // starts one, or the user opens it anyway; the saved open/closed preference
  // is untouched and applies as soon as there is content.
  //
  // `artifacts` outlives a chat switch until the next list arrives, so the list
  // records whose it is, and the decision only moves once the open chat's list
  // has loaded — two chats that both have artifacts must not flicker the panel
  // shut and open again between them.
  const [artifactsConversationId, setArtifactsConversationId] = useState<string | null>(null);
  const [emptyPanelRequested, setEmptyPanelRequested] = useState(false);
  const [panelHasContent, setPanelHasContent] = useState(false);
  const chatArtifacts = artifactsConversationId === activeConversationId ? artifacts : [];
  // Slides: the deck bound to the open chat, if any. A deck chat shows the
  // deck workspace where the document panel would be, and the chat is its
  // "Ask" column.
  const [activeDeck, setActiveDeck] = useState<DeckDetail | null>(null);
  const [deckLoading, setDeckLoading] = useState(false);
  const [deckBusyTool, setDeckBusyTool] = useState<string | null>(null);
  const [deckHistoryRevision, setDeckHistoryRevision] = useState(0);
  const deckChangedThisTurnRef = useRef(false);
  // The history label for the next AI turn when the app sent its prompt (the
  // "Build slides" button), rather than the user typing one.
  const nextDeckTurnLabelRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDeckBusyTool(null);
    deckChangedThisTurnRef.current = false;
    if (!activeConversationId) {
      setActiveDeck(null);
      return;
    }
    setDeckLoading(true);
    getDeckForConversation(activeConversationId)
      .then((deck) => {
        if (!cancelled) setActiveDeck(deck ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveDeck(null);
      })
      .finally(() => {
        if (!cancelled) setDeckLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);
  // Writing: the draft bound to the open chat, if any. Like a deck, a draft
  // chat opens in its studio, with the chat as the dock's Ask tab.
  const [activeDraft, setActiveDraft] = useState<DraftDetail | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftBusyTool, setDraftBusyTool] = useState<string | null>(null);
  const [draftHistoryRevision, setDraftHistoryRevision] = useState(0);
  // Bumps when the draft was replaced from outside the editor (a restore).
  const [draftResetToken, setDraftResetToken] = useState(0);
  const draftChangedThisTurnRef = useRef(false);
  // The history label for the next AI turn when the app sent its prompt
  // ("Approve outline"), rather than the user typing one.
  const nextDraftTurnLabelRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDraftBusyTool(null);
    draftChangedThisTurnRef.current = false;
    if (!activeConversationId) {
      setActiveDraft(null);
      return;
    }
    setDraftLoading(true);
    draftForConversation(activeConversationId)
      .then((draft) => {
        if (cancelled) return;
        // Opening a draft loads it and selects its chat, which starts this
        // fetch too. If the draft changed in between ("Approve outline" pressed
        // the moment it appeared), this answer is older than what is already
        // shown: keep the newer copy, or the next message describes a stage
        // the draft has already left.
        setActiveDraft((current) =>
          current && draft && current.id === draft.id && current.updatedAt >= draft.updatedAt
            ? current
            : (draft ?? null),
        );
      })
      .catch(() => {
        if (!cancelled) setActiveDraft(null);
      })
      .finally(() => {
        if (!cancelled) setDraftLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);
  // The theme library (custom themes). Re-read whenever the deck's theme
  // changes: moving off a custom theme, or the model writing one, saves it.
  const [savedSlideThemes, setSavedSlideThemes] = useState<SlideTheme[]>([]);
  const activeDeckId = activeDeck?.id;
  const activeDeckThemeName = activeDeck?.themeName;
  useEffect(() => {
    if (!activeDeckId) return;
    let cancelled = false;
    listSlideThemes()
      .then((themes) => {
        if (!cancelled) setSavedSlideThemes(themes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeDeckId, activeDeckThemeName]);
  useEffect(() => {
    const listSettled = activeConversationId == null || artifactsConversationId === activeConversationId;
    if (activeDeck || activeDraft) {
      setPanelHasContent(true);
      return;
    }
    if (!listSettled && pendingArtifact == null && activeArtifact == null) return;
    setPanelHasContent(chatArtifacts.length > 0 || pendingArtifact != null || activeArtifact != null);
  }, [activeConversationId, artifactsConversationId, chatArtifacts.length, pendingArtifact, activeArtifact, activeDeck, activeDraft]);
  useEffect(() => {
    setEmptyPanelRequested(false);
  }, [activeConversationId]);
  const panelSuppressed = !panelHasContent && !emptyPanelRequested;

  const {
    collapsed: docPanelCollapsed,
    collapse: collapseDocPanel,
    expand: expandDocPanel,
    toggle: toggleDocPanel,
  } = useDocPanelCollapse({ suppressed: panelSuppressed });

  // Where the window has no room for a side column, its toggles show it as an
  // overlay instead of flipping a collapse state that changes nothing there.
  // Only one overlay at a time: opening either closes the other.
  const sidebarOverlay = useColumnOverlay('sidebar');
  const panelOverlay = useColumnOverlay('panel');
  const { hide: hideSidebarOverlay, toggle: toggleSidebarOverlay } = sidebarOverlay;
  const { hide: hidePanelOverlay, show: showPanelOverlay, toggle: togglePanelOverlay } = panelOverlay;
  const panelExpand = usePanelExpand();
  const { expanded: panelExpanded, restore: restorePanelLayout } = panelExpand;
  const toggleSidebarView = useCallback(() => {
    if (panelExpanded) {
      // Asking for the sidebar while the artifact is expanded is asking for
      // the ordinary layout back.
      restorePanelLayout();
      return;
    }
    if (!sidebarOverlay.narrow) {
      toggleSidebar();
      return;
    }
    hidePanelOverlay();
    toggleSidebarOverlay();
  }, [panelExpanded, restorePanelLayout, sidebarOverlay.narrow, toggleSidebar, hidePanelOverlay, toggleSidebarOverlay]);
  const toggleDocPanelView = useCallback(() => {
    if (!panelOverlay.narrow) {
      if (panelSuppressed) {
        // Shut only because the chat is empty: opening it is a request to see
        // the empty panel, which holds for this chat.
        setEmptyPanelRequested(true);
        expandDocPanel();
        return;
      }
      toggleDocPanel();
      return;
    }
    hideSidebarOverlay();
    togglePanelOverlay();
  }, [panelOverlay.narrow, panelSuppressed, expandDocPanel, toggleDocPanel, hideSidebarOverlay, togglePanelOverlay]);
  // ── Inspector (UI revamp): Page · Activity · Sources ──────────────────────
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('page');
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ChatTranscript>({ turns: [], citations: {} });
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  useEffect(() => {
    setInspectorTab('page');
    setFocusTurnId(null);
  }, [activeConversationId]);
  // Opening a page (or the model writing one) brings the Page tab forward.
  useEffect(() => {
    if (activeArtifact || pendingArtifact) setInspectorTab('page');
  }, [activeArtifact?.id, pendingArtifact != null]);
  const openInspector = useCallback(
    (tab: InspectorTab, turnId?: string | null) => {
      setInspectorTab(tab);
      if (turnId !== undefined) setFocusTurnId(turnId);
      if (!panelOverlay.narrow) {
        setEmptyPanelRequested(true);
        expandDocPanel();
        return;
      }
      hideSidebarOverlay();
      showPanelOverlay();
    },
    [panelOverlay.narrow, expandDocPanel, hideSidebarOverlay, showPanelOverlay],
  );
  const closeInspector = useCallback(() => {
    setInspectorTab('page');
    if (panelOverlay.narrow) hidePanelOverlay();
    else collapseDocPanel();
  }, [panelOverlay.narrow, hidePanelOverlay, collapseDocPanel]);
  const inspectorCounts = useMemo(() => {
    const latest = [...transcript.turns].reverse().find((x) => x.role === 'assistant');
    const activity = latest ? turnActivity(latest).length : 0;
    let sources = 0;
    for (const turn of transcript.turns) sources += turnSites(turn.streamState).length;
    for (const list of Object.values(transcript.citations)) sources += list.length;
    return { activity, sources };
  }, [transcript]);

  /** Bring the panel into view for something the user asked to see. */
  const showDocPanel = useCallback(() => {
    if (!panelOverlay.narrow) {
      expandDocPanel();
      return;
    }
    hideSidebarOverlay();
    showPanelOverlay();
  }, [panelOverlay.narrow, expandDocPanel, hideSidebarOverlay, showPanelOverlay]);
  const closeOverlays = useCallback(() => {
    hideSidebarOverlay();
    hidePanelOverlay();
  }, [hideSidebarOverlay, hidePanelOverlay]);
  const panelVisible = panelOverlay.narrow ? panelOverlay.open : !docPanelCollapsed;
  /* Whether a document the turn just wrote may open itself. Idle is "nothing
   * to take away from the reader": no generation in progress, and either the
   * panel is out of sight or it shows no document. Read when a turn ends,
   * after awaits, hence a ref rather than a closure. */
  const docPanelIdleRef = useRef(false);
  docPanelIdleRef.current = pendingArtifact == null && (!panelVisible || activeArtifact == null);

  // Expanding is a desktop layout: it ends when the panel is put away or the
  // window becomes too narrow for the panel to be a column at all.
  useEffect(() => {
    if (panelExpanded && (docPanelCollapsed || panelOverlay.narrow)) restorePanelLayout();
  }, [panelExpanded, docPanelCollapsed, panelOverlay.narrow, restorePanelLayout]);
  const toggleArtifactExpand = useCallback(() => {
    if (panelOverlay.narrow) return;
    if (!panelExpanded && docPanelCollapsed) showDocPanel();
    panelExpand.toggle();
  }, [panelOverlay.narrow, panelExpanded, docPanelCollapsed, showDocPanel, panelExpand]);

  // An overlay is modal in effect — the scrim takes the pointer — so it takes
  // the keyboard too: focus moves in, Tab stays in, and closing hands focus
  // back to whatever opened it (useFocusTrap restores it). The elements are
  // looked up rather than ref-forwarded, since both components render their
  // own root and the panel swaps between two.
  const sidebarElRef = useRef<HTMLElement | null>(null);
  const panelElRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    sidebarElRef.current = document.getElementById('sidebar');
    panelElRef.current = document.querySelector<HTMLElement>('.body > .doc-panel');
  });
  useFocusTrap(sidebarElRef, sidebarOverlay.open);
  useFocusTrap(panelElRef, panelOverlay.open);
  useEffect(() => {
    if (sidebarOverlay.open) focusInto(sidebarElRef.current);
  }, [sidebarOverlay.open]);
  useEffect(() => {
    if (panelOverlay.open) focusInto(panelElRef.current);
  }, [panelOverlay.open]);
  // Rich status: accepts either a string (legacy) or a StatusState object.
  const setStatusMessage = useCallback((message: string | StatusState) => {
    const state = typeof message === 'string' ? fromString(message) : message;
    setStatus(state);
  }, []);

  // Route error/warning/success to ToastStack exclusively; clear panel status after.
  useEffect(() => {
    if (!status) return;
    if (!TOAST_STATUS_KINDS.has(status.kind)) return;
    setToasts((current) => {
      if (current.some((t) => t.timestamp === status.timestamp)) return current;
      return [...current.slice(-4), status];
    });
    setStatus(null);
  }, [status]);

  const dismissToast = useCallback((timestamp: number) => {
    setToasts((current) => current.filter((t) => t.timestamp !== timestamp));
  }, []);

  // A turn's error stays in its chat, inline under the turn. As a toast it
  // stays until dismissed, so it followed the reader into every other chat —
  // seen live, one dashboard failure sat over five unrelated conversations.
  // Leaving the chat takes its turn errors with it.
  useEffect(() => {
    setToasts((current) => {
      const kept = current.filter((toast) => !(toast.source === 'chat' && toast.kind === 'error'));
      return kept.length === current.length ? current : kept;
    });
  }, [activeConversationId]);

  // Background update checking. Dormant until settings load, and inert unless
  // the user opted into `notify` or `automatic` — `manual` (the default, and
  // what every pre-existing install deserializes to) schedules nothing.
  // `isBusy` gates on streaming so an automatic stage never competes with a
  // live conversation.
  useUpdateScheduler({
    settings: settingsLoaded ? settings : null,
    isBusy: () => chatViewRef.current?.isStreaming() ?? false,
    onStatus: setStatusMessage,
    t,
  });

  // Auto-dismiss timer for transient status kinds (idle).
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!status) return;
    const ms = STATUS_DISMISS_MS[status.kind];
    if (ms == null) return;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatus(null);
    }, ms);
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [status]);

  // Auto-dismiss warning/success toasts; errors stay until dismissed, and so
  // does a toast that offers an action (see `StatusState.action`).
  useEffect(() => {
    const timers = toasts
      .filter((t) => TOAST_DISMISS_MS[t.kind] != null && !t.action)
      .map((t) =>
        window.setTimeout(() => dismissToast(t.timestamp), TOAST_DISMISS_MS[t.kind]!),
      );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts, dismissToast]);

  const handleCollapseDocPanel = useCallback(() => {
    if (panelOverlay.narrow) {
      // The panel's own hide button, inside the overlay: dismiss, and leave
      // the desktop preference as it was.
      hidePanelOverlay();
      return;
    }
    collapseDocPanel();
    try {
      if (localStorage.getItem(DOC_PANEL_HINT_KEY) === '1') return;
      localStorage.setItem(DOC_PANEL_HINT_KEY, '1');
      const hint = makeStatus(
        t('app.status.artifactPanelHidden', { shortcut: modShortcutHint('J') }),
        'success',
      );
      setToasts((current) => [...current.slice(-4), hint]);
    } catch {
      /* ignore storage failures */
    }
  }, [collapseDocPanel, panelOverlay.narrow, hidePanelOverlay]);

  const refreshConversations = useCallback(async () => {
    try {
      const [listed, folderRows] = await Promise.all([
        listConversations(),
        listConversationFolders().catch(() => [] as ConversationFolder[]),
      ]);
      setConversations(listed);
      setConversationFolders(folderRows);
      return listed;
    } catch {
      setConversations([]);
      setConversationFolders([]);
      return [];
    }
  }, []);

  const refreshActiveConversationSummary = useCallback(async (conversationId: string | null) => {
    if (!conversationId) {
      setActiveConversationSummary(null);
      return;
    }
    try {
      const conversationsList = await listConversations();
      const listed = conversationsList.find((c) => c.id === conversationId);
      if (listed) {
        setActiveConversationSummary(listed);
        return;
      }
      // Not a chat in the list: a workflow's own conversation, opened from a
      // run's "Open document". Show its title (the workflow's name) anyway.
      const conversation = await getConversation(conversationId);
      setActiveConversationSummary(
        conversation
          ? {
              id: conversation.id,
              title: conversation.title,
              displayTitle: conversation.title,
              updatedAt: conversation.updatedAt,
              messageCount: 0,
            }
          : null,
      );
    } catch {
      setActiveConversationSummary(null);
    }
  }, []);

  useEffect(() => {
    void refreshActiveConversationSummary(activeConversationId);
  }, [activeConversationId, refreshActiveConversationSummary]);

  // Picking a chat from anywhere (the palette included) is done with the list.
  useEffect(() => {
    hideSidebarOverlay();
  }, [activeConversationId, hideSidebarOverlay]);

  // Best-effort active connector count for the sidebar workspace menu tail.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const grants = await listConnectorGrants();
        if (!cancelled) {
          setConnectorCount(grants.filter((g) => g.status === 'active').length);
        }
      } catch {
        if (!cancelled) setConnectorCount(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearWorkspaceArtifactSelection = useCallback(() => {
    setActiveArtifact(null);
    setOpenArtifactIds([]);
    setPendingArtifact(null);
  }, []);

  /** Bumped by every document write that starts, so an async open for an
   *  earlier write can tell a newer one has taken over the panel. */
  const documentWriteSeqRef = useRef(0);

  const handleDocumentToolActivity = useCallback(
    (activity: DocumentToolActivity) => {
      // Opening the saved document needs the artifact list; see
      // `handleDocumentWritten`, which `routeDocumentToolActivity` sends it to.
      if (activity.phase === 'written') return;
      // A patch changes a document that is already there, in a moment; a
      // "generating" skeleton over it would only flash. `written` still
      // reloads it.
      if (isDocumentPatchTool(activity.toolName)) return;
      if (activity.phase === 'start') documentWriteSeqRef.current += 1;

      if (activity.phase === 'error') {
        // Freeze the panel on the failure rather than dropping it: a skeleton
        // that silently disappears reads as "still thinking about it".
        setPendingArtifact((current) =>
          current ? { ...current, status: 'failed', error: activity.error } : null,
        );
        return;
      }

      if (activity.phase === 'progress') {
        // Counts only — the panel was opened by `start`. A progress update for
        // a write the panel has already let go of must not resurrect it.
        setPendingArtifact((current) =>
          current && current.status !== 'failed'
            ? {
                ...current,
                title: activity.titleHint ?? current.title,
                progress: activity.progress,
              }
            : current,
        );
        return;
      }

      const mode: PendingArtifact['mode'] = isDocumentCreateTool(activity.toolName)
        ? 'create'
        : 'edit';
      const kind = documentToolArtifactKind(activity.toolName);

      expandDocPanel();
      setPendingArtifact((current) => ({
        kind,
        toolName: activity.toolName,
        mode,
        title: activity.titleHint ?? current?.title,
        artifactId: activity.artifactId ?? current?.artifactId,
        // A retry after a failure re-enters the generating state.
        status: 'generating',
        // `start` begins a new write; `complete` keeps the last counts.
        progress: activity.phase === 'complete' ? current?.progress : undefined,
        startedAt: activity.phase === 'start' ? Date.now() : current?.startedAt,
        produced: activity.phase === 'complete',
      }));
    },
    [expandDocPanel],
  );

  const ensureConversation = useCallback(async () => {
    try {
      const conversationsList = await listConversations();
      if (conversationsList.length > 0) {
        setActiveConversationId(conversationsList[0].id);
      } else {
        const created = await createConversation();
        setActiveConversationId(created.id);
      }
    } catch {
      /* leave null; the chat view surfaces an empty thread */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // fetchBrandLogo() never rejects (see brand/logo.ts) — a missing or
        // not-yet-registered `get_brand_logo` command degrades to `null`
        // rather than failing this whole Promise.all, same as every other
        // brand-optional load here.
        const [loadedPaths, fetchedSettings, onboardingState, loadedBrand, loadedLogo] = await Promise.all([
          getAppPaths(),
          getSettings(),
          getOnboardingState(),
          getBrandConfig(),
          fetchBrandLogo(),
        ]);
        // ADR-011: the looks and palettes are gone. A single-mode theme (Amber
        // Terminal, Green Phosphor, Amber Paper) used to force its mode without
        // writing AppSettings.theme; carry that forced mode over once, so
        // nobody's app flips light or dark on upgrade, then drop the old keys.
        const forcedMode = migrateRetiredThemePrefs();
        const loadedSettings =
          forcedMode && fetchedSettings.theme !== forcedMode
            ? { ...fetchedSettings, theme: forcedMode }
            : fetchedSettings;
        if (loadedSettings !== fetchedSettings) void updateSettingsPersisted(loadedSettings);
        setPaths(loadedPaths);
        setSettings(loadedSettings);
        setSettingsLoaded(true);
        setOnboarding(onboardingState);
        applyUiPrefs();
        // Reconcile the pre-paint cache (main.tsx) against the authoritative
        // Rust read: apply whatever Rust says is current, or clear the DOM +
        // cache entirely if branding was turned off since the last launch —
        // otherwise a cleared brand would keep replaying from a stale cache
        // forever.
        if (loadedBrand) {
          applyBrand(loadedBrand, resolveTheme(loadedSettings.theme));
          setBrandLogo(loadedLogo);
        } else {
          clearBrand();
          // No active brand means no brand logo either, regardless of what
          // fetchBrandLogo() returned (it fetches independently of
          // getBrandConfig) — mirrors clearBrand()'s own reconciliation.
          setBrandLogo(null);
        }
        setBrandConfig(loadedBrand);
        void listProviderDescriptors()
          .then(setProviders)
          .catch(() => setProviders([]));

        const readyForWorkspace =
          onboardingState.onboardingCompleted &&
          onboardingState.hasProviderCredential &&
          !onboardingState.migrationRecovery;
        if (readyForWorkspace) {
          await ensureConversation();
          await refreshConversations();
          setBoundaryOk(true);
          setStatus(null);
        } else {
          setBoundaryOk(true);
          setStatus(null);
        }
      } catch (error) {
        setBoundaryOk(false);
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.loadDesktopStateFailed'), 'error'));
      }
    })();
  }, [ensureConversation, refreshConversations]);

  const refreshOnboarding = useCallback(async () => {
    try {
      const next = await getOnboardingState();
      setOnboarding(next);
      setSettings(await getSettings());
      if (next.onboardingCompleted && next.hasProviderCredential && !next.migrationRecovery) {
        await ensureConversation();
        await refreshConversations();
      }
    } catch {
      /* leave current state; the user can retry */
    }
  }, [ensureConversation, refreshConversations]);

  const handleNewChat = useCallback(async () => {
    try {
      const created = await createConversation();
      setActiveConversationId(created.id);
      clearWorkspaceArtifactSelection();
      await refreshConversations();
      setStatus(makeStatus(t('app.status.newChatStarted'), 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.createChatFailed'), 'error'));
    }
  }, [clearWorkspaceArtifactSelection, refreshConversations]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversationId(id);
      clearWorkspaceArtifactSelection();
      // Seed the row dot with the active provider only when unknown — the
      // map is a best-effort heuristic (decision: turn completion is truth).
      setConvoProviders((current) => {
        if (current[id]) return current;
        const next = { ...current, [id]: settings.activeProvider };
        writeConvoProviders(next);
        return next;
      });
    },
    [clearWorkspaceArtifactSelection, settings.activeProvider],
  );

  // ── Slides ────────────────────────────────────────────────────────────────
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const activeDeckRef = useRef(activeDeck);
  activeDeckRef.current = activeDeck;

  /** Open a deck from the Slides page: its chat, with the deck beside it. */
  // Studio: a deck open in the Slides destination. The one mounted ChatView
  // becomes the dock on the right; the chat list is hidden. Deck chats never
  // show in the Chats layout.
  const [studioDeckId, setStudioDeckId] = useState<string | null>(null);
  const [dockTab, setDockTab] = useState<DockTab>('ask');
  const [scriptFocus, setScriptFocus] = useState<ScriptFocusRequest | null>(null);
  const [scriptFindToken, setScriptFindToken] = useState(0);
  const [stageSlideRequest, setStageSlideRequest] = useState<{ index: number; nonce: number } | null>(null);
  const [madeFromChatDeckId, setMadeFromChatDeckId] = useState<string | null>(null);
  const studio = destination === 'slides' && studioDeckId != null && activeDeck?.id === studioDeckId;
  // Writing studio: a draft open in the Writing destination, laid out like the
  // Slides studio (the draft takes the window, the chat column is the dock).
  const [studioDraftId, setStudioDraftId] = useState<string | null>(null);
  const [draftDockTab, setDraftDockTab] = useState<DraftDockTab>('ask');
  const writingStudio = destination === 'writing' && studioDraftId != null && activeDraft?.id === studioDraftId;
  const anyStudio = studio || writingStudio;
  // In the outline stage the outline is the studio's main view, not a dock tab.
  const draftDockTabShown: DraftDockTab =
    activeDraft?.stage === 'outline' && draftDockTab === 'outline' ? 'ask' : draftDockTab;
  // Present: a full-screen overlay (a portal) over the studio; the studio and
  // the one mounted chat stay exactly where they are underneath.
  const [presentStart, setPresentStart] = useState<number | null>(null);
  const stageIndexRef = useRef(0);
  const exportingDeckRef = useRef(false);
  const startPresenting = useCallback((startIndex: number) => {
    if ((activeDeckRef.current?.slides.length ?? 0) === 0) return;
    setPresentStart(startIndex);
  }, []);
  const presenting = studio && presentStart != null && (activeDeck?.slides.length ?? 0) > 0;
  useEffect(() => {
    if (presentStart != null && !studio) setPresentStart(null);
  }, [presentStart, studio]);
  // F5 presents from the first slide, Shift+F5 from the stage's slide.
  useEffect(() => {
    if (!studio || presentStart != null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F5' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      startPresenting(e.shiftKey ? stageIndexRef.current : 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [studio, presentStart, startPresenting]);
  /** The last ordinary (non-deck) chat, to return to when leaving a deck. */
  const lastChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeConversationId && !deckLoading && !activeDeck && !draftLoading && !activeDraft) {
      lastChatIdRef.current = activeConversationId;
    }
  }, [activeConversationId, activeDeck, deckLoading, activeDraft, draftLoading]);
  // A deck chat reached any other way (search, palette, a fresh start) opens
  // in the studio, never in the Chats layout.
  useEffect(() => {
    if (activeDeck && destination === 'chats') {
      setStudioDeckId(activeDeck.id);
      setDestination('slides');
    }
  }, [activeDeck, destination]);
  // The same for a draft chat: it opens in the Writing studio.
  useEffect(() => {
    if (activeDraft && destination === 'chats') {
      setStudioDraftId(activeDraft.id);
      setDestination('writing');
    }
  }, [activeDraft, destination]);
  useEffect(() => {
    setDraftDockTab('ask');
  }, [studioDraftId]);
  useEffect(() => {
    setDockTab('ask');
    setScriptFocus(null);
  }, [studioDeckId]);

  /** Leave a deck for an ordinary chat (the last one, or a new one). */
  const leaveDeckChat = useCallback(() => {
    setActiveDeck(null);
    setStudioDeckId(null);
    setActiveDraft(null);
    setStudioDraftId(null);
    const back = lastChatIdRef.current;
    if (back && conversations.some((c) => c.id === back)) handleSelectConversation(back);
    else void handleNewChat();
  }, [conversations, handleSelectConversation, handleNewChat]);

  /** Open a deck from the Slides page: the studio, with its chat as the dock. */
  const handleOpenDeck = useCallback(
    async (deckId: string) => {
      try {
        const deck = await openDeck(deckId);
        setActiveDraft(null);
        setStudioDraftId(null);
        setActiveDeck(deck);
        setStudioDeckId(deck.id);
        if (deck.conversationId) handleSelectConversation(deck.conversationId);
        setDestination('slides');
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [handleSelectConversation],
  );

  /** The Slides page start box: a new deck whose first message is the prompt. */
  const handleStartDeck = useCallback(
    async (prompt: string, themeName: string, themeCss: string) => {
      const deck = await createDeck(t('slides.new.defaultTitle'), themeName, themeCss);
      await handleOpenDeck(deck.id);
      void refreshConversations();
      setPendingSendText(prompt);
    },
    [handleOpenDeck, refreshConversations, t],
  );

  // A deck started from an ordinary chat (the model called start_deck): when
  // that turn ends, the chat opens as a studio and the model is asked for the
  // storyline, now with the deck tools.
  const startedDeckThisTurnRef = useRef(false);
  const openDeckStartedInChat = useCallback(async () => {
    const conversationId = activeConversationId;
    if (!conversationId) return;
    try {
      const deck = await getDeckForConversation(conversationId);
      if (!deck) return;
      setActiveDeck(deck);
      setMadeFromChatDeckId(deck.id);
      setStudioDeckId(deck.id);
      setDestination('slides');
      void refreshConversations();
      setPendingSendText(appPrompt(t('slides.note.madeDeck'), t('slides.prompt.storylineFromChat')));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [activeConversationId, refreshConversations, t]);

  const handleUndoStartDeck = useCallback(async () => {
    const deck = activeDeckRef.current;
    if (!deck) return;
    try {
      await undoStartDeck(deck.id);
      setMadeFromChatDeckId(null);
      setActiveDeck(null);
      setStudioDeckId(null);
      setDestination('chats');
      void refreshConversations();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [refreshConversations]);

  // A deck made by start_deck has no theme CSS yet (the starter themes live
  // here, not in Rust): give it the default starter on first sight.
  useEffect(() => {
    if (!activeDeck || activeDeck.themeCss !== '') return;
    const fallback = STARTER_THEMES.find((theme) => theme.name === activeDeck.themeName) ?? STARTER_THEMES[0];
    void setDeckTheme(activeDeck.id, fallback.name, fallback.css).then(setActiveDeck, () => {});
  }, [activeDeck]);

  const reloadActiveDeck = useCallback(async () => {
    const conversationId = activeDeckRef.current?.conversationId;
    if (!conversationId) return;
    try {
      const deck = await getDeckForConversation(conversationId);
      if (activeDeckRef.current?.conversationId === conversationId) setActiveDeck(deck ?? null);
    } catch {
      // The next tool call or turn end reloads it again.
    }
  }, []);

  const handleDeckChanged = useCallback(() => {
    deckChangedThisTurnRef.current = true;
    setDeckBusyTool(null);
    void reloadActiveDeck();
  }, [reloadActiveDeck]);

  /** One history entry per AI turn that changed the deck, named by the prompt. */
  const finishDeckTurn = useCallback(async () => {
    setDeckBusyTool(null);
    if (startedDeckThisTurnRef.current) {
      startedDeckThisTurnRef.current = false;
      deckChangedThisTurnRef.current = false;
      await openDeckStartedInChat();
      return;
    }
    const deck = activeDeckRef.current;
    const appLabel = nextDeckTurnLabelRef.current;
    nextDeckTurnLabelRef.current = null;
    if (!deck || !deckChangedThisTurnRef.current) return;
    deckChangedThisTurnRef.current = false;
    const lastPrompt = [...transcriptRef.current.turns].reverse().find((turn) => turn.role === 'user');
    const content = lastPrompt?.content ?? '';
    const text = (appPromptLabel(content) ?? content).replace(/\s+/g, ' ').trim();
    const label =
      appLabel ?? (text.length > 80 ? `${text.slice(0, 79)}…` : text || t('slides.history.aiTurn'));
    try {
      await snapshotDeck(deck.id, 'ai-turn', label);
      setDeckHistoryRevision((n) => n + 1);
    } catch {
      // History is best effort; the deck itself is already saved.
    }
    await reloadActiveDeck();
  }, [reloadActiveDeck, openDeckStartedInChat, t]);

  // Export: the documents are built here, Rust asks for the path and writes
  // the file. Nothing happens on cancel.
  const { locale: exportLocale } = useLocale();
  const [exportingDeck, setExportingDeck] = useState(false);
  const handleExportDeck = useCallback(
    async (kind: 'html' | 'pdf') => {
      const deck = activeDeckRef.current;
      if (!deck || deck.slides.length === 0 || exportingDeckRef.current) return;
      exportingDeckRef.current = true;
      setExportingDeck(true);
      try {
        const saved =
          kind === 'html'
            ? await exportDeckHtml(
                deck.id,
                buildDeckHtmlExport(deck, { lang: exportLocale, generator: appName() }),
                t('slides.export.htmlDialogTitle'),
                // Format names are not translated (D7).
                'HTML',
              )
            : await exportDeckPdf(deck.id, buildDeckPrintHtml(deck), t('slides.export.pdfDialogTitle'), 'PDF');
        if (saved === null) return;
        const name = saved.split(/[\\/]/).pop() ?? saved;
        setStatus(makeStatus(t('slides.export.saved', { name }), 'success'));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStatus(makeStatus(t('slides.export.failed', { reason }), 'error'));
      } finally {
        exportingDeckRef.current = false;
        setExportingDeck(false);
      }
    },
    [exportLocale, t],
  );

  const handleRenameDeck = useCallback(
    async (title: string) => {
      const deck = activeDeckRef.current;
      if (!deck) return;
      try {
        await renameDeck(deck.id, title);
        setActiveDeck({ ...deck, title });
        void refreshConversations();
        if (activeConversationId) void refreshActiveConversationSummary(activeConversationId);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshConversations, refreshActiveConversationSummary, activeConversationId],
  );

  const handleSetDeckTheme = useCallback(
    async (name: string, css: string) => {
      const deck = activeDeckRef.current;
      if (!deck) return;
      try {
        setActiveDeck(await setDeckTheme(deck.id, name, css));
        const label = STARTER_THEMES.find((theme) => theme.name === name)?.label ?? name;
        void listSlideThemes().then(setSavedSlideThemes, () => {});
        await snapshotDeck(deck.id, 'manual', t('slides.history.themeChanged', { name: label }));
        setDeckHistoryRevision((n) => n + 1);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [t],
  );

  const handleSetDeckStoryline = useCallback(async (items: StorylineItem[]) => {
    const deck = activeDeckRef.current;
    if (!deck) return;
    try {
      setActiveDeck(await setDeckStoryline(deck.id, items));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleBuildDeck = useCallback(async () => {
    const deck = activeDeckRef.current;
    if (!deck) return;
    try {
      setActiveDeck(await setDeckStage(deck.id, 'slides'));
      nextDeckTurnLabelRef.current = t('slides.history.built');
      setPendingSendText(appPrompt(t('slides.note.build'), t('slides.prompt.build')));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  const handleRestoreDeck = useCallback(async (snapshotId: string) => {
    const deck = activeDeckRef.current;
    if (!deck) return;
    try {
      setActiveDeck(await restoreDeckSnapshot(deck.id, snapshotId));
      setDeckHistoryRevision((n) => n + 1);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Words: the user's own edits. One history entry per burst of typing on a
  // slide, a few seconds after it stops.
  const wordsSnapshotTimersRef = useRef<Record<string, number>>({});
  const scheduleWordsSnapshot = useCallback(
    (deckId: string, slideId: string, position: number) => {
      const timers = wordsSnapshotTimersRef.current;
      window.clearTimeout(timers[slideId]);
      timers[slideId] = window.setTimeout(() => {
        delete timers[slideId];
        void snapshotDeck(deckId, 'manual', t('slides.history.editedWords', { n: position + 1 }))
          .then(() => setDeckHistoryRevision((n) => n + 1))
          .catch(() => {});
      }, 4000);
    },
    [t],
  );

  const handleEditWords = useCallback(
    async (slideId: string, edits: SlotEdit[], notes?: string) => {
      const deck = activeDeckRef.current;
      if (!deck) return;
      try {
        const next = await editSlideWords(deck.id, slideId, edits, notes);
        setActiveDeck(next);
        const position = next.slides.find((s) => s.id === slideId)?.position ?? 0;
        scheduleWordsSnapshot(deck.id, slideId, position);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [scheduleWordsSnapshot],
  );

  const handleSetPinned = useCallback(
    async (slideId: string, index: number, name: string, pinned: boolean) => {
      const deck = activeDeckRef.current;
      if (!deck) return;
      try {
        setActiveDeck(await setSlotPinned(deck.id, slideId, index, name, pinned));
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  /** Script view: Enter at the end of a bullet adds the next bullet. */
  const handleInsertBullet = useCallback(
    async (slideId: string, index: number, name: string): Promise<string | null> => {
      const deck = activeDeckRef.current;
      if (!deck) return null;
      try {
        const next = await insertBullet(deck.id, slideId, index, name);
        setActiveDeck(next);
        const slide = next.slides.find((s) => s.id === slideId);
        const added = slide?.slots[index + 1];
        if (slide) scheduleWordsSnapshot(deck.id, slideId, slide.position);
        return added?.name ?? null;
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [scheduleWordsSnapshot],
  );

  const handleRemoveBullet = useCallback(
    async (slideId: string, index: number, name: string) => {
      const deck = activeDeckRef.current;
      if (!deck) return;
      try {
        const next = await removeBullet(deck.id, slideId, index, name);
        setActiveDeck(next);
        const position = next.slides.find((s) => s.id === slideId)?.position ?? 0;
        scheduleWordsSnapshot(deck.id, slideId, position);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [scheduleWordsSnapshot],
  );

  const handleReplaceInDeck = useCallback(
    async (find: string, replace: string, matchCase: boolean, wholeWord: boolean, apply: boolean) => {
      const deck = activeDeckRef.current;
      if (!deck) return { total: 0, applied: false, slides: [] };
      const result = await replaceInDeck(deck.id, find, replace, matchCase, wholeWord, apply);
      if (apply && result.total > 0) {
        await reloadActiveDeck();
        try {
          await snapshotDeck(deck.id, 'manual', t('slides.history.replaced', { find, replace }));
          setDeckHistoryRevision((n) => n + 1);
        } catch {
          // History is best effort.
        }
      }
      return result;
    },
    [reloadActiveDeck, t],
  );

  const [deckOverflow, setDeckOverflow] = useState<Record<string, number>>({});
  useEffect(() => setDeckOverflow({}), [activeDeckId]);

  const handleListDeckSnapshots = useCallback(async () => {
    const deck = activeDeckRef.current;
    return deck ? listDeckSnapshots(deck.id) : [];
  }, []);

  // ── Writing ───────────────────────────────────────────────────────────────
  const activeDraftRef = useRef(activeDraft);
  activeDraftRef.current = activeDraft;
  // A turn is running in the draft's chat: the editor is read-only.
  const draftStreaming = activeDraft != null && runStatus?.conversationId === activeDraft.conversationId;

  /** Open a draft: the Writing studio, with its chat as the dock. */
  const handleOpenDraft = useCallback(
    async (draftId: string) => {
      try {
        const draft = await getDraft(draftId);
        setActiveDeck(null);
        setStudioDeckId(null);
        setActiveDraft(draft);
        setStudioDraftId(draft.id);
        handleSelectConversation(draft.conversationId);
        setDestination('writing');
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [handleSelectConversation, setStatusMessage],
  );

  /**
   * The Writing start box (and Home's Write chip, and a Research card's
   * "Write from this report"): a new draft whose first message is the brief.
   * `researchRunIds` attaches finished Research reports before it starts.
   */
  const handleStartDraft = useCallback(
    async (brief: string, options?: { researchRunIds?: string[] }) => {
      const draft = await createDraft(brief);
      const runIds = options?.researchRunIds ?? [];
      if (runIds.length > 0) {
        try {
          await setDraftSources(draft.id, { ...draftSourcesOf(draft), researchRunIds: runIds });
        } catch (error) {
          // The draft still starts; the report can be attached from Sources.
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      }
      await handleOpenDraft(draft.id);
      void refreshConversations();
      setPendingSendText(brief);
    },
    [handleOpenDraft, refreshConversations, setStatusMessage],
  );

  /** A finished Research card's "Write from this report". */
  const handleWriteFromReport = useCallback(
    (runId: string, question: string) => {
      void handleStartDraft(t('writing.fromReport.brief', { question: question.trim() }), {
        researchRunIds: [runId],
      }).catch((error) => setStatusMessage(error instanceof Error ? error.message : String(error)));
    },
    [handleStartDraft, setStatusMessage, t],
  );

  /** The Writing list (not a draft left open in the studio). */
  const openWritingList = useCallback(() => {
    setStudioDraftId(null);
    setDestination('writing');
  }, []);

  const reloadActiveDraft = useCallback(async () => {
    const id = activeDraftRef.current?.id;
    if (!id) return;
    try {
      const draft = await getDraft(id);
      if (activeDraftRef.current?.id === id) setActiveDraft(draft);
    } catch {
      // The next tool call or turn end reloads it again.
    }
  }, []);

  // Sections the assistant is still writing, previewed in the editor. When a
  // call has run, its preview stays until the re-read draft has the section,
  // so the text never blinks out between the two.
  const [draftPreviews, setDraftPreviews] = useState<SectionPreview[]>([]);
  const latestDraftPreviewsRef = useRef<SectionPreview[]>([]);
  const draftReloadRef = useRef<Promise<void> | null>(null);
  const handleDraftPreview = useCallback((previews: SectionPreview[]) => {
    latestDraftPreviewsRef.current = previews;
    const reloading = draftReloadRef.current;
    if (reloading) {
      void reloading.then(() => setDraftPreviews(latestDraftPreviewsRef.current));
      return;
    }
    setDraftPreviews(previews);
  }, []);

  /** A draft tool changed the draft mid-turn: the editor fills in live. */
  const handleDraftChanged = useCallback(() => {
    draftChangedThisTurnRef.current = true;
    setDraftBusyTool(null);
    const reloading: Promise<void> = reloadActiveDraft().finally(() => {
      if (draftReloadRef.current === reloading) draftReloadRef.current = null;
    });
    draftReloadRef.current = reloading;
  }, [reloadActiveDraft]);

  const draftPreview = useMemo(
    () =>
      activeDraft && activeDraft.stage === 'draft' && draftPreviews.length > 0
        ? buildDraftPreview(activeDraft.markdown, activeDraft.outline, draftPreviews)
        : null,
    [activeDraft, draftPreviews],
  );

  // -- The draft's Sources tab --
  const [sourceCollections, setSourceCollections] = useState<KnowledgeCollection[] | null>(null);
  const [draftCollectionIds, setDraftCollectionIds] = useState<string[]>([]);
  const [researchReports, setResearchReports] = useState<ResearchReportSummary[] | null>(null);
  const [sourcesSaving, setSourcesSaving] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  // Bumps when the Sources tab changed the draft chat's collections.
  const [draftSourcesRevision, setDraftSourcesRevision] = useState(0);
  const studioDraftConversationId = writingStudio ? (activeDraft?.conversationId ?? null) : null;
  const sourcesTabShown = draftDockTabShown === 'sources';

  useEffect(() => {
    setSourceCollections(null);
    setResearchReports(null);
    setDraftCollectionIds([]);
    setSourcesError(null);
  }, [studioDraftConversationId]);

  // Read the lists when a draft opens and each time the tab is shown: a
  // collection or a finished report may have appeared since.
  useEffect(() => {
    if (!studioDraftConversationId) return undefined;
    let cancelled = false;
    void Promise.all([
      listKnowledgeCollections().catch(() => [] as KnowledgeCollection[]),
      listConversationCollections(studioDraftConversationId).catch(() => [] as string[]),
      listResearchReports().catch(() => [] as ResearchReportSummary[]),
    ]).then(([collections, enabled, reports]) => {
      if (cancelled) return;
      setSourceCollections(collections ?? []);
      setDraftCollectionIds(enabled ?? []);
      setResearchReports(reports ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [studioDraftConversationId, sourcesTabShown]);

  const handleToggleDraftWeb = useCallback(async (on: boolean) => {
    const draft = activeDraftRef.current;
    if (!draft) return;
    setSourcesSaving(true);
    setSourcesError(null);
    try {
      setActiveDraft(await setDraftSources(draft.id, { ...draftSourcesOf(draft), webSearch: on }));
    } catch (error) {
      setSourcesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSourcesSaving(false);
    }
  }, []);

  const handleToggleDraftReport = useCallback(async (runId: string, on: boolean) => {
    const draft = activeDraftRef.current;
    if (!draft) return;
    const current = draftSourcesOf(draft);
    const ids = on
      ? [...new Set([...current.researchRunIds, runId])]
      : current.researchRunIds.filter((id) => id !== runId);
    setSourcesSaving(true);
    setSourcesError(null);
    try {
      setActiveDraft(await setDraftSources(draft.id, { ...current, researchRunIds: ids }));
    } catch (error) {
      setSourcesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSourcesSaving(false);
    }
  }, []);

  const handleToggleDraftCollection = useCallback(
    async (collectionId: string, on: boolean) => {
      const conversationId = activeDraftRef.current?.conversationId;
      if (!conversationId) return;
      const previous = draftCollectionIds;
      const next = on
        ? [...new Set([...previous, collectionId])]
        : previous.filter((id) => id !== collectionId);
      setDraftCollectionIds(next);
      setSourcesSaving(true);
      setSourcesError(null);
      try {
        // The set actually stored, so the tab never shows one that is not attached.
        setDraftCollectionIds(await setConversationCollections(conversationId, next));
        setDraftSourcesRevision((n) => n + 1);
      } catch (error) {
        setDraftCollectionIds(previous);
        setSourcesError(error instanceof Error ? error.message : String(error));
      } finally {
        setSourcesSaving(false);
      }
    },
    [draftCollectionIds],
  );

  const draftWebReasonId = draftWebSearchUnavailableReasonId(settings);

  // "Edited by you": one history entry per editing session, after the typing
  // pauses for a while, when the assistant is about to take a turn, or when
  // the studio is left.
  const editedDraftIdRef = useRef<string | null>(null);
  const editedTimerRef = useRef<number | null>(null);
  const lastDraftSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  const flushEditedSnapshot = useCallback(async () => {
    if (editedTimerRef.current != null) {
      window.clearTimeout(editedTimerRef.current);
      editedTimerRef.current = null;
    }
    // Let a save that is still out land first, so the version includes it.
    await lastDraftSaveRef.current.catch(() => undefined);
    const draftId = editedDraftIdRef.current;
    if (!draftId) return;
    editedDraftIdRef.current = null;
    try {
      await snapshotDraft(draftId, 'manual', t('writing.history.editedByYou'));
      setDraftHistoryRevision((n) => n + 1);
    } catch {
      // History is best effort; the draft itself is already saved.
    }
  }, [t]);
  useEffect(() => {
    if (draftStreaming) void flushEditedSnapshot();
  }, [draftStreaming, flushEditedSnapshot]);
  useEffect(() => {
    if (!writingStudio) void flushEditedSnapshot();
  }, [writingStudio, studioDraftId, flushEditedSnapshot]);

  const handleSaveDraft = useCallback(
    async (markdown: string): Promise<DraftDetail | null> => {
      const draft = activeDraftRef.current;
      if (!draft) return null;
      const saving = saveDraftMarkdown(draft.id, markdown);
      lastDraftSaveRef.current = saving;
      const next = await saving;
      setActiveDraft((current) => (current?.id === next.id ? next : current));
      editedDraftIdRef.current = next.id;
      if (editedTimerRef.current != null) window.clearTimeout(editedTimerRef.current);
      editedTimerRef.current = window.setTimeout(() => void flushEditedSnapshot(), DRAFT_EDIT_SESSION_IDLE_MS);
      return next;
    },
    [flushEditedSnapshot],
  );

  /** One history entry per AI turn that changed the draft, named by the prompt. */
  const finishDraftTurn = useCallback(async () => {
    setDraftBusyTool(null);
    latestDraftPreviewsRef.current = [];
    setDraftPreviews([]);
    const draft = activeDraftRef.current;
    const appLabel = nextDraftTurnLabelRef.current;
    nextDraftTurnLabelRef.current = null;
    if (!draft || !draftChangedThisTurnRef.current) return;
    draftChangedThisTurnRef.current = false;
    await reloadActiveDraft();
    const lastPrompt = [...transcriptRef.current.turns].reverse().find((turn) => turn.role === 'user');
    const content = lastPrompt?.content ?? '';
    const text = (appPromptLabel(content) ?? content).replace(/\s+/g, ' ').trim();
    const label =
      appLabel ?? (text.length > 80 ? `${text.slice(0, 79)}…` : text || t('writing.history.aiTurn'));
    try {
      await snapshotDraft(draft.id, 'ai-turn', label);
      setDraftHistoryRevision((n) => n + 1);
    } catch {
      // History is best effort.
    }
  }, [reloadActiveDraft, t]);

  const handleRenameDraft = useCallback(
    async (title: string) => {
      const draft = activeDraftRef.current;
      if (!draft) return;
      try {
        setActiveDraft(await renameDraft(draft.id, title));
        void refreshConversations();
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshConversations, setStatusMessage],
  );

  const handleSetDraftOutline = useCallback(
    async (outline: OutlineSection[]) => {
      const draft = activeDraftRef.current;
      if (!draft) return;
      try {
        setActiveDraft(await setDraftOutline(draft.id, outline));
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [setStatusMessage],
  );

  /** Approve outline: the draft stage starts and the assistant is asked to write it. */
  const handleApproveOutline = useCallback(async () => {
    const draft = activeDraftRef.current;
    if (!draft) return;
    try {
      setActiveDraft(await setDraftStage(draft.id, 'draft'));
      nextDraftTurnLabelRef.current = t('writing.history.written');
      setDraftDockTab('ask');
      setPendingSendText(appPrompt(t('writing.note.approve'), t('writing.prompt.writeDraft')));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [setStatusMessage, t]);

  /** "Let AI edit" on a pinned block. */
  const handleUnpinBlock = useCallback(
    async (blockId: string) => {
      const draft = activeDraftRef.current;
      if (!draft) return;
      try {
        setActiveDraft(await setBlockPinned(draft.id, blockId, false));
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [setStatusMessage],
  );

  /** A selection-toolbar action: one chat message naming the blocks. */
  const handleDraftSelection = useCallback(
    (request: SelectionRequest) => {
      setDraftDockTab('ask');
      setPendingSendText(selectionMessage(t, request));
    },
    [t],
  );

  const handleListDraftSnapshots = useCallback(async () => {
    const draft = activeDraftRef.current;
    return draft ? listDraftSnapshots(draft.id) : [];
  }, []);

  const handleRestoreDraft = useCallback(
    async (snapshotId: string) => {
      const draft = activeDraftRef.current;
      if (!draft) return;
      try {
        // Keep what was typed since the last version before replacing it.
        await flushEditedSnapshot();
        setActiveDraft(await restoreDraftSnapshot(draft.id, snapshotId));
        setDraftResetToken((n) => n + 1);
        setDraftHistoryRevision((n) => n + 1);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [flushEditedSnapshot, setStatusMessage],
  );

  const [exportingDraft, setExportingDraft] = useState(false);
  const handleExportDraft = useCallback(
    async (format: DraftExportFormat) => {
      const draft = activeDraftRef.current;
      if (!draft) return;
      setExportingDraft(true);
      try {
        const path = await exportDraft(draft.id, format);
        if (path) {
          const name = path.split(/[\\/]/).pop() ?? path;
          setStatus(makeStatus(t('writing.export.saved', { name }), 'success'));
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setStatus(makeStatus(t('writing.export.failed', { reason }), 'error'));
      } finally {
        setExportingDraft(false);
      }
    },
    [t],
  );

  const handleSelectSearchResult = useCallback(
    (result: SearchResult) => {
      setActiveConversationId(result.conversationId);
      clearWorkspaceArtifactSelection();
      // ChatView loads messages on conversationId change; scroll after render
      setTimeout(() => {
        chatViewRef.current?.scrollToMessage(result.messageId);
      }, 200);
    },
    [clearWorkspaceArtifactSelection],
  );

  const handleDeleteConversation = useCallback((id: string) => {
    setConfirmDeleteId(id);
  }, []);

  const handleForkConversation = useCallback(
    async (conversationId: string, forkMessageId: string) => {
      try {
        const fork = await forkConversation(conversationId, forkMessageId);
        setActiveConversationId(fork.id);
        clearWorkspaceArtifactSelection();
        await refreshConversations();
        setStatus(makeStatus(t('app.status.conversationForked'), 'success'));
      } catch (error) {
        setStatus(
          makeStatus(error instanceof Error ? error.message : t('app.status.forkConversationFailed'), 'error'),
        );
      }
    },
    [clearWorkspaceArtifactSelection, refreshConversations],
  );

  const handleEditForked = useCallback(
    (fork: { id: string }, pendingText: string) => {
      setPendingSendText(pendingText);
      setActiveConversationId(fork.id);
      clearWorkspaceArtifactSelection();
      void refreshConversations();
    },
    [clearWorkspaceArtifactSelection, refreshConversations],
  );

  const performDeleteConversation = useCallback(
    async (id: string) => {
      const wasActive = activeConversationId === id;
      try {
        await deleteConversation(id);
        setConvoProviders((current) => {
          const { [id]: _removed, ...rest } = current;
          writeConvoProviders(rest);
          return rest;
        });
        if (wasActive) {
          const remaining = await listConversations();
          const next = remaining.find((row) => !row.archivedAt) ?? remaining[0];
          if (next) {
            setActiveConversationId(next.id);
          } else {
            const created = await createConversation();
            setActiveConversationId(created.id);
          }
          clearWorkspaceArtifactSelection();
        }
        await refreshConversations();
        setStatus(makeStatus(t('app.status.conversationDeleted'), 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.deleteConversationFailed'), 'error'));
      }
    },
    [activeConversationId, clearWorkspaceArtifactSelection, refreshConversations],
  );

  const handleDeleteAllHistory = useCallback(() => {
    setConfirmDeleteAll(true);
  }, []);

  const performDeleteAllHistory = useCallback(async () => {
    try {
      const created = await deleteAllConversations();
      setActiveConversationId(created.id);
      clearWorkspaceArtifactSelection();
      setConvoProviders({});
      writeConvoProviders({});
      await refreshConversations();
      setStatus(makeStatus(t('app.status.allHistoryDeleted'), 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.deleteHistoryFailed'), 'error'));
    }
  }, [clearWorkspaceArtifactSelection, refreshConversations]);

  const refreshArtifacts = useCallback(async (conversationId: string): Promise<Artifact[]> => {
    try {
      const { artifacts: listed, fileStateMap: nextMap } = await refreshArtifactList(conversationId);
      setArtifacts(listed);
      setArtifactsConversationId(conversationId);
      setFileStateMap(nextMap);
      return listed;
    } catch (error) {
      setArtifacts([]);
      setArtifactsConversationId(conversationId);
      setFileStateMap({});
      setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.loadArtifactsFailed'), 'error'));
      return [];
    }
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    void refreshArtifacts(activeConversationId);
  }, [activeConversationId, refreshArtifacts]);

  // Dev-only (`?route=artifacts`, see devRoute.ts): put sample artifacts in the
  // panel, which dev:web otherwise cannot fill. `devRoute` is null in every
  // production build, and the fixtures are only imported behind that check.
  useEffect(() => {
    if (devRoute !== 'artifacts') return;
    let cancelled = false;
    void import('./dev/artifactFixtures').then(({ FIXTURE_ARTIFACTS }) => {
      if (cancelled) return;
      setArtifacts(FIXTURE_ARTIFACTS);
      setOpenArtifactIds(FIXTURE_ARTIFACTS.map((artifact) => artifact.id));
      setActiveArtifact(FIXTURE_ARTIFACTS[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [devRoute]);

  const addOpenArtifactId = useCallback((artifactId: string) => {
    setOpenArtifactIds((current) => (current.includes(artifactId) ? current : [...current, artifactId]));
  }, []);

  const handleOpenArtifact = useCallback(
    async (artifactId: string) => {
      try {
        // `?route=artifacts` (dev only) has no backend to fetch from; its
        // fixtures are already in memory.
        const fixture = devRoute === 'artifacts' ? artifacts.find((a) => a.id === artifactId) : undefined;
        const got = fixture ?? (await getArtifact(artifactId));
        if (!got) return;
        showDocPanel();
        addOpenArtifactId(artifactId);
        setActiveArtifact(got);
        if (fixture) {
          setDocTab('preview');
          return;
        }
        const state = await checkArtifactFileState(artifactId);
        setFileStateMap((current) => ({ ...current, [artifactId]: state }));
        setDocTab('preview');
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.openArtifactFailed'), 'error'));
      }
    },
    [addOpenArtifactId, showDocPanel, devRoute, artifacts],
  );

  /// A document a workflow saved, to open once its conversation is showing.
  /// Switching conversations clears the document panel and reloads the
  /// artifact list, so the open waits until that list has arrived.
  const pendingWorkflowDocRef = useRef<{ conversationId: string; artifactId: string } | null>(null);
  // Scheduled workflow runs: a notification in the user's language, and a
  // refresh of the Workflows page if it is open.
  const [workflowRunsVersion, setWorkflowRunsVersion] = useState(0);
  // A run waiting on the user (a review or an "Ask me" step) puts a dot on
  // the rail's Workflows button until the page is opened.
  const [workflowsNeedYou, setWorkflowsNeedYou] = useState(false);
  useEffect(() => {
    if (destination === 'workflows') setWorkflowsNeedYou(false);
  }, [destination]);
  useWorkflowRunEvents((event) => {
    setWorkflowRunsVersion((v) => v + 1);
    const note = notificationFor(event, t);
    if (note) void notifyWorkflowRun(note.title, note.body).catch(() => {});
  });
  // A scheduled run paused to ask: say so, and show it on the Workflows page.
  useWorkflowReviewEvents((review) => {
    setWorkflowRunsVersion((v) => v + 1);
    setWorkflowsNeedYou(true);
    const note = notificationForReview(review, t);
    void notifyWorkflowRun(note.title, note.body).catch(() => {});
  });
  // A run stopped at an "Ask me" step: show it, and say so if nobody is looking.
  useWorkflowQuestionEvents((question) => {
    setWorkflowRunsVersion((v) => v + 1);
    setWorkflowsNeedYou(true);
    if (document.hasFocus()) return;
    const note = notificationForQuestion(question, t);
    void notifyWorkflowRun(note.title, note.body).catch(() => {});
  });
  useTrayLabels(t);

  const openWorkflowDocument = useCallback(
    (conversationId: string, artifactId: string) => {
      setDestination('chats');
      if (conversationId === activeConversationId && artifactsConversationId === conversationId) {
        void handleOpenArtifact(artifactId);
        return;
      }
      pendingWorkflowDocRef.current = { conversationId, artifactId };
      handleSelectConversation(conversationId);
    },
    [activeConversationId, artifactsConversationId, handleOpenArtifact, handleSelectConversation],
  );
  useEffect(() => {
    const pending = pendingWorkflowDocRef.current;
    if (!pending || pending.conversationId !== activeConversationId) return;
    if (artifactsConversationId !== activeConversationId) return;
    pendingWorkflowDocRef.current = null;
    void handleOpenArtifact(pending.artifactId);
  }, [activeConversationId, artifactsConversationId, handleOpenArtifact]);

  const handleChatTurnComplete = useCallback(
    async (streamState: AssistantStreamState) => {
      if (!activeConversationId) return;
      void refreshActiveConversationSummary(activeConversationId);
      void refreshConversations();
      // Record the provider that produced the last turn (sidebar row dot).
      setConvoProviders((current) => {
        const next = { ...current, [activeConversationId]: settings.activeProvider };
        writeConvoProviders(next);
        return next;
      });

      // Re-read the artifacts before the document-specific branch below. Any
      // tool can create one -- `generate_image` does -- and the thread renders
      // from this list, so gating the refresh on document tools left a
      // generated image invisible until the app was restarted.
      const listed = await refreshArtifacts(activeConversationId);

      // This handler now runs for every ended turn, failures included, because
      // it owns the only reset of the pending-artifact state. Nothing below may
      // leave the panel generating.
      if (!hadSuccessfulDocumentToolCalls(streamState)) {
        // Before the pending state below is resolved: a panel frozen on why a
        // requested document failed is not idle.
        const idle = docPanelIdleRef.current;
        // The document was asked for and never arrived — freeze the panel on
        // the reason, or drop it when there is nothing to explain. Only the
        // panel is document-specific; the list above is not.
        setPendingArtifact((current) => resolveFailedPendingArtifact(current, streamState));

        // A document written in a fence used to wait on the card's Open
        // button. Open it now — but only into an idle panel, never over a
        // document the reader has in front of them.
        const fence = finishedDocumentFence(streamState);
        if (fence && idle) {
          try {
            const sourceMessageId = await resolveSourceMessageId(
              `${ASSISTANT_TURN_PREFIX}${streamState.requestId}`,
            );
            const existing = findPromotedArtifact(listed, sourceMessageId, fence);
            if (existing) {
              await handleOpenArtifact(existing.id);
            } else {
              const created = await createArtifact(activeConversationId, fence.kind, fence.title, sourceMessageId);
              await setArtifactContent(created.id, { kind: 'text', text: fence.body }, fence.mimeType);
              await refreshArtifacts(activeConversationId);
              await handleOpenArtifact(created.id);
            }
          } catch (error) {
            setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.promoteArtifactFailed'), 'error'));
          }
        }
        return;
      }

      const artifactId = resolveDocumentArtifactId(streamState, listed);
      if (artifactId) {
        await handleOpenArtifact(artifactId);
      }
      setPendingArtifact(null);
      setStatus(makeStatus(t('app.status.documentUpdated'), 'success'));
    },
    [
      activeConversationId,
      settings.activeProvider,
      refreshArtifacts,
      refreshConversations,
      refreshActiveConversationSummary,
      handleOpenArtifact,
    ],
  );

  /** Show a document the moment its tool saved it. The turn can run on for a
   *  while after that — the model summarising what it wrote — and the panel
   *  used to hold the skeleton over an already-saved document until it
   *  ended. `handleChatTurnComplete` still runs afterwards and is idempotent. */
  const handleDocumentWritten = useCallback(
    async (activity: DocumentToolActivity) => {
      if (!activeConversationId) return;
      const seq = documentWriteSeqRef.current;
      try {
        const listed = await refreshArtifacts(activeConversationId);
        // A newer write started meanwhile; its own lifecycle owns the panel.
        if (documentWriteSeqRef.current !== seq) return;
        const artifactId =
          activity.artifactId ??
          (isDocumentCreateTool(activity.toolName) ? listed[0]?.id : undefined);
        if (!artifactId) return;
        await handleOpenArtifact(artifactId);
        if (documentWriteSeqRef.current !== seq) return;
        setPendingArtifact(null);
      } catch {
        // Leave the pending state to the end-of-turn handler, which reports
        // failures; an early open is only a head start.
      }
    },
    [activeConversationId, refreshArtifacts, handleOpenArtifact],
  );

  const routeDocumentToolActivity = useCallback(
    (activity: DocumentToolActivity) => {
      if (activity.phase === 'written') {
        void handleDocumentWritten(activity);
        return;
      }
      handleDocumentToolActivity(activity);
    },
    [handleDocumentWritten, handleDocumentToolActivity],
  );

  const handleCloseArtifactTab = useCallback(
    (artifactId: string) => {
      setOpenArtifactIds((current) => current.filter((id) => id !== artifactId));
    },
    [],
  );

  // When the active artifact is removed from openArtifactIds, switch to the
  // last remaining open artifact or clear the active artifact.
  useEffect(() => {
    if (!activeArtifact) return;
    if (!openArtifactIds.includes(activeArtifact.id)) {
      if (openArtifactIds.length > 0) {
        void handleOpenArtifact(openArtifactIds[openArtifactIds.length - 1]);
      } else {
        setActiveArtifact(null);
      }
    }
  }, [activeArtifact?.id, openArtifactIds, handleOpenArtifact]);

  const handleSaveContent = useCallback(
    async (artifactId: string, content: ArtifactContent, mimeType?: string) => {
      try {
        const updated = await setArtifactContent(artifactId, content, mimeType);
        setActiveArtifact(updated);
        if (activeConversationId) {
          await refreshArtifacts(activeConversationId);
        }
        const state = await checkArtifactFileState(artifactId);
        setFileStateMap((current) => ({ ...current, [artifactId]: state }));
        setStatus(makeStatus(t('app.status.artifactSaved'), 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.saveArtifactFailed'), 'error'));
        throw error;
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  const handleExport = useCallback(
    async (artifactId: string, includeMetadata: boolean) => {
      try {
        const result = await exportArtifact(artifactId, includeMetadata);
        setStatus(makeStatus(t('app.status.artifactExportedTo', { path: result.exportedTo }), 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.exportArtifactFailed'), 'error'));
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeArtifact) return;
    // Only poll file-backed artifacts — inline-payload artifacts never change
    // on disk, so the periodic check is wasted work.
    if (!activeArtifact.contentPath) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (!panelVisible) return;
      void (async () => {
        try {
          const state = await checkArtifactFileState(activeArtifact.id);
          setFileStateMap((current) => ({ ...current, [activeArtifact.id]: state }));
        } catch {
          /* keep last known state */
        }
      })();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    function onVisibility() {
      if (document.visibilityState === 'visible') tick();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeArtifact, panelVisible]);

  const handlePromoteArtifact = useCallback(
    async (messageId: string, candidate: ArtifactCandidate) => {
      if (!activeConversationId) return;
      try {
        const sourceMessageId = await resolveSourceMessageId(messageId);
        const created = await createArtifact(
          activeConversationId,
          candidate.kind,
          candidate.title,
          sourceMessageId,
        );
        await setArtifactContent(created.id, { kind: 'text', text: candidate.body }, candidate.mimeType);
        await refreshArtifacts(activeConversationId);
        await handleOpenArtifact(created.id);
        setStatus(makeStatus(t('app.status.artifactPromoted'), 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.promoteArtifactFailed'), 'error'));
      }
    },
    [activeConversationId, refreshArtifacts, handleOpenArtifact],
  );

  const handleRenameArtifact = useCallback(
    async (artifactId: string, title: string) => {
      try {
        await setArtifactTitle(artifactId, title);
        if (activeConversationId) {
          await refreshArtifacts(activeConversationId);
        }
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.renameArtifactFailed'), 'error'));
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  // Rename a chat (inline dialog). The palette renames the open chat; the
  // sidebar's row menu and a double-click rename whichever row it was.
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const handleRenameChat = useCallback(
    (conversationId?: string) => {
      const targetId = conversationId ?? activeConversationId;
      if (!targetId) return;
      const title =
        targetId === activeConversationId
          ? activeConversationSummary?.displayTitle
          : conversations.find((row) => row.id === targetId)?.displayTitle;
      setRenameTargetId(targetId);
      setRenameValue(title ?? '');
      setRenameDialogOpen(true);
    },
    [activeConversationId, activeConversationSummary, conversations],
  );

  const commitRenameChat = useCallback(async () => {
    const title = renameValue.trim();
    setRenameDialogOpen(false);
    const targetId = renameTargetId;
    if (!title || !targetId) return;
    try {
      await setConversationTitle(targetId, title);
      await refreshConversations();
      if (targetId === activeConversationId) await refreshActiveConversationSummary(targetId);
      setStatus(makeStatus(t('app.status.conversationRenamed'), 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : t('app.status.renameConversationFailed'), 'error'),
      );
    }
  }, [activeConversationId, renameTargetId, renameValue, refreshConversations, refreshActiveConversationSummary]);

  const handlePinConversation = useCallback(
    async (id: string, pinned: boolean) => {
      try {
        await setConversationPinned(id, pinned);
        await refreshConversations();
        await refreshActiveConversationSummary(activeConversationId);
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.pinConversationFailed'), 'error'));
      }
    },
    [activeConversationId, refreshConversations, refreshActiveConversationSummary],
  );

  const handleArchiveConversation = useCallback(
    async (id: string, archived: boolean) => {
      try {
        await setConversationArchived(id, archived);
        await refreshConversations();
        await refreshActiveConversationSummary(activeConversationId);
      } catch (error) {
        setStatus(
          makeStatus(error instanceof Error ? error.message : t('app.status.archiveConversationFailed'), 'error'),
        );
      }
    },
    [activeConversationId, refreshConversations, refreshActiveConversationSummary],
  );

  const handleSetConversationFolder = useCallback(
    async (id: string, folderId: string | null) => {
      try {
        await setConversationFolder(id, folderId);
        await refreshConversations();
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.moveConversationFailed'), 'error'));
      }
    },
    [refreshConversations],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      try {
        const folder = await createConversationFolder(name);
        await refreshConversations();
        setStatus(makeStatus(t('app.status.folderCreated'), 'success'));
        return folder;
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.createFolderFailed'), 'error'));
        return undefined;
      }
    },
    [refreshConversations],
  );

  const handleRenameFolder = useCallback(
    async (folderId: string, name: string) => {
      try {
        await renameConversationFolder(folderId, name);
        await refreshConversations();
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.renameFolderFailed'), 'error'));
      }
    },
    [refreshConversations],
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      try {
        await deleteConversationFolder(folderId);
        await refreshConversations();
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : t('app.status.deleteFolderFailed'), 'error'));
      }
    },
    [refreshConversations],
  );

  const handleExportDiagnostics = useCallback(async () => {
    try {
      const result = await exportDiagnostics();
      setStatus(makeStatus(t('app.status.diagnosticsExportedTo', { path: result.exportedTo }), 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : t('app.status.exportDiagnosticsFailed'), 'error'),
      );
    }
  }, []);

  const handleCopyConversationAsMarkdown = useCallback(async () => {
    if (!activeConversationId) {
      setStatus(makeStatus(t('app.status.nothingToCopy'), 'warning'));
      return;
    }
    try {
      const md = await previewConversationExport(activeConversationId, 'markdown');
      if (!md.trim()) {
        setStatus(makeStatus(t('app.status.nothingToCopy'), 'warning'));
        return;
      }
      await navigator.clipboard.writeText(md);
      setStatus(makeStatus(t('app.status.conversationCopiedMarkdown'), 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : t('app.status.copyConversationFailed'), 'error'),
      );
    }
  }, [activeConversationId]);

  const handleExportConversation = useCallback(
    async (format: 'markdown' | 'json') => {
      if (!activeConversationId) {
        setStatus(makeStatus(t('app.status.nothingToExport'), 'warning'));
        return;
      }
      try {
        const result = await exportConversationDialog(
          activeConversationId,
          format,
          t('chat.export.dialog.title', { format: format === 'json' ? 'JSON' : 'Markdown' }),
          // The file-type filter names a format, and format names are not
          // translated (D7).
          format === 'json' ? 'JSON' : 'Markdown',
        );
        if (result === null) return;
        setStatus(makeStatus(t('app.status.artifactExportedTo', { path: result.exportedTo }), 'success'));
      } catch (error) {
        setStatus(
          makeStatus(error instanceof Error ? error.message : t('app.status.exportConversationFailed'), 'error'),
        );
      }
    },
    [activeConversationId],
  );

  /**
   * The one place a model switch is written (⌘K's `/models` corpus and the
   * composer's model menu both route here). Provider and model move together in
   * a single settings write, so a cross-provider pick cannot leave the two
   * fields briefly disagreeing — and the app re-tints once, from the Phase A
   * `data-provider` effect, rather than twice.
   *
   * `defaultBaseUrl` comes from the caller's provider descriptor: switching to a
   * provider that has never been configured seeds its endpoint, which is what
   * the composer's picker did before V9 folded its two writes into this one.
   * An endpoint the user has already set is never overwritten.
   */
  const handleSelectModel = useCallback(
    (providerId: string, modelId: string, defaultBaseUrl?: string | null) => {
      const existing = settings.providerEndpoints?.[providerId];
      const providerEndpoints = { ...settings.providerEndpoints };
      if (defaultBaseUrl && !existing?.baseUrl) {
        providerEndpoints[providerId] = { ...existing, baseUrl: defaultBaseUrl };
      }
      const next: AppSettings = {
        ...settings,
        activeProvider: providerId,
        activeModel: modelId,
        providerEndpoints,
      };
      setSettings(next);
      void updateSettingsPersisted(next);
    },
    [settings],
  );

  // V7 ⌘K — delete this chat routes through the existing confirm flow.
  const handleDeleteChatRequest = useCallback(() => {
    if (activeConversationId) setConfirmDeleteId(activeConversationId);
  }, [activeConversationId]);

  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => resolveTheme(settings.theme));
  useEffect(() => {
    const eff = applyTheme(settings.theme);
    setEffectiveTheme(eff);
    const stopWatching = watchSystemTheme(settings.theme, () => setEffectiveTheme(resolveTheme(settings.theme)));
    /* A brand or accent change re-resolves the effective mode for anything
     * keyed on it (the brand re-apply below). */
    const onThemeChanged = () => {
      setEffectiveTheme(applyTheme(settings.theme));
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged);
    return () => {
      stopWatching();
      window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged);
    };
  }, [settings.theme]);

  /* The language analogue of the theme effect above, and the reconcile half of
   * the pre-paint language read in `main.tsx`. It corrects the localStorage
   * mirror when it is stale, absent or hand-edited, and carries every change
   * from the Settings picker into the provider.
   *
   * **It must not run until `settings` is the authoritative Rust read.** App
   * sits inside `I18nProvider`, which carries `key={locale}` so that switching
   * language re-mounts this subtree instead of leaving formatted text frozen in
   * somebody's `useState`. That means every locale change resets `settings`
   * back to `defaultSettings` — whose language is `'system'`, a placeholder
   * nobody chose. Announcing that placeholder resolves to a different locale
   * than an explicit choice does, which changes the key, which re-mounts App,
   * which restores the placeholder and announces it again: an unbounded
   * re-mount loop, paced by the boot IPC, with every piece of content in the
   * window flickering for as long as the app is open. It needs a stored
   * language other than `'system'` to bite, so it stayed invisible until the
   * picker had languages worth choosing. `App.smoke.test.tsx` counts boots.
   *
   * `setPreference` is deliberately inert while a dev locale override is
   * active. Without that, this effect would undo `?locale=en-XA` the instant
   * settings loaded, and the pseudo-locale would be unreachable. */
  const { setPreference } = useLocale();
  useEffect(() => {
    if (!settingsLoaded) return;
    setPreference(settings.language);
  }, [settingsLoaded, settings.language, setPreference]);

  // A brand palette is inline CSS on <html>, which beats every stylesheet
  // rule including [data-theme="light"] — so it has to be re-applied for the
  // *resolved* theme on every change, not just when AppSettings.theme is
  // edited. Keyed on effectiveTheme rather than settings.theme so this also
  // fires when watchSystemTheme flips the OS preference while mode ===
  // 'system', which changes effectiveTheme without changing settings.theme.
  useEffect(() => {
    if (brandConfig) applyBrandTheme(brandConfig, effectiveTheme);
  }, [brandConfig, effectiveTheme]);

  // ADR-011 main colour: same reasoning as the brand effect above — inline
  // on <html>, so it is re-derived for the resolved mode on every flip. It
  // stands down while a brand is active (applyAccent checks), which is why
  // brandConfig is a dependency too.
  useEffect(() => {
    applyAccent(settings.accent, effectiveTheme);
  }, [settings.accent, effectiveTheme, brandConfig]);


  // V7 — the active provider's identity tints the app (spec §5.4).
  useEffect(() => {
    document.documentElement.setAttribute('data-provider', providerHueId(settings.activeProvider));
  }, [settings.activeProvider]);

  const workspaceLabel = paths?.artifacts ? shortenWorkspacePath(paths.artifacts) : undefined;

  const hasCredential = onboarding?.hasProviderCredential ?? false;
  const connectionState = deriveConnectionState({
    boundaryOk,
    hasCredential,
    localOnly: settings.localOnly,
  });
  // Shown on the topbar toggle while the panel is hidden — the count is what
  // replaces the old edge rail as the "there is something in there" signal.
  const hiddenArtifactCount = panelVisible ? 0 : chatArtifacts.length;

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  // Where the sheet was when it last closed. Opening it without naming a
  // section — the gear, Ctrl+, or the palette's "Open settings" — returns
  // there, so the one-click paths agree on a destination instead of each
  // hard-coding its own (the workspace menu's "Settings" used to open
  // Appearance while its own Ctrl+, hint opened Providers).
  const lastSettingsSectionRef = useRef<SettingsSection>('providers');
  const openSettings = useCallback((section?: SettingsSection) => {
    // Sections that became rail destinations (the knowledge base first, t1-8;
    // connectors, prompts, skills and memory with the revamp). Redirecting
    // here catches every existing deep link (composer, palette, status line).
    switch (section) {
      case 'knowledge':
        setDestination('documents');
        return;
      case 'connectors':
        setDestination('connectors');
        return;
      case 'memory':
        setDestination('memory');
        return;
      case 'prompts':
      case 'skills':
        setLibraryTab(section);
        setDestination('library');
        return;
    }
    setSettingsSection(section ?? lastSettingsSectionRef.current);
    setDestination('settings');
  }, []);

  // Daily spend alert: checked after every chat turn, shown at most once a day.
  const pushToast = useCallback((toast: StatusState) => {
    setToasts((current) => [...current.slice(-4), toast]);
  }, []);
  const openUsageSettings = useCallback(() => openSettings('about'), [openSettings]);
  const checkSpendAlert = useSpendAlert({
    thresholdUsd: settings.dailySpendAlertUsd,
    onToast: pushToast,
    onOpenUsage: openUsageSettings,
  });

  const openDocuments = useCallback(() => setDestination('documents'), []);

  // ── Ideas ────────────────────────────────────────────────────────────────
  // Collections decide whether "Ask your documents" is ready; re-read when
  // the Documents sheet closes.
  useEffect(() => {
    if (documentsOpen) return;
    let cancelled = false;
    listKnowledgeCollections()
      .then((list) => !cancelled && setCollectionCount(list.length))
      .catch(() => !cancelled && setCollectionCount(0));
    return () => {
      cancelled = true;
    };
  }, [documentsOpen]);

  const ideaCaps = useMemo(
    () =>
      resolveCapabilities({
        settings,
        provider: providers.find((p) => p.id === settings.activeProvider) ?? null,
        collectionCount,
      }),
    [settings, providers, collectionCount],
  );
  // A capability that becomes ready joins the spotlight (a dot on Ideas).
  // Only once everything it depends on has loaded, so startup is not "new".
  useEffect(() => {
    if (collectionCount == null || providers.length === 0) return;
    observeReady(readyCapabilities(ideaCaps));
  }, [ideaCaps, collectionCount, providers.length]);

  const openIdeas = useCallback(() => setDestination('ideas'), []);

  /** Put an idea's prompt in the composer of an empty chat (new if needed). */
  const tryIdea = useCallback(
    async (idea: Idea) => {
      // A deck idea starts in Slides with its story filled in, not in a chat.
      if (idea.opens === 'slides') {
        setSlidesPrefill((prev) => ({ text: t(`ideas.item.${idea.id}.prompt`), seq: (prev?.seq ?? 0) + 1 }));
        setDestination('slides');
        return;
      }
      // From Home the open chat may be a deck's or a draft's: leave it, or
      // Chats would route to Slides or Writing.
      const hadDeck = activeDeckRef.current != null || activeDraftRef.current != null;
      if (hadDeck) {
        setActiveDeck(null);
        setStudioDeckId(null);
        setActiveDraft(null);
        setStudioDraftId(null);
      }
      setDestination('chats');
      const view = chatViewRef.current;
      if (!view) {
        setQueuedIdea(idea);
        return;
      }
      if (hadDeck || !activeConversationId || !view.isEmpty()) await handleNewChat();
      notePicked(idea.id);
      // After the new chat renders.
      requestAnimationFrame(() => chatViewRef.current?.replacePrompt(t(`ideas.item.${idea.id}.prompt`)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeConversationId, t],
  );
  // An idea picked during onboarding runs once the chat is on screen.
  useEffect(() => {
    if (!queuedIdea || !chatViewRef.current) return;
    const idea = queuedIdea;
    setQueuedIdea(null);
    void tryIdea(idea);
  });

  const setupCapability = useCallback(
    (target: SetupTarget) => {
      if (target === 'documents') openDocuments();
      else openSettings(target);
    },
    // openSettings is declared above and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openDocuments],
  );

  const dropHovering = useKnowledgeDrop(
    (paths) => {
      setDroppedPaths(paths);
      setDestination('documents');
    },
    // t1-8 M1 (D13): a native drop that landed on the composer attaches to
    // the message instead of going to Documents.
    (paths) => chatViewRef.current?.handleComposerDrop(paths),
  );
  const rememberSettingsSection = useCallback((section: SettingsSection) => {
    lastSettingsSectionRef.current = section;
  }, []);

  const handleRevealWorkspace = useCallback(() => {
    void revealArtifactsDir().catch((error) => {
      setStatus(
        makeStatus(error instanceof Error ? error.message : t('app.status.revealArtifactsFolderFailed'), 'error'),
      );
    });
  }, []);

  // ── Navigation ───────────────────────────────────────────────────────────
  // One path for the rail, Ctrl+1…9 and the palette's "Go to".
  const navigateTo = useCallback(
    (d: Destination) => {
      if (d === 'settings') openSettings();
      else if (d === 'slides' && studio) setStudioDeckId(null);
      else if (d === 'writing' && writingStudio) setStudioDraftId(null);
      else {
        // Chats never shows a deck or draft chat: going there from one
        // returns to the last ordinary chat.
        if (d === 'chats' && (activeDeck || activeDraft)) leaveDeckChat();
        setDestination(d);
      }
    },
    [openSettings, studio, writingStudio, activeDeck, activeDraft, leaveDeckChat],
  );

  // ── Home ─────────────────────────────────────────────────────────────────
  /** Chats, with an empty chat open (the current one if it is empty), and the
   *  text sent into it if there is any. */
  const openFreshChat = useCallback(
    async (text?: string) => {
      const hadDeck = activeDeckRef.current != null || activeDraftRef.current != null;
      if (hadDeck) {
        setActiveDeck(null);
        setStudioDeckId(null);
        setActiveDraft(null);
        setStudioDraftId(null);
      }
      setDestination('chats');
      const reuse = !hadDeck && activeConversationId != null && (chatViewRef.current?.isEmpty() ?? false);
      if (!reuse) await handleNewChat();
      if (text) setPendingSendText(text);
    },
    [activeConversationId, handleNewChat],
  );
  /** The Slides list (not a deck left open in the studio). */
  const openSlidesList = useCallback(() => {
    setStudioDeckId(null);
    setDestination('slides');
  }, []);
  const handleHomeAsk = useCallback(
    (text: string) => {
      if (looksLikeDeckRequest(text)) {
        const theme = STARTER_THEMES[0];
        void handleStartDeck(text, theme.name, theme.css).catch((error) =>
          setStatusMessage(error instanceof Error ? error.message : String(error)),
        );
      } else {
        void openFreshChat(text);
      }
    },
    [handleStartDeck, openFreshChat, setStatusMessage],
  );
  /** Home's deck chip: a new deck from the box text, opening on its storyline. */
  const handleHomeStartDeck = useCallback(
    (text: string) => {
      const theme = STARTER_THEMES[0];
      void handleStartDeck(text, theme.name, theme.css).catch((error) =>
        setStatusMessage(error instanceof Error ? error.message : String(error)),
      );
    },
    [handleStartDeck, setStatusMessage],
  );
  /** Home's Write chip: a new draft from the box text. */
  const handleHomeWrite = useCallback(
    (brief: string) => {
      void handleStartDraft(brief).catch((error) =>
        setStatusMessage(error instanceof Error ? error.message : String(error)),
      );
    },
    [handleStartDraft, setStatusMessage],
  );
  /** Home's Research chip: a fresh chat, with the text sent as a Research run. */
  const handleHomeResearch = useCallback(
    (text: string) => {
      const reasonId = researchUnavailableReasonId(settings);
      if (reasonId) {
        setStatusMessage(t(reasonId));
        return;
      }
      setPendingSendResearch(true);
      void openFreshChat(text);
    },
    [settings, openFreshChat, setStatusMessage, t],
  );
  const handleHomeOpenChat = useCallback(
    (id: string) => {
      if (activeDeckRef.current || activeDraftRef.current) {
        setActiveDeck(null);
        setStudioDeckId(null);
        setActiveDraft(null);
        setStudioDraftId(null);
      }
      handleSelectConversation(id);
      setDestination('chats');
    },
    [handleSelectConversation],
  );
  const handleHomeNavigate = useCallback(
    (area: Destination) => {
      if (area === 'slides') openSlidesList();
      else if (area === 'writing') openWritingList();
      else navigateTo(area);
    },
    [navigateTo, openSlidesList, openWritingList],
  );
  const handleHomeAction = useCallback(
    (action: HomeAction) => {
      switch (action) {
        case 'new-chat':
          void openFreshChat();
          break;
        case 'start-deck':
          openSlidesList();
          break;
        case 'start-draft':
          openWritingList();
          break;
        case 'add-documents':
          setDestination('documents');
          break;
        case 'new-workflow':
          setWorkflowsStartNew(true);
          setDestination('workflows');
          break;
        case 'add-connector':
          setDestination('connectors');
          break;
        case 'browse-apps':
          openSavedApp(null);
          break;
        case 'review-memory':
          setDestination('memory');
          break;
        case 'open-reviews':
          setDestination('workflows');
          break;
      }
    },
    [openFreshChat, openSlidesList, openWritingList, openSavedApp],
  );

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
    void listConversations()
      .then((rows) => {
        setPaletteConversations(
          rows.map((r) => ({
            id: r.id,
            title: r.displayTitle,
            pinned: Boolean(r.pinnedAt),
            archived: Boolean(r.archivedAt),
          })),
        );
      })
      .catch(() => {
        setPaletteConversations([]);
      });
  }, []);

  // V7 — ⌘⇧P cycles the active provider and re-tints the app (spec §9.1).
  const handleCycleProvider = useCallback(async () => {
    try {
      const descriptors = await listProviderDescriptors();
      if (descriptors.length === 0) return;
      const currentIndex = descriptors.findIndex((d) => d.id === settings.activeProvider);
      const next = descriptors[(currentIndex + 1 + descriptors.length) % descriptors.length];
      if (!next) return;
      const existingEndpoint = settings.providerEndpoints?.[next.id];
      const nextEndpoints = { ...settings.providerEndpoints };
      if (next.defaultBaseUrl && !existingEndpoint?.baseUrl) {
        nextEndpoints[next.id] = { ...existingEndpoint, baseUrl: next.defaultBaseUrl };
      }
      const nextSettings: AppSettings = {
        ...settings,
        activeProvider: next.id,
        providerEndpoints: nextEndpoints,
      };
      // Keep the active model only if the new provider still offers it;
      // otherwise fall back to its first model so sends don't break.
      try {
        const models = await listProviderModels(next.id);
        if (models.length > 0 && !models.some((m) => m.id === settings.activeModel)) {
          nextSettings.activeModel = models[0].id;
        }
      } catch {
        /* keep the current model; the send path surfaces any mismatch */
      }
      setSettings(nextSettings);
      void updateSettingsPersisted(nextSettings);
      setStatusMessage(makeStatus(t('app.status.switchedProvider', { provider: providerDisplayName(next.id) }), 'success'));
    } catch (error) {
      setStatusMessage(
        makeStatus(error instanceof Error ? error.message : t('app.status.switchProviderFailed'), 'error'),
      );
    }
  }, [settings, setStatusMessage]);

  const hotkeyHandlers = useMemo(
    () => ({
      newChat: () => {
        // From Home, a new chat means the chat: take the reader there.
        if (destination === 'home') void openFreshChat();
        else void handleNewChat();
      },
      settings: () => openSettings(),
      shortcuts: () => setShortcutsOpen((open) => !open),
      toggleSidebar: () => toggleSidebarView(),
      toggleDocPanel: () => toggleDocPanelView(),
      toggleArtifactExpand: () => toggleArtifactExpand(),
      historySearch: () => openPalette(),
      // Ctrl+1…9: not while presenting (the deck owns the keyboard).
      goHome: () => !presenting && navigateTo('home'),
      goChats: () => !presenting && navigateTo('chats'),
      goApps: () => !presenting && navigateTo('apps'),
      goSlides: () => !presenting && navigateTo('slides'),
      goWriting: () => !presenting && navigateTo('writing'),
      goDocuments: () => !presenting && navigateTo('documents'),
      goLibrary: () => !presenting && navigateTo('library'),
      goWorkflows: () => !presenting && navigateTo('workflows'),
      goConnectors: () => !presenting && navigateTo('connectors'),
      cycleProvider: () => {
        void handleCycleProvider();
      },
      toggleWebSearch: () => {
        chatViewRef.current?.toggleWebSearch();
      },
      forkConversationHere: () => {
        void chatViewRef.current?.forkConversationHere().then((ok) => {
          if (ok) setStatus(makeStatus(t('app.status.conversationForked'), 'success'));
        });
      },
      copyLastAssistant: () => {
        void chatViewRef.current?.copyLastAssistantMessage().then((ok) => {
          if (ok) setStatus(makeStatus(t('app.status.copiedLastAssistantMessage'), 'success'));
          else setStatus(makeStatus(t('app.status.nothingToCopy'), 'warning'));
        });
      },
      escape: (event: KeyboardEvent) => {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        // Home is the root: Escape has nowhere to go from it.
        if (destination === 'home') return;
        // A destination page: Escape goes back to the chat, unless it is
        // editing text there (or a menu inside it took the key).
        if (destination !== 'chats') {
          const el = document.activeElement;
          const typing =
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement ||
            (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type));
          if (!typing && !event.defaultPrevented) setDestination('chats');
          return;
        }
        if (confirmDeleteId != null || confirmDeleteAll) {
          setConfirmDeleteId(null);
          setConfirmDeleteAll(false);
          return;
        }
        if (sidebarOverlay.open || panelOverlay.open) {
          // A menu or dialog inside the overlay claims its own Escape first.
          if (!event.defaultPrevented) closeOverlays();
          return;
        }
        const active = document.activeElement;
        if (
          active instanceof HTMLTextAreaElement &&
          active.getAttribute('aria-label') === t('chat.composer.prompt.ariaLabel') &&
          chatViewRef.current?.isStreaming()
        ) {
          chatViewRef.current.stopStreaming();
        }
      },
    }),
    [
      confirmDeleteAll,
      confirmDeleteId,
      handleCycleProvider,
      handleNewChat,
      openFreshChat,
      openPalette,
      openSettings,
      navigateTo,
      presenting,
      paletteOpen,
      destination,
      shortcutsOpen,
      toggleDocPanelView,
      toggleSidebarView,
      toggleArtifactExpand,
      sidebarOverlay.open,
      panelOverlay.open,
      closeOverlays,
    ],
  );
  useHotkeys(hotkeyHandlers);

  const handleToggleTheme = useCallback(() => {
    setSettings((current) => {
      const next: AppSettings = {
        ...current,
        theme: effectiveTheme === 'light' ? 'dark' : 'light',
      };
      void updateSettingsPersisted(next);
      return next;
    });
  }, [effectiveTheme]);

  const activeFileState = activeArtifact ? fileStateMap[activeArtifact.id] ?? 'noFileContent' : 'noFileContent';

  const openArtifacts = useMemo(() => {
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    return openArtifactIds
      .map((id) => byId.get(id))
      .filter((a): a is Artifact => a != null);
  }, [artifacts, openArtifactIds]);

  const confirmDeleteTitle = useMemo(
    () => conversations.find((c) => c.id === confirmDeleteId)?.displayTitle ?? null,
    [conversations, confirmDeleteId],
  );

  // Both pre-workspace routes keep the caption row. They bypass the shell
  // otherwise, and on a `decorations: false` window that left the user with no
  // way to move or close it until onboarding was finished.
  //
  // They also keep `ToastStack`, for a closely related reason. The effect above
  // routes every error, warning and success status *exclusively* into `toasts`
  // and nulls the panel status — so with the stack rendered only in the
  // workspace return below, these two routes dropped that entire class of
  // message on the floor. Onboarding renders `status` itself and looks like it
  // has feedback covered, but `status` is null by the time it reads it. The
  // visible cost was on the step that matters most: "Test connection" with a
  // bad key, or a keychain write that failed, reported nothing at all and left
  // the user clicking a button that appeared to do nothing. `.toast-stack` is
  // `position: fixed`, so where it sits in the tree does not matter.
  /* Dev-only: a whole different page, so it bypasses onboarding/boot state
   * entirely rather than threading through every check below. `devRoute` is
   * `null` in every production build (see `devRoute.ts`), so this branch is
   * unreachable there. */
  if (devRoute === 'gallery' && LazyGallery) {
    return (
      <Suspense fallback={null}>
        <LazyGallery />
      </Suspense>
    );
  }

  if (onboarding?.migrationRecovery) {
    return (
      <div className="app" id="app">
        <TitleBar />
        <MigrationRecoveryNotice
          recovery={onboarding.migrationRecovery}
          onStatus={setStatusMessage}
          onDismissed={() => void refreshOnboarding()}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }
  /* `devRoute` is `null` in every production build (see `devRoute.ts`), so this
     disjunct is dead code there and the gate below is unchanged. It exists so
     the layout suite, which runs against a backend-less `dev:web` where
     `getOnboardingState()` rejects and `onboarding` stays null, can still reach
     this screen to measure it. */
  if (devRoute === 'onboarding' || (onboarding && (!onboarding.onboardingCompleted || !onboarding.hasProviderCredential))) {
    return (
      <div className="app" id="app">
        <TitleBar />
        <Onboarding
          settings={settings}
          onSettingsChange={setSettings}
          onStatus={setStatusMessage}
          status={status}
          onComplete={(idea) => {
            if (idea) setQueuedIdea(idea);
            void refreshOnboarding();
          }}
          logoSrc={brandLogo ?? undefined}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="app" id="app">
      {/* The window's caption row: drag region + minimise/maximise/close.
          Without it a frameless window cannot be moved or closed at all
          (shellContract.test.ts pins this). */}
      <TitleBar />

      <div className="shell">
      <Rail
        destination={destination}
        onNavigate={navigateTo}
        dots={{ workflows: workflowsNeedYou && destination !== 'workflows' }}
        effectiveTheme={effectiveTheme}
        onToggleTheme={handleToggleTheme}
        logoSrc={brandLogo ?? undefined}
      />
      {/* `data-page`: a rail page covers the chat (see .body[data-page] in workspace.css). */}
      <div
        className="body"
        data-page={destination !== 'chats' && !anyStudio ? destination : undefined}
        data-studio={anyStudio ? '' : undefined}
      >
        <Sidebar
          conversations={conversations}
          folders={conversationFolders}
          activeConversationId={activeConversationId}
          convoProviders={convoProviders}
          workspaceLabel={workspaceLabel}
          localOnly={settings.localOnly}
          providerCount={providers.length > 0 ? providers.length : undefined}
          connectorCount={connectorCount}
          onSelectConversation={(id) => {
            hideSidebarOverlay();
            handleSelectConversation(id);
          }}
          onNewChat={() => {
            hideSidebarOverlay();
            void handleNewChat();
          }}
          onOpenPalette={openPalette}
          onCollapse={toggleSidebarView}
          onRevealWorkspace={handleRevealWorkspace}
          onOpenSettings={(section) => openSettings(section as SettingsSection | undefined)}
          onExportDiagnostics={() => void handleExportDiagnostics()}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameChat}
          onDeleteAllHistory={handleDeleteAllHistory}
          onPinConversation={(id, pinned) => void handlePinConversation(id, pinned)}
          onArchiveConversation={(id, archived) => void handleArchiveConversation(id, archived)}
          onSetConversationFolder={(id, folderId) => void handleSetConversationFolder(id, folderId)}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={(folderId, name) => void handleRenameFolder(folderId, name)}
          onDeleteFolder={(folderId) => void handleDeleteFolder(folderId)}
          runStatus={runStatus}
        />

        {/* The sidebar's sash, laid over its border rather than given a grid
            track (see .sidebar-resize in workspace.css). */}
        <div
          className="sidebar-resize"
          id="sidebarResize"
          role="separator"
          aria-orientation="vertical"
          aria-controls="sidebar"
          aria-label={t('app.sidebarResizeHandle.ariaLabel')}
          aria-valuenow={sidebarResize.ariaValueNow}
          aria-valuemin={sidebarResize.ariaValueMin}
          aria-valuemax={sidebarResize.ariaValueMax}
          tabIndex={0}
          onPointerDown={sidebarResize.onPointerDown}
          onKeyDown={sidebarResize.onKeyDown}
          onDoubleClick={sidebarResize.onDoubleClick}
        />

        {/* The full-height "Artifacts" rail that used to live here was a second
            affordance for the title strip's own panel toggle. It is gone; the
            toggle carries the artifact count so the panel stays discoverable. */}
        {/* In the studio this column is the dock. Its first child switches
            between the chat header and the dock's tabs; ChatView stays the
            second child either way, so it is never remounted (it owns the
            running stream). */}
        <main
          className="center"
          data-dock-tab={studio ? dockTab : writingStudio ? draftDockTabShown : undefined}
        >
          {writingStudio && activeDraft ? (
            <DraftDock
              tab={draftDockTabShown}
              onTab={setDraftDockTab}
              showOutline={activeDraft.stage === 'draft'}
              outline={
                <OutlineEditor
                  variant="dock"
                  sections={activeDraft.outline}
                  stage={activeDraft.stage}
                  busy={draftStreaming}
                  onChange={(sections) => void handleSetDraftOutline(sections)}
                />
              }
              sources={
                <DraftSourcesPanel
                  webSearch={draftSourcesOf(activeDraft).webSearch}
                  webDisabledReason={draftWebReasonId ? t(draftWebReasonId) : null}
                  onToggleWeb={(on) => void handleToggleDraftWeb(on)}
                  collections={sourceCollections}
                  enabledCollectionIds={draftCollectionIds}
                  onToggleCollection={(id, on) => void handleToggleDraftCollection(id, on)}
                  reports={researchReports}
                  attachedRunIds={draftSourcesOf(activeDraft).researchRunIds}
                  onToggleReport={(id, on) => void handleToggleDraftReport(id, on)}
                  saving={sourcesSaving}
                  error={sourcesError}
                />
              }
              history={
                <DraftHistory
                  revision={draftHistoryRevision}
                  onList={handleListDraftSnapshots}
                  onRestore={handleRestoreDraft}
                />
              }
            >
              {null}
            </DraftDock>
          ) : studio && activeDeck ? (
            <DeckDock
              tab={dockTab}
              onTab={setDockTab}
              script={
                <ScriptPanel
                  deck={activeDeck}
                  overflow={deckOverflow}
                  focusRequest={scriptFocus}
                  findFocusToken={scriptFindToken}
                  onEditWords={handleEditWords}
                  onSetPinned={handleSetPinned}
                  onReplace={handleReplaceInDeck}
                  onInsertBullet={handleInsertBullet}
                  onRemoveBullet={handleRemoveBullet}
                  onAskToFix={(prompt) => {
                    setDockTab('ask');
                    setPendingSendText(appPrompt(t('slides.note.fixOverflow'), prompt));
                  }}
                  onFocusSlide={(index) => setStageSlideRequest({ index, nonce: Date.now() })}
                  onClose={() => setDockTab('ask')}
                />
              }
              history={
                <DeckHistory
                  revision={deckHistoryRevision}
                  onList={handleListDeckSnapshots}
                  onRestore={handleRestoreDeck}
                  onClose={() => setDockTab('ask')}
                />
              }
            >
              {null}
            </DeckDock>
          ) : (
            <MainHead
              title={activeConversationSummary?.displayTitle}
              panelOpen={panelVisible}
              onTogglePanel={toggleDocPanelView}
              hiddenArtifactCount={hiddenArtifactCount}
              sidebarOverlayOpen={sidebarOverlay.open}
              onToggleSidebar={toggleSidebarView}
              onNewChat={() => void handleNewChat()}
              onOpenPalette={openPalette}
            />
          )}
          <ChatView
            ref={chatViewRef}
            settings={settings}
            // Any rail page may add a connector, skill or collection; the
            // composer re-reads them when you come back to the chat.
            settingsOpen={destination !== 'chats'}
            documentsOpen={documentsOpen}
            onSelectModel={handleSelectModel}
            onStatus={setStatusMessage}
            conversationId={activeConversationId}
            artifacts={artifacts}
            activeArtifact={activeArtifact}
            fileStateMap={fileStateMap}
            onPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
            onOpenArtifact={(id) => void handleOpenArtifact(id)}
            onChatTurnComplete={(streamState) => {
              void handleChatTurnComplete(streamState);
              checkSpendAlert();
              void finishDeckTurn();
              void finishDraftTurn();
            }}
            deck={activeDeck}
            onDeckChanged={handleDeckChanged}
            onDeckToolActivity={setDeckBusyTool}
            onDeckStarted={() => {
              startedDeckThisTurnRef.current = true;
            }}
            draft={activeDraft}
            onDraftChanged={handleDraftChanged}
            onDraftToolActivity={setDraftBusyTool}
            onDraftPreview={handleDraftPreview}
            draftSourcesRevision={draftSourcesRevision}
            onOpenDraftSources={() => setDraftDockTab('sources')}
            onWriteFromReport={handleWriteFromReport}
            compact={anyStudio}
            deckOverflow={deckOverflow}
            onDocumentToolActivity={routeDocumentToolActivity}
            onForkConversation={(convId, msgId) => void handleForkConversation(convId, msgId)}
            onEditForked={handleEditForked}
            pendingSendText={pendingSendText}
            pendingSendResearch={pendingSendResearch}
            onPendingSendConsumed={consumePendingSend}
            onConversationChanged={() => {
              void refreshConversations();
              if (activeConversationId) void refreshActiveConversationSummary(activeConversationId);
            }}
            onOpenSettings={(section) => openSettings(section as SettingsSection | undefined)}
            onOpenActivity={(turnId) => openInspector('activity', turnId)}
            onTranscriptChange={setTranscript}
            onRunStatusChange={setRunStatus}
            ideaGallery={activeDeck || activeDraft || ideaState.rowHidden ? null : { caps: ideaCaps, state: ideaState }}
            yourApps={activeDeck || activeDraft ? [] : savedApps}
            onOpenApp={openSavedApp}
            onAllApps={() => openSavedApp(null)}
            readyMadeIdeas={readyMadeIdeas}
            onOpenReadyMade={(idea) => {
              const starter = starterApps.find((s) => s.ideaId === idea.id);
              if (starter) void openStarterApp(starter);
            }}
            onPickIdea={(idea) => void tryIdea(idea)}
            onMoreIdeas={openIdeas}
            onHideIdeas={() => setRowHidden(true)}
            convoProviders={convoProviders}
          />
        </main>
        {/* Rail destinations other than Chats: a page over the body. The chat
            stays mounted underneath, so a turn in progress keeps running. */}
        {destination !== 'chats' && !anyStudio && (
          <div className="dest-page" data-destination={destination}>
            {destination === 'home' && (
              <HomePage
                conversations={conversations}
                savedApps={savedApps}
                ideaCaps={ideaCaps}
                ideaState={ideaState}
                collectionCount={collectionCount}
                onAsk={handleHomeAsk}
                onResearch={handleHomeResearch}
                onWrite={handleHomeWrite}
                onStartDeck={handleHomeStartDeck}
                onOpenChat={handleHomeOpenChat}
                onOpenDeck={(id) => void handleOpenDeck(id)}
                onOpenDraft={(id) => void handleOpenDraft(id)}
                onOpenApp={openSavedApp}
                onNavigate={handleHomeNavigate}
                onAction={handleHomeAction}
                onTryIdea={(idea) => void tryIdea(idea)}
                onMoreIdeas={openIdeas}
              />
            )}
            {destination === 'settings' && (
              <SettingsSheet
                variant="page"
                open
                initialSection={settingsSection}
                onSectionChange={rememberSettingsSection}
                onClose={() => leave('settings')}
                settings={settings}
                onSettingsChange={setSettings}
                paths={paths}
                onStatus={setStatusMessage}
                connectionState={connectionState}
                boundaryOk={boundaryOk}
                hasCredential={hasCredential}
                onInsertPrompt={(text) => chatViewRef.current?.insertPrompt(text)}
                onOpenDocuments={openDocuments}
                onBrandChange={(config, logo) => {
                  setBrandConfig(config);
                  setBrandLogo(logo);
                }}
              />
            )}
            {destination === 'ideas' && (
              <IdeasSheet
                variant="page"
                open
                onClose={() => leave('ideas')}
                caps={ideaCaps}
                onTry={(idea) => void tryIdea(idea)}
                onSetup={setupCapability}
                onInsertPrompt={(text) => chatViewRef.current?.insertPrompt(text)}
                onStatus={setStatusMessage}
              />
            )}
            {destination === 'documents' && (
              <DocumentsSheet
                variant="page"
                open
                onClose={() => leave('documents')}
                settings={settings}
                onSettingsChange={setSettings}
                onStatus={setStatusMessage}
                pendingPaths={droppedPaths}
                onPendingPathsHandled={() => setDroppedPaths([])}
              />
            )}
            {destination === 'library' && (
              <LibraryPage
                key={libraryTab}
                initialTab={libraryTab}
                settings={settings}
                onStatus={setStatusMessage}
                onInsertPrompt={(text) => {
                  setDestination('chats');
                  requestAnimationFrame(() => chatViewRef.current?.insertPrompt(text));
                }}
              />
            )}
            {destination === 'connectors' && <ConnectorsPage onStatus={setStatusMessage} />}
            {destination === 'memory' && (
              <MemoryPage settings={settings} onSettingsChange={setSettings} onStatus={setStatusMessage} />
            )}
            {destination === 'apps' && (
              <AppsPage
                openAppId={openAppId}
                onOpenAppIdChange={setOpenAppId}
                allowlist={settings.artifactRemoteAllowlist}
                styledPreview={settings.artifactStyledPreview}
                colorScheme={effectiveTheme}
                networkPolicyKey={`${settings.localOnly}:${settings.artifactNetworkEnabled}`}
                onAppsChanged={() => void refreshSavedApps()}
                starters={starterApps}
                onAddStarter={(starter) => void addStarterApp(starter)}
                onStatus={setStatusMessage}
              />
            )}
            {destination === 'slides' && (
              <SlidesPage
                onOpenDeck={(deck) => void handleOpenDeck(deck.id)}
                onStartDeck={handleStartDeck}
                onStatus={setStatusMessage}
                prefill={slidesPrefill}
              />
            )}
            {destination === 'writing' && (
              <WritingPage
                onOpenDraft={(id) => void handleOpenDraft(id)}
                onStartDraft={handleStartDraft}
                onStatus={setStatusMessage}
              />
            )}
            {destination === 'workflows' && (
              <WorkflowsPage
                onStatus={setStatusMessage}
                onOpenDocument={openWorkflowDocument}
                refreshKey={workflowRunsVersion}
                startNew={workflowsStartNew}
              />
            )}
          </div>
        )}

        <div
          className="resize-handle"
          id="columnResize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('app.resizeHandle.ariaLabel')}
          aria-valuenow={panelResize.ariaValueNow}
          aria-valuemin={panelResize.ariaValueMin}
          aria-valuemax={panelResize.ariaValueMax}
          tabIndex={0}
          onPointerDown={panelResize.onPointerDown}
          onKeyDown={panelResize.onKeyDown}
          onDoubleClick={panelResize.onDoubleClick}
        />

        {writingStudio && activeDraft ? (
          <section className="doc-panel draft-panel" aria-label={t('writing.studio.ariaLabel')}>
            <WritingStudio
              draft={activeDraft}
              busyTool={draftBusyTool}
              streaming={draftStreaming}
              resetToken={draftResetToken}
              onBack={() => setStudioDraftId(null)}
              onRename={(title) => void handleRenameDraft(title)}
              onSetOutline={(sections) => void handleSetDraftOutline(sections)}
              onApproveOutline={() => void handleApproveOutline()}
              onSave={handleSaveDraft}
              onUnpin={(blockId) => void handleUnpinBlock(blockId)}
              onSelectionRequest={handleDraftSelection}
              onExport={(format) => void handleExportDraft(format)}
              exporting={exportingDraft}
              preview={draftPreview}
            />
          </section>
        ) : studio && activeDeck ? (
          <section className="doc-panel deck-panel" aria-label={t('slides.workspace.ariaLabel')}>
            <DeckWorkspace
              layout="studio"
              onBack={() => setStudioDeckId(null)}
              madeFromChat={madeFromChatDeckId === activeDeck.id}
              onUndoStart={() => void handleUndoStartDeck()}
              onSlotSelected={(slideId, index) => {
                setDockTab('script');
                setScriptFocus({ slideId, index, nonce: Date.now() });
              }}
              onOpenScriptFind={() => {
                setDockTab('script');
                setScriptFindToken((n) => n + 1);
              }}
              slideRequest={stageSlideRequest}
              onSlideChange={(i) => {
                stageIndexRef.current = i;
              }}
              onPresent={startPresenting}
              onExport={(kind) => void handleExportDeck(kind)}
              exporting={exportingDeck}
              deck={activeDeck}
              loading={deckLoading}
              busyTool={deckBusyTool}
              colorScheme={effectiveTheme}
              onRename={(title) => void handleRenameDeck(title)}
              onSetTheme={(name, css) => void handleSetDeckTheme(name, css)}
              onSetStoryline={(items) => void handleSetDeckStoryline(items)}
              onBuild={() => void handleBuildDeck()}
              onListSnapshots={handleListDeckSnapshots}
              onRestore={handleRestoreDeck}
              historyRevision={deckHistoryRevision}
              savedThemes={savedSlideThemes}
              onEditWords={handleEditWords}
              onSetPinned={handleSetPinned}
              onInsertBullet={handleInsertBullet}
              onRemoveBullet={handleRemoveBullet}
              onReplace={handleReplaceInDeck}
              onAskToFix={(prompt) => setPendingSendText(appPrompt(t('slides.note.fixOverflow'), prompt))}
              onOverflowChange={setDeckOverflow}
            />
          </section>
        ) : (
        <DocumentPanel
          inspectorTabs={
            <InspectorTabs
              tab={inspectorTab}
              onTab={(tab) => openInspector(tab)}
              counts={inspectorCounts}
              hasPage={panelHasContent}
              onClose={closeInspector}
            />
          }
          inspectorView={
            inspectorTab === 'activity' ? (
              <ActivityView
                turns={transcript.turns}
                focusTurnId={focusTurnId}
                onSelectTurn={setFocusTurnId}
                networkLog={chatArtifacts.flatMap((a) => readArtifactNetworkLog(artifactPrincipal(a.id)))}
              />
            ) : inspectorTab === 'sources' ? (
              <SourcesView
                turns={transcript.turns}
                knowledgeCitations={transcript.citations}
                onStatus={setStatusMessage}
              />
            ) : undefined
          }
          onAskToFix={(prompt) => chatViewRef.current?.insertPrompt(prompt)}
          artifact={activeArtifact}
          pendingArtifact={pendingArtifact}
          openArtifacts={openArtifacts}
          fileStateMap={fileStateMap}
          activeFileState={activeFileState}
          readLiveDocument={() => chatViewRef.current?.readActiveDocumentWrite() ?? null}
          allowlist={settings.artifactRemoteAllowlist}
          styledPreview={settings.artifactStyledPreview}
          effectiveTheme={effectiveTheme}
          docTab={docTab}
          onSelectTab={setDocTab}
          onOpenArtifact={(id) => void handleOpenArtifact(id)}
          onCloseTab={handleCloseArtifactTab}
          onCollapsePanel={handleCollapseDocPanel}
          expanded={panelExpanded}
          onToggleExpand={panelOverlay.narrow ? undefined : toggleArtifactExpand}
          onDismissPending={() => setPendingArtifact(null)}
          onSaveContent={(artifactId, content, mimeType) => handleSaveContent(artifactId, content, mimeType)}
          onExport={(artifactId, includeMetadata) => handleExport(artifactId, includeMetadata)}
          onSaveAsApp={(artifact, html) =>
            setAppDetailsTarget({ mode: 'save', artifactId: artifact.id, title: artifact.title, html })
          }
          onRenameArtifact={handleRenameArtifact}
          onStatus={setStatusMessage}
          logoSrc={brandLogo ?? undefined}
          activeBrandConfig={brandConfig}
          onBrandApplied={setBrandConfig}
          brandingEnabled={settings.brandingEnabled}
          networkPolicyKey={`${settings.localOnly}:${settings.artifactNetworkEnabled}`}
          onOpenIdeas={openIdeas}
        />
        )}
      </div>
      </div>

      {presenting && activeDeck && presentStart != null && (
        <PresentationView
          deck={activeDeck}
          startIndex={presentStart}
          colorScheme={effectiveTheme}
          onExit={() => setPresentStart(null)}
        />
      )}

      <ShortcutsSheet open={shortcutsOpen} onClose={closeShortcuts} />
      <AppDetailsDialog
        target={appDetailsTarget}
        onClose={() => setAppDetailsTarget(null)}
        onSaved={(app) => {
          setAppDetailsTarget(null);
          void refreshSavedApps();
          setStatusMessage(t('apps.status.saved', { name: app.name }));
        }}
      />

      {/* Closes whichever side column is showing as an overlay (workspace.css). */}
      <div className="overlay-scrim" aria-hidden="true" onClick={closeOverlays} />

      {dropHovering && (
        <div className="kb-drop-overlay" aria-hidden="true">
          <span>{t('shell.documentsSheet.dropHint')}</span>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={() => void (destination === 'home' ? openFreshChat() : handleNewChat())}
        onOpenSettings={(section) => openSettings(section as SettingsSection | undefined)}
        onToggleTheme={handleToggleTheme}
        onOpenShortcuts={openShortcuts}
        onOpenIdeas={openIdeas}
        onOpenWorkflows={() => setDestination('workflows')}
        onNavigate={navigateTo}
        onNewDeck={openSlidesList}
        onNewDraft={openWritingList}
        onToggleArtifactExpand={toggleArtifactExpand}
        onToggleDocPanel={toggleDocPanelView}
        onToggleSidebar={toggleSidebarView}
        onToggleWebSearch={() => chatViewRef.current?.toggleWebSearch()}
        onForkConversationHere={() => {
          void chatViewRef.current?.forkConversationHere().then((ok) => {
            if (ok) setStatus(makeStatus(t('app.status.conversationForked'), 'success'));
          });
        }}
        onEditLastUserMessage={() => {
          const ok = chatViewRef.current?.editLastUserMessage() ?? false;
          if (!ok) setStatus(makeStatus(t('app.status.noUserMessageToEdit'), 'warning'));
        }}
        onOpenChatSettings={() => {
          const ok = chatViewRef.current?.openChatSettings() ?? false;
          if (!ok) setStatus(makeStatus(t('app.status.chatSettingsUnavailable'), 'warning'));
        }}
        onRenameChat={() => handleRenameChat()}
        onPinChat={() => {
          if (activeConversationId) {
            void handlePinConversation(activeConversationId, !activeConversationSummary?.pinnedAt);
          }
        }}
        onArchiveChat={() => {
          if (activeConversationId) {
            void handleArchiveConversation(
              activeConversationId,
              !activeConversationSummary?.archivedAt,
            );
          }
        }}
        activePinned={Boolean(activeConversationSummary?.pinnedAt)}
        activeArchived={Boolean(activeConversationSummary?.archivedAt)}
        onExportDiagnostics={() => void handleExportDiagnostics()}
        onCopyConversationAsMarkdown={() => void handleCopyConversationAsMarkdown()}
        onExportConversationMarkdown={() => void handleExportConversation('markdown')}
        onExportConversationJson={() => void handleExportConversation('json')}
        onDeleteChat={handleDeleteChatRequest}
        onDeleteAllHistory={handleDeleteAllHistory}
        onSelectModel={handleSelectModel}
        conversations={paletteConversations}
        artifacts={artifacts}
        onOpenArtifact={(id) => void handleOpenArtifact(id)}
        onSelectConversation={handleSelectConversation}
        onSearchMessages={(query) => searchMessages({ query })}
        onSelectSearchResult={handleSelectSearchResult}
      />

      {renameDialogOpen && (
        <div
          className="cu-dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRenameDialogOpen(false);
          }}
        >
          <div
            className="cu-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('app.renameChat.ariaLabel')}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 className="cu-dialog-title">{t('app.renameChat.title')}</h2>
            <div className="cu-dialog-body">{t('app.renameChat.body')}</div>
            <label className="cu-dialog-phrase">
              <span>{t('app.renameChat.fieldLabel')}</span>
              <input
                autoFocus
                type="text"
                value={renameValue}
                aria-label={t('app.renameChat.inputAriaLabel')}
                autoComplete="off"
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitRenameChat();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenameDialogOpen(false);
                  }
                }}
              />
            </label>
            <div className="cu-dialog-actions">
              <button className="btn ghost" type="button" onClick={() => setRenameDialogOpen(false)}>
                {t('common.actions.cancel')}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!renameValue.trim()}
                onClick={() => void commitRenameChat()}
              >
                {t('common.actions.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId != null}
        // Now that any row can be deleted from the sidebar — not just the open
        // one — the dialog has to say which chat it means.
        title={t('app.deleteConversation.title', {
          hasTitle: confirmDeleteTitle ? 'yes' : 'no',
          title: confirmDeleteTitle ?? '',
        })}
        // `delete_with_files` removes artifact files and attachment blobs from
        // disk alongside the rows, so the dialog names both. Attachments shared
        // with another chat are kept — hence "its".
        description={t('app.deleteConversation.description')}
        confirmLabel={t('common.actions.delete')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void performDeleteConversation(id);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteAll}
        title={t('app.deleteAllHistory.title')}
        // Usage history is in the list because `usage_summary` cascades from
        // `conversations` — deleting your chats silently takes your token and
        // cost record with them, which the old "App settings are preserved"
        // line implied was safe. Prompts have no such foreign key and survive.
        description={t('app.deleteAllHistory.description')}
        confirmLabel={t('app.deleteAllHistory.confirmLabel')}
        cancelLabel={t('common.actions.cancel')}
        confirmPhrase={t('app.deleteAllHistory.confirmPhrase')}
        confirmPhraseHint={tr('common.confirm.typePhrase', {
          phrase: t('app.deleteAllHistory.confirmPhrase'),
        })}
        confirmPhraseInputLabel={t('common.confirm.typePhraseLabel', {
          phrase: t('app.deleteAllHistory.confirmPhrase'),
        })}
        onCancel={() => setConfirmDeleteAll(false)}
        onConfirm={() => {
          setConfirmDeleteAll(false);
          void performDeleteAllHistory();
        }}
      />
    </div>
  );
}

async function updateSettingsPersisted(next: AppSettings): Promise<void> {
  try {
    await updateSettings(next);
  } catch {
    /* persistence failures surface via status; ignore here */
  }
}
