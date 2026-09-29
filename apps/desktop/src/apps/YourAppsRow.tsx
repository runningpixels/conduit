/// The new-chat screen's "Your apps" row: the most recently opened saved
/// apps, one click to open. Shown only once there is at least one app.

import { useT } from '../i18n';
import type { AppSummary } from '../ipc/contracts';
import { AppTile } from './AppTile';

export const YOUR_APPS_SIZE = 4;

export function YourAppsRow({
  apps,
  onOpen,
  onAll,
}: {
  apps: readonly AppSummary[];
  onOpen: (id: string) => void;
  onAll: () => void;
}) {
  const t = useT();
  if (apps.length === 0) return null;
  return (
    <section className="your-apps" aria-labelledby="your-apps-label">
      <div className="your-apps-head">
        <h2 id="your-apps-label" className="idea-gallery-label">
          {t('apps.home.label')}
        </h2>
        <button type="button" className="idea-gallery-link" onClick={onAll}>
          {t('apps.home.all')} →
        </button>
      </div>
      <ul className="your-apps-list">
        {apps.slice(0, YOUR_APPS_SIZE).map((app) => (
          <li key={app.id}>
            <button
              type="button"
              className="your-app"
              aria-label={t('apps.card.openAriaLabel', { name: app.name })}
              onClick={() => onOpen(app.id)}
            >
              <AppTile icon={app.icon} name={app.name} category={app.category} size="sm" />
              <span className="your-app-name">{app.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
