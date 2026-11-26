/// Installing an app as an OS app: render its icons in the webview, hand them
/// to Rust. One place so the dialog, the save flow and the "edited an installed
/// app" refresh all send the same thing.

import { appInstallStatus, installApp } from '../ipc/client';
import type { AppCategory, AppInstallPlace, AppInstallStatus } from '../ipc/contracts';
import { renderAppIconImages } from './appIconImages';

export interface InstallableApp {
  id: string;
  name: string;
  icon?: string | null;
  category: AppCategory;
}

/** Whether the "also add a desktop shortcut" choice exists on this OS. */
export function offersDesktopShortcut(place: AppInstallPlace): boolean {
  return place === 'startMenu' || place === 'appMenu';
}

/** Render icons and install (or refresh) the app. */
export async function installAppWithIcons(app: InstallableApp, desktopShortcut: boolean): Promise<AppInstallStatus> {
  const icons = await renderAppIconImages({ icon: app.icon, name: app.name, category: app.category });
  return installApp(app.id, icons, desktopShortcut);
}

/** After an edit: if the app is installed, rewrite its entries so the name,
 *  icon and shortcut match, keeping the desktop-shortcut choice. Never throws;
 *  the edit itself already succeeded. Returns the new status, or null. */
export async function refreshInstalledApp(app: InstallableApp): Promise<AppInstallStatus | null> {
  try {
    const status = await appInstallStatus(app.id);
    if (!status.installed) return null;
    return await installAppWithIcons(app, status.desktopShortcut);
  } catch (e) {
    console.warn('could not refresh the installed app', e);
    return null;
  }
}
