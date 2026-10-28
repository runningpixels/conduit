import { Fragment, useCallback, useEffect, useState } from 'react';
import { appName } from '../../brand';
import type { SkillSource, SkillSummary } from '../../ipc/contracts';
import {
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
  importSkillFolder,
  importSkillGit,
  importSkillZip,
  listSkills,
  revealSkillsDir,
} from '../../ipc/client';
import { useRichT, useT, type Translate } from '../../i18n';
import { PageEmpty, PageListItem } from '../../shell/PageFrame';
import { embeddedLibraryFrame, type LibraryFrame } from './LibraryLayout';
import { skillExistsName } from './skillExists';

/** The "Import from GitHub" form: the link typed, and what went wrong. */
interface GithubImport {
  url: string;
  error: string | null;
  /** A skill of this name exists; the form asks whether to replace it. */
  conflict: string | null;
}

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
  const [github, setGithub] = useState<GithubImport | null>(null);

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

  const openGithub = () => setGithub({ url: '', error: null, conflict: null });

  async function importFromGithub(form: GithubImport, replace: boolean) {
    const url = form.url.trim();
    if (!url) return;
    setBusy(true);
    try {
      const skill = await importSkillGit(url, replace);
      setGithub(null);
      setSelectedId(skill.id);
      onStatus(t('settings.skills.status.importedGithub', { name: skill.name }));
      await refresh();
    } catch (e) {
      const taken = replace ? null : skillExistsName(e);
      setGithub(
        taken !== null ? { ...form, error: null, conflict: taken } : { ...form, error: String(e), conflict: null },
      );
    } finally {
      setBusy(false);
    }
  }

  const githubButton = (
    <button className="btn ghost" type="button" disabled={busy} onClick={openGithub}>
      {t('settings.skills.actions.importGithub')}
    </button>
  );

  const actions = (
    <>
      {githubButton}
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
  if (github) {
    const form = github;
    const heading = t('settings.skills.github.title');
    detail = (
      <form
        className="library-detail library-editor"
        aria-label={heading}
        onSubmit={(e) => {
          e.preventDefault();
          if (form.conflict === null) void importFromGithub(form, false);
        }}
      >
        <header className="library-detail-head">
          <h3 className="library-detail-title">{heading}</h3>
        </header>
        <label className="field">
          <span className="field-label">{t('settings.skills.github.urlLabel')}</span>
          <input
            className="library-input"
            type="url"
            autoFocus
            spellCheck={false}
            placeholder={t('settings.skills.github.urlPlaceholder')}
            value={form.url}
            disabled={busy}
            onChange={(e) => setGithub({ url: e.target.value, error: null, conflict: null })}
          />
        </label>
        <p className="library-detail-text">{t('settings.skills.github.scriptsNote')}</p>
        {form.error ? (
          <p className="library-detail-text skill-error" role="alert">
            {form.error}
          </p>
        ) : null}
        {form.conflict !== null ? (
          <div className="library-editor-actions" role="alert">
            <p className="library-detail-text skill-replace-prompt">
              {t('settings.skills.replace.prompt', { name: form.conflict })}
            </p>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setGithub({ ...form, conflict: null })}>
              {t('common.actions.cancel')}
            </button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void importFromGithub(form, true)}>
              {t('settings.skills.replace.confirm')}
            </button>
          </div>
        ) : (
          <div className="library-editor-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setGithub(null)}>
              {t('common.actions.cancel')}
            </button>
            <button className="btn primary" type="submit" disabled={busy || !form.url.trim()}>
              {busy ? t('settings.skills.github.importing') : t('settings.skills.github.import')}
            </button>
          </div>
        )}
      </form>
    );
  } else if (selected) {
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
          <>
            <button className="btn primary" type="button" disabled={busy} onClick={importFolder}>
              {t('settings.skills.actions.importFolder')}
            </button>
            {githubButton}
          </>
        }
      />
    );
  }

  return <>{frame({ actions, list, detail })}</>;
}
