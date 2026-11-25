/// "Install as app": one screen. Shows the app's tile and name, says where the
/// entry will appear on this OS, and offers a desktop shortcut where the OS has
/// one. Installing renders the icons here and hands them to Rust; an error is
/// shown in the dialog so the user can retry.
///
/// Can open over the document panel's Save flow or an app window, so Escape is
/// caught in the capture phase like `AppDetailsDialog`.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import type { AppInstallPlace, AppInstallStatus } from '../ipc/contracts';
import { AppTile } from './AppTile';
import { installAppWithIcons, offersDesktopShortcut, type InstallableApp } from './appInstall';

/** Message key for "where it appears", by place. `unsupported` has no entry. */
export function placeMessageKey(place: AppInstallPlace): string | null {
  switch (place) {
    case 'startMenu':
      return 'apps.install.where.startMenu';
    case 'applications':
      return 'apps.install.where.applications';
    case 'appMenu':
      return 'apps.install.where.appMenu';
    default:
      return null;
  }
}

/** Key of the post-install status message for a place. */
export function installedMessageKey(place: AppInstallPlace): string {
  return place === 'startMenu'
    ? 'apps.status.installed.startMenu'
    : place === 'applications'
      ? 'apps.status.installed.applications'
      : 'apps.status.installed.appMenu';
}

export function InstallAppDialog({
  app,
  place,
  onClose,
  onInstalled,
}: {
  /** The app to install, or null while closed. */
  app: InstallableApp | null;
  place: AppInstallPlace;
  onClose: () => void;
  onInstalled: (app: InstallableApp, status: AppInstallStatus) => void;
}) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const open = app != null;
  useFocusTrap(dialogRef, open);
  const [desktopShortcut, setDesktopShortcut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    setDesktopShortcut(true);
    setBusy(false);
    setError(null);
  }, [app]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!app) return null;
  const whereKey = placeMessageKey(place);
  const showShortcut = offersDesktopShortcut(place);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!app || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await installAppWithIcons(app, showShortcut && desktopShortcut);
      onInstalled(app, status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="consent-overlay app-details-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="app-details-dialog app-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id={titleId}>{t('apps.install.title')}</h2>
        <div className="app-install-identity">
          <AppTile icon={app.icon} name={app.name} category={app.category} size="lg" />
          <span className="app-install-name" title={app.name}>
            {app.name}
          </span>
        </div>
        {whereKey && <p className="app-details-intro app-install-where">{t(whereKey)}</p>}
        {showShortcut && (
          <label className="app-details-keep">
            <input
              type="checkbox"
              checked={desktopShortcut}
              onChange={(e) => setDesktopShortcut(e.target.checked)}
            />
            <span>{t('apps.install.desktopShortcut')}</span>
          </label>
        )}
        {error && (
          <p className="app-details-error" role="alert">
            {error}
          </p>
        )}
        <div className="app-details-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? t('apps.install.installing') : t('apps.install.confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
