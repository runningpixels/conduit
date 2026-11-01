/// A project's settings: instructions, Documents collections and skills that
/// every chat in the project (folder) uses, on top of the app's and before the
/// chat's own, and the working folder new chats in it start in. Laid out like
/// the agent editor, whose classes it borrows.
///
/// Escape is caught in the capture phase, like the other dialogs over a page.
/// Choosing a folder asks for the workspace tools consent first, as a chat's
/// folder chip does.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import {
  createKnowledgeCollection,
  getProjectSettings,
  listKnowledgeCollections,
  listSkills,
  pickWorkspaceFolder,
  setProjectSettings,
} from '../ipc/client';
import { WorkspaceToolsConsentDialog } from '../workspace/settings/WorkspaceToolsConsentDialog';
import type { ConversationFolder, KnowledgeCollection, ProjectSettings, SkillSummary } from '../ipc/contracts';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toggled(ids: readonly string[], id: string, on: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

export function ProjectSettingsDialog({
  folder,
  onClose,
  onSaved,
  onOpenDocuments,
  workspaceConsented,
  onAllowWorkspace,
}: {
  folder: ConversationFolder;
  onClose: () => void;
  onSaved: (saved: ProjectSettings) => void;
  /// Go to where documents are added to a collection.
  onOpenDocuments?: () => void;
  /// Whether the workspace tools consent has been given.
  workspaceConsented: boolean;
  /// Record the workspace tools consent.
  onAllowWorkspace: () => Promise<void>;
}) {
  const t = useT();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusTrap(formRef, true);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [collections, setCollections] = useState<KnowledgeCollection[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askConsent, setAskConsent] = useState(false);
  const [picking, setPicking] = useState(false);
  const askConsentRef = useRef(false);
  askConsentRef.current = askConsent;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // Escape answers the consent question first, then closes the dialog.
        if (askConsentRef.current) setAskConsent(false);
        else onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => getProjectSettings(folder.id))
      .then((settings) => {
        if (!cancelled) setDraft(settings);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    Promise.resolve()
      .then(() => listKnowledgeCollections())
      .then((list) => {
        if (!cancelled) setCollections(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      });
    Promise.resolve()
      .then(() => listSkills())
      .then((list) => {
        if (!cancelled) setSkills(Array.isArray(list) ? list.filter((s) => !s.parseError) : []);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [folder.id]);

  // The field is disabled until the settings load, so `autoFocus` would do
  // nothing; focus it once they have (the opener's menu hands focus back first).
  const loaded = draft !== null;
  useEffect(() => {
    if (loaded) instructionsRef.current?.focus();
  }, [loaded]);

  function set(fn: (d: ProjectSettings) => ProjectSettings) {
    setDraft((d) => (d ? fn(d) : d));
    setProblem(null);
  }

  async function newCollection() {
    setProblem(null);
    try {
      const collection = await createKnowledgeCollection(folder.name);
      setCollections((list) => [...(list ?? []), collection]);
      set((d) => ({ ...d, collectionIds: toggled(d.collectionIds, collection.id, true) }));
      setCreated(true);
    } catch (e) {
      setProblem(errorText(e));
    }
  }

  async function chooseFolder() {
    setPicking(true);
    try {
      const path = await pickWorkspaceFolder();
      if (path) set((d) => ({ ...d, workspaceRoot: path }));
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPicking(false);
    }
  }

  function onChooseFolder() {
    if (picking) return;
    if (workspaceConsented) void chooseFolder();
    else setAskConsent(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !draft) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await setProjectSettings({
        ...draft,
        userInstructions: draft.userInstructions?.trim() ? draft.userInstructions : null,
      });
      onSaved(saved);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(false);
    }
  }

  const collectionIds = draft?.collectionIds ?? [];
  const skillIds = draft?.skillIds ?? [];
  const goneCollections = collections ? collectionIds.filter((id) => !collections.some((c) => c.id === id)) : [];
  const goneSkills = skills ? skillIds.filter((id) => !skills.some((s) => s.id === id)) : [];

  return (
    <div
      className="consent-overlay app-inputs-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={formRef}
        className="app-inputs-dialog agent-editor-dialog project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <header className="agent-editor-head">
          <h2 id={titleId}>{t('shell.projects.settings.title', { name: folder.name })}</h2>
          <p className="wf-muted">{t('shell.projects.settings.lead')}</p>
        </header>

        {loadFailed ? (
          <p className="agent-editor-problems" role="alert">
            {t('shell.projects.settings.loadFailed')}
          </p>
        ) : (
          <div className="agent-editor-body">
            <section className="agent-editor-col">
              <label className="app-field agent-editor-instructions">
                <span className="app-field-label">{t('shell.projects.settings.instructions')}</span>
                <textarea
                  className="mem-input"
                  rows={12}
                  ref={instructionsRef}
                  disabled={!draft}
                  placeholder={t('shell.projects.settings.instructionsPlaceholder')}
                  value={draft?.userInstructions ?? ''}
                  onChange={({ target: { value } }) => set((d) => ({ ...d, userInstructions: value }))}
                />
              </label>

              <fieldset className="wf-tools agent-editor-group" disabled={!draft}>
                <legend>{t('shell.projects.settings.folder')}</legend>
                <p className="wf-muted">{t('shell.projects.settings.folderHint')}</p>
                {draft?.workspaceRoot ? (
                  <p className="project-settings-folder" title={draft.workspaceRoot}>
                    {draft.workspaceRoot}
                  </p>
                ) : (
                  <p className="wf-muted">{t('shell.projects.settings.folderNone')}</p>
                )}
                <div className="project-settings-actions">
                  <button type="button" className="btn ghost" disabled={picking} onClick={onChooseFolder}>
                    {t('shell.projects.settings.folderChoose')}
                  </button>
                  {draft?.workspaceRoot ? (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => set((d) => ({ ...d, workspaceRoot: null }))}
                    >
                      {t('shell.projects.settings.folderRemove')}
                    </button>
                  ) : null}
                </div>
              </fieldset>
            </section>

            <section className="agent-editor-col">
              <fieldset className="wf-tools agent-editor-group" disabled={!draft}>
                <legend>{t('shell.projects.settings.documents')}</legend>
                <p className="wf-muted">{t('shell.projects.settings.documentsHint')}</p>
                {collections && collections.length === 0 ? (
                  <p className="wf-muted">{t('shell.agents.editor.knowledge.none')}</p>
                ) : null}
                {(collections ?? []).map((c) => (
                  <label key={c.id} className="wf-check">
                    <input
                      type="checkbox"
                      checked={collectionIds.includes(c.id)}
                      onChange={({ target: { checked } }) => set((d) => ({ ...d, collectionIds: toggled(d.collectionIds, c.id, checked) }))}
                    />
                    {t('workspace.workflows.editor.searchDocs.option', { name: c.name, count: c.documentCount })}
                  </label>
                ))}
                {goneCollections.map((id) => (
                  <label key={id} className="wf-check">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => set((d) => ({ ...d, collectionIds: toggled(d.collectionIds, id, false) }))}
                    />
                    {t('workspace.workflows.editor.searchDocs.gone')}
                  </label>
                ))}
                <div className="project-settings-actions">
                  <button type="button" className="btn ghost" onClick={() => void newCollection()}>
                    {t('shell.projects.settings.newCollection')}
                  </button>
                  {onOpenDocuments ? (
                    <button type="button" className="btn ghost" onClick={onOpenDocuments}>
                      {t('shell.agents.editor.knowledge.open')}
                    </button>
                  ) : null}
                </div>
                {created ? <p className="wf-muted">{t('shell.projects.settings.addFilesHint')}</p> : null}
              </fieldset>

              <fieldset className="wf-tools agent-editor-group" disabled={!draft}>
                <legend>{t('shell.projects.settings.skills')}</legend>
                <p className="wf-muted">{t('shell.projects.settings.skillsHint')}</p>
                {skills && skills.length === 0 ? (
                  <p className="wf-muted">{t('shell.projects.settings.skillsNone')}</p>
                ) : null}
                {(skills ?? []).map((s) => (
                  <label key={s.id} className="wf-check" title={s.description}>
                    <input
                      type="checkbox"
                      checked={skillIds.includes(s.id)}
                      onChange={({ target: { checked } }) => set((d) => ({ ...d, skillIds: toggled(d.skillIds, s.id, checked) }))}
                    />
                    {s.name}
                  </label>
                ))}
                {goneSkills.map((id) => (
                  <label key={id} className="wf-check">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => set((d) => ({ ...d, skillIds: toggled(d.skillIds, id, false) }))}
                    />
                    {id}
                  </label>
                ))}
              </fieldset>
            </section>
          </div>
        )}

        <footer className="agent-editor-foot">
          {problem ? (
            <ul className="agent-editor-problems" role="alert">
              <li>{problem}</li>
            </ul>
          ) : null}
          <div className="app-details-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !draft}>
              {t('common.actions.save')}
            </button>
          </div>
        </footer>

        {/* Inside the form so the focus trap reaches it. */}
        <WorkspaceToolsConsentDialog
          visible={askConsent}
          onAllow={() => {
            setAskConsent(false);
            void onAllowWorkspace()
              .then(() => chooseFolder())
              .catch((e: unknown) => setProblem(errorText(e)));
          }}
          onDeny={() => setAskConsent(false)}
        />
      </form>
    </div>
  );
}
