/// One open app: a header Conduit draws (outside the sandbox, so a page can't
/// fake it), the app in the same sandboxed frame as an artifact (ADR-007), and
/// a status strip that always says what the app may reach.
///
/// Network access is ADR-010 unchanged, keyed to the app (`app:<id>`), so a
/// grant made here belongs to the app and survives the chat it came from.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { HtmlArtifactRenderer, type ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { declaredHosts, scriptedHosts } from '../artifacts/networkHosts';
import { isHttpOrHttpsUrl } from '../artifacts/externalUrl';
import { useArtifactNetwork } from '../workspace/useArtifactNetwork';
import {
  ArtifactNetworkBanner,
  ArtifactNetworkChip,
  ArtifactNetworkDialog,
  useSiteLabel,
} from '../workspace/ArtifactNetwork';
import { OpenExternalLinkDialog } from '../workspace/OpenExternalLinkDialog';
import { Menu } from '../workspace/Menu';
import { ChevronLeft, MoreIcon, PencilIcon, RetryIcon, TrashIcon } from '../icons';
import { appPrincipal, openApp, openExternalUrl } from '../ipc/client';
import type { AppDetail, AppSummary } from '../ipc/contracts';
import { AppTile } from './AppTile';

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

  const html = app?.html ?? '';
  const network = useArtifactNetwork(app ? appPrincipal(app.id) : null, html, networkPolicyKey);
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
  if (!app) {
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
        <ArtifactNetworkChip
          declared={declared}
          scripted={scripted}
          state={network.state}
          denied={network.denied}
          log={network.log}
          onRevoke={(origin) => void network.revoke(origin)}
        />
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

      <div className="app-view-frame">
        <HtmlArtifactRenderer
          key={`${summary.id}:${summary.version}:${revision}`}
          html={html}
          allowlist={allowlist}
          styledPreview={styledPreview}
          colorScheme={colorScheme}
          onExternalLink={handleExternalLink}
          network={network.handler}
        />
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
    </section>
  );
}
