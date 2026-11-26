/// An app's own window (`?app=<id>`, label `app-<id>`): the app filling the
/// window, no rail and no chat. Boots like the quick-ask window (settings →
/// theme, accent, brand), then renders `AppView` in standalone mode.
///
/// Rust emits `app-changed` after the app is edited, refreshed, installed or
/// deleted: an update reloads the frame and the title, a delete leaves a short
/// "removed" page with a Close button. Edit and Delete work here as in the Apps
/// page; "Open in Conduit" hands the app to the main window.

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import type { AppSettings } from '@conduit/config-schema';
import { useT } from '../i18n';
import { deleteApp, getSettings, listApps, showAppInMain } from '../ipc/client';
import type { AppSummary } from '../ipc/contracts';
import { applyTheme, resolveTheme, watchSystemTheme } from '../theme';
import { applyAccent } from '../themes/accent';
import { applyCachedBrand } from '../brand/applyBrand';
import { sweepPageSiteData } from '../artifacts/pageSiteData';
import { ToastStack } from '../workspace/ToastStack';
import { fromString, TOAST_DISMISS_MS, TOAST_STATUS_KINDS, type StatusState } from '../chat/statusTypes';
import { AppDetailsDialog, type AppDetailsTarget } from './AppDetailsDialog';
import { AppView } from './AppView';
import { appNetworkPolicyKey } from './appHostSettings';
import { useAppChanged } from './appEvents';
import { refreshInstalledApp } from './appInstall';

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function closeThisWindow() {
  if (!hasTauriBridge()) {
    window.close();
    return;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch {
    window.close();
  }
}

export function StandaloneAppRoot({ appId }: { appId: string }) {
  const t = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => resolveTheme('system'));
  const [revision, setRevision] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppDetailsTarget | null>(null);
  const [deleting, setDeleting] = useState<AppSummary | null>(null);
  const [toasts, setToasts] = useState<StatusState[]>([]);

  const onStatus = useCallback((message: string) => {
    const status = fromString(message);
    const shown = TOAST_STATUS_KINDS.has(status.kind) ? status : { ...status, kind: 'success' as const };
    setToasts((current) => [...current.slice(-4), shown]);
  }, []);
  const dismissToast = useCallback((timestamp: number) => {
    setToasts((current) => current.filter((toast) => toast.timestamp !== timestamp));
  }, []);
  useEffect(() => {
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismissToast(toast.timestamp), TOAST_DISMISS_MS[toast.kind] ?? 6000),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismissToast]);

  // Theme, accent and brand, as the main window has them.
  useEffect(() => {
    let cancelled = false;
    void getSettings().then(
      (loaded) => {
        if (!cancelled) setSettings(loaded);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const themeMode = settings?.theme ?? 'system';
  useEffect(() => {
    const apply = () => {
      const effective = applyTheme(themeMode);
      applyCachedBrand(effective);
      applyAccent(settings?.accent, effective);
      setEffectiveTheme(effective);
    };
    apply();
    return watchSystemTheme(themeMode, apply);
  }, [themeMode, settings?.accent]);

  // The name, for the native title and the Edit dialog.
  const [nameRevision, setNameRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void listApps().then(
      (apps) => {
        const found = apps.find((app) => app.id === appId);
        if (!cancelled && found) setName(found.name);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [appId, nameRevision]);
  useEffect(() => {
    if (!name) return;
    document.title = name;
    if (!hasTauriBridge()) return;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name))
      .catch(() => {
        /* A title is cosmetic. */
      });
  }, [name]);

  useAppChanged((event) => {
    if (event.id !== appId) return;
    if (event.kind === 'deleted') {
      setRemoved(true);
      return;
    }
    // Installing doesn't change the app: don't reload it mid-task.
    if (event.kind !== 'updated') return;
    setRevision((r) => r + 1);
    setNameRevision((r) => r + 1);
  });

  const confirmDelete = useCallback(async () => {
    const app = deleting;
    setDeleting(null);
    if (!app) return;
    try {
      await deleteApp(app.id);
      void sweepPageSiteData();
      await closeThisWindow();
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e));
    }
  }, [deleting, onStatus]);

  return (
    <main className="standalone-app">
      {removed ? (
        <div className="standalone-removed" role="alert">
          <p>{t('apps.standalone.removed')}</p>
          <button type="button" className="btn primary" onClick={() => void closeThisWindow()}>
            {t('common.actions.close')}
          </button>
        </div>
      ) : (
        settings && (
          <AppView
            standalone
            appId={appId}
            allowlist={settings.artifactRemoteAllowlist}
            styledPreview={settings.artifactStyledPreview}
            colorScheme={effectiveTheme}
            networkPolicyKey={appNetworkPolicyKey(settings)}
            revision={revision}
            onOpenedElsewhere={() => void closeThisWindow()}
            onEdit={(app) => setEditing({ mode: 'edit', app })}
            // Refreshing from the source chat needs the main window's artifacts.
            onUpdateFromSource={(app) => void showAppInMain(app.id).catch(() => {})}
            onDelete={setDeleting}
            onStatus={onStatus}
          />
        )
      )}
      <AppDetailsDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(app) => {
          setEditing(null);
          setName(app.name);
          void refreshInstalledApp(app);
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
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}
