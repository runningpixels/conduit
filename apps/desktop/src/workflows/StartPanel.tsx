/// The Start panel: everything about the workflow as a whole. When it starts,
/// what it asks for each run, and its settings (description, model, folder).
/// Shown beside the canvas when the start node (or nothing) is selected, and
/// beside the step list.

import { useState } from 'react';
import { useT } from '../i18n';
import { pickWorkspaceFolder } from '../ipc/client';
import type { WorkflowDefinition, WorkflowInput } from '../ipc/contracts';
import { newInput, withFolder, withWorkflowModel } from './editorModel';
import { TriggerSection } from './TriggerSection';
import { WorkflowModelRow } from './WorkflowModelRow';
import type { WorkflowDraft } from './WorkflowEditor';

export function StartPanel({
  draft,
  onChange,
  notes,
}: {
  draft: WorkflowDraft;
  onChange: (next: WorkflowDraft) => void;
  /** Things the draft still needs filled in; the checkboxes are only a reminder. */
  notes?: readonly string[];
}) {
  const t = useT();
  const def = draft.definition;
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const setDefinition = (definition: WorkflowDefinition) => onChange({ ...draft, definition });
  const inputs = def.inputs ?? [];
  const setInputs = (next: WorkflowInput[]) => setDefinition({ ...def, inputs: next });

  return (
    <div className="wfe-start">
      <header className="wfe-start-head">
        <h2 className="wfe-title">{t('workspace.workflows.canvas.start')}</h2>
        <p className="wfe-help">{t('workspace.workflows.editor.start.subtitle')}</p>
      </header>

      {notes && notes.length > 0 ? (
        <section className="wfe-section" aria-label={t('workspace.workflows.describe.notes')}>
          <h3 className="wfe-h">{t('workspace.workflows.describe.notes')}</h3>
          <ul className="wfe-notes">
            {notes.map((note, index) => (
              <li key={`${index}-${note}`}>
                <label className="wfe-check">
                  <input
                    type="checkbox"
                    checked={done.has(index)}
                    onChange={(e) => {
                      const next = new Set(done);
                      if (e.target.checked) next.add(index);
                      else next.delete(index);
                      setDone(next);
                    }}
                  />
                  <span>{note}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="wfe-section">
        <TriggerSection def={def} onChange={setDefinition} />
      </section>

      <section className="wfe-section" aria-labelledby="wfe-inputs-title">
        <h3 className="wfe-h" id="wfe-inputs-title">
          {t('workspace.workflows.editor.inputs.title')}
        </h3>
        <p className="wfe-help">{t('workspace.workflows.editor.inputs.hint')}</p>
        {inputs.length > 0 ? (
          <div className="wfe-inputs">
            <span className="wfe-col-head">{t('workspace.workflows.editor.inputs.nameHeader')}</span>
            <span className="wfe-col-head">{t('workspace.workflows.editor.inputs.defaultHeader')}</span>
            <span />
            {inputs.map((input, index) => (
              <InputRow
                key={input.id}
                input={input}
                index={index}
                onChange={(next) => setInputs(inputs.map((i) => (i.id === input.id ? next : i)))}
                onRemove={() => setInputs(inputs.filter((i) => i.id !== input.id))}
              />
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="btn ghost wfe-add-value"
          onClick={() => setInputs([...inputs, newInput(inputs, t('workspace.workflows.editor.inputs.newLabel'))])}
        >
          {t('workspace.workflows.editor.inputs.add')}
        </button>
      </section>

      <section className="wfe-section wfe-settings" aria-labelledby="wfe-settings-title">
        <h3 className="wfe-h" id="wfe-settings-title">
          {t('workspace.workflows.editor.settings.title')}
        </h3>
        <label className="wfe-field">
          <span>{t('workspace.workflows.edit.description')}</span>
          <input
            className="mem-input"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
        </label>
        <div className="wfe-setting">
          <WorkflowModelRow
            kind="workflow"
            idPrefix="wf-model"
            model={def.model}
            onChange={(model) => setDefinition(withWorkflowModel(def, model))}
          />
          <p className="wfe-help">{t('workspace.workflows.model.hint')}</p>
        </div>
        <FolderRow folder={def.folder} onChange={(folder) => setDefinition(withFolder(def, folder))} />
      </section>
    </div>
  );
}

function InputRow({
  input,
  index,
  onChange,
  onRemove,
}: {
  input: WorkflowInput;
  index: number;
  onChange: (next: WorkflowInput) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <>
      <input
        className="mem-input"
        aria-label={t('workspace.workflows.editor.inputs.label', { n: index + 1 })}
        placeholder={t('workspace.workflows.editor.inputs.labelPlaceholder')}
        value={input.label}
        onChange={(e) => onChange({ ...input, label: e.target.value })}
      />
      <input
        className="mem-input"
        aria-label={t('workspace.workflows.editor.inputs.default', { n: index + 1 })}
        placeholder={t('workspace.workflows.editor.inputs.defaultPlaceholder')}
        value={input.default ?? ''}
        onChange={(e) => onChange({ ...input, default: e.target.value })}
      />
      <button type="button" className="btn ghost" aria-label={t('workspace.workflows.editor.inputs.remove', { n: index + 1 })} onClick={onRemove}>
        ×
      </button>
    </>
  );
}

/// The folder `read_file` steps read from: shown as a path, picked with the
/// system folder dialog, and clearable.
function FolderRow({ folder, onChange }: { folder: string | undefined; onChange: (folder: string | null) => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    setError(null);
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) onChange(picked);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('workspace.workflows.folder.pickFailed'));
    }
  };
  return (
    <div className="wfe-setting" role="group" aria-label={t('workspace.workflows.folder.label')}>
      <div className="wfe-setting-row">
        <div className="wfe-setting-text">
          <div className="wfe-label">{t('workspace.workflows.folder.label')}</div>
          <p className="wfe-help">{t('workspace.workflows.folder.hint')}</p>
        </div>
        <div className="wfe-setting-actions">
          <button type="button" className="btn ghost" onClick={() => void choose()}>
            {folder ? t('workspace.workflows.folder.change') : t('workspace.workflows.folder.choose')}
          </button>
          {folder ? (
            <button type="button" className="btn ghost" onClick={() => onChange(null)}>
              {t('workspace.workflows.folder.clear')}
            </button>
          ) : null}
        </div>
      </div>
      {folder ? <code className="wfe-path">{folder}</code> : <p className="wfe-help">{t('workspace.workflows.folder.none')}</p>}
      {error ? <p className="wfe-error">{error}</p> : null}
    </div>
  );
}
