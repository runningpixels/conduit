import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppPaths, AppSettings, Artifact, ArtifactContent, BrandConfig, ConversationSummary, FileState, OnboardingState, ProviderDescriptor, SearchResult } from './ipc/contracts';
import type { ArtifactCandidate } from './chat/artifactCandidates';
import type { StatusState } from './chat/statusTypes';
import { ToastStack } from './workspace/ToastStack';
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
  listConnectorGrants,
  listProviderDescriptors,
  listProviderModels,
  revealArtifactsDir,
  searchMessages,
  setArtifactContent,
  setArtifactTitle,
  updateSettings,
} from './ipc/client';
import { ChatView, type ChatViewHandle } from './chat/ChatView';
import {
  documentToolArtifactKind,
  hadSuccessfulDocumentToolCalls,
  isDocumentCreateTool,
  resolveDocumentArtifactId,
  type DocumentToolActivity,
} from './chat/agentTools';
import type { AssistantStreamState } from './chat/streamState';
import {
  resolveFailedPendingArtifact,
  type PendingArtifact,
} from './artifacts/pendingArtifact';
import { applyTheme, resolveTheme, watchSystemTheme } from './theme';
import { applyBrand, applyBrandTheme, clearBrand } from './brand/applyBrand';
import { fetchBrandLogo } from './brand/logo';
import { providerDisplayName, providerHueId } from './lib/providerIdentity';
import { MainHead } from './workspace/MainHead';
import { TitleBar } from './shell/TitleBar';
import { deriveConnectionState } from './lib/connectionState';
import { SidebarIcon } from './icons';
import { DocumentPanel } from './workspace/DocumentPanel';
import { Sidebar } from './shell/Sidebar';
import { SettingsSheet, type SettingsSection } from './shell/SettingsSheet';
import { applyUiPrefs } from './shell/uiPrefs';
import { useColumnResize, useDocPanelCollapse, useSidebarCollapse } from './workspace/useLayout';
import { useHotkeys } from './workspace/useHotkeys';
import { CommandPalette } from './workspace/CommandPalette';
import { refreshArtifactList } from './workspace/useArtifacts';
import { modShortcutHint } from './lib/shortcuts';
import { Onboarding, MigrationRecoveryNotice } from './onboarding/Onboarding';
import { ConfirmDialog } from '@conduit/ui';
import {
  exportConversationDialog,
  exportDiagnostics,
  forkConversation,
  previewConversationExport,
  setConversationTitle,
} from './ipc/client';

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
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: false,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
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

