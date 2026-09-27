/// Library (rail destination): the user's saved prompts and skills.
///
/// List-and-detail. The Prompts | Skills tabs sit at the top of the list pane
/// and switch what the list holds; the header's main action follows the tab
/// ("New prompt", "Import folder"). The sections own their behaviour and hand
/// their parts to the PageFrame built here (workspace/settings/LibraryLayout).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { useRichT, useT } from '../i18n';
import { PageFrame } from '../shell/PageFrame';
import type { LibraryFrame } from '../workspace/settings/LibraryLayout';
import { PromptsSection } from '../workspace/settings/PromptsSection';
import { SkillsSection } from '../workspace/settings/SkillsSection';

export type LibraryTab = 'prompts' | 'skills';

const TABS: LibraryTab[] = ['prompts', 'skills'];

export function LibraryPage({
  settings,
  onStatus,
  onInsertPrompt,
  initialTab = 'prompts',
}: {
  settings: AppSettings;
  onStatus: (message: string) => void;
  onInsertPrompt: (body: string) => void;
  initialTab?: LibraryTab;
}) {
  const t = useT();
  const tr = useRichT();
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const tabRefs = useRef<Partial<Record<LibraryTab, HTMLButtonElement | null>>>({});
  // Each tab's section renders its own PageFrame, so switching remounts the
  // tab buttons too; put focus back on the chosen tab once it has rendered.
  const refocusTab = useRef(false);
  useEffect(() => {
    if (!refocusTab.current) return;
    refocusTab.current = false;
    tabRefs.current[tab]?.focus();
  }, [tab]);
  const selectTab = (id: LibraryTab) => {
    if (id === tab) return;
    refocusTab.current = true;
    setTab(id);
  };

  // Arrow keys move between the tabs (the ARIA tabs pattern); only the active
  // tab is in the tab order.
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    let next: LibraryTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
  };

  const tabs = (
    <div className="library-tabs" role="tablist" aria-label={t('shell.library.heading')}>
      {TABS.map((id) => (
        <button
          key={id}
          ref={(el) => {
            tabRefs.current[id] = el;
          }}
          type="button"
          role="tab"
          id={`library-tab-${id}`}
          aria-selected={tab === id}
          aria-controls={`library-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          className="library-tab"
          onClick={() => selectTab(id)}
          onKeyDown={onTabKeyDown}
        >
          {t(`shell.settingsSheet.nav.${id}`)}
        </button>
      ))}
    </div>
  );

  const frame: LibraryFrame = ({ actions, listHeader, list, detail }) => (
    <PageFrame
      className="library-page"
      title={t('shell.library.heading')}
      subtitle={tab === 'prompts' ? t('shell.settingsSheet.prompts.intro') : tr('shell.settingsSheet.skills.intro')}
      about={
        <p>{tab === 'prompts' ? t('shell.library.prompts.about') : t('settings.skills.intro')}</p>
      }
      actions={actions}
      listLabel={t(`shell.settingsSheet.nav.${tab}`)}
      listHeader={
        <>
          {tabs}
          {listHeader}
        </>
      }
      list={
        <div
          className="library-panel"
          role="tabpanel"
          id={`library-panel-${tab}`}
          aria-labelledby={`library-tab-${tab}`}
        >
          {list}
        </div>
      }
    >
      {detail}
    </PageFrame>
  );

  return tab === 'prompts' ? (
    <PromptsSection onStatus={onStatus} onInsertPrompt={onInsertPrompt} frame={frame} />
  ) : (
    <SkillsSection onStatus={onStatus} workspaceRoot={settings.workspaceRoot} frame={frame} />
  );
}
