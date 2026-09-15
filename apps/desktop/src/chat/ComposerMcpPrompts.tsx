import type { CSSProperties } from 'react';
import type { ConnectorPromptInfo } from '../ipc/contracts';
import { groupByConnector, isStale } from './connectorCapabilities';
import { useT } from '../i18n';

interface ComposerMcpPromptsProps {
  open: boolean;
  prompts: ConnectorPromptInfo[];
  onClose: () => void;
  onPick: (prompt: ConnectorPromptInfo) => void;
  onRefresh: () => void;
}

const noteStyle: CSSProperties = { display: 'block', color: 'var(--ink-3)', fontSize: 'var(--fs-md)' };

/** Composer popover listing MCP prompts, grouped by connector (M4). */
export function ComposerMcpPrompts({
  open,
  prompts,
  onClose,
  onPick,
  onRefresh,
}: ComposerMcpPromptsProps) {
  const t = useT();
  if (!open) return null;

  const groups = groupByConnector(prompts);

  return (
    <div
      id="composer-mcp-prompts"
      role="dialog"
      aria-label={t('chat.mcpPrompts.ariaLabel')}
      className="chat-settings-pop"
    >
      <p className="chat-settings-pop-lead">{t('chat.mcpPrompts.intro')}</p>
      {prompts.length === 0 ? (
        <p className="chat-settings-pop-lead">{t('chat.mcpPrompts.none')}</p>
      ) : (
        groups.map((group) => (
          <div key={group.connectorVersionId}>
            <div className="menu-label" title={group.connectorName}>{group.connectorName}</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {group.items.map((prompt) => {
                const stale = isStale(prompt);
                return (
                  <li key={prompt.name}>
                    {stale ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 9px' }}>
                        <span>
                          <b>{prompt.name}</b>
                          <small style={noteStyle}>{t('chat.mcpPrompts.staleNote')}</small>
                        </span>
                        <button className="btn ghost" type="button" onClick={onRefresh}>
                          {t('chat.mcpPrompts.refresh')}
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="menu-item" onClick={() => onPick(prompt)}>
                        <span>
                          <b>{prompt.name}</b>
                          {prompt.description ? <small style={noteStyle}>{prompt.description}</small> : null}
                        </span>
                      </button>
                    )}
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
