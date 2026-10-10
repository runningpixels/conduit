/// One open app: a header Conduit draws (outside the sandbox, so a page can't
/// fake it), the app in the same sandboxed frame as an artifact (ADR-007), and
/// a status strip that always says what the app may reach.
///
/// Network access is ADR-010 unchanged, keyed to the app (`app:<id>`), so a
/// grant made here belongs to the app and survives the chat it came from.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { HtmlArtifactRenderer, type ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { declaredCapabilities, declaredHosts, scriptedHosts } from '../artifacts/networkHosts';
import { isHttpOrHttpsUrl } from '../artifacts/externalUrl';
import { useArtifactNetwork } from '../workspace/useArtifactNetwork';
import { usePageBridge } from '../workspace/usePageBridge';
import { usePageLlm } from '../workspace/usePageLlm';
import { PageLlmBanner, PageLlmDialog } from '../workspace/PageLlmConsent';
import type { PageBridgeHandler } from '../artifacts/pageBridge';
import {
  ArtifactNetworkBanner,
  ArtifactNetworkChip,
  ArtifactNetworkDialog,
  FullAccessBanner,
  FullAccessDialog,
  useSiteLabel,
} from '../workspace/ArtifactNetwork';
import { OpenExternalLinkDialog } from '../workspace/OpenExternalLinkDialog';
import { Menu } from '../workspace/Menu';
import { ChevronLeft, ModelIcon, MoreIcon, PencilIcon, RetryIcon, SettingsIcon, SlidersIcon, TrashIcon } from '../icons';
import {
  appPrincipal,
  getAppInputs,
  openApp,
  openExternalUrl,
  pageStorageClear,
  pageStorageUsage,
  type PageStorageUsage,
} from '../ipc/client';
import type { AppDetail, AppSummary } from '../ipc/contracts';
import { AppTile } from './AppTile';
import { AppInputsDialog } from './AppInputsDialog';
import { AppSettingsView } from './AppSettingsView';

export interface AppViewProps {
  appId: string;
  allowlist: string[];
  /** The "styled preview" setting, so an app looks as its page did in the chat. */
  styledPreview: boolean;
  colorScheme: ArtifactColorScheme;
  /** Changes when local-only or the artifact-network setting changes. */
  networkPolicyKey?: string;
  /** Bumped by the page after an edit or update, to reload the app. */
  revision: number;
  onBack: () => void;
  onEdit: (app: AppSummary) => void;
  onUpdateFromSource: (app: AppSummary) => void;
  onDelete: (app: AppSummary) => void;
  onStatus?: (message: string) => void;
}

