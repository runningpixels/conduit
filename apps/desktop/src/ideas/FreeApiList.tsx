/// "Free APIs" on the Ideas page: every service in the free API catalogue
/// (freeApis.ts) with what it gives, its limit, its docs, and a Try button
/// that starts the idea built on it — the same as picking that idea's card.

import { openExternalUrl } from '../ipc/client';
import { useT } from '../i18n';
import { IDEAS, type Capability, type Idea } from './catalog';
import type { Capabilities } from './capabilities';
import { FREE_APIS, freeApiGivesKey, freeApiLimitMessage, type FreeApi } from './freeApis';
import { ideaStatus, missingNeed } from './selectIdeas';

/// The idea that shows an API off: the first one that leads with it, else the
/// first that uses it at all.
export function ideaForApi(api: Pick<FreeApi, 'id'>): Idea | undefined {
  return IDEAS.find((i) => i.apis?.[0] === api.id) ?? IDEAS.find((i) => i.apis?.includes(api.id));
}

export interface FreeApiListProps {
  caps: Capabilities;
  onTry: (idea: Idea) => void;
  onSetup: (need: Capability) => void;
  onStatus: (message: string) => void;
}

export function FreeApiList({ caps, onTry, onSetup, onStatus }: FreeApiListProps) {
  const t = useT();
  return (
    <ul className="free-apis">
      {FREE_APIS.map((api) => {
        const idea = ideaForApi(api);
        const limit = freeApiLimitMessage(api);
        const title = idea ? t(`ideas.item.${idea.id}.title`) : '';
        const status = idea ? ideaStatus(idea, caps) : 'off';
        const need = idea ? missingNeed(idea, caps) : null;
        return (
          <li key={api.id} className="free-api" data-api={api.id}>
            <div className="free-api-text">
              <h4>{api.name}</h4>
              <p>{t(freeApiGivesKey(api))}</p>
              <p className="free-api-meta">
                <span className="free-api-hosts">{api.hosts.join(' · ')}</span>
                <span>{t(limit.key, limit.values)}</span>
              </p>
              {api.attribution && <p className="free-api-meta">{t('ideas.apis.credit', { attribution: api.attribution })}</p>}
            </div>
            <div className="free-api-actions">
              {idea && <span className="free-api-idea">{t('ideas.apis.idea', { title })}</span>}
              <div className="free-api-buttons">
                <button
                  className="btn ghost"
                  type="button"
                  aria-label={t('ideas.apis.docsAriaLabel', { name: api.name })}
                  onClick={() => {
                    openExternalUrl(api.docs).catch((err: unknown) =>
                      onStatus(err instanceof Error ? err.message : String(err)),
                    );
                  }}
                >
                  {t('ideas.apis.docs')} ↗
                </button>
                {idea && status === 'ready' ? (
                  <button
                    className="btn primary"
                    type="button"
                    aria-label={t('ideas.apis.tryAriaLabel', { title, name: api.name })}
                    onClick={() => onTry(idea)}
                  >
                    {t('ideas.card.try')}
                  </button>
                ) : idea && status === 'setup' && need ? (
                  <button className="btn" type="button" onClick={() => onSetup(need)}>
                    {t(`ideas.setup.${need}`)}
                  </button>
                ) : (
                  <span className="idea-card-off">{t('ideas.card.unavailable')}</span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
