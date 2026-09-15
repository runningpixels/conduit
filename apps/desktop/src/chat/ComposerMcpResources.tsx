import type { ConnectorResourceInfo, ResourceRef } from '../ipc/contracts';
import { groupByConnector, isStale, sameResource, toResourceRef } from './connectorCapabilities';
import { useT } from '../i18n';

interface ComposerMcpResourcesProps {
  open: boolean;
  resources: ConnectorResourceInfo[];
  attached: ResourceRef[];
  onClose: () => void;
  onToggle: (resource: ConnectorResourceInfo, next: boolean) => void;
  onRefresh: () => void;
}

/** Composer popover for attaching MCP resources to the next turn, grouped by connector (M5). */
export function ComposerMcpResources({
  open,
  resources,
  attached,
  onClose,
  onToggle,
  onRefresh,
}: ComposerMcpResourcesProps) {
  const t = useT();
  if (!open) return null;

  const groups = groupByConnector(resources);

  return (
    <div
      id="composer-mcp-resources"
      role="dialog"
      aria-label={t('chat.mcpResources.ariaLabel')}
      className="chat-settings-pop"
    >
      <p className="chat-settings-pop-lead">{t('chat.mcpResources.intro')}</p>
      {resources.length === 0 ? (
        <p className="chat-settings-pop-lead">{t('chat.mcpResources.none')}</p>
      ) : (
        groups.map((group) => (
          <div key={group.connectorVersionId}>
            <div className="menu-label" title={group.connectorName}>{group.connectorName}</div>
            <ul className="composer-skill-list">
              {group.items.map((resource) => {
                const stale = isStale(resource);
                const on = !stale && attached.some((ref) => sameResource(ref, toResourceRef(resource)));
                return (
                  <li key={`${resource.connectorVersionId}:${resource.uri || resource.name}`}>
                    <button
                      className="toggle"
                      type="button"
                      role="switch"
                      aria-pressed={on}
                      aria-label={t('chat.mcpResources.toggleAriaLabel', {
                        action: on ? 'detach' : 'attach',
                        name: resource.name,
                      })}
                      disabled={stale}
                      onClick={() => onToggle(resource, !on)}
                    />
                    <span>
                      <b>{resource.name}</b>
                      <small>{stale ? t('chat.mcpResources.staleNote') : resource.description ?? resource.uri}</small>
                      {stale ? (
                        <button className="btn ghost" type="button" onClick={onRefresh}>
                          {t('chat.mcpResources.refresh')}
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      <div className="chat-settings-pop-actions">
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('common.actions.close')}
        </button>
      </div>
    </div>
  );
}
