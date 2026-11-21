/// The tabs of a rail group: Context (Documents, Library, Connectors, Memory)
/// and Agents (Needs you, Agents, Workflows) are each one rail item, and these
/// tabs switch between its pages. Each tab is still its own destination, so
/// its page renders below exactly as before.
///
/// Navigation, not an ARIA tablist: each tab goes somewhere (the page under it
/// is a destination with its own deep links), so the current one is marked
/// with `aria-current="page"` and Tab moves between them.

import { useT } from '../i18n';
import { AGENT_TABS, CONTEXT_TABS, destinationIcon, type AgentTab, type ContextTab, type Destination } from './Rail';

export type RailGroup = 'context' | 'work';

export interface ContextTabsProps {
  /** Which group's tabs; Context when left out. */
  group?: RailGroup;
  current: ContextTab | AgentTab;
  onNavigate: (d: Destination) => void;
  /** A number beside a tab, e.g. how many things wait under Needs you. */
  counts?: Partial<Record<Destination, number>>;
}

export function ContextTabs({ group = 'context', current, onNavigate, counts = {} }: ContextTabsProps) {
  const t = useT();
  const tabs: readonly Destination[] = group === 'work' ? AGENT_TABS : CONTEXT_TABS;
  const label = (tab: Destination) => (group === 'work' ? t(`shell.work.tab.${tab}`) : t(`shell.rail.${tab}`));
  return (
    <nav
      className="context-tabs"
      data-group={group}
      aria-label={group === 'work' ? t('shell.work.ariaLabel') : t('shell.context.ariaLabel')}
    >
      {/* Agents leaves its label out: its first page is also called Agents. */}
      {group === 'context' && (
        <span className="context-tabs-label" aria-hidden="true">
          {t('shell.rail.context')}
        </span>
      )}
      {tabs.map((tab) => {
        const count = counts[tab] ?? 0;
        return (
          <button
            key={tab}
            type="button"
            className="context-tab"
            data-tab={tab}
            aria-current={tab === current ? 'page' : undefined}
            aria-label={count > 0 ? t('shell.work.tabWithCount', { label: label(tab), count }) : undefined}
            onClick={() => onNavigate(tab)}
          >
            <span className="context-tab-icon" aria-hidden="true">
              {destinationIcon(tab)}
            </span>
            {label(tab)}
            {count > 0 && (
              <span className="context-tab-count" aria-hidden="true">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
