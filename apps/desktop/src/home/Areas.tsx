/// "Everything {app} can do": every area of the app as one tile, with a live
/// count and the one thing to do there.
///
/// An area that is still empty shows an example instead of a count, so the
/// same tiles teach a new user and orient an experienced one. An example the
/// ask box can run fills it in; one that needs setting up first is a hint.

import { useId } from 'react';
import { appName } from '../brand';
import { useT } from '../i18n';
import type { Destination } from '../shell/Rail';
import { AREA_ICONS, AREA_INFO, type AreaCounts, type HomeAction, type HomeTarget } from './areaInfo';

export interface AreasProps {
  counts: AreaCounts;
  onNavigate: (area: Destination) => void;
  onAction: (action: HomeAction) => void;
  /** Puts an example request in the ask box. */
  onTryExample: (text: string) => void;
}

export function Areas({ counts, onNavigate, onAction, onTryExample }: AreasProps) {
  const t = useT();
  const labelId = useId();
  const run = (target: HomeTarget) => {
    if ('navigate' in target) onNavigate(target.navigate);
    else onAction(target.action);
  };

  return (
    <section className="home-section" aria-labelledby={labelId}>
      <div className="home-section-heading">
        <h3 id={labelId} className="home-section-title">
          {t('home.areas.title', { app: appName() })}
        </h3>
        <p className="home-section-sub">{t('home.areas.subtitle')}</p>
      </div>

      <ul className="home-tiles">
        {AREA_INFO.map((info) => {
          const count = counts[info.count];
          const example = t(`home.area.${info.area}.example`);
          const exampleBody = (
            <>
              <span className="home-tile-try-label">{t('home.areas.tryLabel')}</span>
              <span className="home-tile-try-text">{example}</span>
            </>
          );
          return (
            <li key={info.area} className="home-card home-tile" data-area={info.area}>
              <button type="button" className="home-tile-main" onClick={() => onNavigate(info.area)}>
                <span className="home-icon-tile" aria-hidden="true">
                  {AREA_ICONS[info.area]}
                </span>
                <span className="home-tile-name">{t(`home.area.${info.area}.name`)}</span>
                {count != null && count > 0 && (
                  <span className="home-tile-count">{t(`home.count.${info.count}`, { count })}</span>
                )}
                <span className="home-tile-desc">{t(`home.area.${info.area}.desc`)}</span>
              </button>
              {count === 0 &&
                (info.askable ? (
                  <button
                    type="button"
                    className="home-tile-try"
                    aria-label={t('home.areas.tryAria', { example })}
                    onClick={() => onTryExample(example)}
                  >
                    {exampleBody}
                  </button>
                ) : (
                  <p className="home-tile-try">{exampleBody}</p>
                ))}
              <button type="button" className="home-tile-action" onClick={() => run(info.tileAction)}>
                {t(info.tileActionLabelId)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
