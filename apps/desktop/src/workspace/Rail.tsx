import type { ReactNode } from 'react';
import {
  ActivityCheckIcon,
  ChatIcon,
  ChevronLeft,
  ChevronRight,
  ConnectorsIcon,
  FilesIcon,
  HistoryIcon,
  ModelIcon,
  SettingsIcon,
} from '../icons';

export type WorkspaceTab = 'chat' | 'history' | 'artifacts' | 'connectors' | 'activity' | 'models';

interface RailButtonDef {
  tab: WorkspaceTab;
  label: string;
  icon: ReactNode;
  badge?: number;
}

const RAIL_BUTTONS: RailButtonDef[] = [
  { tab: 'chat', label: 'Chat session', icon: <ChatIcon /> },
  { tab: 'history', label: 'Chat history', icon: <HistoryIcon /> },
  { tab: 'artifacts', label: 'Artifacts', icon: <FilesIcon />, badge: 3 },
  { tab: 'connectors', label: 'Connectors', icon: <ConnectorsIcon />, badge: 1 },
  { tab: 'activity', label: 'Activity', icon: <ActivityCheckIcon />, badge: 1 },
  { tab: 'models', label: 'Models & keys', icon: <ModelIcon /> },
];

interface RailProps {
  active: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenSettings: () => void;
}

/** v5 collapsible icon rail: rail-btn with active accent bar and optional badge,
 *  plus expand/collapse. The active state is driven by [data-tab] on <html>. */
export function Rail({ active, onSelect, expanded, onToggleExpand, onOpenSettings }: RailProps) {
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
        {RAIL_BUTTONS.map((btn) => (
          <button
            key={btn.tab}
            className="rail-btn"
            data-tab={btn.tab}
            type="button"
            aria-label={btn.label}
            title={btn.label}
            aria-pressed={active === btn.tab}
            onClick={() => onSelect(btn.tab)}
          >
            {btn.badge !== undefined && <span className="badge">{btn.badge}</span>}
            {btn.icon}
            <span className="rail-label">{btn.label}</span>
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button
          className="rail-btn"
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
          <span className="rail-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}