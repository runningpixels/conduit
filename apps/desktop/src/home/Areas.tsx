/// "Everything {app} can do": every area of the app, explained once.
///
/// Two ways to look at the same eight areas. The guide is job cards: what you
/// can get done, a real prompt, and where to start. It is for someone new.
/// Compact is eight small tiles with live counts, for someone who knows their
/// way around. Which one shows follows how many areas this device has opened,
/// unless the reader chose.

import { useId } from 'react';
import { appName } from '../brand';
import { useT } from '../i18n';
import type { Destination } from '../shell/Rail';
import {
  AREA_ICONS,
  AREA_INFO,
  JOB_CARDS,
  type AreaCounts,
  type HomeAction,
  type HomeTarget,
} from './areaInfo';
import { AREAS, type Area, type HomeView } from './visitedAreas';

export interface AreasProps {
  view: HomeView;
  onViewChange: (view: HomeView) => void;
  visited: readonly Area[];
  counts: AreaCounts;
  onNavigate: (area: Destination) => void;
  onAction: (action: HomeAction) => void;
}

export function Areas({ view, onViewChange, visited, counts, onNavigate, onAction }: AreasProps) {
  const t = useT();
  const labelId = useId();
  const run = (target: HomeTarget) => {
    if ('navigate' in target) onNavigate(target.navigate);
    else onAction(target.action);
  };

  return (
    <section className="home-section" aria-labelledby={labelId}>
      <div className="home-section-head">
        <div className="home-section-heading">
          <h3 id={labelId} className="home-section-title">
            {t('home.areas.title', { app: appName() })}
          </h3>
          <p className="home-section-sub">
            {view === 'guide' ? t('home.areas.subtitle.guide') : t('home.areas.subtitle.compact')}
          </p>
        </div>
        <div className="home-section-tools">
          {view === 'guide' && (
            <span className="home-progress">{t('home.areas.progress', { n: visited.length, total: AREAS.length })}</span>
          )}
          <button
            type="button"
            className="home-link"
            aria-pressed={view === 'compact'}
            onClick={() => onViewChange(view === 'guide' ? 'compact' : 'guide')}
          >
            {view === 'guide' ? t('home.areas.showAll') : t('home.areas.showGuide')}
          </button>
        </div>
      </div>

      {view === 'guide' ? (
        <ul className="home-jobs">
          {JOB_CARDS.map((job) => {
            const tried = visited.includes(job.area);
            return (
              <li key={job.id} className="home-card home-job" data-area={job.area}>
                <div className="home-job-head">
                  <span className="home-icon-tile" aria-hidden="true">
                    {AREA_ICONS[job.area]}
                  </span>
                  <h4 className="home-job-title">{t(`home.job.${job.id}.title`)}</h4>
                  {tried && <span className="home-tag">{t('home.areas.tried')}</span>}
                </div>
                <p className="home-job-body">{t(`home.job.${job.id}.body`)}</p>
                <p className="home-job-example">
                  <span className="home-job-example-label">{t('home.areas.tryLabel')}</span>
                  <code>{t(`home.job.${job.id}.example`)}</code>
                </p>
                <div className="home-job-foot">
                  <button type="button" className="btn home-job-start" onClick={() => run(job.start)}>
                    {t(`home.job.${job.id}.start`)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="home-tiles">
          {AREA_INFO.map((info) => {
            const count = counts[info.count];
            const name = t(`home.area.${info.area}.name`);
            const isNew = !visited.includes(info.area);
            return (
              <li key={info.area} className="home-card home-tile" data-area={info.area}>
                <button type="button" className="home-tile-main" onClick={() => onNavigate(info.area)}>
                  <span className="home-tile-top">
                    <span className="home-icon-tile" aria-hidden="true">
                      {AREA_ICONS[info.area]}
                    </span>
                    {isNew && (
                      <span className="home-new" title={t('home.areas.newToYou')}>
                        <span className="home-new-dot" aria-hidden="true" />
                        <span className="sr-only">{t('home.areas.newToYou')}</span>
                      </span>
                    )}
                  </span>
                  <span className="home-tile-name">{name}</span>
                  <span className="home-tile-count">
                    {count == null
                      ? ' '
                      : count === 0
                        ? t('home.count.none')
                        : t(`home.count.${info.count}`, { count })}
                  </span>
                  <span className="home-tile-desc">{t(`home.area.${info.area}.desc`)}</span>
                </button>
                <button type="button" className="home-tile-action" onClick={() => run(info.tileAction)}>
                  {t(info.tileActionLabelId)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
