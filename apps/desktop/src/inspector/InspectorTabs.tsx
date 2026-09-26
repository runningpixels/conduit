import { useRef, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';

export type InspectorTab = 'page' | 'activity' | 'sources';

export interface InspectorTabsProps {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  counts?: { activity?: number; sources?: number };
  /** Without a page the Page tab is not offered. */
  hasPage: boolean;
  onClose: () => void;
}

/** DOM id of a tab button — the panel the host renders uses it for `aria-labelledby`. */
export function inspectorTabId(tab: InspectorTab): string {
  return `inspector-tab-${tab}`;
}

/** DOM id the host must give the panel for `tab` (the tab's `aria-controls`). */
export function inspectorPanelId(tab: InspectorTab): string {
  return `inspector-panel-${tab}`;
}

const LABEL_KEYS: Record<InspectorTab, string> = {
  page: 'inspector.tabs.page',
  activity: 'inspector.tabs.activity',
  sources: 'inspector.tabs.sources',
};

/**
 * The inspector's tab strip (Page · Activity · Sources) and its close button.
 * WAI-ARIA tabs with automatic activation: arrow keys, Home and End move the
 * selection and focus together; only the selected tab is in the tab order.
 */
export function InspectorTabs({ tab, onTab, counts, hasPage, onClose }: InspectorTabsProps) {
  const t = useT();
  const fmt = useFormatters();
  const refs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});
  const tabs: InspectorTab[] = hasPage ? ['page', 'activity', 'sources'] : ['activity', 'sources'];
  // A stale `page` selection after the page closed still leaves one tab focusable.
  const selected = tabs.includes(tab) ? tab : tabs[0];

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.indexOf(selected);
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (at + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (at - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[next];
    onTab(target);
    refs.current[target]?.focus();
  }

  return (
    <div className="inspector-tabs">
      <div
        className="inspector-tablist"
        role="tablist"
        aria-label={t('inspector.tabs.ariaLabel')}
        onKeyDown={move}
      >
        {tabs.map((id) => {
          const count = id === 'page' ? undefined : counts?.[id];
          const isSelected = id === selected;
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={inspectorTabId(id)}
              aria-selected={isSelected}
              aria-controls={inspectorPanelId(id)}
              tabIndex={isSelected ? 0 : -1}
              className="inspector-tab"
              onClick={() => onTab(id)}
            >
              {t(LABEL_KEYS[id])}
              {count != null && count > 0 && <span className="inspector-tab-count">{fmt.count(count)}</span>}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="inspector-close"
        aria-label={t('inspector.tabs.close')}
        title={t('inspector.tabs.close')}
        onClick={onClose}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
