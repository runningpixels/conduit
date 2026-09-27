import { Fragment, useCallback, useEffect, useState } from 'react';
import { appName } from '../../brand';
import type { SkillSource, SkillSummary } from '../../ipc/contracts';
import {
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
  importSkillFolder,
  importSkillZip,
  listSkills,
  revealSkillsDir,
} from '../../ipc/client';
import { useRichT, useT, type Translate } from '../../i18n';
import { PageEmpty, PageListItem } from '../../shell/PageFrame';
import { embeddedLibraryFrame, type LibraryFrame } from './LibraryLayout';

interface SkillsSectionProps {
  onStatus: (message: string) => void;
  workspaceRoot?: string | null;
  /** How the parts are arranged; the Library page passes its PageFrame. */
  frame?: LibraryFrame;
}

/** The order the list groups sources in: the managed folder first. */
const SOURCE_ORDER: SkillSource[] = ['conduit', 'workspace', 'claude', 'agents', 'brand'];

function sourceLabel(source: SkillSource, t: Translate): string {
  switch (source) {
    case 'conduit':
      return appName();
    case 'claude':
      return 'Claude';
    case 'agents':
      return t('settings.skills.source.agents');
    case 'brand':
      return t('settings.skills.source.brand');
    case 'workspace':
      return t('settings.skills.source.workspace');
  }
}

export function SkillsSection({ onStatus, workspaceRoot, frame = embeddedLibraryFrame }: SkillsSectionProps) {
  const t = useT();
  const tr = useRichT();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills(workspaceRoot));
    } catch (e) {
      onStatus(t('settings.skills.status.loadFailed', { error: String(e) }));
    }
  }, [onStatus, workspaceRoot, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = await action();
      if (result !== null && result !== undefined) {
        onStatus(label);
      }
      await refresh();
    } catch (e) {
      onStatus(t('settings.skills.status.actionFailed', { label, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const groups = SOURCE_ORDER.map((source) => ({
    source,
    skills: skills.filter((s) => s.source === source),
  })).filter((g) => g.skills.length > 0);
  const ordered = groups.flatMap((g) => g.skills);
  const selected = ordered.find((s) => s.id === selectedId) ?? ordered[0] ?? null;

  const importFolder = () =>
    void run(t('settings.skills.status.importedFolder'), () =>
      importSkillFolder(t('settings.skills.dialog.importFolderTitle')),
    );

  const actions = (
    <>
      <button
        className="btn ghost"
        type="button"
        disabled={busy}
        onClick={() =>
          void run(t('settings.skills.status.openedFolder'), async () => {
            await revealSkillsDir();
            return true;
          })
        }
      >
        {t('settings.skills.actions.openFolder')}
      </button>
      <button
        className="btn ghost"
        type="button"
        disabled={busy}
        onClick={() =>
          void run(t('settings.skills.status.importedZip'), () =>
            importSkillZip(t('settings.skills.dialog.importZipTitle'), t('settings.skills.dialog.filterName')),
          )
        }
      >
        {t('settings.skills.actions.importZip')}
      </button>
      <button className="btn primary" type="button" disabled={busy} onClick={importFolder}>
        {t('settings.skills.actions.importFolder')}
      </button>
    </>
  );

  const list =
    groups.length === 0 ? (
      <p className="library-list-hint">{t('shell.library.skills.empty.title')}</p>
    ) : (
      groups.map((g) => (
        <Fragment key={g.source}>
          <div className="page-list-group">{sourceLabel(g.source, t)}</div>
          {g.skills.map((skill) => (
            <PageListItem
              key={skill.id}
              selected={selected?.id === skill.id}
              onSelect={() => setSelectedId(skill.id)}
              title={skill.name}
              meta={skill.parseError ?? skill.description}
            />
          ))}
        </Fragment>
      ))
    );

  let detail: React.ReactNode;
  if (selected) {
    const skill = selected;
    detail = (
      <article className="library-detail" aria-labelledby={`skill-title-${skill.id}`}>
        <header className="library-detail-head">
          <div className="library-detail-heading">
            <h3 className="library-detail-title" id={`skill-title-${skill.id}`}>
              {skill.name}
            </h3>
            <p className="library-detail-meta">
              <span className="skill-source">{sourceLabel(skill.source, t)}</span>
              {skill.hasScripts ? (
                <>
                  {' · '}
                  <span className="skill-flag">{t('settings.skills.scriptsUnusedFlag')}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="library-detail-actions">
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(t('settings.skills.status.exported', { name: skill.name }), () =>
                  exportSkillFolder(skill.id, t('settings.skills.dialog.exportFolderTitle'), workspaceRoot),
                )
              }
            >
              {t('settings.skills.actions.exportFolder')}
            </button>
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(t('settings.skills.status.exportedZip', { name: skill.name }), () =>
                  exportSkillZip(
                    skill.id,
                    t('settings.skills.dialog.exportZipTitle'),
                    t('settings.skills.dialog.filterName'),
                    workspaceRoot,
                  ),
                )
              }
            >
              {t('settings.skills.actions.exportZip')}
            </button>
            {skill.source === 'conduit' ? (
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!confirm(t('settings.skills.confirm.delete', { name: skill.name }))) return;
                  void run(t('settings.skills.status.deleted', { name: skill.name }), async () => {
                    await deleteManagedSkill(skill.id);
                    if (selectedId === skill.id) setSelectedId(null);
                    return true;
                  });
                }}
              >
                {t('common.actions.delete')}
              </button>
            ) : null}
          </div>
        </header>
        {skill.parseError ? (
          <p className="library-detail-text skill-error">{skill.parseError}</p>
        ) : (
          <p className="library-detail-text">{skill.description}</p>
        )}
        <section className="grp">
          <div className="grp-label">{t('shell.library.skills.location')}</div>
          <code className="library-path">{skill.path}</code>
        </section>
        {skill.compatibility ? (
          <section className="grp">
            <div className="grp-label">{t('shell.library.skills.compatibility')}</div>
            <p className="library-detail-text">{skill.compatibility}</p>
          </section>
        ) : null}
        {skill.license ? (
          <section className="grp">
            <div className="grp-label">{t('shell.library.skills.license')}</div>
            <p className="library-detail-text">{skill.license}</p>
          </section>
        ) : null}
      </article>
    );
  } else {
    detail = (
      <PageEmpty
        title={t('shell.library.skills.empty.title')}
        body={tr('settings.skills.empty.hint')}
        action={
          <button className="btn primary" type="button" disabled={busy} onClick={importFolder}>
            {t('settings.skills.actions.importFolder')}
          </button>
        }
      />
    );
  }

  return <>{frame({ actions, list, detail })}</>;
}
