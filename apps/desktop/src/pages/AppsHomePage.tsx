/// Apps: your apps as cards, one click to open: the app's tile and name,
/// its kind and when you last opened it, what it does, and whether it goes
/// online or uses your AI model. Managing them (details, network access, starters, delete) is the
/// Manage page beside it on the rail, which is the Apps page as it was.
///
/// Opening an app goes through the same flow as everywhere else
/// (`onOpen` → App.tsx `openSavedApp`), and the app itself shows here, in the
/// same view Manage uses.
///
/// The cards keep the order the apps list already has (most recently opened
/// first).

import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import type { AppSummary } from '../ipc/contracts';
import { AppTile } from '../apps/AppTile';
import { useFormatters } from '../i18n/formatters';
import { useExampleItems } from '../examples/useExampleItems';
import { ExampleChip } from '../examples/ExampleChip';
import { PageEmpty, PageFrame } from '../shell/PageFrame';

export interface AppsHomePageProps {
  apps: readonly AppSummary[];
  onOpen: (id: string) => void;
  /** Start a chat that builds a new app. */
  onNewApp: () => void;
  /** Go to Manage (details, network access, starters). */
  onManage: () => void;
}

export function AppsHomePage({ apps, onOpen, onNewApp, onManage }: AppsHomePageProps) {
  const t = useT();
  const fmt = useFormatters();
  const { isExample } = useExampleItems();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? apps.filter((app) => app.name.toLocaleLowerCase().includes(q)) : apps;
  }, [apps, query]);

  return (
    <PageFrame
      title={t('apps.launcher.title')}
      subtitle={t('apps.launcher.subtitle')}
      about={t('apps.launcher.about')}
      className="apps-home"
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onManage}>
            {t('apps.launcher.manage')}
          </button>
          <button type="button" className="btn primary" onClick={onNewApp}>
            {t('apps.launcher.newApp')}
          </button>
        </>
      }
    >
      {apps.length === 0 ? (
        <PageEmpty
          title={t('apps.launcher.emptyTitle')}
          body={t('apps.launcher.emptyBody')}
          action={
            <button type="button" className="btn" onClick={onManage}>
              {t('apps.launcher.emptyAction')}
            </button>
          }
        />
      ) : (
        <>
          <input
            className="apps-home-search"
            type="search"
            value={query}
            placeholder={t('apps.launcher.search')}
            aria-label={t('apps.launcher.search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown.length > 0) onOpen(shown[0].id);
            }}
          />
          {shown.length === 0 ? (
            <p className="apps-home-nomatch">{t('apps.launcher.noMatch', { query: query.trim() })}</p>
          ) : (
            <ul className="apps-home-grid" aria-label={t('apps.launcher.gridLabel')}>
              {shown.map((app) => (
                <li key={app.id}>
                  <button type="button" className="apps-home-card" aria-label={app.name} onClick={() => onOpen(app.id)}>
                    <span className="apps-home-card-top">
                      <AppTile icon={app.icon} name={app.name} category={app.category} size="lg" />
                      <span className="apps-home-card-title">
                        <span className="apps-home-name">{app.name}</span>
                        <span className="apps-home-meta">
                          {t(`apps.category.${app.category}`)}
                          {' · '}
                          {app.lastOpenedAt
                            ? t('apps.launcher.opened', { when: fmt.timeAgo(app.lastOpenedAt) })
                            : t('apps.launcher.neverOpened')}
                          {isExample('app', app.id) && <ExampleChip />}
                        </span>
                      </span>
                    </span>
                    {app.description && <span className="apps-home-desc">{app.description}</span>}
                    <span className="apps-home-traits">
                      <span className="apps-home-trait" data-tone={app.hosts.length > 0 ? 'net' : 'off'}>
                        {app.hosts.length > 0 ? t('apps.card.usesInternet') : t('apps.view.offline')}
                      </span>
                      {app.llm && (
                        <span className="apps-home-trait" data-tone="ai">
                          {t('apps.launcher.usesAi')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageFrame>
  );
}
