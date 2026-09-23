import type { KnowledgeCollection } from '../ipc/contracts';
import { useT } from '../i18n';

interface ComposerCollectionsProps {
  open: boolean;
  streaming: boolean;
  collections: KnowledgeCollection[];
  enabledIds: string[];
  onClose: () => void;
  onToggle: (collectionId: string, enabled: boolean) => void;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
}

/** Per-conversation knowledge base collection attachment popover (t1-6).
 *  Structural copy of `ComposerSkills` — purely presentational, controlled
 *  open/close, a `role="switch"` per row. */
export function ComposerCollections({
  open,
  streaming,
  collections,
  enabledIds,
  onClose,
  onToggle,
  onOpenSettings,
  onRefresh,
}: ComposerCollectionsProps) {
  const t = useT();
  if (!open) return null;

  const enabled = new Set(enabledIds);

  return (
    <div
      id="composer-collections"
      role="dialog"
      aria-label={t('chat.knowledge.ariaLabel')}
      className="chat-settings-pop"
    >
      <p className="chat-settings-pop-lead">{t('chat.knowledge.intro')}</p>
      {collections.length === 0 ? (
        <p className="chat-settings-pop-lead">{t('chat.knowledge.noneDiscovered')}</p>
      ) : (
        <ul className="composer-skill-list">
          {collections.map((collection) => {
            const on = enabled.has(collection.id);
            return (
              <li key={collection.id}>
                <button
                  className="toggle"
                  type="button"
                  role="switch"
                  aria-pressed={on}
                  aria-label={t('chat.knowledge.toggleAriaLabel', {
                    action: on ? 'disable' : 'enable',
                    name: collection.name,
                  })}
                  disabled={streaming}
                  onClick={() => onToggle(collection.id, !on)}
                />
                <span>
                  <b>{collection.name}</b>
                  <small>
                    {t('chat.knowledge.documentCount', { count: collection.documentCount })}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="chat-settings-pop-actions">
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('common.actions.close')}
        </button>
        {onRefresh ? (
          <button className="btn ghost" type="button" onClick={onRefresh}>
            {t('chat.knowledge.refresh')}
          </button>
        ) : null}
        {onOpenSettings ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            {t('chat.knowledge.manageInSettings')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