export function AppView({
  appId,
  allowlist,
  styledPreview,
  colorScheme,
  networkPolicyKey,
  revision,
  onBack,
  onEdit,
  onUpdateFromSource,
  onDelete,
  onStatus,
}: AppViewProps) {
  const t = useT();
  const fmt = useFormatters();
  const siteLabel = useSiteLabel();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [storageUsage, setStorageUsage] = useState<PageStorageUsage | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // The settings page replaces the frame area while open. The frame itself
  // stays mounted (hidden), so an app mid-task keeps its state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setSettingsOpen(false), [appId]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);
  // Bumped after "Clear data" so the frame's key changes and it reloads with
  // an empty store, the same way a source update bumps `revision`.
  const [clearRevision, setClearRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    openApp(appId)
      .then((detail) => {
        if (!cancelled) setApp(detail);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, revision]);

  // Launch inputs (ADR-013): the effective values (stored-or-default), fetched
  // once per `app` load. `null` while that fetch is out — the frame is held
  // back until it lands, so `window.conduit.inputs` is never baked with a
  // placeholder the page would have to un-learn a moment later.
  const [inputValues, setInputValues] = useState<Record<string, unknown> | null>(null);
  const [inputsRevision, setInputsRevision] = useState(0);
  const [inputsDialogOpen, setInputsDialogOpen] = useState(false);
  // Which app id the dialog has already auto-opened for — an app whose
  // required input the user dismissed without filling should not re-open the
  // dialog on every render, only the first time this app is seen open.
  const autoOpenedInputsForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!app) {
      setInputValues(null);
      return;
    }
    if (app.inputs.length === 0) {
      setInputValues({});
      return;
    }
    let cancelled = false;
    setInputValues(null);
    getAppInputs(app.id)
      .then((values) => {
        if (!cancelled) setInputValues(values);
      })
      .catch(() => {
        if (!cancelled) setInputValues({});
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  useEffect(() => {
    if (app?.inputsMissing && autoOpenedInputsForRef.current !== app.id) {
      autoOpenedInputsForRef.current = app.id;
      setInputsDialogOpen(true);
    }
  }, [app]);

  const handleInputsSaved = useCallback((values: Record<string, unknown>) => {
    setInputValues(values);
    setInputsRevision((r) => r + 1);
    setInputsDialogOpen(false);
  }, []);

  const html = app?.html ?? '';
  const network = useArtifactNetwork(app ? appPrincipal(app.id) : null, html, networkPolicyKey);
  const llm = usePageLlm(app ? appPrincipal(app.id) : null);
  const pageBridge = usePageBridge(app ? appPrincipal(app.id) : null, llm.handler);
  // After the page writes, re-read how much it stores — debounced, since a
  // tracker may save on every keystroke.
  const [writeRevision, setWriteRevision] = useState(0);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
  }, []);
  const bridge = useMemo<PageBridgeHandler | undefined>(() => {
    if (!pageBridge) return undefined;
    return async (method, params) => {
      const outcome = await pageBridge(method, params);
      if (outcome.ok && method !== 'storage.get' && method !== 'storage.keys' && method !== 'llm.complete') {
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(() => setWriteRevision((r) => r + 1), 600);
      }
      return outcome;
    };
  }, [pageBridge]);
  const [llmReviewOpen, setLlmReviewOpen] = useState(false);
  const { decide: decideLlm, refresh: refreshLlm } = llm;
  const handleLlmDecision = useCallback(
    (decision: 'deny' | 'session' | 'page') => {
      setLlmReviewOpen(false);
      void decideLlm(decision);
    },
    [decideLlm],
  );
  useEffect(() => {
    if (!llm.pending) setLlmReviewOpen(false);
  }, [llm.pending]);
  const handleStopModelAccess = useCallback(() => {
    setMenuOpen(false);
    void llm.revoke();
  }, [llm]);
  const declaresStorage = useMemo(() => declaredCapabilities(html).includes('storage'), [html]);
  const declared = useMemo(() => declaredHosts(html), [html]);
  const scripted = useMemo(() => {
    const known = new Set(declared.map((d) => d.origin));
    return scriptedHosts(html).filter((origin) => !known.has(origin));
  }, [html, declared]);
  const pendingOrigins = useMemo(() => network.pending.map((p) => p.origin), [network.pending]);
  const { decide } = network;
  const handleDecision = useCallback(
    (decision: 'deny' | 'session' | 'page', anySite = false) => {
      setReviewOpen(false);
      void decide(pendingOrigins, decision, anySite);
    },
    [decide, pendingOrigins],
  );
  useEffect(() => {
    if (network.pending.length === 0) setReviewOpen(false);
  }, [network.pending.length]);
  // Full web access (ADR-007): offered when the page tried to load something
  // its CSP stopped.
  const [fullAccessReviewOpen, setFullAccessReviewOpen] = useState(false);
  const { allowFullAccess, dismissFullAccess } = network;
  const handleAllowFullAccess = useCallback(() => {
    setFullAccessReviewOpen(false);
    void allowFullAccess();
  }, [allowFullAccess]);
  const handleNotNowFullAccess = useCallback(() => {
    setFullAccessReviewOpen(false);
    dismissFullAccess();
  }, [dismissFullAccess]);

  const handleExternalLink = useCallback((url: string) => {
    if (isHttpOrHttpsUrl(url)) setPendingUrl(url);
  }, []);
  const confirmExternalLink = useCallback(() => {
    const url = pendingUrl;
    setPendingUrl(null);
    if (!url) return;
    openExternalUrl(url).catch((e) => onStatus?.(e instanceof Error ? e.message : String(e)));
  }, [pendingUrl, onStatus]);
  const cancelExternalLink = useCallback(() => setPendingUrl(null), []);

  // How much the page has stored (ADR-012): read on open, after "Clear
  // data", and shortly after the page writes.
  const openedAppId = app?.id;
  useEffect(() => {
    if (!openedAppId || !declaresStorage) {
      setStorageUsage(null);
      return;
    }
    let cancelled = false;
    pageStorageUsage(appPrincipal(openedAppId))
      .then((usage) => {
        if (!cancelled) setStorageUsage(usage);
      })
      .catch(() => {
        if (!cancelled) setStorageUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openedAppId, declaresStorage, clearRevision, writeRevision]);

  const handleClearData = useCallback(async () => {
    setClearConfirmOpen(false);
    if (!app) return;
    try {
      await pageStorageClear(appPrincipal(app.id));
      setClearRevision((r) => r + 1);
      onStatus?.(t('apps.status.cleared', { name: app.name }));
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : String(e));
    }
  }, [app, onStatus, t]);

  if (error) {
    return (
      <section className="app-view">
        <div className="app-view-head">
          <button type="button" className="btn ghost app-view-back" onClick={onBack}>
            <ChevronLeft />
            {t('apps.view.allApps')}
          </button>
        </div>
        <p className="app-view-error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!app || inputValues === null) {
    return (
      <section className="app-view" aria-busy="true">
        <div className="app-view-head">
          <button type="button" className="btn ghost app-view-back" onClick={onBack}>
            <ChevronLeft />
            {t('apps.view.allApps')}
          </button>
        </div>
      </section>
    );
  }

  // AppDetail is the summary's fields plus the page (flattened in Rust).
  const summary: AppSummary = app;
  const reachable = [...(network.state?.always ?? []), ...(network.state?.session ?? [])];

  return (
    <section className="app-view" aria-labelledby={`app-view-title-${summary.id}`}>
      <header className="app-view-head">
        <button type="button" className="btn ghost app-view-back" onClick={onBack}>
          <ChevronLeft />
          {t('apps.view.allApps')}
        </button>
        <span className="app-view-sep" aria-hidden="true" />
        <AppTile icon={summary.icon} name={summary.name} category={summary.category} size="sm" />
        <h2 id={`app-view-title-${summary.id}`} className="app-view-title" title={summary.name}>
          {summary.name}
        </h2>
        <span className="app-view-version">v{summary.version}</span>
        <span className="app-view-spacer" />
        {summary.sourceChanged && (
          <button type="button" className="btn app-view-update" onClick={() => onUpdateFromSource(summary)}>
            <RetryIcon />
            {t('apps.card.update')}
          </button>
        )}
        {app.inputs.length > 0 && (
          <button type="button" className="btn ghost app-view-inputs" onClick={() => setInputsDialogOpen(true)}>
            <SlidersIcon />
            {t('apps.view.inputs')}
          </button>
        )}
        <ArtifactNetworkChip
          declared={declared}
          scripted={scripted}
          state={network.state}
          denied={network.denied}
          log={network.log}
          onRevoke={(origin) => void network.revoke(origin)}
        />
        <button
          ref={settingsButtonRef}
          type="button"
          className="icon-btn"
          aria-label={t('apps.view.settings')}
          aria-pressed={settingsOpen}
          title={t('apps.view.settings')}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
        </button>
        <button
          ref={menuTriggerRef}
          type="button"
          className="icon-btn"
          aria-label={t('apps.view.moreActions')}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreIcon />
        </button>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          triggerRef={menuTriggerRef}
          className="menu app-view-menu"
          label={t('apps.view.moreActions')}
          dismissOnOutsidePress
        >
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onEdit(summary);
            }}
          >
            <PencilIcon />
            {t('apps.menu.edit')}
          </button>
          {summary.sourceChanged && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onUpdateFromSource(summary);
              }}
            >
              <RetryIcon />
              {t('apps.menu.update')}
            </button>
          )}
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon />
            {t('apps.view.settings')}
          </button>
          {declaresStorage && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setClearConfirmOpen(true);
              }}
            >
              <TrashIcon />
              {t('apps.menu.clearData')}
            </button>
          )}
          {llm.state?.granted && (
            <button type="button" className="menu-item" role="menuitem" onClick={handleStopModelAccess}>
              <ModelIcon />
              {t('apps.menu.stopModelAccess')}
            </button>
          )}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="menu-item danger"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onDelete(summary);
            }}
          >
            <TrashIcon />
            {t('apps.menu.delete')}
          </button>
        </Menu>
      </header>

      <ArtifactNetworkBanner
        pending={network.pending}
        onReview={() => setReviewOpen(true)}
        onNotNow={() => handleDecision('deny')}
      />
      <FullAccessBanner
        blocked={network.fullAccessRequest}
        onReview={() => setFullAccessReviewOpen(true)}
        onNotNow={handleNotNowFullAccess}
      />
      <PageLlmBanner
        pending={llm.pending}
        onReview={() => setLlmReviewOpen(true)}
        onNotNow={() => handleLlmDecision('deny')}
      />

      {settingsOpen && (
        <AppSettingsView
          appId={summary.id}
          appName={summary.name}
          sites={[
            ...(network.state?.always ?? []).map((origin) => ({ origin, scope: 'page' as const })),
            ...(network.state?.session ?? [])
              .filter((origin) => !(network.state?.always ?? []).includes(origin))
              .map((origin) => ({ origin, scope: 'session' as const })),
          ]}
          siteLabel={siteLabel}
          onRevokeSite={network.revoke}
          onLlmRevoked={() => void refreshLlm()}
          onClearData={() => setClearConfirmOpen(true)}
          dataRevision={clearRevision + writeRevision}
          onStatus={onStatus}
          onBack={closeSettings}
        />
      )}
      <div className="app-view-frame" hidden={settingsOpen}>
        {/* Waits for the page's access to be known, so it loads once with the
            right policy. */}
        {network.fullAccess !== undefined && (
          <HtmlArtifactRenderer
            key={`${summary.id}:${summary.version}:${revision}:${clearRevision}:${network.reloadToken}`}
            html={html}
            allowlist={allowlist}
            styledPreview={styledPreview}
            colorScheme={colorScheme}
            onExternalLink={handleExternalLink}
            network={network.handler}
            bridge={bridge}
            inputValues={inputValues}
            inputsRevision={inputsRevision}
            fullWebAccess={network.fullAccess}
            onBlockedLoad={network.reportBlocked}
          />
        )}
      </div>

      <footer className="app-view-strip">
        {summary.hosts.length === 0 && reachable.length === 0 ? (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="off" aria-hidden="true" />
            {t('apps.view.offline')}
          </span>
        ) : network.state?.blockedReason ? (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="off" aria-hidden="true" />
            {t('apps.view.networkBlocked')}
          </span>
        ) : reachable.length > 0 ? (
          <span className="app-view-fact" title={reachable.map(siteLabel).join(', ')}>
            <span className="app-view-dot" data-tone="net" aria-hidden="true" />
            {t('apps.view.reaches', { hosts: reachable.map(siteLabel).join(', ') })}
          </span>
        ) : (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="off" aria-hidden="true" />
            {summary.hosts.length > 0 ? t('apps.view.asksFirst') : t('apps.view.offline')}
          </span>
        )}
        {summary.sourceChanged && (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="warn" aria-hidden="true" />
            {t('apps.card.sourceChanged')}
          </span>
        )}
        {declaresStorage && storageUsage && storageUsage.bytes > 0 && (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="net" aria-hidden="true" />
            {t('apps.view.stores', { size: fmt.size(storageUsage.bytes) })}
          </span>
        )}
        {llm.state?.granted && (
          <span className="app-view-fact">
            <span className="app-view-dot" data-tone="net" aria-hidden="true" />
            {t('apps.view.usesModel')}
          </span>
        )}
        <span className="app-view-when">
          {t('apps.view.saved', { when: fmt.timeAgo(summary.createdAt) })}
        </span>
      </footer>

      <OpenExternalLinkDialog url={pendingUrl} onConfirm={confirmExternalLink} onCancel={cancelExternalLink} />
      <ArtifactNetworkDialog
        open={reviewOpen}
        title={summary.name}
        sites={network.pending}
        declared={declared}
        onDecide={handleDecision}
      />
      <FullAccessDialog
        open={fullAccessReviewOpen && network.fullAccessRequest.length > 0}
        title={summary.name}
        blocked={network.fullAccessRequest}
        onAllow={handleAllowFullAccess}
        onNotNow={handleNotNowFullAccess}
      />
      <PageLlmDialog open={llmReviewOpen} title={summary.name} state={llm.state} onDecide={handleLlmDecision} />
      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('apps.clearData.title')}
        description={t('apps.clearData.description')}
        confirmLabel={t('apps.clearData.confirm')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => void handleClearData()}
      />
      <AppInputsDialog
        appId={inputsDialogOpen ? summary.id : null}
        inputs={app.inputs}
        values={inputValues}
        onClose={() => setInputsDialogOpen(false)}
        onSaved={handleInputsSaved}
      />
    </section>
  );
}
