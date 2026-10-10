/// Apps: the mini-apps saved from chats, and one open app at a time.
///
/// An app is a copy of an HTML page from a chat. It opens here without the
/// chat, and keeps the network access it was given (principal `app:<id>`).
/// Saving happens from the document panel (⋯ → Save as app).

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../i18n';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { declaredCapabilities, declaredHosts, declaredInputs } from '../artifacts/networkHosts';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { deleteApp, getArtifact, getArtifactContentBytes, listApps, updateAppFromArtifact } from '../ipc/client';
import type { AppSummary, StarterAppInfo } from '../ipc/contracts';
import { AppDetailsDialog, type AppDetailsTarget } from '../apps/AppDetailsDialog';
import { AppTile } from '../apps/AppTile';
import { AppView } from '../apps/AppView';
import { useSiteLabel } from '../workspace/ArtifactNetwork';
import { sweepPageSiteData } from '../artifacts/pageSiteData';

export interface AppsPageProps {
  /** Open this app on mount (from the new-chat row or a "Saved" toast). */
  openAppId: string | null;
  onOpenAppIdChange: (id: string | null) => void;
  allowlist: string[];
  styledPreview: boolean;
  colorScheme: ArtifactColorScheme;
  networkPolicyKey?: string;
  /** The apps changed (saved, edited, deleted) — for the new-chat row. */
  onAppsChanged?: () => void;
  /** Ready-made apps bundled with Conduit. */
  starters?: readonly StarterAppInfo[];
  onAddStarter?: (starter: StarterAppInfo) => void;
  onStatus?: (message: string) => void;
}

