/// The studio's right column: tabs Ask, Script and History. Ask holds the
/// chat (App renders the one mounted ChatView inside it); Script and History
/// are the deck's script panel and snapshot list. The tab is controlled.
///
/// Every panel stays mounted: the chat owns running streams and the script
/// owns an unsaved caret, so hiding a tab must not unmount it.

import type { KeyboardEvent, ReactNode } from 'react';
import { useT } from '../i18n';

export type DockTab = 'ask' | 'script' | 'history';

export interface DeckDockProps {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  /** The chat. */
  children: ReactNode;
  script: ReactNode;
  history: ReactNode;
}

const TABS: ReadonlyArray<{ tab: DockTab; labelId: string }> = [
  { tab: 'ask', labelId: 'slides.dock.ask' },
  { tab: 'script', labelId: 'slides.dock.script' },
  { tab: 'history', labelId: 'slides.dock.history' },
];

export function DeckDock({ tab, onTab, children, script, history }: DeckDockProps) {
  const t = useT();

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const at = TABS.findIndex((x) => x.tab === tab);
    onTab(TABS[(at + delta + TABS.length) % TABS.length].tab);
  };

  const panels: ReadonlyArray<{ tab: DockTab; node: ReactNode }> = [
    { tab: 'ask', node: children },
    { tab: 'script', node: script },
    { tab: 'history', node: history },
  ];

  return (
    <div className="deck-dock">
      <div className="deck-dock-tabs" role="tablist" aria-label={t('slides.dock.aria')} onKeyDown={onKeyDown}>
        {TABS.map(({ tab: id, labelId }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`deck-dock-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`deck-dock-panel-${id}`}
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
          id={`deck-dock-panel-${id}`}
          aria-labelledby={`deck-dock-tab-${id}`}
          className="deck-dock-panel"
          hidden={tab !== id}
        >
          {node}
        </div>
      ))}
    </div>
  );
}
