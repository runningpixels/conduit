import type { ReactNode } from 'react';
import {
  ActivityCheckIcon,
  ChatIcon,
  ChevronLeft,
  ChevronRight,
  ConnectorsIcon,
  FilesIcon,
  HistoryIcon,
  SettingsIcon,
} from '../icons';
import { ACTIVITY_PANE_ENABLED } from './features';

export type WorkspaceTab = 'chat' | 'history' | 'artifacts' | 'connectors' | 'activity' | 'settings';

interface RailButtonDef {
  tab: WorkspaceTab;
  label: string;
  icon: ReactNode;
  badge?: number;
}

const RAIL_BUTTONS: RailButtonDef[] = [
  { tab: 'chat', label: 'Chat session', icon: <ChatIcon /> },
  { tab: 'history', label: 'Chat history', icon: <HistoryIcon /> },
  { tab: 'artifacts', label: 'Artifacts', icon: <FilesIcon /> },
  { tab: 'connectors', label: 'Connectors', icon: <ConnectorsIcon /> },
  ...(ACTIVITY_PANE_ENABLED
    ? [{ tab: 'activity' as const, label: 'Activity', icon: <ActivityCheckIcon /> }]
    : []),
];

interface RailProps {
  active: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  /// Live artifact count for the Files & artifacts tab badge.
  artifactCount?: number;
}

/** v5 collapsible icon rail: rail-btn with active accent bar and optional badge,
 *  plus expand/collapse. The active state is driven by [data-tab] on <html>. */
export function Rail({ active, onSelect, expanded, onToggleExpand, artifactCount = 0 }: RailProps) {
  return (
    <nav className="rail" aria-label="Chat panel tabs">
      <div className="rail-top">
        <button
          className="rail-btn rail-toggle"
          type="button"
          aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
          aria-expanded={expanded}
          title={expanded ? 'Collapse navigation' : 'Expand navigation'}
          onClick={onToggleExpand}
        >
          {expanded ? <ChevronLeft className="collapse-icon" /> : <ChevronRight className="expand-icon" />}
          <span className="rail-label">Collapse</span>
        </button>
        {RAIL_BUTTONS.map((btn) => {
          const badge =
            btn.tab === 'artifacts'
              ? artifactCount > 0
                ? artifactCount
                : undefined
              : btn.badge;
          const isCurrent = active === btn.tab;
          return (
          <button
            key={btn.tab}
            className="rail-btn"
            data-tab={btn.tab}
            type="button"
            aria-label={btn.label}
            title={btn.label}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelect(btn.tab)}
          >
            {badge !== undefined && <span className="badge">{badge}</span>}
            {btn.icon}
            <span className="rail-label">{btn.label}</span>
          </button>
          );
        })}
      </div>
      <div className="rail-bottom">
        <button
          className="rail-btn"
          data-tab="settings"
          type="button"
          aria-label="Settings"
          title="Settings"
          aria-current={active === 'settings' ? 'page' : undefined}
          onClick={() => onSelect('settings')}
        >
          <SettingsIcon />
          <span className="rail-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}