export default function App() {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [status, setStatus] = useState<StatusState | null>(makeStatus('Booting desktop shell', 'active'));
  const [boundaryOk, setBoundaryOk] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convoProviders, setConvoProviders] = useState<Record<string, string>>(readConvoProviders);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [connectorCount, setConnectorCount] = useState<number | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [toasts, setToasts] = useState<StatusState[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteConversations, setPaletteConversations] = useState<{ id: string; title: string }[]>([]);
  const chatViewRef = useRef<ChatViewHandle>(null);

  const { onPointerDown, onKeyDown: onResizeKeyDown, ariaValueNow, ariaValueMin, ariaValueMax } =
    useColumnResize();
  const { toggle: toggleSidebar } = useSidebarCollapse();
  const { collapsed: docPanelCollapsed, collapse: collapseDocPanel, expand: expandDocPanel, toggle: toggleDocPanel } = useDocPanelCollapse();
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

  // Auto-dismiss warning/success toasts; errors stay until dismissed.
  useEffect(() => {
    const timers = toasts
      .filter((t) => TOAST_DISMISS_MS[t.kind] != null)
      .map((t) =>
        window.setTimeout(() => dismissToast(t.timestamp), TOAST_DISMISS_MS[t.kind]!),
      );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [toasts, dismissToast]);

  const handleCollapseDocPanel = useCallback(() => {
    collapseDocPanel();
    try {
      if (localStorage.getItem(DOC_PANEL_HINT_KEY) === '1') return;
      localStorage.setItem(DOC_PANEL_HINT_KEY, '1');
      const hint = makeStatus(
        `Artifact panel hidden. Press ${modShortcutHint('J')} or use the panel button in the top bar to bring it back.`,
        'success',
      );
      setToasts((current) => [...current.slice(-4), hint]);
    } catch {
      /* ignore storage failures */
    }
  }, [collapseDocPanel]);

  const refreshConversations = useCallback(async () => {
    try {
      const listed = await listConversations();
      setConversations(listed);
      return listed;
    } catch {
      setConversations([]);
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
      setActiveConversationSummary(conversationsList.find((c) => c.id === conversationId) ?? null);
    } catch {
      setActiveConversationSummary(null);
    }
  }, []);

  useEffect(() => {
    void refreshActiveConversationSummary(activeConversationId);
  }, [activeConversationId, refreshActiveConversationSummary]);

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

  const handleDocumentToolActivity = useCallback(
    (activity: DocumentToolActivity) => {
      if (activity.phase === 'error') {
        // Freeze the panel on the failure rather than dropping it: a skeleton
        // that silently disappears reads as "still thinking about it".
        setPendingArtifact((current) =>
          current ? { ...current, status: 'failed', error: activity.error } : null,
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
        const [loadedPaths, loadedSettings, onboardingState, loadedBrand, loadedLogo] = await Promise.all([
          getAppPaths(),
          getSettings(),
          getOnboardingState(),
          getBrandConfig(),
          fetchBrandLogo(),
        ]);
        setPaths(loadedPaths);
        setSettings(loadedSettings);
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
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to load desktop state', 'error'));
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
      setStatus(makeStatus('Started a new chat', 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to create chat', 'error'));
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
        setStatus(makeStatus('Forked conversation', 'success'));
      } catch (error) {
        setStatus(
          makeStatus(error instanceof Error ? error.message : 'Failed to fork conversation', 'error'),
        );
      }
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
          if (remaining.length > 0) {
            setActiveConversationId(remaining[0].id);
          } else {
            const created = await createConversation();
            setActiveConversationId(created.id);
          }
          clearWorkspaceArtifactSelection();
        }
        await refreshConversations();
        setStatus(makeStatus('Conversation deleted', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to delete conversation', 'error'));
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
      setStatus(makeStatus('All conversation history deleted', 'success'));
    } catch (error) {
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to delete history', 'error'));
    }
  }, [clearWorkspaceArtifactSelection, refreshConversations]);

  const refreshArtifacts = useCallback(async (conversationId: string): Promise<Artifact[]> => {
    try {
      const { artifacts: listed, fileStateMap: nextMap } = await refreshArtifactList(conversationId);
      setArtifacts(listed);
      setFileStateMap(nextMap);
      return listed;
    } catch (error) {
      setArtifacts([]);
      setFileStateMap({});
      setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to load artifacts', 'error'));
      return [];
    }
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    void refreshArtifacts(activeConversationId);
  }, [activeConversationId, refreshArtifacts]);

  const addOpenArtifactId = useCallback((artifactId: string) => {
    setOpenArtifactIds((current) => (current.includes(artifactId) ? current : [...current, artifactId]));
  }, []);

  const handleOpenArtifact = useCallback(
    async (artifactId: string) => {
      try {
        const got = await getArtifact(artifactId);
        if (!got) return;
        expandDocPanel();
        addOpenArtifactId(artifactId);
        setActiveArtifact(got);
        const state = await checkArtifactFileState(artifactId);
        setFileStateMap((current) => ({ ...current, [artifactId]: state }));
        setDocTab('preview');
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to open artifact', 'error'));
      }
    },
    [addOpenArtifactId, expandDocPanel],
  );

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

      // This handler now runs for every ended turn, failures included, because
      // it owns the only reset of the pending-artifact state. Nothing below may
      // leave the panel generating.
      if (!hadSuccessfulDocumentToolCalls(streamState)) {
        // The document was asked for and never arrived — freeze the panel on
        // the reason, or drop it when there is nothing to explain.
        setPendingArtifact((current) => resolveFailedPendingArtifact(current, streamState));
        return;
      }

      const listed = await refreshArtifacts(activeConversationId);
      const artifactId = resolveDocumentArtifactId(streamState, listed);
      if (artifactId) {
        await handleOpenArtifact(artifactId);
      }
      setPendingArtifact(null);
      setStatus(makeStatus('Document updated', 'success'));
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
        setStatus(makeStatus('Saved artifact', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to save artifact', 'error'));
        throw error;
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  const handleExport = useCallback(
    async (artifactId: string, includeMetadata: boolean) => {
      try {
        const result = await exportArtifact(artifactId, includeMetadata);
        setStatus(makeStatus(`Exported to ${result.exportedTo}`, 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to export artifact', 'error'));
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
      if (docPanelCollapsed) return;
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
  }, [activeArtifact, docPanelCollapsed]);

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
        setStatus(makeStatus('Promoted to artifact', 'success'));
      } catch (error) {
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to promote artifact', 'error'));
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
        setStatus(makeStatus(error instanceof Error ? error.message : 'Failed to rename artifact', 'error'));
      }
    },
    [activeConversationId, refreshArtifacts],
  );

  // V7 ⌘K — rename this chat (inline dialog, preserved capability).
  const handleRenameChat = useCallback(() => {
    setRenameValue(activeConversationSummary?.displayTitle ?? '');
    setRenameDialogOpen(true);
  }, [activeConversationSummary]);

  const commitRenameChat = useCallback(async () => {
    const title = renameValue.trim();
    setRenameDialogOpen(false);
    if (!title || !activeConversationId) return;
    try {
      await setConversationTitle(activeConversationId, title);
      await refreshConversations();
      await refreshActiveConversationSummary(activeConversationId);
      setStatus(makeStatus('Conversation renamed', 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : 'Failed to rename conversation', 'error'),
      );
    }
  }, [activeConversationId, renameValue, refreshConversations, refreshActiveConversationSummary]);

  const handleExportDiagnostics = useCallback(async () => {
    try {
      const result = await exportDiagnostics();
      setStatus(makeStatus(`Diagnostics exported to ${result.exportedTo}`, 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : 'Failed to export diagnostics', 'error'),
      );
    }
  }, []);

  const handleCopyConversationAsMarkdown = useCallback(async () => {
    if (!activeConversationId) {
      setStatus(makeStatus('Nothing to copy', 'warning'));
      return;
    }
    try {
      const md = await previewConversationExport(activeConversationId, 'markdown');
      if (!md.trim()) {
        setStatus(makeStatus('Nothing to copy', 'warning'));
        return;
      }
      await navigator.clipboard.writeText(md);
      setStatus(makeStatus('Conversation copied as Markdown', 'success'));
    } catch (error) {
      setStatus(
        makeStatus(error instanceof Error ? error.message : 'Failed to copy conversation', 'error'),
      );
    }
  }, [activeConversationId]);

  const handleExportConversation = useCallback(
    async (format: 'markdown' | 'json') => {
      if (!activeConversationId) {
        setStatus(makeStatus('Nothing to export', 'warning'));
        return;
      }
      try {
        const result = await exportConversationDialog(activeConversationId, format);
        if (result === null) return;
        setStatus(makeStatus(`Exported to ${result.exportedTo}`, 'success'));
      } catch (error) {
        setStatus(
          makeStatus(error instanceof Error ? error.message : 'Failed to export conversation', 'error'),
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
    return watchSystemTheme(settings.theme, () => setEffectiveTheme(resolveTheme(settings.theme)));
  }, [settings.theme]);

  // A brand palette is inline CSS on <html>, which beats every stylesheet
  // rule including [data-theme="light"] — so it has to be re-applied for the
  // *resolved* theme on every change, not just when AppSettings.theme is
  // edited. Keyed on effectiveTheme rather than settings.theme so this also
  // fires when watchSystemTheme flips the OS preference while mode ===
  // 'system', which changes effectiveTheme without changing settings.theme.
  useEffect(() => {
    if (brandConfig) applyBrandTheme(brandConfig, effectiveTheme);
  }, [brandConfig, effectiveTheme]);

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
  const hiddenArtifactCount = docPanelCollapsed ? artifacts.length : 0;

  const openSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section ?? 'providers');
    setSettingsOpen(true);
  }, []);

  const handleRevealWorkspace = useCallback(() => {
    void revealArtifactsDir().catch((error) => {
      setStatus(
        makeStatus(error instanceof Error ? error.message : 'Could not reveal artifacts folder', 'error'),
      );
    });
  }, []);

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
    void listConversations()
      .then((rows) => {
        setPaletteConversations(rows.map((r) => ({ id: r.id, title: r.displayTitle })));
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
      setStatusMessage(makeStatus(`Switched to ${providerDisplayName(next.id)}`, 'success'));
    } catch (error) {
      setStatusMessage(
        makeStatus(error instanceof Error ? error.message : 'Failed to switch provider', 'error'),
      );
    }
  }, [settings, setStatusMessage]);

  const hotkeyHandlers = useMemo(
    () => ({
      newChat: () => {
        void handleNewChat();
      },
      settings: () => openSettings(),
      toggleSidebar: () => toggleSidebar(),
      toggleDocPanel: () => toggleDocPanel(),
      historySearch: () => openPalette(),
      cycleProvider: () => {
        void handleCycleProvider();
      },
      toggleWebSearch: () => {
        chatViewRef.current?.toggleWebSearch();
      },
      forkConversationHere: () => {
        void chatViewRef.current?.forkConversationHere().then((ok) => {
          if (ok) setStatus(makeStatus('Forked conversation', 'success'));
        });
      },
      copyLastAssistant: () => {
        void chatViewRef.current?.copyLastAssistantMessage().then((ok) => {
          if (ok) setStatus(makeStatus('Copied last assistant message', 'success'));
          else setStatus(makeStatus('Nothing to copy', 'warning'));
        });
      },
      escape: () => {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (confirmDeleteId != null || confirmDeleteAll) {
          setConfirmDeleteId(null);
          setConfirmDeleteAll(false);
          return;
        }
        const active = document.activeElement;
        if (
          active instanceof HTMLTextAreaElement &&
          active.getAttribute('aria-label') === 'Message the active provider' &&
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
      openPalette,
      openSettings,
      paletteOpen,
      settingsOpen,
      toggleDocPanel,
      toggleSidebar,
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
  if (onboarding?.migrationRecovery) {
    return (
      <div className="app" id="app">
        <TitleBar />
        <MigrationRecoveryNotice
          recovery={onboarding.migrationRecovery}
          onStatus={setStatusMessage}
          onDismissed={() => void refreshOnboarding()}
        />
      </div>
    );
  }
  if (onboarding && (!onboarding.onboardingCompleted || !onboarding.hasProviderCredential)) {
    return (
      <div className="app" id="app">
        <TitleBar />
        <Onboarding
          settings={settings}
          onSettingsChange={setSettings}
          onStatus={setStatusMessage}
          status={status}
          onComplete={() => void refreshOnboarding()}
        />
      </div>
    );
  }

  return (
    <div className="app" id="app">
      {/* The window's caption row: drag region + minimise/maximise/close.
          Without it a frameless window cannot be moved or closed at all
          (shellContract.test.ts pins this). */}
      <TitleBar />

      {/* Only pointer affordance for reopening a collapsed sidebar; CSS
          reveals it on html[data-sidebar="closed"]. */}
      <button
        className="sb-reveal"
        type="button"
        aria-label="Open sidebar"
        title={`Open sidebar  ${modShortcutHint('\\')}`}
        onClick={() => toggleSidebar()}
      >
        <SidebarIcon />
      </button>

      <div className="body">
        <Sidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          convoProviders={convoProviders}
          workspaceLabel={workspaceLabel}
          localOnly={settings.localOnly}
          providerCount={providers.length > 0 ? providers.length : undefined}
          connectorCount={connectorCount}
          onSelectConversation={handleSelectConversation}
          onNewChat={() => void handleNewChat()}
          onOpenPalette={openPalette}
          onCollapse={() => toggleSidebar()}
          onRevealWorkspace={handleRevealWorkspace}
          onOpenSettings={(section) => openSettings(section as SettingsSection)}
          onExportDiagnostics={() => void handleExportDiagnostics()}
          onDeleteConversation={handleDeleteConversation}
          onDeleteAllHistory={handleDeleteAllHistory}
          logoSrc={brandLogo ?? undefined}
        />

        {/* The full-height "Artifacts" rail that used to live here was a second
            affordance for the title strip's own panel toggle. It is gone; the
            toggle carries the artifact count so the panel stays discoverable. */}
        <main className="center">
          <MainHead
            title={activeConversationSummary?.displayTitle}
            effectiveTheme={effectiveTheme}
            onToggleTheme={handleToggleTheme}
            panelOpen={!docPanelCollapsed}
            onTogglePanel={toggleDocPanel}
            hiddenArtifactCount={hiddenArtifactCount}
          />
          <ChatView
            ref={chatViewRef}
            settings={settings}
            onSelectModel={handleSelectModel}
            onStatus={setStatusMessage}
            conversationId={activeConversationId}
            artifacts={artifacts}
            activeArtifact={activeArtifact}
            fileStateMap={fileStateMap}
            onPromoteArtifact={(messageId, candidate) => void handlePromoteArtifact(messageId, candidate)}
            onOpenArtifact={(id) => void handleOpenArtifact(id)}
            onChatTurnComplete={(streamState) => void handleChatTurnComplete(streamState)}
            onDocumentToolActivity={handleDocumentToolActivity}
            onForkConversation={(convId, msgId) => void handleForkConversation(convId, msgId)}
            onOpenSettings={(section) => openSettings(section as SettingsSection | undefined)}
            convoProviders={convoProviders}
          />
        </main>

        <div
          className="resize-handle"
          id="columnResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize document column"
          aria-valuenow={ariaValueNow}
          aria-valuemin={ariaValueMin}
          aria-valuemax={ariaValueMax}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onResizeKeyDown}
        />

        <DocumentPanel
          artifact={activeArtifact}
          pendingArtifact={pendingArtifact}
          openArtifacts={openArtifacts}
          fileStateMap={fileStateMap}
          activeFileState={activeFileState}
          allowlist={settings.artifactRemoteAllowlist}
          styledPreview={settings.artifactStyledPreview}
          effectiveTheme={effectiveTheme}
          docTab={docTab}
          onSelectTab={setDocTab}
          onOpenArtifact={(id) => void handleOpenArtifact(id)}
          onCloseTab={handleCloseArtifactTab}
          onCollapsePanel={handleCollapseDocPanel}
          onDismissPending={() => setPendingArtifact(null)}
          onSaveContent={(artifactId, content, mimeType) => handleSaveContent(artifactId, content, mimeType)}
          onExport={(artifactId, includeMetadata) => handleExport(artifactId, includeMetadata)}
          onRenameArtifact={handleRenameArtifact}
          onStatus={setStatusMessage}
          logoSrc={brandLogo ?? undefined}
          activeBrandConfig={brandConfig}
          onBrandApplied={setBrandConfig}
          brandingEnabled={settings.brandingEnabled}
        />
      </div>

      <SettingsSheet
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
        paths={paths}
        onStatus={setStatusMessage}
        connectionState={connectionState}
        boundaryOk={boundaryOk}
        hasCredential={hasCredential}
        onInsertPrompt={(text) => chatViewRef.current?.insertPrompt(text)}
        onBrandChange={(config, logo) => {
          setBrandConfig(config);
          setBrandLogo(logo);
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={() => void handleNewChat()}
        onOpenSettings={(section) => openSettings(section as SettingsSection | undefined)}
        onToggleTheme={handleToggleTheme}
        onToggleDocPanel={toggleDocPanel}
        onToggleSidebar={toggleSidebar}
        onToggleWebSearch={() => chatViewRef.current?.toggleWebSearch()}
        onForkConversationHere={() => {
          void chatViewRef.current?.forkConversationHere().then((ok) => {
            if (ok) setStatus(makeStatus('Forked conversation', 'success'));
          });
        }}
        onRenameChat={handleRenameChat}
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
            aria-label="Rename chat"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 className="cu-dialog-title">Rename this chat</h2>
            <div className="cu-dialog-body">Choose a title for this conversation.</div>
            <label className="cu-dialog-phrase">
              <span>Title</span>
              <input
                autoFocus
                type="text"
                value={renameValue}
                aria-label="Conversation title"
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
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!renameValue.trim()}
                onClick={() => void commitRenameChat()}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId != null}
        // Now that any row can be deleted from the sidebar — not just the open
        // one — the dialog has to say which chat it means.
        title={
          confirmDeleteTitle ? `Delete “${confirmDeleteTitle}”?` : 'Delete conversation?'
        }
        // `delete_with_files` removes artifact files and attachment blobs from
        // disk alongside the rows, so the dialog names both. Attachments shared
        // with another chat are kept — hence "its".
        description="Its messages, and the artifacts and attachments stored on disk with them, will be deleted."
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void performDeleteConversation(id);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all conversation history?"
        // Usage history is in the list because `usage_summary` cascades from
        // `conversations` — deleting your chats silently takes your token and
        // cost record with them, which the old "App settings are preserved"
        // line implied was safe. Prompts have no such foreign key and survive.
        description="Every conversation and message will be deleted, along with the artifacts and attachments stored on disk and your usage history. Settings, API keys, and saved prompts are kept."
        confirmLabel="Delete all"
        confirmPhrase="delete all"
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