/** The HTML of an artifact, inline or file-backed. */
async function artifactHtml(artifactId: string): Promise<string> {
  const artifact = await getArtifact(artifactId);
  if (artifact?.contentText != null) return artifact.contentText;
  const bytes = await getArtifactContentBytes(artifactId);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function AppsPage({
  openAppId,
  onOpenAppIdChange,
  allowlist,
  styledPreview,
  colorScheme,
  networkPolicyKey,
  onAppsChanged,
  starters = [],
  onAddStarter,
  onStatus,
}: AppsPageProps) {
  const t = useT();
  const siteLabel = useSiteLabel();
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppDetailsTarget | null>(null);
  const [deleting, setDeleting] = useState<AppSummary | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setApps(await listApps());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setApps([]);
    }
  }, []);

  // Reload when an app opens or closes, and when a starter is added (the
  // starter list changes identity), so My apps shows it straight away.
  useEffect(() => {
    void refresh();
  }, [refresh, openAppId, starters]);

  const changed = useCallback(async () => {
    setRevision((r) => r + 1);
    await refresh();
    onAppsChanged?.();
  }, [refresh, onAppsChanged]);

  const updateFromSource = useCallback(
    async (app: AppSummary) => {
      if (!app.sourceArtifactId) return;
      try {
        const html = await artifactHtml(app.sourceArtifactId);
        const updated = await updateAppFromArtifact(
          app.id,
          declaredHosts(html).map((d) => d.origin),
          declaredCapabilities(html),
          declaredInputs(html),
        );
        onStatus?.(t('apps.status.updated', { name: updated.name, version: updated.version }));
        await changed();
      } catch (e) {
        onStatus?.(e instanceof Error ? e.message : String(e));
      }
    },
    [changed, onStatus, t],
  );

  const confirmDelete = useCallback(async () => {
    const app = deleting;
    setDeleting(null);
    if (!app) return;
    try {
      await deleteApp(app.id);
      // What the app kept on its own origin (full web access) goes with it.
      void sweepPageSiteData();
      if (openAppId === app.id) onOpenAppIdChange(null);
      onStatus?.(t('apps.status.deleted', { name: app.name }));
      await changed();
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : String(e));
    }
  }, [deleting, openAppId, onOpenAppIdChange, onStatus, changed, t]);

  const dialogs = (
    <>
      <AppDetailsDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void changed();
        }}
      />
      <ConfirmDialog
        open={deleting != null}
        title={t('apps.delete.title', { name: deleting?.name ?? '' })}
        description={t('apps.delete.description')}
        confirmLabel={t('apps.delete.confirm')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );

  if (openAppId) {
    return (
      <>
        <AppView
          appId={openAppId}
          allowlist={allowlist}
          styledPreview={styledPreview}
          colorScheme={colorScheme}
          networkPolicyKey={networkPolicyKey}
          revision={revision}
          onBack={() => onOpenAppIdChange(null)}
          onEdit={(app) => setEditing({ mode: 'edit', app })}
          onUpdateFromSource={(app) => void updateFromSource(app)}
          onDelete={setDeleting}
          onStatus={onStatus}
        />
        {dialogs}
      </>
    );
  }

  return (
    <PageFrame title={t('apps.page.title')} subtitle={t('apps.page.subtitle')} className="apps-page">
      {loadError && (
        <p className="apps-error" role="alert">
          {loadError}
        </p>
      )}
      {apps && apps.length === 0 && !loadError && starters.length === 0 ? (
        <PageEmpty title={t('apps.page.emptyTitle')} body={t('apps.page.emptyBody')} />
      ) : null}
      {apps && apps.length === 0 && !loadError && starters.length > 0 ? (
        <p className="apps-empty-note">{t('apps.page.emptyBody')}</p>
      ) : null}
      {apps && apps.length > 0 && (
        <section className="apps-section" aria-labelledby="apps-mine">
          <h3 id="apps-mine" className="apps-section-title">
            {t('apps.page.mine', { count: apps.length })}
          </h3>
          <ul className="apps-grid">
            {apps.map((app) => (
              <li key={app.id} className="app-card">
                <div className="app-card-top">
                  <AppTile icon={app.icon} name={app.name} category={app.category} />
                  <span className="app-card-category">{t(`apps.category.${app.category}`)}</span>
                </div>
                <div className="app-card-text">
                  <span className="app-card-name" title={app.name}>
                    {app.name}
                  </span>
                  <span className="app-card-desc">{app.description ?? ''}</span>
                </div>
                <div className="app-card-chips">
                  {app.hosts.length === 0 ? (
                    <span className="app-chip">
                      <span className="app-view-dot" data-tone="off" aria-hidden="true" />
                      {t('apps.card.offline')}
                    </span>
                  ) : (
                    app.hosts.slice(0, 2).map((host) => (
                      <span key={host} className="app-chip" title={siteLabel(host)}>
                        <span className="app-view-dot" data-tone="net" aria-hidden="true" />
                        {siteLabel(host)}
                      </span>
                    ))
                  )}
                  {app.hosts.length > 2 && (
                    <span className="app-chip">{t('apps.card.moreHosts', { count: app.hosts.length - 2 })}</span>
                  )}
                </div>
                <div className="app-card-foot">
                  <button
                    type="button"
                    className="btn app-card-open"
                    aria-label={t('apps.card.openAriaLabel', { name: app.name })}
                    onClick={() => onOpenAppIdChange(app.id)}
                  >
                    {t('apps.card.open')}
                  </button>
                  {app.sourceChanged && (
                    <button type="button" className="app-card-update" onClick={() => void updateFromSource(app)}>
                      {t('apps.card.update')}
                    </button>
                  )}
                  <span className="app-card-version">v{app.version}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {starters.length > 0 && (
        <section className="apps-section" aria-labelledby="apps-starters">
          <div className="apps-section-head">
            <h3 id="apps-starters" className="apps-section-title">
              {t('apps.page.starters')}
            </h3>
            <span className="apps-section-note">{t('apps.page.startersNote')}</span>
          </div>
          <ul className="apps-starters">
            {starters.map((starter) => {
              const name = t(`ideas.item.${starter.ideaId}.title`);
              return (
                <li key={starter.id} className="starter-card">
                  <AppTile icon={starter.icon} name={name} category={starter.category} />
                  <span className="starter-text">
                    <span className="starter-name">{name}</span>
                    <span className="starter-blurb">{t(`ideas.item.${starter.ideaId}.blurb`)}</span>
                    {starter.hosts.length > 0 && (
                      <span className="starter-hosts" title={starter.hosts.map(siteLabel).join(', ')}>
                        <span className="app-view-dot" data-tone="net" aria-hidden="true" />
                        {t('apps.card.usesInternet')}
                      </span>
                    )}
                  </span>
                  {starter.installedAppId ? (
                    <button
                      type="button"
                      className="btn app-card-open"
                      aria-label={t('apps.card.openAriaLabel', { name })}
                      onClick={() => onOpenAppIdChange(starter.installedAppId ?? null)}
                    >
                      {t('apps.card.open')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      aria-label={t('apps.card.addAriaLabel', { name })}
                      disabled={!onAddStarter}
                      onClick={() => onAddStarter?.(starter)}
                    >
                      {t('apps.card.add')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {dialogs}
    </PageFrame>
  );
}
