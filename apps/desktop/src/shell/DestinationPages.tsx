/// Rail destinations that used to be Settings sections (docs/plans/ui-revamp.md):
/// Library (Prompts and Skills), Connectors and Memory. Each is a page in the
/// main area, built from the same section components Settings used, under
/// the headings and intros those sections already had.

import { useState } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { useRichT, useT } from '../i18n';
import { ConnectorsSection } from '../workspace/settings/ConnectorsSection';
import { MemorySection } from '../workspace/settings/MemorySection';
import { PromptsSection } from '../workspace/settings/PromptsSection';
import { SkillsSection } from '../workspace/settings/SkillsSection';
import { useAutoSave } from '../workspace/settings/useAutoSave';

function Page({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="sheet sheet-single sheet-page" aria-label={label}>
      <div className="sheet-main scroll">{children}</div>
    </section>
  );
}

export type LibraryTab = 'prompts' | 'skills';

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
  return (
    <Page label={t('shell.library.heading')}>
      <h2 className="sheet-h">{t('shell.library.heading')}</h2>
      <div className="ideas-tabs" role="tablist" aria-label={t('shell.library.heading')}>
        {(['prompts', 'skills'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`library-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`library-panel-${id}`}
            className={`ideas-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(`shell.settingsSheet.nav.${id}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`}>
        {tab === 'prompts' ? (
          <>
            <p className="sheet-sub">{t('shell.settingsSheet.prompts.intro')}</p>
            <PromptsSection onStatus={onStatus} onInsertPrompt={onInsertPrompt} />
          </>
        ) : (
          <>
            <p className="sheet-sub">{tr('shell.settingsSheet.skills.intro')}</p>
            <SkillsSection onStatus={onStatus} workspaceRoot={settings.workspaceRoot} />
          </>
        )}
      </div>
    </Page>
  );
}

export function ConnectorsPage({ onStatus }: { onStatus: (message: string) => void }) {
  const t = useT();
  return (
    <Page label={t('shell.settingsSheet.connectors.heading')}>
      <h2 className="sheet-h">{t('shell.settingsSheet.connectors.heading')}</h2>
      <p className="sheet-sub">{t('shell.settingsSheet.connectors.intro')}</p>
      <ConnectorsSection onStatus={onStatus} showHeader={false} />
    </Page>
  );
}

export function MemoryPage({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const save = useAutoSave(onSettingsChange, onStatus);
  return (
    <Page label={t('shell.settingsSheet.memory.heading')}>
      <h2 className="sheet-h">{t('shell.settingsSheet.memory.heading')}</h2>
      <p className="sheet-sub">{t('shell.settingsSheet.memory.intro')}</p>
      <MemorySection settings={settings} onUpdate={save} onStatus={onStatus} />
    </Page>
  );
}
