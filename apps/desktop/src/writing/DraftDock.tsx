/// The Writing studio's right column: tabs Ask, Outline, Sources and
/// History. Ask holds the chat (App renders the one mounted ChatView beside
/// it, as the Slides dock does); Outline, Sources and History are the draft's
/// outline editor, what it may draw facts from, and its version list. The tab is controlled. While the draft is in its outline
/// stage the outline is the studio's main view, so the dock leaves it out.
///
/// Every panel stays mounted: the chat owns running streams, and an outline
/// row being typed must not be lost to a tab switch.

import type { KeyboardEvent, ReactNode } from 'react';
import { useT } from '../i18n';

export type DraftDockTab = 'ask' | 'outline' | 'sources' | 'history';

export interface DraftDockProps {
  tab: DraftDockTab;
  onTab: (tab: DraftDockTab) => void;
  /** Offer the Outline tab (the draft stage). */
  showOutline: boolean;
  /** The chat (null: App renders it as the column's next child). */
  children: ReactNode;
  outline: ReactNode;
  sources: ReactNode;
  history: ReactNode;
}

const TABS: ReadonlyArray<{ tab: DraftDockTab; labelId: string }> = [
  { tab: 'ask', labelId: 'writing.dock.ask' },
  { tab: 'outline', labelId: 'writing.dock.outline' },
  { tab: 'sources', labelId: 'writing.dock.sources' },
  { tab: 'history', labelId: 'writing.dock.history' },
];

export function DraftDock({ tab, onTab, showOutline, children, outline, sources, history }: DraftDockProps) {
  const t = useT();
  const tabs = TABS.filter((x) => showOutline || x.tab !== 'outline');

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const at = Math.max(0, tabs.findIndex((x) => x.tab === tab));
    onTab(tabs[(at + delta + tabs.length) % tabs.length].tab);
  };

  const panels: ReadonlyArray<{ tab: DraftDockTab; node: ReactNode }> = [
    { tab: 'ask', node: children },
    ...(showOutline ? [{ tab: 'outline' as const, node: outline }] : []),
    { tab: 'sources', node: sources },
    { tab: 'history', node: history },
  ];

  return (
    <div className="deck-dock">
      <div className="deck-dock-tabs" role="tablist" aria-label={t('writing.dock.aria')} onKeyDown={onKeyDown}>
        {tabs.map(({ tab: id, labelId }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`draft-dock-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`draft-dock-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="deck-dock-tab"
            onClick={() => onTab(id)}
          >
            {t(labelId)}
          </button>
        ))}
      </div>
      {panels.map(({ tab: id, node }) => (
        <div
          key={id}
          role="tabpanel"
          id={`draft-dock-panel-${id}`}
          aria-labelledby={`draft-dock-tab-${id}`}
          className="deck-dock-panel"
          hidden={tab !== id}
        >
          {node}
        </div>
      ))}
    </div>
  );
}
